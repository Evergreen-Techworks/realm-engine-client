import type { DllFeatureKey } from './contract.js';

type DllFeatureValue = boolean | number | string;
/**
 * `false` means "the DLL definitely did not get this" (e.g. the pipe is down);
 * anything else — `true`, or a sender that returns nothing, like the ~30
 * fire-and-forget callers and every test double predating this contract —
 * is treated as delivered. This keeps `sendDllFeature`'s truth accurate for
 * callers that check it (see MovementController.navigateTo) without forcing
 * every existing sender to start returning a boolean.
 */
type DllFeatureSender = (key: DllFeatureKey, value: DllFeatureValue) => boolean | void;

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
  const delivered = slot.sender(key, value) !== false;
  slot.owned![key] = value;
  // Only record what the DLL actually holds when the send really reached it —
  // otherwise a later override/restore would see `current` already matching
  // and skip resending a value the DLL never got.
  if (delivered) slot.current![key] = value;
  // #region agent log
  // #endregion
  return delivered;
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
  const delivered = slot.sender(key, value) !== false;
  if (delivered) slot.current![key] = value;
  return delivered;
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
  const delivered = slot.sender(key, value) !== false;
  if (delivered) slot.current![key] = value;
  return delivered;
}
