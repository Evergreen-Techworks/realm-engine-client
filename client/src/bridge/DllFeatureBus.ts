import type { DllFeatureKey } from './contract.js';

type DllFeatureValue = boolean | number | string;
type DllFeatureSender = (key: DllFeatureKey, value: DllFeatureValue) => void;

/** Plugins are esbuild-bundled separately; each bundle inlines this module unless externalized.
 *  The main app sets the sender here — use a process-global slot so every copy shares it. */
const GLOBAL_SLOT_KEY = '__LFG_dllFeatureBus_v1';

/**
 * `owned`: the last value each key's owner (a plugin or dashboard control) sent.
 * `current`: the last value the DLL was sent by anyone, an override included.
 * Both are optional so a slot created by an older bundle still works.
 */
type BusSlot = {
  sender: DllFeatureSender | null;
  owned?: Partial<Record<DllFeatureKey, DllFeatureValue>>;
  current?: Partial<Record<DllFeatureKey, DllFeatureValue>>;
};

function getBusSlot(): BusSlot {
  const g = globalThis as unknown as Record<string, unknown>;
  let slot = g[GLOBAL_SLOT_KEY] as BusSlot | undefined;
  if (!slot) {
    slot = { sender: null };
    g[GLOBAL_SLOT_KEY] = slot;
  }
  slot.owned ??= {};
  slot.current ??= {};
  return slot;
}

const busInstanceId = `bus_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export function setDllFeatureSender(next: DllFeatureSender | null): void {
  const slot = getBusSlot();
  slot.sender = next;
  slot.current = {};   // what a new sender holds is unknown until something is sent
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
  slot.owned![key] = value;
  slot.current![key] = value;
  // #region agent log
  // #endregion
  return true;
}

/**
 * Send a temporary value for a key another component owns (a script lifting a
 * plugin's setting for the length of one action). The owner's value is kept, so
 * `restoreDllFeature` can put it back, and a later send by the owner still wins.
 */
export function overrideDllFeature(key: DllFeatureKey, value: DllFeatureValue): boolean {
  const slot = getBusSlot();
  if (!slot.sender) return false;
  if (slot.current![key] === value) return true;
  slot.sender(key, value);
  slot.current![key] = value;
  return true;
}

/**
 * Undo `overrideDllFeature`: send the owner's last value again, or `fallback` (the
 * DLL's own default) when the owner never sent one. Nothing is sent when the DLL
 * already holds that value, e.g. because the owner re-sent it during the override.
 */
export function restoreDllFeature(key: DllFeatureKey, fallback: DllFeatureValue): boolean {
  const slot = getBusSlot();
  if (!slot.sender) return false;
  const value = slot.owned![key] ?? fallback;
  if (slot.current![key] === value) return true;
  slot.sender(key, value);
  slot.current![key] = value;
  return true;
}
