/** Auto Drink — HP/MP potion id catalog. */

import type { PluginContext } from '../api.js';
import {
  POTION_SLOT_TYPE,
  FALLBACK_HP_POT_IDS,
  FALLBACK_MP_POT_IDS,
  FALLBACK_POT_AMOUNT,
} from './constants.js';

export interface PotIds {
  hpPots: Set<number>;
  mpPots: Set<number>;
  /** Restore amount per potion id, from the `amount` attribute on `<Activate>`. */
  amounts: Map<number, number>;
}

const ACTIVATE_HEAL_RE  = /<Activate\b([^>]*)>\s*Heal\s*<\/Activate>/i;
const ACTIVATE_MAGIC_RE = /<Activate\b([^>]*)>\s*Magic\s*<\/Activate>/i;
const AMOUNT_ATTR_RE    = /\bamount\s*=\s*"(\d+)"/i;

function readAmount(attrs: string | undefined): number {
  const m = attrs ? AMOUNT_ATTR_RE.exec(attrs) : null;
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : FALLBACK_POT_AMOUNT;
}

/**
 * Build HP/MP potion id sets from the already-loaded catalog (`ctx.gameData`),
 * which the proxy loads from the correct on-disk path at startup. Seeded with the
 * well-known potion ids so the plugin still works if the catalog is unavailable.
 *
 * All potions share `SlotType` 10, so the `Activate` effect (`Heal` vs `Magic`)
 * is the only reliable HP-vs-MP signal. The `amount` attribute on that same tag
 * is what lets the plugin size a burst instead of drinking one pot per tick.
 */
export function loadPotIds(ctx: PluginContext): PotIds {
  const hpPots = new Set<number>(FALLBACK_HP_POT_IDS);
  const mpPots = new Set<number>(FALLBACK_MP_POT_IDS);
  const amounts = new Map<number, number>();

  const gd = ctx.gameData;
  if (gd) {
    for (const obj of gd.getAllObjects()) {
      if (obj.slotType !== POTION_SLOT_TYPE) continue;
      const raw = gd.getRawObjectXml(obj.type);
      if (!raw) continue;
      const heal = ACTIVATE_HEAL_RE.exec(raw);
      if (heal) {
        hpPots.add(obj.type);
        amounts.set(obj.type, readAmount(heal[1]));
      }
      const magic = ACTIVATE_MAGIC_RE.exec(raw);
      if (magic) {
        mpPots.add(obj.type);
        amounts.set(obj.type, readAmount(magic[1]));
      }
    }
  }
  return { hpPots, mpPots, amounts };
}
