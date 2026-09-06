/**
 * Character class type IDs.
 * Mirror of the player-class id set in `packages/core/src/core/rotmg-class-ids.ts`
 * (`PLAYER_CLASS_TYPE_IDS`); the two live in separate build trees with no shared
 * import edge, so keep them in sync by hand. Both include Priest (784).
 */
export const ClassId = {
  Rogue:        768,
  Archer:       775,
  Wizard:       782,
  Priest:       784,
  Samurai:      785,
  Bard:         796,
  Warrior:      797,
  Knight:       798,
  Paladin:      799,
  Assassin:     800,
  Necromancer:  801,
  Huntress:     802,
  Mystic:       803,
  Trickster:    804,
  Sorcerer:     805,
  Ninja:        806,
  Summoner:     817,
  Kensei:       818,
} as const;

export type ClassIdName = keyof typeof ClassId;
