import { afterEach, expect, it, vi } from 'vitest';
import { overrideDllFeature, restoreDllFeature, sendDllFeature, setDllFeatureSender } from '../DllFeatureBus.js';

// sendDllFeature() used to report success as soon as a sender was merely
// *registered* — it never looked at what the sender actually returned. A
// caller that latches state on "sent" (e.g. MovementController.navigateTo)
// then believed a goal reached the DLL when the pipe was actually down,
// which permanently deduped every later retry against a target that never
// arrived. `false` from a sender now means "definitely not delivered"; a
// sender that returns `true` or nothing (every pre-existing fire-and-forget
// caller) is still treated as delivered.

afterEach(() => setDllFeatureSender(null));

it('reports success when the sender does not report otherwise (void sender)', () => {
  const sender = vi.fn();
  setDllFeatureSender(sender);
  expect(sendDllFeature('walkTargetActive', true)).toBe(true);
  expect(sender).toHaveBeenCalledWith('walkTargetActive', true);
});

it('reports success when the sender explicitly confirms delivery', () => {
  setDllFeatureSender(() => true);
  expect(sendDllFeature('walkTargetX', 1)).toBe(true);
});

it('reports failure when the sender says the pipe did not take it, and does not fake delivery', () => {
  setDllFeatureSender(() => false);
  expect(sendDllFeature('walkTargetX', 1)).toBe(false);
});

it('a dropped send does not get recorded as the DLL\'s current state, so a later resend of the same value is not skipped', () => {
  let delivered = false;
  setDllFeatureSender(() => delivered);

  expect(sendDllFeature('walkTargetActive', true)).toBe(false);

  // Bridge comes up; the same value is sent again. If the drop above had been
  // recorded into `current`, overrideDllFeature's `current === value` short
  // circuit would wrongly treat this as a no-op.
  delivered = true;
  expect(overrideDllFeature('walkTargetActive', true)).toBe(true);
});

it('overrideDllFeature and restoreDllFeature also propagate a dropped send instead of assuming delivery', () => {
  setDllFeatureSender(() => false);
  expect(overrideDllFeature('walkTargetActive', true)).toBe(false);
  expect(restoreDllFeature('walkTargetActive', false)).toBe(false);
});

it('returns false with no sender registered at all', () => {
  expect(sendDllFeature('walkTargetActive', true)).toBe(false);
  expect(overrideDllFeature('walkTargetActive', true)).toBe(false);
  expect(restoreDllFeature('walkTargetActive', false)).toBe(false);
});
