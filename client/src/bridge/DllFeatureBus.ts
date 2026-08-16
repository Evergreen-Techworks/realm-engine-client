import type { DllFeatureKey } from './contract.js';

type DllFeatureValue = boolean | number | string;
type DllFeatureSender = (key: DllFeatureKey, value: DllFeatureValue) => void;

/** Plugins are esbuild-bundled separately; each bundle inlines this module unless externalized.
 *  The main app sets the sender here — use a process-global slot so every copy shares it. */
const GLOBAL_SLOT_KEY = '__LFG_dllFeatureBus_v1';

type BusSlot = { sender: DllFeatureSender | null };

function getBusSlot(): BusSlot {
  const g = globalThis as unknown as Record<string, unknown>;
  let slot = g[GLOBAL_SLOT_KEY] as BusSlot | undefined;
  if (!slot) {
    slot = { sender: null };
    g[GLOBAL_SLOT_KEY] = slot;
  }
  return slot;
}

const busInstanceId = `bus_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export function setDllFeatureSender(next: DllFeatureSender | null): void {
  getBusSlot().sender = next;
  // #region agent log
  // #endregion
}

export function sendDllFeature(key: DllFeatureKey, value: DllFeatureValue): boolean {
  const slot = getBusSlot();
  // #region agent log
  // #endregion
  if (!slot.sender) {
    // #region agent log
    // #endregion
    return false;
  }
  slot.sender(key, value);
  // #region agent log
  // #endregion
  return true;
}
