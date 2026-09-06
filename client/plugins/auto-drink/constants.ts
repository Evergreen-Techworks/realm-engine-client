/** Auto Drink — shared constants and small pure helpers. */

/** Maps where auto-drink never fires (no combat). */
export const SAFE_ZONE_MAPS = new Set<string>([
  'Nexus', 'Vault',
  'Guild Hall', 'Guild Hall 2', 'Guild Hall 3', 'Guild Hall 4', 'Guild Hall 5',
  'Cloth Bazaar',
  'Nexus Explanation', 'Vault Explanation', 'Guild Explanation',
  'Daily Quest Room', 'Daily Login Room',
  'Pet Yard', 'Pet Yard 2', 'Pet Yard 3', 'Pet Yard 4', 'Pet Yard 5',
]);

/** USEITEM slot id for potion-belt quickslot `i` is `BELT_SLOT_BASE + i`. */
export const BELT_SLOT_BASE = 1_000_000;

/**
 * Slot type shared by every HP/MP potion (Health and Magic both use 10), so the
 * Activate effect — not the slot type — is what distinguishes HP from MP pots.
 */
export const POTION_SLOT_TYPE = 10;

/** Well-known potion ids, used to seed the catalog so the plugin still works
 *  if `ctx.gameData` is unavailable. */
export const FALLBACK_HP_POT_IDS = [2594, 2736, 2795]; // Health / Minor Health / Greater Health
export const FALLBACK_MP_POT_IDS = [2595, 2781, 2796]; // Magic  / Minor Magic  / Greater Magic

/** Restore assumed for a potion whose `<Activate amount="...">` is unreadable. */
export const FALLBACK_POT_AMOUNT = 100;

/** Clamp a percentage into the [5, 95] drink-threshold range. */
export function clampPct(v: number): number {
  return Math.max(5, Math.min(95, Math.trunc(Number(v) || 0)));
}
