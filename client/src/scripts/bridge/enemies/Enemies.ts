import { Enemies, Position } from '@realmengine/sdk';
import type { Enemy } from '@realmengine/sdk';
import type { BridgeDeps } from '../BridgeDeps.js';
import { warnUnimplemented } from '../stubWarn.js';
import { StatType } from '../../../constants/StatType.js';
import { ConditionEffect } from '../../../constants/ConditionEffect.js';

function hasEffect(mask0: number, mask1: number, bit: number): boolean {
  return bit < 31 ? ((mask0 >>> 0) & (1 << bit)) !== 0
    : ((mask1 >>> 0) & (1 << (bit - 31))) !== 0;
}

export class BridgeEnemies {
  static install(deps: BridgeDeps): void {
    const build = (objectId: number): Enemy | null => {
      const e = deps.worldState.getEntity(objectId);
      if (!e || deps.gameData.getObjectCategory(e.objectType) !== 'Enemy') return null;
      const def = deps.gameData.getObject(e.objectType);
      const s = e.stats ?? {};
      const hp = Number(s[String(StatType.HP)] ?? 0);
      const maxHp = Number(s[String(StatType.MaxHP)] ?? def?.maxHp ?? Math.max(1, hp));
      const defense = Number(s[String(StatType.Defense)] ?? def?.defense ?? 0);
      const effects0 = Number(s[String(StatType.Effects)] ?? 0);
      const effects1 = Number(s[String(StatType.Effects2)] ?? 0);
      const invulnerable = hasEffect(effects0, effects1, ConditionEffect.Invulnerable)
        || hasEffect(effects0, effects1, ConditionEffect.Invincible)
        || hasEffect(effects0, effects1, ConditionEffect.Stasis);
      return {
        objectId: e.objectId,
        objectType: e.objectType,
        name: def?.displayId ?? def?.id ?? `Enemy 0x${e.objectType.toString(16)}`,
        position: new Position(e.pos.x, e.pos.y),
        hp: Number.isFinite(hp) ? hp : 0,
        maxHp: Number.isFinite(maxHp) ? maxHp : 0,
        defense: Number.isFinite(defense) ? defense : 0,
        stats: { maxHP: maxHp, maxMP: 0, attack: 0, defense, speed: 0, dexterity: 0, vitality: 0, wisdom: 0 },
        phase: 0,
        isEnraged: false,
        isBoss: deps.gameData.isBoss(e.objectType, 2000),
        isTargetingMe: false,
        isTargetable: hp > 0 && !invulnerable,
        isInvulnerable: invulnerable,
      };
    };

    Enemies.getAll = (): Enemy[] => {
      const p = deps.clientRef.current?.playerData.pos ?? { x: 0, y: 0 };
      return deps.worldState.getEnemiesMatching(deps.gameData, p)
        .map((row) => build(row.objectId)).filter((e): e is Enemy => e != null);
    };
    Enemies.getNearest = (): Enemy | null => {
      const p = deps.clientRef.current?.playerData.pos;
      if (!p) return null;
      const row = deps.worldState.getNearestEnemy(deps.gameData, p);
      return row ? build(row.objectId) : null;
    };
    Enemies.getNearestTo = (_position: Position): Enemy | null => {
      warnUnimplemented('Enemies.getNearestTo');
      return null;
    };
    Enemies.getBoss = (): Enemy | null => {
      return Enemies.getAll().filter((e) => e.isBoss && e.isTargetable)
        .sort((a, b) => b.maxHp - a.maxHp)[0] ?? null;
    };
    Enemies.getTargetingMe = (): Enemy[] => {
      warnUnimplemented('Enemies.getTargetingMe');
      return [];
    };
    Enemies.find = (_name: string): Enemy | null => {
      const q = _name.trim().toLowerCase();
      return Enemies.getAll().find((e) => e.name.toLowerCase().includes(q)) ?? null;
    };
    Enemies.count = () => {
      return Enemies.getAll().length;
    };
    Enemies.getById = (_objectId: number) => {
      return build(_objectId);
    };
    Enemies.getByType = (_objectType: number): Enemy[] => {
      return Enemies.getAll().filter((e) => e.objectType === _objectType);
    };
  }
}
