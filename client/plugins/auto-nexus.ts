import type { PluginContext } from './api.js';
import type { ClientConnection } from './api.js';
import type { Packet } from './api.js';

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

interface TrackedBullet {
  ownerId:    number;
  bulletType: number;
  damage:     number;
  ts:         number;
}

interface TrackedAoe {
  damage:      number;
  armorPierce: boolean;
  pos:         { x: number; y: number };
  radius:      number;
}

interface NexusState {
  clientHp:     number;
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
  bullets:      Map<string, TrackedBullet>;
  pendingAoes:  TrackedAoe[];
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

  let enableAutoNexus      = true;  // EnableAutoNexus
  let enableAutoNexusOnly  = true;  // EnableAutoNexusOnly (Settings default true)
  let nexusThresholdPct    = 25;   // AutoNexusPercentageThreshold
  let useClientHp          = true; // AutoNexusUseClientHp
  let syncServerHp         = true; // AutoNexusSyncHp
  let showNotification     = true; // AutoNexusShowInformation
  /** When false: incoming `AOE` packets are ignored for simulated HP / nexus threshold (MOVE sweep skipped). */
  let trackAoeDamage       = true;

  ctx.registerSetting('threshold', {
    label: 'Nexus HP %', type: 'range', value: nexusThresholdPct, min: 1, max: 95, step: 1,
  }, (v: number) => { nexusThresholdPct = v; });

  ctx.registerSetting('autoNexusOnly', {
    label: 'EnableAutoNexusOnly (MultiTool gate)', advanced: true, type: 'boolean', value: enableAutoNexusOnly,
  }, (v: boolean) => { enableAutoNexusOnly = v; });

  ctx.registerSetting('useClientHp', {
    label: 'Use client HP (simulated)', advanced: true, type: 'boolean', value: useClientHp,
  }, (v: boolean) => { useClientHp = v; });

  ctx.registerSetting('syncHp', {
    label: 'Sync HP to server (>30 drift)', advanced: true, type: 'boolean', value: syncServerHp,
  }, (v: boolean) => { syncServerHp = v; });

  ctx.registerSetting('showNotif', {
    label: 'Show chat message on nexus', advanced: true, type: 'boolean', value: showNotification,
  }, (v: boolean) => { showNotification = v; });

  ctx.registerSetting('trackAoeDamage', {
    label: 'Include AoE in nexus HP sim', advanced: true,
    type: 'boolean',
    value: trackAoeDamage,
  }, (v: boolean) => { trackAoeDamage = v === true; });

  let closeSpawnTiles = 0.15;
  ctx.registerSetting('closeSpawn', {
    label: 'Close-spawn radius (tiles)', advanced: true, type: 'range', value: closeSpawnTiles, min: 0, max: 0.3, step: 0.05,
  }, (v: number) => { closeSpawnTiles = v; });

  // Autopot (HP + MP) lives in the auto-drink plugin. The dashboard warns there
  // if this nexus threshold is set at/above auto-drink's HP threshold.

  const states = new WeakMap<ClientConnection, NexusState>();

  function getState(client: ClientConnection): NexusState {
    let s = states.get(client);
    if (!s) {
      s = {
        clientHp: 0, serverHp: 0, maxHp: 0,
        defense: 0, vitality: 0,
        regenAccum: 0,
        pendingHeal: 0,
        nexusSent: false, inSafeZone: false,
        lastTickTime: Date.now(), lastSyncTick: 0,
        bullets: new Map(), pendingAoes: [],
      };
      states.set(client, s);
    }
    return s;
  }

  /** Run at the start of every hot path: track active client; if nexus already sent, short-circuit. */
  function nexusPrologue(_client: ClientConnection, state: NexusState): boolean {
    if (state.nexusSent) return true;
    return false;
  }

  // method_31
  function shouldNexus(state: NexusState): boolean {
    if (!enableAutoNexus || !enableAutoNexusOnly) return false;
    if (state.inSafeZone)     return false;
    if (state.maxHp <= 0)     return false;
    const threshold = nexusThresholdPct * 0.01 * state.maxHp;

    if (useClientHp) {
      return state.clientHp <= threshold;
    }
    return state.serverHp <= threshold;
  }

  // method_0
  function doNexus(client: ClientConnection, state: NexusState, reason: string): void {
    if (state.nexusSent) return;
    state.nexusSent = true;

    const hpPct = state.maxHp > 0 ? Math.round((state.clientHp / state.maxHp) * 100) : 0;
    ctx.log(`AUTO NEXUS — HP: ${Math.round(state.clientHp)}/${state.maxHp} (${hpPct}%) — ${reason}`);

    if (showNotification) {
        ctx.sendNotification(client, 'AutoNexus',
        `AutoNexused at ${hpPct}% HP\nHP: ${Math.round(state.clientHp)}/${state.maxHp} | DEF: ${state.defense} | ServerHP: ${state.serverHp}\nSource: ${reason}`);
    }

    const escape = ctx.createPacket('ESCAPE');
    escape.modified = true;
    client.sendToServer(escape);
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
  ): void {
    state.clientHp -= dmg;
    state.serverHp -= dmg;

    if (shouldNexus(state)) {
      if (packet) packet.send = false;
      doNexus(client, state, reason);
    }
  }

  function getThresholdHp(state: NexusState): number {
    return nexusThresholdPct * 0.01 * state.maxHp;
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
    if (inCombat) state.regenAccum /= 2 * num;

    const num4 = Math.trunc(state.regenAccum);
    state.regenAccum -= num4;
    state.clientHp += num4;
    if (state.clientHp > state.maxHp) state.clientHp = state.maxHp;
  }

  ctx.hookPacket('MAPINFO', (client, packet) => {
    const mapName = (packet.data.name ?? packet.data.displayName ?? '') as string;
    const state   = getState(client);
    state.inSafeZone = SAFE_ZONE_MAPS.has(mapName);
    state.nexusSent  = false;
    state.clientHp   = 0;
    state.serverHp   = 0;
    state.pendingHeal = 0;
    state.regenAccum  = 0;
    state.bullets.clear();
    state.pendingAoes   = [];
    ctx.log(`Map: "${mapName}" — safe zone: ${state.inSafeZone}`);
  }, { prepend: true });

  ctx.hookPacket('CREATESUCCESS', (client) => {
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

    const serverHp = pd.health > 0 ? pd.health : state.maxHp;

    if (state.clientHp <= 0) {
      state.clientHp   = serverHp;
      state.serverHp   = serverHp;
      state.pendingHeal = 0;
    } else {
      const drift = Math.abs(state.clientHp - serverHp);
      if (syncServerHp && drift > 30 && state.lastSyncTick > 5) {
        // ctx.log(`HP sync: client ${Math.round(state.clientHp)} → server ${serverHp} (drift ${drift})`);
        state.clientHp = serverHp;
      }
      state.serverHp = serverHp;
    }

    // Class89.method_7: `int_9` heal queue (method_33) after stats, before method_30
    if (state.pendingHeal !== 0) {
      state.clientHp += state.pendingHeal;
      if (state.clientHp > state.maxHp) state.clientHp = state.maxHp;
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
          applyDamage(client, state, dmg, `AoE dmg=${dmg} (on MOVE, pre-AOEACK)`, packet);
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

  ctx.hookPacket('ENEMYSHOOT', (client, packet) => {
    if (!packet.isDefined) return;
    const state = getState(client);
    if (nexusPrologue(client, state)) return;
    if (state.nexusSent) return;

    const ownerId    = packet.data.ownerId     as number;
    const bulletType = (packet.data.bulletType as number) ?? 0;
    const damage     = packet.data.damage      as number;
    const numShots   = (packet.data.numShots   as number) ?? 1;
    const actual     = (numShots === 255 || numShots === 0) ? 1 : numShots;
    const ts         = Date.now();

    // Extension: point-blank spawn nexus before bullet dict (minimum latency)
    if (
      closeSpawnTiles > 0 && state.maxHp > 0 && !state.inSafeZone &&
      enableAutoNexus && enableAutoNexusOnly
    ) {
      const spawnPos  = (packet.data.startingPos ?? packet.data.position) as { x: number; y: number } | undefined;
      const playerPos = client.playerData?.pos;
      if (spawnPos && playerPos) {
        const dx   = spawnPos.x - playerPos.x;
        const dy   = spawnPos.y - playerPos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= closeSpawnTiles) {
          let piercing = false;
          if (ctx.gameData && ctx.worldState) {
            const entityType = ctx.worldState.getEntityType(ownerId);
            if (entityType !== undefined) {
              const proj = ctx.gameData.getProjectile(entityType, bulletType);
              if (proj) piercing = proj.armorPiercing;
            }
          }
          const perBullet = getDmgFromState(client, state, damage, piercing);
          const totalDmg  = perBullet * actual;
          if ((state.clientHp - totalDmg) / state.maxHp * 100 <= nexusThresholdPct) {
            const enemyName = ctx.worldState
              ? (ctx.gameData?.getObject(ctx.worldState.getEntityType(ownerId) ?? 0)?.id ?? `#${ownerId}`)
              : `#${ownerId}`;
            doNexus(client, state,
              `close-spawn: ${actual} shot(s) from ${enemyName} (${dist.toFixed(2)} tiles, ~${Math.round(totalDmg)} dmg)`);
            return;
          }
        }
      }
    }

    const bulletId = packet.data.bulletId as number;
    for (let i = 0; i < actual; i++) {
      state.bullets.set(`${ownerId}:${bulletId + i}`, { ownerId, bulletType, damage, ts });
    }
    for (const [k, b] of state.bullets) {
      if (ts - b.ts > 12000) state.bullets.delete(k);
    }
  }, { prepend: true });

  ctx.hookPacket('PLAYERHIT', (client, packet) => {
    if (!packet.isDefined) return;
    const state = getState(client);
    if (nexusPrologue(client, state)) { packet.send = false; return; }
    if (state.nexusSent) { packet.send = false; return; }
    if (state.maxHp <= 0) return;

    const bulletId = packet.data.bulletId as number;
    const objectId = packet.data.objectId as number;
    const key      = `${objectId}:${bulletId}`;
    const bullet   = state.bullets.get(key);

    let baseDmg  = bullet ? bullet.damage : 200;
    let piercing = !bullet;

    if (bullet && ctx.gameData && ctx.worldState) {
      const entityType = ctx.worldState.getEntityType(objectId);
      if (entityType !== undefined) {
        const proj = ctx.gameData.getProjectile(entityType, bullet.bulletType);
        if (proj) piercing = proj.armorPiercing;
      }
      state.bullets.delete(key);
    }

    const dmg = getDmgFromState(client, state, baseDmg, piercing);
    applyDamage(client, state, dmg, `projectile hit (${dmg} dmg)`, packet);
  }, { prepend: true });

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
          applyDamage(client, state, dmg, `AoE dmg=${dmg} (on MOVE, pre-AOEACK)`, packet);
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
      ctx.log(`Server confirmed ${serverDmg} dmg (client HP ~${Math.round(state.clientHp)}/${state.maxHp})`);
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

  ctx.hookCommand('an', (client, _cmd, args) => {
    const state = getState(client);
    if (args.length === 0) {
      const threshHp = Math.round(getThresholdHp(state));
      ctx.sendNotification(client, 'AutoNexus', `Nexus threshold: ${nexusThresholdPct}% (${threshHp} HP)`);
      return;
    }
    const val = parseInt(args[0], 10);
    if (isNaN(val) || val < 1 || val > 100) {
      ctx.sendNotification(client, 'AutoNexus', 'Usage: /an [1-100]');
      return;
    }
    nexusThresholdPct = Math.max(1, Math.min(100, val));
    ctx.updateSetting('threshold', nexusThresholdPct);
    const threshHp = Math.round(getThresholdHp(state));
    ctx.sendNotification(client, 'AutoNexus',
      `Nexus threshold set to ${nexusThresholdPct}% (${threshHp} HP)`);
    ctx.log(`/an: threshold → ${nexusThresholdPct}%`);
  });

  ctx.hookCommand('reset', (client, _cmd, _args) => {
    const state = getState(client);
    if (!client.playerData || state.maxHp <= 0) return;
    const oldHp = Math.round(state.clientHp);
    state.clientHp = state.serverHp;
    ctx.sendNotification(client, 'AutoNexus', `Reset client HP ${oldHp} → ${state.serverHp}`);
    ctx.log(`/reset: clientHp ${oldHp} → ${state.serverHp}`);
  });

  ctx.hookCommand('nexus', (client, _cmd, _args) => {
    const state = getState(client);
    doNexus(client, state, '/nexus command');
  });

  ctx.log(
    `Loaded — threshold: ${nexusThresholdPct}%, MultiTool gate: ${enableAutoNexusOnly}`,
  );
}
