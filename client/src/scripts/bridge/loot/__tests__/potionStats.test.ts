import { describe, expect, it, vi } from 'vitest';
import { loot } from '@realmengine/sdk';
import { install } from '../index.js';
import type { BridgeDeps } from '../../BridgeDeps.js';

// Archer's 8/8 caps, verbatim from objects.xml (RotMG 86ad651b).
const ARCHER = 0x0307;
const CAPS = { maxHitPoints: 750, maxMagicPoints: 300, attack: 75, defense: 25, speed: 55, dexterity: 50, hpRegen: 40, mpRegen: 50 };
type Stat = 'attack' | 'defense' | 'speed' | 'dexterity' | 'vitality' | 'wisdom';
const STATS: Stat[] = ['attack', 'defense', 'speed', 'dexterity', 'vitality', 'wisdom'];
const capOf = (stat: Stat) => (stat === 'vitality' ? CAPS.hpRegen : stat === 'wisdom' ? CAPS.mpRegen : CAPS[stat]);

// The tradable stat potions, type -> <Activate stat="..."> from objects.xml.
const POTIONS: Array<[string, number, Stat]> = [
  ['Potion of Attack', 0xa1f, 'attack'],
  ['Potion of Defense', 0xa20, 'defense'],
  ['Potion of Speed', 0xa21, 'speed'],
  ['Potion of Vitality', 0xa34, 'vitality'],
  ['Potion of Wisdom', 0xa35, 'wisdom'],
  ['Potion of Dexterity', 0xa4c, 'dexterity'],
];

const client: any = { connected: true, objectId: 1, playerData: {} };
install({
  clientRef: { current: client },
  worldState: { getEntity: () => null },
  gameData: { getAllObjects: () => [], getPlayerClassStatMaxes: (t: number) => (t === ARCHER ? CAPS : undefined) },
  proxy: { hookPacket: vi.fn(), packetFactory: { createByName: (name: string) => ({ name, data: {} }) } },
} as unknown as BridgeDeps);

/** An Archer whose `capped` stats sit at cap and every other stat at zero. */
function archer(capped: Stat[]) {
  client.playerData = {
    classType: ARCHER, maxHealth: 150, healthBonus: 0, exaltedMaxHP: 0, maxMana: 100, manaBonus: 0, exaltedMaxMP: 0,
    ...Object.fromEntries(STATS.map((s) => [s, capped.includes(s) ? capOf(s) : 0])),
  };
}

describe('loot.isUsefulStatPot', () => {
  it.each(POTIONS)('a %s is not useful once its own stat is capped', (_name, itemId, stat) => {
    archer([stat]);
    expect(loot.isUsefulStatPot(itemId)).toBe(false);
  });

  it.each(POTIONS)('a %s is useful while its own stat is below cap, whatever else is capped', (_name, itemId, stat) => {
    archer(STATS.filter((s) => s !== stat));
    expect(loot.isUsefulStatPot(itemId)).toBe(true);
  });
});
