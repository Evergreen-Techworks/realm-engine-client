import type { PluginContext, ClientConnection } from './api.js';
import { automaticAbilityPaused } from './api.js';

// Class-autodetected auto ability. Fires a USEITEM for the ability slot (the
// same proven mechanism auto-drink uses for potions). Point-aimed classes fire
// at the nearest enemy; self/area classes use the same MP reserve gate.
const ABILITY_SLOT = 1;
// Self-buffs last a few seconds and have a usage cooldown; re-casting every
// tick spams past that cooldown and eventually crashes the game. Fixed
// intervals avoid it without per-item cooldown bookkeeping.
// Defaults for the configurable fire intervals. These are the minimum gap
// between casts, not the item's real cooldown; there is no per-item cooldown
// bookkeeping, so setting them too low spams the server.
const DEFAULT_SELF_INTERVAL_MS = 2500;
const DEFAULT_TARGET_INTERVAL_MS = 1000;
const MIN_INTERVAL_MS = 250;
const MAX_INTERVAL_MS = 10000;
const MANUAL_PAUSE_MS = 3000;
// Drop targets that haven't updated recently so we don't fire at a ghost
// (a despawned/out-of-view enemy that auto-aim already ignores).
const DEFAULT_TARGET_MAX_STALE_MS = 3000;

// Aimed abilities → fire at nearest enemy.
const TARGET_CLASSES = new Set<number>([
  775, 782, 785, 798, 800, 801, 802, 803, 805, 806, 817,
]);
// Self/area buffs → fire nonstop at own position. Rogue (768) is excluded:
// its cloak is a utility stealth, not something to auto-cast.
const SELF_CLASSES = new Set<number>([784, 796, 797, 799]);
// Trickster/Kensei omitted entirely: their abilities move the player.

const SAFE_ZONE_SUBSTRINGS = ['nexus', 'vault', 'guild hall', 'cloth bazaar', 'daily quest', 'daily login', 'pet yard', 'grand bazaar'];

// Block any ability item that moves the player (prisms, sheaths, Planewalker).
const MOVEMENT_ACTIVATE_RE =
  /<Activate\b[^>]*>\s*(?:Teleport|TeleportToObject|MarkAndTeleport|Dash|ChannelDash)\s*<\/Activate>/;

export function register(ctx: PluginContext) {
  ctx.name = 'Auto Ability';
  ctx.category = 'combat';

  let mpReservePct = 25;
  let targetMaxStaleMs = DEFAULT_TARGET_MAX_STALE_MS;
  let selfNeedsTarget = true;
  let diagnostics = false;
  let safeZonePause = true;
  let abilityRange = 12;
  let targetMinMaxHp = 0;
  let skipScenery = true;
  let selfIntervalMs = DEFAULT_SELF_INTERVAL_MS;
  let targetIntervalMs = DEFAULT_TARGET_INTERVAL_MS;

  const safeZone = new WeakMap<ClientConnection, boolean>();
  const nextAllowedAt = new WeakMap<ClientConnection, number>();
  let selfFiring = false;

  // New key intentionally does not inherit the old 85% floor from saved profiles.
  ctx.registerSetting('mpReservePct', {
    label: 'MP reserve after cast (%)',
    type: 'range', value: 25, min: 0, max: 100, step: 5,
  }, (v: number) => { mpReservePct = Math.max(0, Math.min(100, Math.trunc(Number(v) || 0))); });

  ctx.registerSetting('targetMaxStaleMs', {
    label: 'Target max age (ms; 0 = ignore)', type: 'number',
    value: DEFAULT_TARGET_MAX_STALE_MS, min: 0, max: 30000, step: 100,
  }, (v: number) => { targetMaxStaleMs = Math.max(0, Math.min(30000, Math.trunc(Number(v) || 0))); });

  ctx.registerSetting('selfNeedsTarget', {
    label: 'Self-cast requires nearby enemy', type: 'boolean', value: true,
  }, (v: boolean) => { selfNeedsTarget = v === true; });

  ctx.registerSetting('diagnostics', {
    label: 'Log cast / skip reasons', type: 'boolean', value: false,
  }, (v: boolean) => { diagnostics = v === true; });

  ctx.registerSetting('safeZonePause', {
    label: 'Pause in safe zones',
    type: 'boolean', value: true,
  }, (v: boolean) => { safeZonePause = v === true; });

  ctx.registerSetting('abilityRange', {
    label: 'Aimed range (tiles)',
    type: 'range', value: 12, min: 3, max: 30, step: 1,
  }, (v: number) => { abilityRange = Math.max(3, Math.min(30, Math.trunc(Number(v) || 12))); });

  ctx.registerSetting('targetMinMaxHp', {
    label: 'Min target max HP (0 = any enemy)',
    type: 'number', value: 0, min: 0, max: 200000, step: 250,
  }, (v: number) => { targetMinMaxHp = Math.max(0, Math.trunc(Number(v) || 0)); });

  ctx.registerSetting('skipScenery', {
    label: 'Skip walls / breakables',
    type: 'boolean', value: true,
  }, (v: boolean) => { skipScenery = v === true; });

  const clampInterval = (v: number, fallback: number) =>
    Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.trunc(Number(v) || fallback)));

  ctx.registerSetting('targetIntervalMs', {
    label: 'Aimed cooldown (ms)',
    type: 'number', value: DEFAULT_TARGET_INTERVAL_MS,
    min: MIN_INTERVAL_MS, max: MAX_INTERVAL_MS, step: 50,
  }, (v: number) => { targetIntervalMs = clampInterval(v, DEFAULT_TARGET_INTERVAL_MS); });

  ctx.registerSetting('selfIntervalMs', {
    label: 'Self-cast cooldown (ms)',
    type: 'number', value: DEFAULT_SELF_INTERVAL_MS,
    min: MIN_INTERVAL_MS, max: MAX_INTERVAL_MS, step: 50,
  }, (v: number) => { selfIntervalMs = clampInterval(v, DEFAULT_SELF_INTERVAL_MS); });

  const lastDiagnosticAt = new WeakMap<ClientConnection, number>();
  function diagnosticsDue(client: ClientConnection): boolean {
    return diagnostics && Date.now() - (lastDiagnosticAt.get(client) ?? -Infinity) >= 3000;
  }
  function diagnose(client: ClientConnection, reason: string): void {
    if (!diagnosticsDue(client)) return;
    const now = Date.now();
    lastDiagnosticAt.set(client, now);
    ctx.log(`Auto Ability: ${reason}`);
  }
  const abilityMetadata = new Map<number, { xml: string | undefined; movement: boolean; cost: number | null; invalidCost: boolean }>();
  function metadata(itemType: number) {
    const xml = ctx.gameData?.getRawObjectXml(itemType);
    const cached = abilityMetadata.get(itemType);
    if (cached && cached.xml === xml) return cached;
    const rawCost = xml?.match(/<MpCost\b[^>]*>\s*([^<]*)\s*<\/MpCost>/i)?.[1];
    const cost = rawCost === undefined ? null : Number(rawCost.trim());
    const result = { xml, movement: xml !== undefined && MOVEMENT_ACTIVATE_RE.test(xml), cost,
      invalidCost: cost !== null && (!rawCost?.trim() || !Number.isFinite(cost) || cost < 0) };
    // Missing XML can become available after startup; do not cache that absence.
    if (xml !== undefined) abilityMetadata.set(itemType, result);
    return result;
  }

  function sendUseAbility(client: ClientConnection, usePos: { x: number; y: number }, itemType: number): void {
    const pkt = ctx.createPacket('USEITEM');
    pkt.data = {
      time: Math.trunc(client.time ?? 0),
      slotObject: { objectId: client.objectId, slotId: ABILITY_SLOT, objectType: itemType },
      itemUsePos: { x: usePos.x, y: usePos.y },
      useType: 1,
      unknownInt: 0,
    };
    pkt.modified = true;
    selfFiring = true;
    try { client.sendToServer(pkt); } finally { selfFiring = false; }
  }

  ctx.hookPacket('MAPINFO', (client, packet) => {
    const name = String(packet.data.name ?? '').toLowerCase();
    const display = String(packet.data.displayName ?? '').toLowerCase();
    const combined = name + ' ' + display;
    safeZone.set(client, SAFE_ZONE_SUBSTRINGS.some(s => combined.includes(s)));
    nextAllowedAt.delete(client);
  });

  // Manual ability press → back off so we don't fight the player's cooldown.
  ctx.hookPacket('USEITEM', (client, packet) => {
    if (selfFiring) return;
    if (packet.data?.slotObject?.slotId === ABILITY_SLOT) {
      nextAllowedAt.set(client, Date.now() + MANUAL_PAUSE_MS);
    }
  });

  ctx.hookPacket('NEWTICK', (client) => {
    if (!ctx.enabled || !client?.connected || !client.objectId) return;
    if (automaticAbilityPaused(client)) return;
    const pd = client.playerData;
    const knownMap = String(pd.mapName ?? '').toLowerCase();
    const inSafeZone = safeZone.get(client)
      ?? (!knownMap || SAFE_ZONE_SUBSTRINGS.some(s => knownMap.includes(s)));
    if (safeZonePause && inSafeZone) { diagnose(client, 'paused in safe/unknown map'); return; }
    const isTarget = TARGET_CLASSES.has(pd.classType);
    const isSelf = SELF_CLASSES.has(pd.classType);
    if (!isTarget && !isSelf) { diagnose(client, `unsupported class ${pd.classType}`); return; }

    const itemType = pd.inventory?.[ABILITY_SLOT] ?? -1;
    if (itemType <= 0) { diagnose(client, 'no equipped ability'); return; }
    const ability = metadata(itemType);
    if (ability.movement) { diagnose(client, 'movement ability excluded'); return; }
    if (ability.invalidCost) { diagnose(client, 'invalid ability MP cost in XML'); return; }
    const maxMana = pd.effectiveMaxMana;
    const mana = pd.mana;
    if (!Number.isFinite(maxMana) || maxMana <= 0 || !Number.isFinite(mana) || mana < 0) {
      diagnose(client, 'MP stats unavailable'); return;
    }
    if (ability.cost !== null && mana < ability.cost) {
      diagnose(client, `MP below ability cost (${mana}/${ability.cost})`); return;
    }
    const reserve = maxMana * mpReservePct / 100;
    if (mana - (ability.cost ?? 0) < reserve) {
      diagnose(client, `MP under reserve after cast (${mana}/${maxMana} MP; cost ${ability.cost ?? 'unknown'}; reserve ${mpReservePct}%)`);
      return;
    }
    const now = Date.now();
    if (now < (nextAllowedAt.get(client) ?? 0)) { diagnose(client, 'cooldown/manual-use pause'); return; }
    if (!Number.isFinite(pd.pos?.x) || !Number.isFinite(pd.pos?.y) || (pd.pos.x === 0 && pd.pos.y === 0)) {
      diagnose(client, 'player position unavailable'); return;
    }

    let usePos = pd.pos;
    if (isTarget || selfNeedsTarget) {
      const ws = ctx.getWorldState(client);
      const gd = ctx.gameData;
      if (!ws || !gd) { diagnose(client, 'world/game data unavailable'); return; }
      const filter = {
        maxDistance: abilityRange,
        maxStaleMs: targetMaxStaleMs > 0 ? targetMaxStaleMs : undefined,
        maxHpMin: targetMinMaxHp > 0 ? targetMinMaxHp : undefined,
        excludeScenery: skipScenery,
        hpMin: 1,
      };
      const enemy = ws.getNearestEnemy(gd, pd.pos, filter);
      if (!enemy) {
        // Do the explanatory queries only when a log can actually be emitted.
        if (diagnosticsDue(client)) {
          let reason = `no living enemy within ${abilityRange} tiles`;
          if (targetMaxStaleMs > 0 && ws.getNearestEnemy(gd, pd.pos, { ...filter, maxStaleMs: undefined })) {
            reason = `target is stale (limit ${targetMaxStaleMs} ms)`;
          } else if (targetMinMaxHp > 0 && ws.getNearestEnemy(gd, pd.pos, { ...filter, maxHpMin: undefined })) {
            reason = `target under ${targetMinMaxHp} max-HP floor`;
          } else if (skipScenery && ws.getNearestEnemy(gd, pd.pos, { ...filter, excludeScenery: false })) {
            reason = 'targets rejected as scenery';
          }
          diagnose(client, reason);
        }
        return;
      }
      if (isTarget) usePos = { x: enemy.x, y: enemy.y };
    }
    // Back off even if the transport throws, preventing retries every tick.
    nextAllowedAt.set(client, now + (isSelf ? selfIntervalMs : targetIntervalMs));
    try {
      sendUseAbility(client, usePos, itemType);
      diagnose(client, `cast ${itemType} at (${usePos.x}, ${usePos.y}); MP ${mana}/${maxMana}; cost ${ability.cost ?? 'unknown'}`);
    } catch (err) {
      diagnose(client, `send failed: ${(err as Error).message}`);
    }
  });

  // The DLL-side auto-ability path is superseded by this packet approach.
  ctx.on('clientDisconnected', (client) => {
    safeZone.delete(client);
    nextAllowedAt.delete(client);
    lastDiagnosticAt.delete(client);
  });
}
