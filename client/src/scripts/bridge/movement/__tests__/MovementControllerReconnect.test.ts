import { beforeEach, expect, it, vi } from 'vitest';
import { MovementController } from '../MovementController.js';
import { sendDllFeature } from '../../../../bridge/DllFeatureBus.js';
import type { BridgeDeps } from '../../BridgeDeps.js';

// task-NAV1: a navigation goal sent while the DLL bridge is down was reported to
// the caller as sent (DllFeatureBus.sendDllFeature returned true whenever a
// sender was merely *registered*, never checking whether InternalBridge.send()
// actually reached the pipe). navigateTo() then latched `this.target` on that
// false success, so every later call for the same goal short-circuited on
// TARGET_EPSILON and never retried. These are the four regression cases from
// the brief's Gates section.

vi.mock('../../../../bridge/DllFeatureBus.js', () => ({ sendDllFeature: vi.fn() }));

/** Minimal stand-in for InternalBridge's `authenticated` (re)connect event. */
function fakeDllBridge() {
  const handlers = new Set<() => void>();
  return {
    on: (_event: 'authenticated', cb: () => void) => { handlers.add(cb); },
    off: (_event: 'authenticated', cb: () => void) => { handlers.delete(cb); },
    fire: () => { for (const cb of [...handlers]) cb(); },
  };
}

function goalIdOf(call: unknown[]): number {
  return Number(String(call[1]).split(',')[0]);
}

beforeEach(() => {
  vi.mocked(sendDllFeature).mockReset();
});

it('gate: a goal requested while the bridge is down is retried once the bridge comes up', () => {
  const movement = new MovementController({ clientRef: { current: { connected: true } } } as unknown as BridgeDeps);

  // Bridge down: InternalBridge.send() returned false, so sendDllFeature must too.
  vi.mocked(sendDllFeature).mockReturnValueOnce(false);
  expect(movement.navigateTo(105.4, 67.5)).toBe(false);
  expect(movement.getTarget()).toBeNull(); // must not latch a goal that never reached the DLL

  // Bridge comes up. The script's loop re-requests the same destination every
  // tick (this is how the farmer drives Walking.walkTo) — since nothing latched,
  // this call is not deduped and actually sends.
  vi.mocked(sendDllFeature).mockReturnValueOnce(true);
  expect(movement.navigateTo(105.4, 67.5)).toBe(true);
  expect(movement.getTarget()).toEqual({ x: 105.4, y: 67.5 });
  expect(sendDllFeature).toHaveBeenCalledTimes(2);
});

it('gate: a goal in flight is reissued with a new request id when the bridge drops and reconnects', () => {
  const bridge = fakeDllBridge();
  const movement = new MovementController(
    { clientRef: { current: { connected: true } }, dllBridge: bridge } as unknown as BridgeDeps,
  );
  vi.mocked(sendDllFeature).mockReturnValue(true);

  movement.navigateTo(10, 20);
  const firstId = goalIdOf(vi.mocked(sendDllFeature).mock.calls.at(-1)!);

  // The bridge drops (pipe closes) and reconnects. The script never re-calls
  // navigateTo — from its point of view nothing changed, it's still heading to
  // the same goal — so without a reconnect hook the DLL would never hear about
  // it again (dedup already latched `this.target` from the first, real send).
  bridge.fire();

  const lastCall = vi.mocked(sendDllFeature).mock.calls.at(-1)!;
  expect(lastCall[0]).toBe('scriptNavigationGoal');
  const secondId = goalIdOf(lastCall);
  expect(secondId).not.toBe(firstId);
  expect(secondId).toBeGreaterThan(firstId); // fresh requestId — the DLL may half-know the old one
  expect(String(lastCall[1])).toBe(`${secondId},10,20`);
});

it('gate: a map change before the reconnect drops the stale goal instead of reissuing it', () => {
  const bridge = fakeDllBridge();
  const hooks = new Map<string, () => void>();
  const movement = new MovementController({
    clientRef: { current: { connected: true } },
    dllBridge: bridge,
    proxy: { hookPacket: (name: string, cb: () => void) => hooks.set(name, cb) },
  } as unknown as BridgeDeps);
  vi.mocked(sendDllFeature).mockReturnValue(true);

  movement.navigateTo(10, 20);

  // Map changes while the bridge is still down (or between drop and reconnect):
  // MAPINFO clears the waypoint, exactly as it does today.
  hooks.get('MAPINFO')!();
  expect(movement.getTarget()).toBeNull();

  const callsBeforeReconnect = vi.mocked(sendDllFeature).mock.calls.length;
  bridge.fire(); // bridge reconnects after the map change
  const callsAfterReconnect = vi.mocked(sendDllFeature).mock.calls.slice(callsBeforeReconnect);
  expect(callsAfterReconnect).toEqual([]); // nothing reissued — the goal is gone, not stale-resent
});

it('gate: the ordinary case sends exactly once, dedup intact, no double-send on a no-op reconnect', () => {
  const bridge = fakeDllBridge();
  const movement = new MovementController(
    { clientRef: { current: { connected: true } }, dllBridge: bridge } as unknown as BridgeDeps,
  );
  vi.mocked(sendDllFeature).mockReturnValue(true);

  // A connect before any goal exists (e.g. app startup) has nothing to reissue.
  bridge.fire();
  expect(sendDllFeature).not.toHaveBeenCalled();

  // Steady state: the script reaffirms the same goal every tick; dedup blocks all
  // but the first send.
  movement.navigateTo(10, 20);
  movement.navigateTo(10, 20);
  movement.navigateTo(10.1, 20); // within TARGET_EPSILON
  expect(sendDllFeature).toHaveBeenCalledTimes(1);

  // A reconnect where nothing changed (same map, same goal) reissues exactly
  // once — not once per some duplicated internal wiring.
  bridge.fire();
  expect(sendDllFeature).toHaveBeenCalledTimes(2);
});
