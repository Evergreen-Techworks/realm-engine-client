import type { PluginContext } from '../src/plugins/PluginContext.js';
import type { ClientConnection } from '../src/proxy/ClientConnection.js';

/**
 * O3 Helper — faithful port of RealmStock MultiTool's Class87 (O3 Helper).
 *
 * Intercepts ENEMYHIT packets (client→server) and suppresses them according
 * to MultiTool's method_9 decision tree:
 *
 *   O3IgnoreShield  — block hits on Oryx 3 while his shield is up (bool_1)
 *   O3IgnoreCoins   — block hits on the three coin guardian entities (8701–8703)
 *   O3IgnoreDammah  — block hits on Dammah while he is speaking (bool_2)
 *
 * Object type IDs (Class87.cs constants):
 *   45363 = Oryx 3 main body         (tracked as o3Id     / int_5)
 *    8701 = Coin guardian type 1     (tracked as coin1Id  / int_6)
 *    8702 = Coin guardian type 2     (tracked as coin2Id  / int_7)
 *    8703 = Coin guardian type 3     (tracked as coin3Id  / int_8)
 *    9635 = Chancellor Dammah        (tracked as dammahId / int_10)
 *
 * Shield detection (method_5):
 *   UPDATE and NEWTICK stat type 125 (Class34.class34_121 = smethod_0(125))
 *   on the Oryx 3 entity.  Shield is active when the signed-int32 value is
 *   in { -935464302, -918686683 } (Class87.list_1).
 *
 * Dammah phase detection (method_6):
 *   TEXT packet where name == "#Chancellor Dammah", numStars <= -1, and
 *   cleanText matches one of the five known voice lines (Class87.list_0).
 *
 * Note on the "active coin" (int_9 / SHOWEFFECT tracking):
 *   MultiTool also hooks SHOWEFFECT to identify which single coin currently
 *   has a Flash effect — that coin (int_9) is allowed through even when
 *   O3IgnoreCoins is on.  bot-client does not parse SHOWEFFECT fields (the
 *   packet definition has fields: []), so int_9 is left at -1, meaning ALL
 *   three coin guardians are blocked when O3IgnoreCoins is enabled.  This is
 *   the conservative/safe behaviour.
 *
 * method_8() equivalent:
 *   canSuppressAbility() is exported so auto-ability.ts can call it, matching
 *   Class85.method_8's call to class36_0.class87_0.method_8().
 *
 * Chat commands:
 *   /o3   — print the current O3 tracking state inline
 */

// ── Object type IDs ──────────────────────────────────────────────────────────

const O3_BOSS_TYPE   = 45363; // Oryx 3
const O3_COIN1_TYPE  = 8701;  // coin guardian 1
const O3_COIN2_TYPE  = 8702;  // coin guardian 2
const O3_COIN3_TYPE  = 8703;  // coin guardian 3
const O3_DAMMAH_TYPE = 9635;  // Chancellor Dammah

// ── Shield state: Class34.class34_121 = smethod_0(125) → stat type 125 ───────

const O3_STATE_STAT = 125;

// Class87.list_1 — signed-int32 values on stat-125 that mean shield is up
const O3_SHIELD_VALUES = new Set<number>([-935464302, -918686683]);

// ── Dammah voice lines: Class87.list_0 ──────────────────────────────────────

const DAMMAH_LINES = new Set([
  'No more! A steep price is to be paid for this brazen insolence in the face of my own grandeur!',
  'Greetings, dogged peons! I am Dammah, and I shall be your unmaker!',
  'Ahem... Your uprising ends here. Lay down your feeble weapons and accept death.',
  'Do NOT interrupt me, impatient ones!',
  'I SAID DO NOT INTERRUPT ME! For this I shall hasten your end!',
]);

// ── Per-client state ──────────────────────────────────────────────────────────

interface O3State {
  inSanctuary:  boolean;  // bool_0  — map name == "Oryx's Sanctuary"
  o3Id:         number;   // int_5   — Oryx 3 instance id (-1 = not tracked)
  coin1Id:      number;   // int_6   — coin guardian 1 instance id
  coin2Id:      number;   // int_7   — coin guardian 2 instance id
  coin3Id:      number;   // int_8   — coin guardian 3 instance id
  // int_9 (SHOWEFFECT-tracked active coin) always stays -1; see note above.
  dammahId:     number;   // int_10  — Dammah instance id
  shieldActive: boolean;  // bool_1
  dammahPhase:  boolean;  // bool_2
}

function freshState(): O3State {
  return {
    inSanctuary:  false,
    o3Id:         -1,
    coin1Id:      -1,
    coin2Id:      -1,
    coin3Id:      -1,
    dammahId:     -1,
    shieldActive: false,
    dammahPhase:  false,
  };
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export function register(ctx: PluginContext) {
  ctx.name     = 'O3 Helper';
  ctx.category = 'combat';

  // ── Settings (matching MultiTool Settings.Default.*) ─────────────────────

  let enabled      = true;
  let ignoreShield = true;  // O3IgnoreShield
  let ignoreCoins  = true;  // O3IgnoreCoins
  let ignoreDammah = true;  // O3IgnoreDammah

  ctx.registerSetting('enabled', {
    label: 'Enable O3 Helper', type: 'boolean', value: enabled,
  }, (v: boolean) => { enabled = v; });

  ctx.registerSetting('ignoreShield', {
    label: 'Block hits during O3 shield raise', type: 'boolean', value: ignoreShield,
  }, (v: boolean) => { ignoreShield = v; });

  ctx.registerSetting('ignoreCoins', {
    label: 'Block hits on coin guardians', type: 'boolean', value: ignoreCoins,
  }, (v: boolean) => { ignoreCoins = v; });

  ctx.registerSetting('ignoreDammah', {
    label: 'Block hits on Dammah (while speaking)', type: 'boolean', value: ignoreDammah,
  }, (v: boolean) => { ignoreDammah = v; });

  ctx.registerSetting('status', {
    label: 'O3 Status', type: 'text', value: 'Not in Oryx\'s Sanctuary',
  });

  // ── Per-client state map ──────────────────────────────────────────────────

  const stateMap = new Map<ClientConnection, O3State>();

  function getState(client: ClientConnection): O3State {
    let s = stateMap.get(client);
    if (!s) { s = freshState(); stateMap.set(client, s); }
    return s;
  }

  ctx.on('clientConnected',    (c) => stateMap.set(c, freshState()));
  ctx.on('clientDisconnected', (c) => stateMap.delete(c));

  // ── Helpers ───────────────────────────────────────────────────────────────

  function updateStatusDisplay(state: O3State): void {
    if (!state.inSanctuary) {
      ctx.updateSetting('status', 'Not in Oryx\'s Sanctuary');
      return;
    }
    const parts: string[] = [];
    if (state.o3Id !== -1)    parts.push(`O3 id=${state.o3Id}`);
    if (state.shieldActive)   parts.push('SHIELD UP');
    if (state.dammahPhase)    parts.push('DAMMAH PHASE');
    const coins = [state.coin1Id, state.coin2Id, state.coin3Id].filter(x => x !== -1);
    if (coins.length)         parts.push(`coins=[${coins.join(',')}]`);
    ctx.updateSetting('status', parts.length ? parts.join(' | ') : 'Sanctuary — waiting for O3');
  }

  // method_5: find stat type 125 on entity and update shieldActive.
  function checkShield(stats: Array<{ id: number; value: unknown }>, state: O3State): void {
    for (const stat of stats) {
      if (stat.id === O3_STATE_STAT) {
        state.shieldActive = O3_SHIELD_VALUES.has(stat.value as number);
        return;
      }
    }
    // Stat absent in this tick — leave shieldActive unchanged.
  }

  // method_9: true = allow the hit, false = block it.
  // Exact port of Class87.method_9(int int_11).
  function canHit(targetId: number, state: O3State): boolean {
    if (!state.inSanctuary) return true;
    if (!enabled) return true;

    // O3IgnoreShield: block Oryx 3 while shield is raised
    if (ignoreShield && targetId === state.o3Id && state.shieldActive) return false;

    // O3IgnoreCoins: guard section (int_9 == -1 since SHOWEFFECT not parsed)
    if (ignoreCoins) {
      // if (int_11 == int_9) return true  — int_9 is always -1, never matches
      if (targetId !== state.coin1Id && targetId !== state.coin2Id) {
        return targetId !== state.coin3Id;  // block coin3; allow everything else
      }
      return false; // was coin1 or coin2 → block
    }

    // O3IgnoreDammah: block Dammah while he is speaking
    if (ignoreDammah && state.dammahPhase && targetId === state.dammahId) return false;

    return true;
  }

  // method_8: true = suppress ability use (used by auto-ability plugin).
  // Exact port of Class87.method_8().
  function shouldSuppressAbility(state: O3State): boolean {
    if (!state.inSanctuary) return false;
    if (!enabled) return false;
    if (ignoreShield && state.shieldActive) return true;
    if (ignoreDammah && state.dammahPhase) return true;
    return false;
  }

  // Expose for external use (e.g. auto-ability.ts can call ctx.getData)
  ctx.setData('shouldSuppressAbility', (client: ClientConnection) =>
    shouldSuppressAbility(getState(client))
  );

  // ── MAPINFO — method_0: set inSanctuary, full entity reset ───────────────

  ctx.hookPacket('MAPINFO', (client, packet) => {
    if (!packet.isDefined) return;
    const state = getState(client);
    const name  = (packet.data.name as string) ?? '';
    state.inSanctuary = name === "Oryx's Sanctuary";

    // Reset all entity tracking on every map change
    state.o3Id        = -1;
    state.coin1Id     = -1;
    state.coin2Id     = -1;
    state.coin3Id     = -1;
    state.dammahId    = -1;
    state.shieldActive = false;
    state.dammahPhase  = false;

    updateStatusDisplay(state);

    if (state.inSanctuary) {
      ctx.log('Entered Oryx\'s Sanctuary — O3 tracking active');
    }
  });

  ctx.hookPacket('CREATESUCCESS', (client) => {
    const state = getState(client);
    state.o3Id        = -1;
    state.coin1Id     = -1;
    state.coin2Id     = -1;
    state.coin3Id     = -1;
    state.dammahId    = -1;
    state.shieldActive = false;
    state.dammahPhase  = false;
  });

  // ── UPDATE — method_3: scan new objects, record IDs, check shield ─────────
  //
  // MultiTool's loop scans entities in array order until it finds the O3 boss.
  // Coins and Dammah are only recorded when int_5 (o3Id) is not yet known.
  // Once O3 is found, int_5 is set and method_5 is called on its stat block.
  // We replicate this faithfully, then also handle drops.

  ctx.hookPacket('UPDATE', (client, packet) => {
    if (!packet.isDefined) return;
    const state = getState(client);
    if (!state.inSanctuary) return;

    const newObjs = (packet.data.newObjs as any[]) ?? [];
    for (const entity of newObjs) {
      const objectType = entity.objectType as number;
      const objectId   = entity.status?.objectId as number;
      const stats      = (entity.status?.data ?? []) as Array<{ id: number; value: unknown }>;

      if (objectType === O3_BOSS_TYPE) {
        state.o3Id = objectId;
        checkShield(stats, state);
        // MultiTool's loop breaks here — but we continue to process remaining
        // entities in the same packet for completeness.
        continue;
      }

      // Coins and Dammah are only recorded before O3 appears (int_5 == -1).
      if (state.o3Id === -1) {
        if      (objectType === O3_COIN1_TYPE)  state.coin1Id  = objectId;
        else if (objectType === O3_COIN2_TYPE)  state.coin2Id  = objectId;
        else if (objectType === O3_COIN3_TYPE)  state.coin3Id  = objectId;
        else if (objectType === O3_DAMMAH_TYPE) state.dammahId = objectId;
      }
    }

    // Remove entities that are leaving scope
    const drops = (packet.data.drops as number[]) ?? [];
    for (const oid of drops) {
      if (oid === state.o3Id)     { state.o3Id     = -1; state.shieldActive = false; }
      if (oid === state.coin1Id)  state.coin1Id  = -1;
      if (oid === state.coin2Id)  state.coin2Id  = -1;
      if (oid === state.coin3Id)  state.coin3Id  = -1;
      if (oid === state.dammahId) { state.dammahId = -1; state.dammahPhase  = false; }
    }

    updateStatusDisplay(state);
  });

  // ── NEWTICK — method_4: refresh shield status for tracked O3 entity ───────

  ctx.hookPacket('NEWTICK', (client, packet) => {
    if (!packet.isDefined) return;
    const state = getState(client);
    if (!state.inSanctuary || state.o3Id === -1) return;

    const statuses = (packet.data.statuses as any[]) ?? [];
    for (const status of statuses) {
      if ((status.objectId as number) !== state.o3Id) continue;
      const stats = (status.data ?? []) as Array<{ id: number; value: unknown }>;
      const prevShield = state.shieldActive;
      checkShield(stats, state);
      if (state.shieldActive !== prevShield) {
        ctx.log(`O3 shield: ${state.shieldActive ? 'UP' : 'DOWN'}`);
        updateStatusDisplay(state);
      }
      break;
    }
  });

  // ── TEXT — method_6: detect Dammah phase from voice lines ────────────────
  //
  // Condition: numStars <= -1 (NPC speaker) AND name == "#Chancellor Dammah"
  // AND cleanText is one of the five voice lines in DAMMAH_LINES.

  ctx.hookPacket('TEXT', (client, packet) => {
    if (!packet.isDefined) return;
    const state = getState(client);
    if (!state.inSanctuary) return;

    const numStars  = packet.data.numStars  as number;
    const name      = packet.data.name      as string;
    const cleanText = packet.data.cleanText as string;

    if (numStars <= -1 && name === '#Chancellor Dammah') {
      const prev = state.dammahPhase;
      state.dammahPhase = DAMMAH_LINES.has(cleanText);
      if (state.dammahPhase !== prev) {
        ctx.log(`Dammah phase: ${state.dammahPhase ? 'ACTIVE' : 'ended'}`);
        updateStatusDisplay(state);
      }
    }
  });

  // ── ENEMYHIT — method_1 / method_9: core packet filter ───────────────────
  //
  // Class65 maps to ENEMYHIT (packet id 25, direction client→server).
  // method_1(Class65) calls method_9(class65_0.int_2) where int_2 = targetId.
  // If method_9 returns false, class65_0.bool_0 (send flag) is set false.

  ctx.hookPacket('ENEMYHIT', (client, packet) => {
    if (!packet.isDefined) return;
    const state    = getState(client);
    const targetId = packet.data.targetId as number;

    if (!canHit(targetId, state)) {
      packet.send = false;
    }
  });

  // ── Chat command: /o3 ────────────────────────────────────────────────────

  ctx.hookCommand('o3', (client, _cmd, args) => {
    if (args.length > 0) {
      const arg = args[0].toLowerCase();
      if (arg === 'on' || arg === 'enable') {
        ctx.enabled = true;
        ctx.sendNotification(client, 'O3 Helper', 'O3 Helper ON');
        return;
      } else if (arg === 'off' || arg === 'disable') {
        ctx.enabled = false;
        ctx.sendNotification(client, 'O3 Helper', 'O3 Helper OFF');
        return;
      } else if (arg === 'toggle' || arg === 't') {
        ctx.enabled = !ctx.enabled;
        ctx.sendNotification(client, 'O3 Helper', `O3 Helper ${ctx.enabled ? 'ON' : 'OFF'}`);
        return;
      }
    }
    const state = getState(client);
    if (!state.inSanctuary) {
      ctx.enabled = !ctx.enabled;
      ctx.sendNotification(client, 'O3 Helper', `O3 Helper ${ctx.enabled ? 'ON' : 'OFF'} (Not in Oryx's Sanctuary)`);
      return;
    }
    const lines = [
      `O3 id=${state.o3Id === -1 ? 'none' : state.o3Id}`,
      `shield=${state.shieldActive ? 'UP' : 'down'}`,
      `coins=[${[state.coin1Id, state.coin2Id, state.coin3Id].map(x => x === -1 ? '-' : x).join(',')}]`,
      `dammah id=${state.dammahId === -1 ? 'none' : state.dammahId}`,
      `dammahPhase=${state.dammahPhase}`,
    ];
    ctx.sendNotification(client, 'O3 Helper', lines.join(' | '));
    ctx.log(`O3 state: ${JSON.stringify(state)}`);
  });

  ctx.log('Loaded — blocks ENEMYHIT during O3 shield / coins / Dammah phases. /o3 to toggle/inspect state');
}
