import type { PluginContext, ClientConnection } from './api.js';
import { sendDllFeature } from './api.js';

// Class-autodetected auto ability. Fires a USEITEM for the ability slot (the
// same proven mechanism auto-drink uses for potions). Point-aimed classes fire
// at the nearest enemy; everyone else self-casts nonstop above the MP floor.
const ABILITY_SLOT = 1;
// Self-buffs last a few seconds and have a usage cooldown; re-casting every
// tick spams past that cooldown and eventually crashes the game. Fixed
// intervals avoid it without per-item cooldown bookkeeping.
const SELF_INTERVAL_MS = 2500;
const TARGET_INTERVAL_MS = 1000;
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
    if (pd.maxMana <= 0 || (pd.mana / pd.maxMana) * 100 < mpFloorPct) return;

    const now = Date.now();
    if (now < (nextAllowedAt.get(client) ?? 0)) return;

    // pos {0,0} before first update looks like cheating to the server.
    if (pd.pos.x === 0 && pd.pos.y === 0) return;

    if (isSelf) {
      sendUseAbility(client, pd.pos, itemType);
      nextAllowedAt.set(client, now + SELF_INTERVAL_MS);
    } else {
      const ws = ctx.getWorldState(client);
      const gd = ctx.gameData;
      if (!ws || !gd) return;
      const enemy = ws.getNearestEnemy(gd, pd.pos, {
        maxDistance: abilityRange,
        maxStaleMs: TARGET_MAX_STALE_MS,
      });
      if (!enemy) return;
      sendUseAbility(client, { x: enemy.x, y: enemy.y }, itemType);
      nextAllowedAt.set(client, now + TARGET_INTERVAL_MS);
    }
  });

  // The DLL-side auto-ability path is superseded by this packet approach.
  ctx.on('clientDisconnected', (client) => {
    safeZone.delete(client);
    nextAllowedAt.delete(client);
  });
}
