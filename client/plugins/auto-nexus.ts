import type { PluginContext } from '../src/plugins/PluginContext.js';
import type { ClientConnection } from '../src/proxy/ClientConnection.js';
import type { Packet } from '../src/packets/Packet.js';
import { sendDllFeature } from '../src/bridge/DllFeatureBus.js';
import { getDllThreats, getDllGround, getDllThreatsAgeMs } from '../src/bridge/DllThreatBus.js';
import type { DllThreat } from '../src/bridge/DllThreatBus.js';

/**
 * Auto Nexus — near 1:1 port of MultiTool `Class89` (minus autopot, plus close-spawn ENEMYSHOOT).
 *
 * Parity (Class89):
 *   method_0   → doNexus(ESCAPE)
 *   method_1   → MAPINFO / reset map, safe `bool_1`, clear bullets+aoes
 *   method_7   → NEWTICK: sync, `int_9` heal queue, `method_30` thresholds; regen is from `method_14/29` in MT — we apply `method_29` on NEWTICK + MOVE like prior bot
 *   method_8   → SHOWEFFECT / nova (float_3) — not wired (no float_3)
 *   method_10  → stat batch HP/VIT/flags; `int_9` — we use NEWTICK + `pendingHeal` for queued heal
 *   method_12  → item regen `float_1`/`int_10` — not wired
 *   method_16  → AOE add to list (optional: `trackAoeDamage`); method_17 MOVE sweep = AoE+suppression
 *   method_18  → GROUNDDAMAGE = tile max × (Int32_47/1000)
 *   method_19  → PLAYERHIT; unknown shot: warn in MT, we use 175 + piercing
 *   method_20  → damage formula + Int32_47/1000 + petrify/curse/invuln
 *   method_29  → regen; `bool_3` confused; `num3` combat drain
 *   method_30  → threshold ints (`int_1` from %)
 *   method_31  → shouldNexus; `bool_1` safe zone; `int_1` / `Int32_1` / `int_4`/`int_5`
 *   method_35  → apply damage, then `method_31` → `method_0`
 *
 * Priority: `Proxy.hookPacket` prepend, plugin load order `auto-nexus` first.
 *
 * DEATH (S→C) is never blocked — the client always receives the server’s death packet; we may still send ESCAPE as a last resort.
 */

// ── Safe zones (Class89.list_1) ───────────────────────────────────────────────

const SAFE_ZONE_MAPS = new Set([
  'Nexus',
  'Vault',
  'Guild Hall', 'Guild Hall 2', 'Guild Hall 3', 'Guild Hall 4', 'Guild Hall 5',
  'Cloth Bazaar',
  'Nexus Explanation', 'Vault Explanation', 'Guild Explanation',
  'Daily Quest Room', 'Daily Login Room',
  'Pet Yard', 'Pet Yard 2', 'Pet Yard 3', 'Pet Yard 4', 'Pet Yard 5',
]);

// ── Interfaces ────────────────────────────────────────────────────────────────

interface TrackedAoe {
  damage:      number;
  armorPierce: boolean;
  pos:         { x: number; y: number };
  radius:      number;
}

/**
 * One locally predicted hit, pending confirmation from the server.
 *
 * An entry lives until either the server confirms it (a server HP drop or a
 * DAMAGE packet consumes it) or its TTL expires — expiry refunds the HP, because
 * `clientHp` is recomputed from the surviving entries rather than accumulated.
 */
interface PredictedHit {
  amount:    number;
  at:        number;
  expiresAt: number;
  source:    string;
  serverWillApply: boolean;
}

interface NexusState {
  /**
   * Authoritative HP — ProdMafia's `syncedChp`. Written only from `pd.health` on
   * NEWTICK and from server DAMAGE confirmations. Local damage never mutates it.
   */
  serverHp:     number;
  maxHp:        number;
  defense:      number;
  vitality:     number;
  regenAccum:   number;
  pendingHeal:  number;
  nexusSent:    boolean;
  inSafeZone:   boolean;
  lastTickTime: number;
  lastSyncTick: number;
  pendingAoes:  TrackedAoe[];
  /** Locally predicted damage awaiting confirmation — see `clientHp`. */
  predicted:    PredictedHit[];
  /** Positive recovery applied to the prediction but not yet in `serverHp`. */
  predictedRecovery: number;
  /** Pending release timers for held lethal PLAYERHITs. */
  heldTimers:   ReturnType<typeof setTimeout>[];
  /** Trailing window of server HP loss no prediction accounted for. */
  unattributed: UnattributedSample[];
}

interface UnattributedSample {
  amount: number;
  at:     number;
}

/** Class27 Int32_47: stored ×1000, default 1000. */
function damageRedIntThousand(pd: ClientConnection['playerData']): number {
  const v = pd.exaltationDamageMultiplier;
  return v > 0 ? v : 1000;
}

// ── method_20 — MultiTool Class89 ─────────────────────────────────────────────

function calcDamage(
  baseDmg:      number,
  defense:      number,
  piercing:     boolean,
  armorBroken:  boolean,
  armored:      boolean,
  exposed:      boolean,
  invulnerable: boolean,
  petrified:    boolean,
  cursed:       boolean,
  int47Thousand: number,
): number {
  let def = defense;
  if (piercing || armorBroken) {
    def = 0;
  } else if (armored) {
    def = Math.floor(def * 1.5);
  }
  if (exposed) def -= 20;

  const minDmg  = baseDmg * 0.10;
  const normDmg = baseDmg - def;
  let result    = Math.max(minDmg, normDmg);

 //result *= int47Thousand / 1000; //Not used

  if (invulnerable) return 0;
  if (petrified)    result = Math.floor(result * 0.90);
  if (cursed)       result = Math.floor(result * 1.25);

  return Math.floor(result);
}

// method_29: num2 = 2*(1+0.12*vit) + float_1*maxHp + int_10; item terms default 0 without Class89.method_12
function method29BaseRegenPerSec(
  vit: number,
  maxHp: number,
  float1HpRegenFromGear = 0,
  int10FlatRegen = 0,
): number {
  return 2 + (0.2407 * vit) + float1HpRegenFromGear * maxHp + int10FlatRegen;
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export function register(ctx: PluginContext) {
  ctx.name     = 'Auto Nexus';
  ctx.category = 'combat';

  let enableAutoNexus = true;  // EnableAutoNexus

  const enableAutoNexusOnly = true; 
  const useClientHp         = true; 
  const syncServerHp        = true; 
  const trackAoeDamage      = false;

  // ── Thresholds ─────────────────────────────────────────────────────────
  let nexusThresholdPct    = 25;   // ForceAutoNexusHealth
  let predictedNexusPct    = 10;   // PredictedAutoNexusHealth
  let predictedNexusTimeMs = 200;  // PredictedAutoNexusTime
  let includeGroundTicks   = true; // IncludeGroundTicks
  let showNotification     = true; // ShowChatMessageOnNexus
  let drawOverlay          = false; // DrawOverlay

  // ── Lethal PLAYERHIT hold ──────────────────────────────────────────────
  let holdLethalHits  = true; // HoldLethalPlayerHit
  let lethalHoldMs    = 100;  // LethalHoldTime
  let lethalCushionHp = 10;    // LethalCushionHealth

  // ── Predicted-damage ledger TTLs ───────────────────────────────────────
  const PREDICTED_TTL_PROJECTILE_MS  = 600;
  const PREDICTED_TTL_ENVIRONMENT_MS = 1200;
  const MAX_PENDING_PREDICTIONS      = 64;

  // ── Unattributed-damage margin (ProdMafia `effectiveAutoNexusThreshold`) ──
  let useUnattributedMargin = true;

  const UNATTRIBUTED_WINDOW_MS    = 2000;
  const UNATTRIBUTED_REACTION_MS  = 350;
  const UNATTRIBUTED_MAX_FRACTION = 0.12;

  ctx.registerSetting('ForceAutoNexusHealth', {
    label: 'Force Nexus Health',
    type: 'range', value: nexusThresholdPct, min: 0, max: 100, step: 1,
  }, (v: number) => { nexusThresholdPct = v; });

  ctx.registerSetting('PredictedAutoNexusHealth', {
    label: 'Predicted Nexus Health',
    type: 'range', value: predictedNexusPct, min: 0, max: 100, step: 1,
  }, (v: number) => { predictedNexusPct = v; });

  ctx.registerSetting('PredictedAutoNexusTime', {
    label: 'Predicted Nexus Time',
    type: 'range', value: predictedNexusTimeMs, min: 0, max: 1000, step: 10,
  }, (v: number) => { predictedNexusTimeMs = v; pushDllSettings(); });

  ctx.registerSetting('IncludeGroundTicks', {
    label: 'Include Ground Ticks', type: 'boolean', value: includeGroundTicks,
  }, (v: boolean) => {
    includeGroundTicks = v === true;
    sendDllFeature('autoNexusTilePredict', includeGroundTicks);
  });

  ctx.registerSetting('HoldLethalPlayerHit', {
    label: 'Hold Lethal Player Hits', type: 'boolean', value: holdLethalHits,
  }, (v: boolean) => { holdLethalHits = v === true; });

  ctx.registerSetting('LethalHoldTime', {
    label: 'Lethal Hold Time', advanced: true,
    type: 'range', value: lethalHoldMs, min: 0, max: 2000, step: 25,
  }, (v: number) => { lethalHoldMs = v; });

  ctx.registerSetting('LethalCushionHealth', {
    label: 'Lethal Cushion HP', advanced: true,
    type: 'range', value: lethalCushionHp, min: 0, max: 500, step: 5,
  }, (v: number) => { lethalCushionHp = v; });

  ctx.registerSetting('UnattributedMargin', {
    label: 'Nexus Early on Unseen Damage',
    type: 'boolean', value: useUnattributedMargin,
  }, (v: boolean) => { useUnattributedMargin = v === true; });

  ctx.registerSetting('ShowChatMessageOnNexus', {
    label: 'Show Chat Message on Nexus', advanced: true,
    type: 'boolean', value: showNotification,
  }, (v: boolean) => { showNotification = v === true; });

  ctx.registerSetting('DrawOverlay', {
    label: 'Draw Overlay', advanced: true,
    type: 'boolean', value: drawOverlay,
  }, (v: boolean) => {
    drawOverlay = v === true;
    sendDllFeature('autoNexusDebugDraw', drawOverlay ? 1 : 0);
  });

  // Autopot (HP + MP) lives in the auto-drink plugin. The dashboard warns there
  // if this nexus threshold is set at/above auto-drink's HP threshold.

  function pushDllSettings(): void {
    sendDllFeature('autoNexusPredictedTimeMs', predictedNexusTimeMs);
  }

  function armDll(on: boolean): void {
    sendDllFeature('autoNexusEnabled', on);
    if (on) {
      sendDllFeature('autoNexusProjPredict', true);
      sendDllFeature('autoNexusTilePredict', includeGroundTicks);
      sendDllFeature('autoNexusDebugDraw', drawOverlay ? 1 : 0);
      pushDllSettings();
    }
  }
  ctx.onEnabledChange(armDll);
  armDll(ctx.enabled);
  ctx.registerCleanup(() => sendDllFeature('autoNexusEnabled', false));

  const states = new WeakMap<ClientConnection, NexusState>();

  function getState(client: ClientConnection): NexusState {
    let s = states.get(client);
    if (!s) {
      s = {
        serverHp: 0, maxHp: 0,
        defense: 0, vitality: 0,
        regenAccum: 0,
        pendingHeal: 0,
        nexusSent: false, inSafeZone: false,
        lastTickTime: Date.now(), lastSyncTick: 0,
        pendingAoes: [],
        predicted: [], predictedRecovery: 0, heldTimers: [],
        unattributed: [],
      };
      states.set(client, s);
    }
    return s;
  }

  // ── Predicted-damage ledger ───────────────────────────────────────────
  function pruneExpired(state: NexusState): void {
    if (state.predicted.length === 0) return;
    const now = Date.now();
    state.predicted = state.predicted.filter((p) => p.expiresAt > now);
  }

  function chargePredicted(
    state:  NexusState,
    amount: number,
    source: string,
    ttlMs:  number,
    serverWillApply: boolean,
  ): void {
    if (amount <= 0) return;
    pruneExpired(state);

    const now = Date.now();
    state.predicted.push({
      amount, at: now, expiresAt: now + ttlMs, source, serverWillApply,
    });

    while (state.predicted.length > MAX_PENDING_PREDICTIONS) {
      const dropped = state.predicted.shift();
      if (dropped) {
        ctx.log(`Prediction ledger full — refunded ${Math.round(dropped.amount)} HP (${dropped.source})`);
      }
    }
  }

  function pendingDamage(state: NexusState): number {
    pruneExpired(state);
    let total = 0;
    for (const p of state.predicted) total += p.amount;
    return total;
  }

  function consumePredicted(state: NexusState, amount: number): number {
    pruneExpired(state);
    let remaining = amount;

    while (remaining > 0 && state.predicted.length > 0) {
      const oldest = state.predicted[0];
      if (oldest.amount <= remaining) {
        remaining -= oldest.amount;
        state.predicted.shift();
      } else {
        oldest.amount -= remaining;
        remaining = 0;
      }
    }

    return amount - remaining;
  }

  function clientHp(state: NexusState): number {
    const hp = state.serverHp + state.predictedRecovery - pendingDamage(state);
    return Math.min(hp, state.maxHp > 0 ? state.maxHp : hp);
  }

  function serverBelievedHp(state: NexusState): number {
    pruneExpired(state);
    let hp = state.serverHp;
    for (const p of state.predicted) {
      if (p.serverWillApply) hp -= p.amount;
    }
    return hp;
  }

  /** Add recovery to the prediction, bounded so `clientHp` cannot exceed max HP. */
  function addPredictedRecovery(state: NexusState, amount: number): void {
    if (amount === 0) return;
    state.predictedRecovery += amount;
    if (state.predictedRecovery < 0) state.predictedRecovery = 0;

    const overshoot = clientHp(state) - state.maxHp;
    if (state.maxHp > 0 && overshoot > 0) {
      state.predictedRecovery = Math.max(0, state.predictedRecovery - overshoot);
    }
  }

  function resyncPrediction(state: NexusState): void {
    state.predicted.length  = 0;
    state.predictedRecovery = 0;
    state.regenAccum        = 0;
  }

  function unattributedDps(state: NexusState): number {
    if (state.unattributed.length === 0) return 0;
    const cutoff = Date.now() - UNATTRIBUTED_WINDOW_MS;
    state.unattributed = state.unattributed.filter((s) => s.at > cutoff);
    if (state.unattributed.length === 0) return 0;

    let total = 0;
    for (const sample of state.unattributed) total += sample.amount;
    return total / (UNATTRIBUTED_WINDOW_MS / 1000);
  }

  function unattributedMarginHp(state: NexusState): number {
    if (!useUnattributedMargin || state.maxHp <= 0) return 0;
    const dps = unattributedDps(state);
    if (dps <= 0) return 0;
    const margin = dps * (UNATTRIBUTED_REACTION_MS / 1000);
    return Math.min(margin, state.maxHp * UNATTRIBUTED_MAX_FRACTION);
  }

  function baseThresholdHp(state: NexusState): number {
    return nexusThresholdPct * 0.01 * state.maxHp;
  }

  function effectiveThresholdHp(state: NexusState): number {
    return baseThresholdHp(state) + unattributedMarginHp(state);
  }

  const liveHeldTimers = new Set<ReturnType<typeof setTimeout>>();
  ctx.registerCleanup(() => {
    for (const timer of liveHeldTimers) clearTimeout(timer);
    liveHeldTimers.clear();
  });

  function clearHeldTimers(state: NexusState): void {
    for (const timer of state.heldTimers) {
      clearTimeout(timer);
      liveHeldTimers.delete(timer);
    }
    state.heldTimers.length = 0;
  }

  let activeClient: ClientConnection | null = null;

  /** Run at the start of every hot path: track active client; if nexus already sent, short-circuit. */
  function nexusPrologue(client: ClientConnection, state: NexusState): boolean {
    activeClient = client;
    if (state.nexusSent) return true;
    return false;
  }

  ctx.on('clientDisconnected', (client) => {
    clearHeldTimers(getState(client));
    if (activeClient === client) activeClient = null;
  });

  // method_31
  function shouldNexus(state: NexusState): boolean {
    if (!enableAutoNexus || !enableAutoNexusOnly) return false;
    if (state.inSafeZone)     return false;
    if (state.maxHp <= 0)     return false;
    const threshold = effectiveThresholdHp(state);

    if (useClientHp) {
      return clientHp(state) <= threshold;
    }
    return serverBelievedHp(state) <= threshold;
  }

  // method_0
  function doNexus(
    client: ClientConnection,
    state:  NexusState,
    reason: string,
    detail?: string,
  ): void {
    if (state.nexusSent) return;
    state.nexusSent = true;

    const hp    = clientHp(state);
    const hpPct = state.maxHp > 0 ? Math.round((hp / state.maxHp) * 100) : 0;
    const conds = describeConditions(client.playerData);
    const thresholds = describeThresholds(state);
    ctx.log(`AUTO NEXUS — HP: ${Math.round(hp)}/${state.maxHp} (${hpPct}%) — ${reason}`
      + ` — ${thresholds} — ${describeLedger(state)}`
      + (conds ? ` — conditions: ${conds}` : '')
      + (detail ? ` — ${detail.replace(/\n/g, ' | ')}` : ''));

    if (showNotification) {
        ctx.sendNotification(client, 'AutoNexus',
        `AutoNexused at ${hpPct}% HP\nHP: ${Math.round(hp)}/${state.maxHp} | DEF: ${state.defense} | ServerHP: ${state.serverHp}`
        + `\n${thresholds}`
        + `\n${describeLedger(state)}`
        + (conds ? `\nConditions: ${conds}` : '')
        + `\nSource: ${reason}`
        + (detail ? `\n${detail}` : ''));
    }

    const escape = ctx.createPacket('ESCAPE');
    escape.modified = true;
    client.sendToServer(escape);
  }

  function describeLedger(state: NexusState): string {
    const pending = pendingDamage(state);
    return `HP model: synced ${Math.round(state.serverHp)}`
      + ` + recovery ${Math.round(state.predictedRecovery)}`
      + ` - pending ${Math.round(pending)} (${state.predicted.length} entries)`
      + ` = ${Math.round(clientHp(state))}`;
  }

  function describeThresholds(state: NexusState): string {
    const base   = Math.round(baseThresholdHp(state));
    const margin = unattributedMarginHp(state);
    if (margin <= 0) return `threshold ${base} HP (${nexusThresholdPct}%)`;
    return `threshold ${base} HP (${nexusThresholdPct}%) `
      + `→ ${Math.round(base + margin)} HP `
      + `(+${Math.round(margin)} unseen-dmg margin, ${Math.round(unattributedDps(state))} HP/s)`;
  }

  function attackerName(client: ClientConnection, attackerObjId: number): string {
    const type = ctx.getWorldState(client)?.getEntityType(attackerObjId);
    if (type === undefined) return `#${attackerObjId}`;
    const def = ctx.gameData?.getObject(type);
    return def?.displayId || def?.id || `0x${type.toString(16)}`;
  }

  function getDmgFromState(
    client: ClientConnection,
    state: NexusState,
    baseDmg: number,
    piercing: boolean,
  ): number {
    const pd = client.playerData;
    return calcDamage(
      baseDmg,
      state.defense,
      piercing,
      pd.hasConditionEffect('ArmorBroken'),
      pd.hasConditionEffect('Armored'),
      pd.hasConditionEffect('Exposed'),
      pd.hasConditionEffect('Invulnerable') || pd.hasConditionEffect('Invincible'),
      pd.hasConditionEffect('Petrified'),
      pd.hasConditionEffect('Curse'),
      damageRedIntThousand(pd),
    );
  }

  // method_35 — int_4 / int_5, then method_31 → method_0
  // For C→S packets (PLAYERHIT, MOVE, GROUNDDAMAGE, AOEACK when used): `packet.send = false` means
  // the proxy does not forward that packet to the real server, so the server never applies the hit/ack
  // (same idea as MultiTool suppressing the outgoing copy).
  function applyDamage(
    client: ClientConnection,
    state:  NexusState,
    dmg:    number,
    reason: string,
    packet?: Packet,
    ttlMs:  number = PREDICTED_TTL_PROJECTILE_MS,
  ): void {
    chargePredicted(state, dmg, reason, ttlMs, true);
    const entry = state.predicted[state.predicted.length - 1];

    if (shouldNexus(state)) {
      if (packet) packet.send = false;
      doNexus(client, state, reason);
    }

    if (entry && packet && !packet.send) entry.serverWillApply = false;
  }


  // method_29: num = int_13*0.001 = elapsed seconds; float_1/int_10/float_3 = 0 without method_8/12
  function regenMethod29(state: NexusState, pd: ClientConnection['playerData'], deltaSec: number): void {
    if (deltaSec <= 0 || state.maxHp <= 0) return;
    const num = deltaSec;

    const sick     = pd.hasConditionEffect('Sick');
    const healing  = pd.hasConditionEffect('Healing');
    const bleeding = pd.hasConditionEffect('Bleeding');
    const confused = pd.hasConditionEffect('Confused');
    // Class89 num3: (bool_2 && Int32_46==0) || int_11>=100 — approximated
    const inCombat = pd.hasConditionEffect('InCombat') || pd.powerLevel >= 100;

    let num2 = method29BaseRegenPerSec(state.vitality, state.maxHp, 0, 0);
    //if (confused) num2 /= 2; //This is just not true

    if (!sick) {
      const float3 = 20;
      if (healing) state.regenAccum += (float3 + num2) * num;
      else         state.regenAccum += num2 * num;
    }
    if (bleeding) state.regenAccum -= 20 * num;
    if (inCombat) state.regenAccum /= 2;

    const num4 = Math.trunc(state.regenAccum);
    state.regenAccum -= num4;
    // Regen is a prediction like any other: it lands in `predictedRecovery` and is
    // retired when the server's own HP catches up to it.
    addPredictedRecovery(state, num4);
  }

  ctx.hookPacket('MAPINFO', (client, packet) => {
    const mapName = (packet.data.name ?? packet.data.displayName ?? '') as string;
    const state   = getState(client);
    state.inSafeZone = SAFE_ZONE_MAPS.has(mapName);
    state.nexusSent  = false;
    state.serverHp   = 0;
    state.pendingHeal = 0;
    state.pendingAoes   = [];
    state.unattributed  = [];
    resyncPrediction(state);

    if (state.heldTimers.length > 0) {
      ctx.log(`Dropping ${state.heldTimers.length} held PLAYERHIT(s) — map changed before release`);
      clearHeldTimers(state);
    }
    ctx.log(`Map: "${mapName}" — safe zone: ${state.inSafeZone}`);
  }, { prepend: true });

  ctx.hookPacket('CREATESUCCESS', (client) => {
    const existing = states.get(client);
    if (existing) clearHeldTimers(existing);
    states.delete(client);
  }, { prepend: true });

  ctx.hookPacket('NEWTICK', (client, packet) => {
    if (!packet.isDefined) return;
    const state = getState(client);
    const pd    = client.playerData;
    if (nexusPrologue(client, state)) { packet.send = false; return; }
    if (state.nexusSent) { packet.send = false; return; }

    state.maxHp    = pd.maxHealth; //Actual Max HP
    state.defense  = pd.defense; //Actual Def
    state.vitality = pd.vitality; //Actual Vit

    const serverHp     = pd.health > 0 ? pd.health : state.maxHp;
    const prevServerHp = state.serverHp;

    if (prevServerHp <= 0) {
      state.serverHp = serverHp;
      resyncPrediction(state);
      state.pendingHeal = 0;
    } else {
      const delta = prevServerHp - serverHp;

      if (delta > 0) {
        const consumed    = consumePredicted(state, delta);
        const unexplained = delta - consumed;
        if (unexplained > 0) {
          state.unattributed.push({ amount: unexplained, at: Date.now() });
        }
      } else if (delta < 0) {
        // The server healed us; retire the recovery we had already predicted.
        addPredictedRecovery(state, delta);
      }

      state.serverHp = serverHp;

      if (syncServerHp && clientHp(state) > serverHp) {
        const excess = clientHp(state) - serverHp;
        state.predictedRecovery = Math.max(0, state.predictedRecovery - excess);
      }
    }

    // Class89.method_7: `int_9` heal queue (method_33) after stats, before method_30
    if (state.pendingHeal !== 0) {
      addPredictedRecovery(state, state.pendingHeal);
      state.pendingHeal = 0;
    }

    state.lastSyncTick++;
    state.lastTickTime = Date.now();

    const deltaSec = (packet.data.tickTime as number ?? 200) / 1000;
    regenMethod29(state, pd, deltaSec);
    if (shouldNexus(state)) {
      if (packet) packet.send = false;
      doNexus(client, state, `Server Side Hit`);
    }
    // Autopot (HP + MP) is owned by the auto-drink plugin — see its HP threshold guard.
  }, { prepend: true });

  ctx.hookPacket('MOVE', (client, packet) => {
    const state = getState(client);
    if (nexusPrologue(client, state)) { packet.send = false; return; }
    if (state.nexusSent) { packet.send = false; return; }
    if (state.maxHp <= 0) return;

    const playerPos = client.playerData.pos;
    const aoes      = state.pendingAoes;

    if (!trackAoeDamage) {
      aoes.length = 0;
    } else if (aoes.length > 0 && playerPos) {
      for (let i = aoes.length - 1; i >= 0; i--) {
        const aoe = aoes[i];
        const dx  = playerPos.x - aoe.pos.x;
        const dy  = playerPos.y - aoe.pos.y;
        const distSq = dx * dx + dy * dy;
        const radiusSq = aoe.radius * aoe.radius;

        if (distSq <= radiusSq) {
          const dmg = getDmgFromState(client, state, aoe.damage, aoe.armorPierce);
          aoes.splice(i, 1);
          applyDamage(client, state, dmg, `AoE dmg=${dmg} (on MOVE, pre-AOEACK)`, packet,
            PREDICTED_TTL_ENVIRONMENT_MS);
          if (state.nexusSent) return;
        }
      }
    }

    const now      = Date.now();
    const deltaSec = Math.min((now - state.lastTickTime) / 1000, 0.5);
    if (deltaSec > 0) {
      state.lastTickTime = now;
      regenMethod29(state, client.playerData, deltaSec);
    }
  }, { prepend: true });

  ctx.hookPacket('PLAYERHIT', (client, packet) => {
    if (!packet.isDefined) return;
    const state = getState(client);
    if (nexusPrologue(client, state)) { packet.send = false; return; }
    if (state.nexusSent) { packet.send = false; return; }
    if (state.maxHp <= 0) return;

    const bulletId = (packet.data.bulletId as number) & 0xffff;
    const objectId = packet.data.objectId as number;
    const bullet   = ctx.getProjectileTracker(client)?.getBullet(`${objectId}:${bulletId}`);

    // Unknown bullet: assume the worst (MultiTool warns and guesses here too).
    const baseDmg  = bullet ? bullet.damage : 200;
    const piercing = bullet ? (bullet.projDef?.armorPiercing ?? false) : true;

    const dmg = getDmgFromState(client, state, baseDmg, piercing);

    const srvHp = serverBelievedHp(state);
    const lethal = holdLethalHits
      && !state.inSafeZone
      && enableAutoNexus && enableAutoNexusOnly
      && srvHp > 0
      && srvHp - dmg <= lethalCushionHp;

    if (lethal) {
      packet.send = false;
      chargePredicted(state, dmg, 'held lethal PLAYERHIT',
        PREDICTED_TTL_PROJECTILE_MS + lethalHoldMs, true);

      const inFlight = state.serverHp - srvHp;
      doNexus(client, state,
        `LETHAL projectile hit (${dmg} dmg vs ${Math.round(srvHp)} server HP)`,
        `Server HP ${Math.round(state.serverHp)} - ${Math.round(inFlight)} in flight `
        + `= ${Math.round(srvHp)}; incoming ${dmg}${bullet ? '' : ' (estimated — unknown bullet)'}`);

      releaseHeldHit(client, state, packet, dmg);
      return;
    }

    applyDamage(client, state, dmg, `projectile hit (${dmg} dmg)`, packet);
  }, { prepend: true });

  function releaseHeldHit(
    client: ClientConnection,
    state:  NexusState,
    packet: Packet,
    dmg:    number,
  ): void {
    const bytes = Buffer.from(packet.rawBytes);
    const timer = setTimeout(() => {
      const idx = state.heldTimers.indexOf(timer);
      if (idx >= 0) state.heldTimers.splice(idx, 1);
      liveHeldTimers.delete(timer);
      if (!client.connected) {
        ctx.log(`Held PLAYERHIT dropped — client disconnected before release`);
        return;
      }
      client.sendRawToServer(bytes);
      ctx.log(`Released held PLAYERHIT (${dmg} dmg) ${lethalHoldMs}ms after ESCAPE`);
    }, lethalHoldMs);
    state.heldTimers.push(timer);
    liveHeldTimers.add(timer);
  }

  ctx.hookPacket('AOE', (client, packet) => {
    if (!packet.isDefined) return;
    if (!trackAoeDamage) return;
    const state = getState(client);
    if (nexusPrologue(client, state)) return;
    state.pendingAoes.push({
      damage:      packet.data.damage     as number,
      armorPierce: packet.data.armorPierce as boolean,
      pos:         packet.data.position   as { x: number; y: number },
      radius:      packet.data.radius     as number,
    });
    if (state.pendingAoes.length > 20) state.pendingAoes.shift();
  }, { prepend: true });

  ctx.hookPacket('AOEACK', (client, packet) => {
    const state = getState(client);
    if (nexusPrologue(client, state)) { packet.send = false; return; }
    const playerPos = client.playerData.pos;
    const aoes      = state.pendingAoes;
     if (!trackAoeDamage) {
      aoes.length = 0;
    } else if (aoes.length > 0 && playerPos) {
      for (let i = aoes.length - 1; i >= 0; i--) {
        const aoe = aoes[i];
        const dx  = playerPos.x - aoe.pos.x;
        const dy  = playerPos.y - aoe.pos.y;
        const distSq = dx * dx + dy * dy;
        const radiusSq = aoe.radius * aoe.radius;

        if (distSq <= radiusSq) {
          const dmg = getDmgFromState(client, state, aoe.damage, aoe.armorPierce);
          aoes.splice(i, 1);
          applyDamage(client, state, dmg, `AoE dmg=${dmg} (on MOVE, pre-AOEACK)`, packet,
            PREDICTED_TTL_ENVIRONMENT_MS);
          if (state.nexusSent) return;
        }
      }
    }
    if (state.nexusSent) { packet.send = false; return; }
  }, { prepend: true });

  // method_18
  ctx.hookPacket('GROUNDDAMAGE', (client, packet) => {
    if (!packet.isDefined) return;
    const state = getState(client);
    if (nexusPrologue(client, state)) { packet.send = false; return; }
    if (state.nexusSent) { packet.send = false; return; }
    if (state.maxHp <= 0) return;

    let raw   = 50;
    let label = 'est=50';
    const pos = packet.data.position as { x: number; y: number } | undefined;
    if (pos && ctx.worldState && ctx.gameData) {
      const tileType = ctx.worldState.getTileAt(Math.floor(pos.x), Math.floor(pos.y));
      if (tileType !== undefined) {
        const tileDmg = ctx.gameData.getTileDamage(tileType);
        if (tileDmg !== undefined) { raw = tileDmg; label = `tile=0x${tileType.toString(16)}`; }
      }
    }

    const int47 = damageRedIntThousand(client.playerData);
    const dmg   = Math.floor(raw * (int47 / 1000));

    applyDamage(
      client, state, dmg, `ground damage (${label}, raw=${raw} → ${dmg})`, packet,
      PREDICTED_TTL_ENVIRONMENT_MS,
    );
  }, { prepend: true });

  ctx.hookPacket('DAMAGE', (client, packet) => {
    if (!packet.isDefined) return;
    const state    = getState(client);
    if (nexusPrologue(client, state)) { packet.send = false; return; }
    const targetId = packet.data.targetId as number;
    if (targetId !== client.objectId) return;
    const kill = packet.data.kill as boolean;
    const serverDmg = packet.data.damageAmount as number;
    if (kill && !state.nexusSent && enableAutoNexus && enableAutoNexusOnly) {
      packet.send = false;
      if (!state.inSafeZone) {
        doNexus(client, state, `DAMAGE kill=true (dmg=${serverDmg})`);
      }
      return;
    }
    if (serverDmg > 0 && !state.nexusSent) {
      const consumed    = consumePredicted(state, serverDmg);
      const unexplained = serverDmg - consumed;
      state.serverHp -= serverDmg;
      if (unexplained > 0) {
        state.unattributed.push({ amount: unexplained, at: Date.now() });
      }
      ctx.log(`Server confirmed ${serverDmg} dmg `
        + `(${Math.round(consumed)} matched a prediction, ${Math.round(unexplained)} unattributed) — `
        + describeLedger(state));

      if (shouldNexus(state)) {
        doNexus(client, state, `server DAMAGE ${serverDmg}`);
      }
    }
  }, { prepend: true });

  // S→C: always forward DEATH to the game client (do not set packet.send = false).
  ctx.hookPacket('DEATH', (client, _packet) => {
    const state = getState(client);
    if (nexusPrologue(client, state)) return;
    if (!state.nexusSent && enableAutoNexus && enableAutoNexusOnly && !state.inSafeZone) {
      doNexus(client, state, 'DEATH packet (last-resort nexus, DEATH still forwarded to client)');
    }
  }, { prepend: true });

  // ── Predictive path: DLL threat list ──────────────────────────────────
  function normalizeEffect(name: string): string {
    return name.replace(/\s+/g, '').toLowerCase();
  }

  interface PredictedConditions {
    armorBroken: boolean;
    armored:     boolean;
    exposed:     boolean;
    petrified:   boolean;
    cursed:      boolean;
  }

  interface IncomingHit {
    from:     string;
    dmg:      number;
    tHitMs:   number;
    piercing: boolean;
    known:    boolean;
    applies:  string[];
  }

  const MAX_INCOMING_LINES = 10;

  function describeIncoming(
    incoming: IncomingHit[],
    state: NexusState,
    hpAfter: number,
  ): string {
    if (incoming.length === 0) return '';

    const total = incoming.reduce((sum, b) => sum + b.dmg, 0);
    const shown = incoming.slice(0, MAX_INCOMING_LINES);

    const lines = shown.map((b) => {
      const flags = (b.piercing ? ' [pierces DEF]' : '')
        + (b.known ? '' : ' [est dmg]')
        + (b.applies.length > 0 ? ` [applies ${b.applies.join('+')}]` : '');
      return `  +${b.tHitMs}ms  ${b.from} — ${b.dmg} dmg${flags}`;
    });
    if (incoming.length > shown.length) {
      const rest = incoming.slice(shown.length);
      const restDmg = rest.reduce((sum, b) => sum + b.dmg, 0);
      lines.push(`  ...+${rest.length} more — ${restDmg} dmg`);
    }

    const hpNow    = Math.round(clientHp(state));
    const after    = Math.round(hpAfter);
    const wouldDie = hpAfter <= 0;

    return `Incoming (${incoming.length} source${incoming.length === 1 ? '' : 's'}):\n`
      + `${lines.join('\n')}\n`
      + `Total ${total} dmg vs ${hpNow} HP → `
      + (wouldDie ? `DEATH (${after})` : `~${after}/${state.maxHp} HP`);
  }

  function describeConditions(pd: ClientConnection['playerData']): string {
    const names: string[] = [];
    if (pd.hasConditionEffect('ArmorBroken')) names.push('Armor Broken');
    if (pd.hasConditionEffect('Armored'))     names.push('Armored');
    if (pd.hasConditionEffect('Exposed'))     names.push('Exposed');
    if (pd.hasConditionEffect('Curse'))       names.push('Curse');
    if (pd.hasConditionEffect('Petrified'))   names.push('Petrified');
    if (pd.hasConditionEffect('Sick'))        names.push('Sick');
    if (pd.hasConditionEffect('Bleeding'))    names.push('Bleeding');
    if (pd.hasConditionEffect('Invulnerable') || pd.hasConditionEffect('Invincible')) {
      names.push('Invulnerable(ignored)');
    }
    return names.join(', ');
  }

  function evaluateThreats(): void {
    if (!ctx.enabled) return;
    const client = activeClient;
    if (!client) return;
    if (!enableAutoNexus || !enableAutoNexusOnly) return;

    const state = getState(client);
    if (state.nexusSent || state.inSafeZone || state.maxHp <= 0) return;

    const threats = getDllThreats();
    const ground = getDllGround();
    
    const groundDmgRaw =
      includeGroundTicks && ground && ground.rawDamage > 0 ? ground.rawDamage : 0;
    if (threats.length === 0 && groundDmgRaw === 0) return;

    const pd = client.playerData;
    const int47 = damageRedIntThousand(pd);
    const cond: PredictedConditions = {
      armorBroken: pd.hasConditionEffect('ArmorBroken'),
      armored:     pd.hasConditionEffect('Armored'),
      exposed:     pd.hasConditionEffect('Exposed'),
      petrified:   pd.hasConditionEffect('Petrified'),
      cursed:      pd.hasConditionEffect('Curse'),
    };

    const tracker = ctx.getProjectileTracker(client);
    
    const listAgeMs = Math.max(0, getDllThreatsAgeMs() ?? 0);
    const sinceScan = (tHitMs: number): number => Math.max(0, tHitMs - listAgeMs);
    
    type Event =
      | { kind: 'bullet'; tHitMs: number; threat: DllThreat }
      | { kind: 'ground'; tHitMs: number; rawDamage: number };
    const ordered: Event[] = threats.map(
      (threat): Event => ({ kind: 'bullet', tHitMs: sinceScan(threat.tHitMs), threat }),
    );
    if (groundDmgRaw > 0 && ground) {
      
      const ticks = ground.events.length > 0
        ? ground.events
        : [{ rawDamage: groundDmgRaw, tHitMs: ground.tHitMs }];
      for (const tick of ticks) {
        if (tick.rawDamage <= 0) 
          continue;
        
        ordered.push({
          kind: 'ground',
          tHitMs: sinceScan(tick.tHitMs),
          rawDamage: tick.rawDamage,
        });
      }
    }
    ordered.sort((a, b) => a.tHitMs - b.tHitMs);

    let hp = clientHp(state);
    let resolved = 0;
    let bulletCount = 0;
    
    const incoming: IncomingHit[] = [];
    for (let i = 0; i < ordered.length; i++) {
      const ev = ordered[i];
      if (ev.tHitMs > predictedNexusTimeMs) break;

      if (ev.kind === 'ground') {
        const applied = Math.floor(ev.rawDamage * (int47 / 1000));
        hp -= applied;
        incoming.push({
          from: 'damaging ground', dmg: Math.round(applied), tHitMs: Math.round(ev.tHitMs),
          piercing: true,
          known: true,
          applies: [],
        });
        if (hp / state.maxHp * 100 <= predictedNexusPct) {
          doNexus(client, state,
            `predicted: standing on damaging ground in ${Math.round(ev.tHitMs)}ms `
            + `→ ~${Math.round(hp)}/${state.maxHp} HP`,
            describeIncoming(incoming, state, hp));
          return;
        }
        continue;
      }

      const threat = ev.threat;
      bulletCount++;

      const bullet = tracker?.getBullet(`${threat.attackerObjId}:${threat.bulletId & 0xffff}`);
      const projDef = bullet?.projDef ?? null;
      if (bullet) resolved++;

      const baseDmg  = bullet ? bullet.damage : threat.fallbackDamage;
      const piercing = projDef ? projDef.armorPiercing : threat.fallbackArmorPiercing;

      const applied = calcDamage(
        baseDmg, state.defense, piercing,
        cond.armorBroken, cond.armored, cond.exposed,
        false,
        cond.petrified, cond.cursed, int47,
      );
      hp -= applied;

      const mitigationEffects: string[] = [];
      for (const ce of projDef?.conditionEffects ?? []) {
        switch (normalizeEffect(ce.effect)) {
          case 'armorbroken': mitigationEffects.push('Armor Broken'); break;
          case 'armored':     mitigationEffects.push('Armored');      break;
          case 'exposed':     mitigationEffects.push('Exposed');      break;
          case 'petrified':   mitigationEffects.push('Petrified');    break;
          case 'curse':       mitigationEffects.push('Curse');        break;
          default: break;
        }
      }

      incoming.push({
        from: attackerName(client, threat.attackerObjId),
        dmg: Math.round(applied),
        tHitMs: Math.round(ev.tHitMs),
        piercing: !!piercing,
        known: !!bullet,
        applies: mitigationEffects,
      });

      if (hp / state.maxHp * 100 <= predictedNexusPct) {
        doNexus(client, state,
          `predicted: ${bulletCount} bullet(s) in ${Math.round(ev.tHitMs)}ms `
          + `→ ~${Math.round(hp)}/${state.maxHp} HP (${resolved}/${bulletCount} resolved)`,
          describeIncoming(incoming, state, hp));
        return;
      }

      for (const effect of mitigationEffects) {
        switch (effect) {
          case 'Armor Broken': cond.armorBroken = true; break;
          case 'Armored':      cond.armored     = true; break;
          case 'Exposed':      cond.exposed     = true; break;
          case 'Petrified':    cond.petrified   = true; break;
          case 'Curse':        cond.cursed      = true; break;
          default: break;
        }
      }
    }
  }

  const threatTimer = setInterval(() => {
    try { evaluateThreats(); } catch (err) { ctx.log(`threat eval failed: ${(err as Error).message}`); }
  }, 20);
  ctx.registerCleanup(() => clearInterval(threatTimer));

  ctx.hookCommand('an', (client, _cmd, args) => {
    const state = getState(client);
    if (args.length === 0) {
      ctx.sendNotification(client, 'AutoNexus', `Nexus ${describeThresholds(state)}`);
      return;
    }
    const val = parseInt(args[0], 10);
    if (isNaN(val) || val < 0 || val > 100) {
      ctx.sendNotification(client, 'AutoNexus', 'Usage: /an [0-100]');
      return;
    }
    nexusThresholdPct = val;
    ctx.updateSetting('ForceAutoNexusHealth', nexusThresholdPct);
    ctx.sendNotification(client, 'AutoNexus',
      `Nexus ${describeThresholds(state)}`);
    ctx.log(`/an: threshold → ${nexusThresholdPct}%`);
  });

  ctx.hookCommand('reset', (client, _cmd, _args) => {
    const state = getState(client);
    if (!client.playerData || state.maxHp <= 0) return;
    const oldHp = Math.round(clientHp(state));
    resyncPrediction(state);
    ctx.sendNotification(client, 'AutoNexus',
      `Reset client HP ${oldHp} → ${state.serverHp}\n${describeLedger(state)}`);
    ctx.log(`/reset: clientHp ${oldHp} → ${state.serverHp} (ledger cleared)`);
  });

  ctx.hookCommand('nexus', (client, _cmd, _args) => {
    const state = getState(client);
    doNexus(client, state, '/nexus command');
  });

  ctx.log(
    `Loaded — force: ${nexusThresholdPct}%, predicted: ${predictedNexusPct}% within `
    + `${predictedNexusTimeMs}ms, ground ticks: ${includeGroundTicks}`,
  );
}
