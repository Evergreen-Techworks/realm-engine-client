/**
 * PyRelay `Constants/ClassIds` — playable classes (for discovering own player in UPDATE).
 * Mirror of `src/constants/ClassId.ts` in the proxy app (separate build tree, no shared
 * import edge — keep in sync by hand). 784 (Priest) is included in both.
 */
export const WIZARD_CLASS_ID = 782;

export const PLAYER_CLASS_TYPE_IDS: ReadonlySet<number> = new Set([
  768, 775, 782, 784, 785, 796, 797, 798, 799, 800, 801, 802, 803, 804, 805, 806, 817, 818
]);

export function isPlayerObjectType(objectType: number): boolean {
  return PLAYER_CLASS_TYPE_IDS.has(objectType);
}
