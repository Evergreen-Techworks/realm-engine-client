import type { PluginContext, ClientConnection } from './api.js';

// Class-autodetected auto ability. Fires a USEITEM for the ability slot (the
// same proven mechanism auto-drink uses for potions). Point-aimed classes fire
// at the nearest enemy; everyone else self-casts nonstop above the MP floor.
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
const TARGET_MAX_STALE_MS = 500;

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

  let mpFloorPct = 85;
  let safeZonePause = true;
  let abilityRange = 12;
  let minTargetMaxHp = 1000;
  let skipScenery = true;
  let selfIntervalMs = DEFAULT_SELF_INTERVAL_MS;
  let targetIntervalMs = DEFAULT_TARGET_INTERVAL_MS;

  const safeZone = new WeakMap<ClientConnection, boolean>();
  const nextAllowedAt = new WeakMap<ClientConnection, number>();
  let selfFiring = false;

  ctx.registerSetting('mpFloorPct', {
    label: 'Min MP % (0 = nonstop)',
    type: 'range', value: 85, min: 0, max: 100, step: 5,
  }, (v: number) => { mpFloorPct = Math.max(0, Math.min(100, Math.trunc(Number(v) || 0))); });

  ctx.registerSetting('safeZonePause', {
    label: 'Pause in safe zones',
    type: 'boolean', value: true,
  }, (v: boolean) => { safeZonePause = v === true; });

  ctx.registerSetting('abilityRange', {
    label: 'Aimed range (tiles)',
    type: 'range', value: 12, min: 3, max: 30, step: 1,
  }, (v: number) => { abilityRange = Math.max(3, Math.min(30, Math.trunc(Number(v) || 12))); });

  ctx.registerSetting('minTargetMaxHp', {
    label: 'Min target max HP',
    type: 'number', value: 1000, min: 0, max: 200000, step: 250,
  }, (v: number) => { minTargetMaxHp = Math.max(0, Math.trunc(Number(v) || 0)); });

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

  function isMovementAbility(itemType: number): boolean {
    if (itemType <= 0) return false;
    const xml = ctx.gameData?.getRawObjectXml(itemType);
    return xml !== undefined && MOVEMENT_ACTIVATE_RE.test(xml);
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
    if (safeZonePause && (safeZone.get(client) ?? true)) return;

    const pd = client.playerData;
    const cls = pd.classType;
    const isTarget = TARGET_CLASSES.has(cls);
    const isSelf = SELF_CLASSES.has(cls);
    if (!isTarget && !isSelf) return;

    const itemType = pd.inventory?.[ABILITY_SLOT] ?? -1;
    if (itemType <= 0 || isMovementAbility(itemType)) return;
    // maxMana is the gearless base (StatType.MaxMP); add the gear bonus for the
    // true max, as auto-drink does. Using the bare base makes the ratio exceed
    // 100% on any MP gear, so the floor never held and this fired every interval
    // at 0 MP, which the server closes the connection over.
    const trueMaxMana = pd.maxMana + pd.manaBonus;
    if (trueMaxMana <= 0 || (pd.mana / trueMaxMana) * 100 < mpFloorPct) return;

    const now = Date.now();
    if (now < (nextAllowedAt.get(client) ?? 0)) return;

    // pos {0,0} before first update looks like cheating to the server.
    if (pd.pos.x === 0 && pd.pos.y === 0) return;

    const ws = ctx.getWorldState(client);
    const gd = ctx.gameData;
    if (!ws || !gd) return;

    if (isSelf) {
      // A self-buff burns the same MP whether anything worth buffing for is
      // nearby or not, so hold it behind the same target test the aimed classes
      // use rather than casting into an empty room.
      const nearby = ws.getNearestEnemy(gd, pd.pos, {
        maxDistance: abilityRange,
        maxStaleMs: TARGET_MAX_STALE_MS,
        maxHpMin: minTargetMaxHp > 0 ? minTargetMaxHp : undefined,
        excludeScenery: skipScenery,
      });
      if (!nearby) return;
      sendUseAbility(client, pd.pos, itemType);
      nextAllowedAt.set(client, now + selfIntervalMs);
    } else {
      // Without a floor on the target's max HP this fires at every rat in the
      // realm and the MP is gone before anything worth spending it on shows up.
      // The floor is on MAX HP, not current, so a boss already worn down still
      // qualifies.
      const enemy = ws.getNearestEnemy(gd, pd.pos, {
        maxDistance: abilityRange,
        maxStaleMs: TARGET_MAX_STALE_MS,
        maxHpMin: minTargetMaxHp > 0 ? minTargetMaxHp : undefined,
        excludeScenery: skipScenery,
      });
      if (!enemy) return;
      sendUseAbility(client, { x: enemy.x, y: enemy.y }, itemType);
      nextAllowedAt.set(client, now + targetIntervalMs);
    }
  });

  // The DLL-side auto-ability path is superseded by this packet approach.
  ctx.on('clientDisconnected', (client) => {
    safeZone.delete(client);
    nextAllowedAt.delete(client);
  });
}
