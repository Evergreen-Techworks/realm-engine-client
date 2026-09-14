import { describe, expect, it } from 'vitest';
import { shouldSkipPermanentPotionClassCap } from '../../../plugins/auto-loot/items.js';
import type { PlayerClassStatMaxes } from '../../game-data/GameDataLoader.js';

// Archer's 8/8 caps, verbatim from objects.xml (RotMG 86ad651b).
const ARCHER = 0x0307;
const CAPS: PlayerClassStatMaxes = {
  maxHitPoints: 750, maxMagicPoints: 300, attack: 75, defense: 25,
  speed: 55, dexterity: 50, hpRegen: 40, mpRegen: 50,
};
const getCaps = (classType: number) => (classType === ARCHER ? CAPS : undefined);

type Stat = 'attack' | 'defense' | 'speed' | 'dexterity' | 'vitality' | 'wisdom';
const capOf = (stat: Stat) => (stat === 'vitality' ? CAPS.hpRegen : stat === 'wisdom' ? CAPS.mpRegen : CAPS[stat]);
const STATS: Stat[] = ['attack', 'defense', 'speed', 'dexterity', 'vitality', 'wisdom'];

/** A player whose `capped` stats sit at cap and every other stat at zero. */
const player = (capped: Stat[]) => ({
  ...Object.fromEntries(STATS.map((s) => [s, capped.includes(s) ? capOf(s) : 0])) as Record<Stat, number>,
  maxHealth: 150, maxMana: 100,
});

// The tradable stat potions, type -> <Activate stat="..."> from objects.xml:
// 0xa1f Potion of Attack (ATT), 0xa20 Potion of Defense (DEF), 0xa21 Potion of
// Speed (SPD), 0xa34 Potion of Vitality (VIT), 0xa35 Potion of Wisdom (WIS),
// 0xa4c Potion of Dexterity (DEX).
const POTIONS: Array<[string, number, Stat]> = [
  ['Potion of Attack', 0xa1f, 'attack'],
  ['Potion of Defense', 0xa20, 'defense'],
  ['Potion of Speed', 0xa21, 'speed'],
  ['Potion of Vitality', 0xa34, 'vitality'],
  ['Potion of Wisdom', 0xa35, 'wisdom'],
  ['Potion of Dexterity', 0xa4c, 'dexterity'],
];

describe('Auto Loot permanent-potion class cap', () => {
  it.each(POTIONS)('skips a %s when its own stat is capped', (_name, itemId, stat) => {
    expect(shouldSkipPermanentPotionClassCap(ARCHER, player([stat]), itemId, getCaps)).toBe(true);
  });

  it.each(POTIONS)('loots a %s while its own stat is below cap, whatever else is capped', (_name, itemId, stat) => {
    const others = STATS.filter((s) => s !== stat);
    expect(shouldSkipPermanentPotionClassCap(ARCHER, player(others), itemId, getCaps)).toBe(false);
  });
});
