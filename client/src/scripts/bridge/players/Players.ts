import { Players, Position } from '@realmengine/sdk';
import type { PlayerNameMatchMode } from '@realmengine/sdk';
import type { PlayerEntity, Stats } from '@realmengine/sdk';
import type { BridgeDeps } from '../BridgeDeps.js';
import type { PlayerRawStatsRowForDashboard } from '../../../state/GameWorldState.js';
import { StatType } from '../../../constants/StatType.js';

function rawNum(
  raw: Record<string, number | string>,
  id: number,
  def = 0,
): number {
  const v = raw[String(id)];
  if (v == null || v === '') return def;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : def;
}

function statsFromRaw(raw: Record<string, number | string>): Stats {
  return {
    maxHP: rawNum(raw, StatType.MaxHP, 0),
    maxMP: rawNum(raw, StatType.MaxMP, 0),
    attack: rawNum(raw, StatType.Attack, 0),
    defense: rawNum(raw, StatType.Defense, 0),
    speed: rawNum(raw, StatType.Speed, 0),
    dexterity: rawNum(raw, StatType.Dexterity, 0),
    vitality: rawNum(raw, StatType.Vitality, 0),
    wisdom: rawNum(raw, StatType.Wisdom, 0),
  };
}

function rowToPlayerEntity(row: PlayerRawStatsRowForDashboard): PlayerEntity {
  const raw = row.rawStats;
  return {
    objectType: row.objectType,
    objectId: row.objectId,
    name: row.name,
    position: new Position(row.x, row.y),
    hp: rawNum(raw, StatType.HP, 0),
    maxHp: rawNum(raw, StatType.MaxHP, 0),
    mp: rawNum(raw, StatType.MP, 0),
    maxMp: rawNum(raw, StatType.MaxMP, 0),
    stats: statsFromRaw(raw),
    className: row.className,
  };
}

function playerRows(deps: BridgeDeps): PlayerRawStatsRowForDashboard[] {
  return deps.worldState.getAllPlayersRawStatsForDashboard(deps.gameData);
}

function findRowByName(
  rows: PlayerRawStatsRowForDashboard[],
  name: string,
): PlayerRawStatsRowForDashboard | null {
  const q = name.trim().toLowerCase();
  if (!q) return null;
  for (const row of rows) {
    if (row.name.trim().toLowerCase() === q) return row;
  }
  for (const row of rows) {
    if (row.name.toLowerCase().includes(q)) return row;
  }
  return null;
}

function findRowByNameMatch(
  rows: PlayerRawStatsRowForDashboard[],
  name: string,
  match: PlayerNameMatchMode,
): PlayerRawStatsRowForDashboard | null {
  const q = name.trim().toLowerCase();
  if (!q) return null;
  if (match === 'equals') {
    for (const row of rows) {
      if (row.name.trim().toLowerCase() === q) return row;
    }
    return null;
  }
  for (const row of rows) {
    if (row.name.toLowerCase().includes(q)) return row;
  }
  return null;
}

function guildStringFromRow(row: PlayerRawStatsRowForDashboard): string {
  const v = row.rawStats[String(StatType.GuildName)];
  if (v == null) return '';
  return String(v).trim();
}

function nearbyGuildsFromRows(rows: PlayerRawStatsRowForDashboard[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const g = guildStringFromRow(row);
    if (!g) continue;
    const key = g.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return out;
}

export class BridgePlayers {
  static install(deps: BridgeDeps): void {
    Players.getAll = (): PlayerEntity[] => {
      return playerRows(deps).map(row => ({ ...rowToPlayerEntity(row),
        lastUpdate: deps.worldState.getEntity(row.objectId)?.lastUpdate }));
    };

    Players.getNearest = (): PlayerEntity | null => {
      const self = deps.clientRef.current?.playerData;
      if (!self?.ownerObjectId) return null;
      const mx = self.pos.x;
      const my = self.pos.y;
      let best: PlayerRawStatsRowForDashboard | null = null;
      let bestD = Infinity;
      for (const row of playerRows(deps)) {
        if (row.objectId === self.ownerObjectId) continue;
        const d = Math.hypot(row.x - mx, row.y - my);
        if (d < bestD) {
          bestD = d;
          best = row;
        }
      }
      return best ? rowToPlayerEntity(best) : null;
    };

    Players.find = (name: string): PlayerEntity | null => {
      const row = findRowByName(playerRows(deps), name);
      return row ? rowToPlayerEntity(row) : null;
    };

    Players.getHP = (name: string) => {
      const row = findRowByName(playerRows(deps), name);
      return row ? rawNum(row.rawStats, StatType.HP, 0) : 0;
    };

    Players.getMaxHP = (name: string) => {
      const row = findRowByName(playerRows(deps), name);
      return row ? rawNum(row.rawStats, StatType.MaxHP, 0) : 0;
    };

    Players.getHPPercent = (name: string) => {
      const row = findRowByName(playerRows(deps), name);
      if (!row) return 0;
      const hp = rawNum(row.rawStats, StatType.HP, 0);
      const max = rawNum(row.rawStats, StatType.MaxHP, 0);
      if (max <= 0) return 0;
      return hp / max;
    };

    Players.getMP = (name: string) => {
      const row = findRowByName(playerRows(deps), name);
      return row ? rawNum(row.rawStats, StatType.MP, 0) : 0;
    };

    Players.getAccountFame = (name: string) => {
      const row = findRowByName(playerRows(deps), name);
      if (!row) return 0;
      return Math.trunc(rawNum(row.rawStats, StatType.CurrentFame, 0));
    };

    Players.getCharacterFame = (name: string) => {
      const row = findRowByName(playerRows(deps), name);
      if (!row) return 0;
      return Math.trunc(rawNum(row.rawStats, StatType.CharacterAliveFame, 0));
    };

    Players.count = () => playerRows(deps).length;

    Players.getPlayerGuild = (name: string, match: PlayerNameMatchMode = 'equals'): string => {
      const row = findRowByNameMatch(playerRows(deps), name, match);
      return row ? guildStringFromRow(row) : '';
    };

    Players.getNearbyGuilds = (): string[] => {
      return nearbyGuildsFromRows(playerRows(deps));
    };
  }
}
