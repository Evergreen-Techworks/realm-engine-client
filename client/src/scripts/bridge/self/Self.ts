import type { ExaltedBonuses, GearBonuses, Stats } from '@realmengine/sdk';
import { Position, StatusEffect } from '@realmengine/sdk';
import type { Item } from '@realmengine/sdk';
import type { BridgeDeps } from '../BridgeDeps.js';
import { Self } from '../sdkInternal.js';
import type { PlayerData } from '../../../state/PlayerData.js';
import type { ConditionEffectName } from '../../../constants/ConditionEffect.js';

const EMPTY_STATS: Stats = {
  maxHP: 0,
  maxMP: 0,
  attack: 0,
  defense: 0,
  speed: 0,
  dexterity: 0,
  vitality: 0,
  wisdom: 0,
};

const EMPTY_EXALTED: ExaltedBonuses = {
  maxHP: 0,
  maxMP: 0,
  attack: 0,
  defense: 0,
  speed: 0,
  dexterity: 0,
  vitality: 0,
  wisdom: 0,
};

const EMPTY_GEAR: GearBonuses = {
  maxHP: 0,
  maxMP: 0,
  attack: 0,
  defense: 0,
  speed: 0,
  dexterity: 0,
  vitality: 0,
  wisdom: 0,
};

function playerData(deps: BridgeDeps): PlayerData | null {
  return deps.clientRef.current?.playerData ?? null;
}

/** Map @realmengine/sdk StatusEffect string values → RotMG bitmask names on PlayerData */
const SDK_EFFECT_TO_CONDITION: Partial<Record<StatusEffect, ConditionEffectName>> = {
  [StatusEffect.CURSED]: 'Curse',
  [StatusEffect.SLOWED]: 'Slowed',
  [StatusEffect.STUNNED]: 'Stunned',
  [StatusEffect.BLIND]: 'Blind',
  [StatusEffect.HALLUCINATING]: 'Hallucinating',
  [StatusEffect.DRUNK]: 'Drunk',
  [StatusEffect.CONFUSED]: 'Confused',
  [StatusEffect.STASIS]: 'Stasis',
  [StatusEffect.INVISIBLE]: 'Invisible',
  [StatusEffect.ARMORED]: 'Armored',
  [StatusEffect.INVINCIBLE]: 'Invincible',
  [StatusEffect.SPEEDY]: 'Speedy',
  [StatusEffect.HEALING]: 'Healing',
  [StatusEffect.DAMAGING]: 'Damaging',
  [StatusEffect.BERSERK]: 'Berserk',
  [StatusEffect.PETRIFIED]: 'Petrified',
  [StatusEffect.SICK]: 'Sick',
  [StatusEffect.BLEEDING]: 'Bleeding',
  [StatusEffect.QUIET]: 'Quiet',
  [StatusEffect.EXPOSED]: 'Exposed',
  [StatusEffect.HEXED]: 'Hexed',
};

/** Player inventory stat slots 8–11 → weapon, ability, armor, ring. */
function equippedFromInventory(deps: BridgeDeps, invIndex: number): Item | null {
  const p = playerData(deps);
  if (!p || invIndex < 0 || invIndex >= p.inventory.length) return null;
  const typeId = p.inventory[invIndex];
  if (!Number.isFinite(typeId) || typeId < 0) return null;
  return deps.gameData.buildSdkItem(typeId);
}

function buildStats(p: PlayerData): Stats {
  return {
    maxHP: p.maxHealth,
    maxMP: p.maxMana,
    attack: p.attack + p.attackBonus + p.exaltedAttack,
    defense: p.defense + p.defenseBonus + p.exaltedDefense,
    speed: p.speed + p.speedBonus + p.exaltedSpeed,
    dexterity: p.dexterity + p.dexterityBonus + p.exaltedDexterity,
    vitality: p.vitality + p.vitalityBonus + p.exaltedVitality,
    wisdom: p.wisdom + p.wisdomBonus + p.exaltedWisdom,
  };
}

function buildExaltedBonuses(p: PlayerData): ExaltedBonuses {
  return {
    maxHP: p.exaltedMaxHP,
    maxMP: p.exaltedMaxMP,
    attack: p.exaltedAttack,
    defense: p.exaltedDefense,
    speed: p.exaltedSpeed,
    dexterity: p.exaltedDexterity,
    vitality: p.exaltedVitality,
    wisdom: p.exaltedWisdom,
  };
}

function buildGearBonuses(p: PlayerData): GearBonuses {
  return {
    maxHP: p.healthBonus,
    maxMP: p.manaBonus,
    attack: p.attackBonus,
    defense: p.defenseBonus,
    speed: p.speedBonus,
    dexterity: p.dexterityBonus,
    vitality: p.vitalityBonus,
    wisdom: p.wisdomBonus,
  };
}

type CombatStatKey = 'attack' | 'defense' | 'speed' | 'dexterity' | 'vitality' | 'wisdom';

function combatStat(deps: BridgeDeps, key: CombatStatKey): number {
  const p = playerData(deps);
  if (!p) return 0;
  return buildStats(p)[key];
}

export class BridgeSelf {
  static install(deps: BridgeDeps): void {
    Self.getX = () => {
      const p = playerData(deps);
      return p?.pos.x ?? 0;
    };
    Self.getY = () => {
      const p = playerData(deps);
      return p?.pos.y ?? 0;
    };
    Self.getPosition = () => {
      const p = playerData(deps);
      return new Position(p?.pos.x ?? 0, p?.pos.y ?? 0);
    };
    Self.distanceTo = (other: Position) => {
      const p = playerData(deps);
      if (!p) return 0;
      return new Position(p.pos.x, p.pos.y).distanceTo(other);
    };

    Self.getHP = () => {
      const p = playerData(deps);
      return p?.health ?? 0;
    };
    Self.getMaxHP = () => {
      const p = playerData(deps);
      return p?.maxHealth ?? 0;
    };
    Self.getHPPercent = () => {
      const p = playerData(deps);
      if (!p || p.maxHealth <= 0) return 0;
      return p.health / p.maxHealth;
    };
    Self.getMP = () => {
      const p = playerData(deps);
      return p?.mana ?? 0;
    };
    Self.getMaxMP = () => {
      const p = playerData(deps);
      return p?.maxMana ?? 0;
    };
    Self.getMPPercent = () => {
      const p = playerData(deps);
      if (!p || p.maxMana <= 0) return 0;
      return p.mana / p.maxMana;
    };
    Self.getStats = () => {
      const p = playerData(deps);
      if (!p) return { ...EMPTY_STATS };
      return buildStats(p);
    };
    Self.getExaltedBonuses = () => {
      const p = playerData(deps);
      if (!p) return { ...EMPTY_EXALTED };
      return buildExaltedBonuses(p);
    };
    Self.getExaltedMaxHP = () => playerData(deps)?.exaltedMaxHP ?? 0;
    Self.getExaltedMaxMP = () => playerData(deps)?.exaltedMaxMP ?? 0;
    Self.getExaltedAtk = () => playerData(deps)?.exaltedAttack ?? 0;
    Self.getExaltedDef = () => playerData(deps)?.exaltedDefense ?? 0;
    Self.getExaltedSpd = () => playerData(deps)?.exaltedSpeed ?? 0;
    Self.getExaltedDex = () => playerData(deps)?.exaltedDexterity ?? 0;
    Self.getExaltedVit = () => playerData(deps)?.exaltedVitality ?? 0;
    Self.getExaltedWis = () => playerData(deps)?.exaltedWisdom ?? 0;
    Self.getGearBonuses = () => {
      const p = playerData(deps);
      if (!p) return { ...EMPTY_GEAR };
      return buildGearBonuses(p);
    };
    Self.getGearMaxHP = () => playerData(deps)?.healthBonus ?? 0;
    Self.getGearMaxMP = () => playerData(deps)?.manaBonus ?? 0;
    Self.getGearAtk = () => playerData(deps)?.attackBonus ?? 0;
    Self.getGearDef = () => playerData(deps)?.defenseBonus ?? 0;
    Self.getGearSpd = () => playerData(deps)?.speedBonus ?? 0;
    Self.getGearDex = () => playerData(deps)?.dexterityBonus ?? 0;
    Self.getGearVit = () => playerData(deps)?.vitalityBonus ?? 0;
    Self.getGearWis = () => playerData(deps)?.wisdomBonus ?? 0;
    Self.getAtk = () => combatStat(deps, 'attack');
    Self.getDef = () => combatStat(deps, 'defense');
    Self.getSpd = () => combatStat(deps, 'speed');
    Self.getDex = () => combatStat(deps, 'dexterity');
    Self.getVit = () => combatStat(deps, 'vitality');
    Self.getWis = () => combatStat(deps, 'wisdom');
    Self.hasEffect = (effect: StatusEffect) => {
      const p = playerData(deps);
      if (!p) return false;
      const name = SDK_EFFECT_TO_CONDITION[effect];
      if (!name) return false;
      return p.hasConditionEffect(name);
    };
    Self.getEffects = () => {
      const p = playerData(deps);
      if (!p) return [];
      const all = Object.values(StatusEffect) as StatusEffect[];
      const out: StatusEffect[] = [];
      for (const e of all) {
        if (typeof e !== 'string') continue;
        const name = SDK_EFFECT_TO_CONDITION[e as StatusEffect];
        if (!name || !p.hasConditionEffect(name)) continue;
        out.push(e as StatusEffect);
      }
      return out;
    };

    Self.getWeapon = (): Item | null => equippedFromInventory(deps, 0);
    Self.getAbility = (): Item | null => equippedFromInventory(deps, 1);
    Self.getArmor = (): Item | null => equippedFromInventory(deps, 2);
    Self.getRing = (): Item | null => equippedFromInventory(deps, 3);

    Self.getName = () => {
      const p = playerData(deps);
      return p?.name ?? '';
    };
    Self.getClass = () => {
      const p = playerData(deps);
      if (!p?.classType) return '';
      const def = deps.gameData.getObject(p.classType);
      return def?.displayId || def?.id || String(p.classType);
    };
    Self.getLevel = () => playerData(deps)?.level ?? 0;
    Self.isDead = () => {
      const p = playerData(deps);
      return p?.hasConditionEffect('Dead') ?? false;
    };
    Self.isInCombat = () => {
      // TODO: wire from world state / combat flags
      return false;
    };
    Self.isInvisible = () => {
      const p = playerData(deps);
      return p?.hasConditionEffect('Invisible') ?? false;
    };

    Self.getAccountFame = () => {
      const p = playerData(deps);
      return p?.currentFame ?? 0;
    };

    Self.getCharacterFame = () => {
      const p = playerData(deps);
      return p?.characterAliveFame ?? 0;
    };

    Self.getPowerLevel = () => {
      const p = playerData(deps);
      return p?.powerLevel ?? 0;
    };

    Self.getStars = () => {
      const p = playerData(deps);
      return p?.stars ?? 0;
    };
  }
}
