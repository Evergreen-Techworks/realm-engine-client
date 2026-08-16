/** Auto Drink — HP/MP potion id catalog. */

import type { PluginContext } from '../api.js';
import {
  POTION_SLOT_TYPE,
  FALLBACK_HP_POT_IDS,
  FALLBACK_MP_POT_IDS,
} from './constants.js';

export interface PotIds {
  hpPots: Set<number>;
  mpPots: Set<number>;
}

/**
 * Build HP/MP potion id sets from the already-loaded catalog (`ctx.gameData`),
 * which the proxy loads from the correct on-disk path at startup. Seeded with the
 * well-known potion ids so the plugin still works if the catalog is unavailable.
 *
 * All potions share `SlotType` 10, so the `Activate` effect (`Heal` vs `Magic`)
 * is the only reliable HP-vs-MP signal.
 */
export function loadPotIds(ctx: PluginContext): PotIds {
  const hpPots = new Set<number>(FALLBACK_HP_POT_IDS);
  const mpPots = new Set<number>(FALLBACK_MP_POT_IDS);

  const gd = ctx.gameData;
  if (gd) {
    for (const obj of gd.getAllObjects()) {
      if (obj.slotType !== POTION_SLOT_TYPE) continue;
      const raw = gd.getRawObjectXml(obj.type);
      if (!raw) continue;
      // <Activate amount="100">Heal</Activate> / ...>Magic</Activate>
      if (/<Activate\b[^>]*>\s*Heal\s*<\/Activate>/i.test(raw)) hpPots.add(obj.type);
      if (/<Activate\b[^>]*>\s*Magic\s*<\/Activate>/i.test(raw)) mpPots.add(obj.type);
    }
  }
  return { hpPots, mpPots };
}
