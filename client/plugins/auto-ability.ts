import type { PluginContext } from '../src/plugins/PluginContext.js';
import type { ClientConnection } from '../src/proxy/ClientConnection.js';
import { ClassId } from '../src/constants/ClassId.js';

// These classes have risky or position-independent abilities — never auto-activate
const EXCLUDED_CLASSES = new Set<number>([ClassId.Kensei, ClassId.Rogue, ClassId.Trickster]);

// These classes buff themselves — send USEITEM at own position
const SELF_BUFF_CLASSES = new Set<number>([
  ClassId.Priest, ClassId.Warrior, ClassId.Paladin, ClassId.Bard, ClassId.Necromancer,
]);

const SAFE_ZONE_SUBSTRINGS = ['nexus', 'vault', 'guild hall', 'cloth bazaar', 'daily quest', 'daily login', 'pet yard'];

const ABILITY_COOLDOWN_MS = 1500;
const MANUAL_USE_PAUSE_MS = 3000;

const pluginStartedAtMs = Date.now();
function getUseItemTime(): number {
  return Math.floor(Date.now() - pluginStartedAtMs);
}

export function register(ctx: PluginContext) {
  ctx.name = 'Auto Ability';
  ctx.category = 'combat';

  let mpThresholdPct = 100;
  let mode: 'auto' | 'manual' = 'auto';
  let safeZoneEnabled = true;
  let abilityRange = 12;

  // Per-client: safe zone status read directly from raw MAPINFO packet fields,
  // avoiding normalizeMapDisplayName returning '' for locale tokens like {s.rotmg}
  const clientSafeZone = new WeakMap<ClientConnection, boolean>();
  const nextAllowedAt = new WeakMap<ClientConnection, number>();
  let isAutoFiring = false;

  ctx.registerSetting('mode', {
    label: 'Mode',
    type: 'select',
    value: 'auto',
    options: [
      { label: 'Auto detect', value: 'auto' },
      { label: 'Manual', value: 'manual' },
    ],
  }, (v: string) => { mode = v === 'manual' ? 'manual' : 'auto'; });

  ctx.registerSetting('safeZoneEnabled', {
    label: 'Safe zone protection',
    type: 'boolean',
    value: true,
  }, (v: boolean) => { safeZoneEnabled = v === true; });

  ctx.registerSetting('abilityRange', {
    label: 'Max enemy range (tiles)',
    type: 'range',
    value: 12,
    min: 3,
    max: 30,
    step: 1,
  }, (v: number) => {
    abilityRange = Math.max(3, Math.min(30, Math.trunc(Number(v) || 12)));
  });

  ctx.registerSetting('mpThresholdPct', {
    label: 'Min MP % to activate',
    type: 'range',
    value: 100,
    min: 0,
    max: 100,
    step: 5,
  }, (v: number) => {
    mpThresholdPct = Math.max(0, Math.min(100, Math.trunc(Number(v) || 0)));
  });

  function isSafeZone(client: ClientConnection): boolean {
    // true = unknown map (no MAPINFO yet) — don't fire blind
    return clientSafeZone.get(client) ?? true;
  }

  function sendUseAbility(client: ClientConnection, usePos: { x: number; y: number }): void {
    const abilityItemType = client.playerData.inventory[1];
    if (abilityItemType === -1) return;
    const pkt = ctx.createPacket('USEITEM');
    pkt.data = {
      time: getUseItemTime(),
      slotObject: { objectId: client.objectId, slotId: 1, objectType: abilityItemType },
      itemUsePos: { x: usePos.x, y: usePos.y },
      useType: 1,
      unknownInt: 0,
    };
    pkt.modified = true;
    isAutoFiring = true;
    try {
      client.sendToServer(pkt);
    } finally {
      isAutoFiring = false;
    }
  }

  // Read raw name + displayName from MAPINFO — avoids normaliseMapDisplayName
  // turning locale tokens into '' which would fool the safe-zone check
  ctx.hookPacket('MAPINFO', (client, packet) => {
    const name = String(packet.data.name ?? '').toLowerCase();
    const display = String(packet.data.displayName ?? '').toLowerCase();
    const combined = name + ' ' + display;
    clientSafeZone.set(client, SAFE_ZONE_SUBSTRINGS.some(s => combined.includes(s)));
    nextAllowedAt.delete(client);
  });

  // When the player presses Q manually, back off so we don't fight their cooldown
  ctx.hookPacket('USEITEM', (client, packet) => {
    if (isAutoFiring) return;
    if (packet.data?.slotObject?.slotId === 1) {
      nextAllowedAt.set(client, Date.now() + MANUAL_USE_PAUSE_MS);
    }
  });

  ctx.hookPacket('NEWTICK', (client) => {
    if (!ctx.enabled) return;
    if (mode === 'manual') return;
    if (!client?.connected || !client.objectId) return;
    if (safeZoneEnabled && isSafeZone(client)) return;

    const pd = client.playerData;
    if (EXCLUDED_CLASSES.has(pd.classType)) return;
    if (pd.inventory[1] === -1) return;
    if (pd.maxMana <= 0) return;
    if ((pd.mana / pd.maxMana) * 100 < mpThresholdPct) return;

    const now = Date.now();
    if (now < (nextAllowedAt.get(client) ?? 0)) return;

    if (SELF_BUFF_CLASSES.has(pd.classType)) {
      // Guard: pos defaults to {0,0} before first position update — (0,0) looks
      // like cheating to the server since the player can't actually be there
      if (pd.pos.x === 0 && pd.pos.y === 0) return;
      sendUseAbility(client, pd.pos);
      nextAllowedAt.set(client, now + ABILITY_COOLDOWN_MS);
    } else {
      const ws = ctx.getWorldState(client) ?? ctx.worldState;
      const gd = ctx.gameData;
      if (!ws || !gd) return;
      const enemy = ws.getNearestEnemy(gd, pd.pos, { maxDistance: abilityRange });
      if (!enemy) return;
      sendUseAbility(client, { x: enemy.x, y: enemy.y });
      nextAllowedAt.set(client, now + ABILITY_COOLDOWN_MS);
    }
  });
}
