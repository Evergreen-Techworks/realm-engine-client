import type { PluginContext } from './api.js';
import type { ClientConnection } from './api.js';

// Safe floor replacement target — mirrors Multitool Class97 `ushort_0`.
const SAFE_FLOOR_NAME = 'EH Secret Floor';
const SAFE_FLOOR_FALLBACK = 0x1aa1;

interface SafeWalkState {
  // Per-tile positions protected by a ProtectFromGroundDamage object — mirrors
  // Multitool Class97.bool_0[] grid.  Tiles in this set are left untouched.
  protectTiles: Set<string>;
  // True when the current map is Lair of Shaitan — mirrors Class97.bool_1.
  inShaitanMap: boolean;
}

function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}

function getState(map: Map<ClientConnection, SafeWalkState>, client: ClientConnection): SafeWalkState {
  let state = map.get(client);
  if (!state) {
    state = { protectTiles: new Set<string>(), inShaitanMap: false };
    map.set(client, state);
  }
  return state;
}

function resolveSafeFloorType(ctx: PluginContext): number {
  return ctx.gameData?.getTileTypeByName(SAFE_FLOOR_NAME) ?? SAFE_FLOOR_FALLBACK;
}

export function register(ctx: PluginContext) {
  ctx.name = 'Safe Walk';
  ctx.category = 'movement';

  const stateByClient = new Map<ClientConnection, SafeWalkState>();

  ctx.registerSetting('enabled', {
    label: 'Safe walk',
    type: 'boolean',
    value: false,
  });

  // Mirrors Multitool Settings.Default.SafeWalkInShatters
  ctx.registerSetting('safeWalkInShatters', {
    label: 'Safe walk in Shatters / Lair of Shaitan',
    type: 'boolean',
    value: false,
  });

  ctx.on('clientConnected', (client) => {
    stateByClient.set(client, { protectTiles: new Set<string>(), inShaitanMap: false });
  });

  ctx.on('clientDisconnected', (client) => {
    stateByClient.delete(client);
  });

  // Mirrors Class97.method_2 — reset state on map load
  ctx.hookPacket('MAPINFO', (client, packet) => {
    const mapName = String(packet.data.displayName ?? packet.data.name ?? '').toLowerCase();
    stateByClient.set(client, {
      protectTiles: new Set<string>(),
      inShaitanMap: mapName.includes('shaitan'),
    });
  });

  // Mirrors Class97.method_3 — process UPDATE tiles
  ctx.hookPacket('UPDATE', (client, packet) => {
    if (!packet.isDefined) return;
    if (!ctx.getSetting<boolean>('enabled')) return;

    const gd = ctx.gameData;
    if (!gd) return;

    const state = getState(stateByClient, client);
    const allowShaitan = !!ctx.getSetting<boolean>('safeWalkInShatters');

    // Track ProtectFromGroundDamage objects — mirrors Class97.method_3 newObjs loop
    if (Array.isArray(packet.data.newObjs)) {
      for (const entity of packet.data.newObjs as Array<{
        objectType?: number;
        status?: { position?: { x?: number; y?: number } };
      }>) {
        const def = gd.getObject(Number(entity.objectType));
        if (!def?.protectFromGroundDamage) continue;
        const x = Number(entity.status?.position?.x);
        const y = Number(entity.status?.position?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        state.protectTiles.add(tileKey(Math.trunc(x), Math.trunc(y)));
      }
    }

    if (!Array.isArray(packet.data.tiles)) return;

    const safeFloorType = resolveSafeFloorType(ctx);
    let changed = false;

    // Mirrors Class97.method_3 tiles loop:
    //   if (EnableSafeWalk && (!inShaitan || SafeWalkInShatters)
    //       && tileStructure.MinDamage > 0
    //       && !protectFromGroundDamage[x, y])
    //     tile.type = safeFloor;
    for (const tile of packet.data.tiles as Array<{ x?: number; y?: number; type?: number }>) {
      const x = Number(tile.x);
      const y = Number(tile.y);
      const type = Number(tile.type);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(type)) continue;
      if (state.inShaitanMap && !allowShaitan) continue;
      if (!gd.getTileHasMinDamage(type)) continue;
      if (state.protectTiles.has(tileKey(x, y))) continue;
      tile.type = safeFloorType;
      changed = true;
    }

    if (changed) packet.modified = true;
  });
}
