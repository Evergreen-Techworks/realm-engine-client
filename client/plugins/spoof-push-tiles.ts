import type { PluginContext } from '../src/plugins/PluginContext.js';
import type { GameDataLoader } from '../src/game-data/GameDataLoader.js';

const DEFAULT_TARGET_TILE_TYPE = 0xb003;

const PUSH_TILE_NAMES = new Set([
  'blue alpha square',
  'dread angler puller down',
  'dread angler puller left',
  'dread angler puller right',
  'dread angler puller up',
  'ds sludge tile e',
  'ds sludge tile n',
  'ds sludge tile s',
  'ds sludge tile w',
  'flowing sand1',
  'flowing sand2',
  'flowing sand3',
  'flowing sand4',
  'green alpha square',
  'ksw conveyor down',
  'ksw conveyor left',
  'ksw conveyor right',
  'ksw conveyor up',
  'purple alpha square',
  'red alpha square',
  'snowball boost down',
  'snowball boost left',
  'snowball boost right',
  'snowball boost up',
  'specpen murcian conveyor',
  'sprite square down',
  'sprite square left',
  'sprite square right',
  'sprite square up',
  'whirlpool dn',
  'whirlpool lf',
  'whirlpool rt',
  'whirlpool start dn',
  'whirlpool start lf',
  'whirlpool start up',
  'whirlpool up',
]);

function normalizeTileName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

function isAllowedPushTile(gameData: GameDataLoader, tileType: number): boolean {
  return PUSH_TILE_NAMES.has(normalizeTileName(gameData.getTileName(tileType)));
}

export function register(ctx: PluginContext) {
  ctx.name = 'Spoof Push Tiles';
  ctx.category = 'movement';

  ctx.registerSetting('targetTileType', {
    label: 'Replace push tiles with type',
    type: 'number',
    value: DEFAULT_TARGET_TILE_TYPE,
    min: 0,
    max: 999999,
    step: 1,
  });

  ctx.hookPacket('UPDATE', (client, packet) => {
    if (!packet.isDefined || !Array.isArray(packet.data.tiles)) return;

    const gameData = ctx.gameData;
    if (!gameData) return;

    const targetTileType = Number(ctx.getSetting('targetTileType'));
    if (!Number.isFinite(targetTileType)) return;

    let changed = 0;
    for (const tile of packet.data.tiles as Array<{ type?: number }>) {
      const tileType = Number(tile?.type);
      if (!Number.isFinite(tileType)) continue;
      if (!isAllowedPushTile(gameData, tileType)) continue;
      if (tileType === targetTileType) continue;
      tile.type = targetTileType;
      changed++;
    }

    if (changed > 0) {
      packet.modified = true;
      ctx.setData('lastSpoofCount', changed);
    }
  });

  const handleSpoofToggle = (client: any) => {
    ctx.enabled = !ctx.enabled;
    const status = ctx.enabled ? 'ON' : 'OFF';
    ctx.sendNotification(client, ctx.name, `Push tile spoof ${status}`);
  };

  ctx.hookCommand('spoofpush', handleSpoofToggle);
  ctx.hookCommand('sp', handleSpoofToggle);
}
