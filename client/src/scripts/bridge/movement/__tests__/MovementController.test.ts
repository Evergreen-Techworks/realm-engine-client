import { expect, it, vi } from 'vitest';
import { MovementController } from '../MovementController.js';
import { sendDllFeature } from '../../../../bridge/DllFeatureBus.js';
import type { BridgeDeps } from '../../BridgeDeps.js';
vi.mock('../../../../bridge/DllFeatureBus.js', () => ({ sendDllFeature: vi.fn(() => true) }));
it('clears native waypoints even with no script target cached', () => {
  const movement = new MovementController({ clientRef: { current: { connected: true } } } as unknown as BridgeDeps);
  movement.clearWaypoint();
  expect(sendDllFeature).toHaveBeenCalledWith('walkTargetActive', false);
  movement.navigateTo(10, 20); movement.clearWaypoint();
  expect(movement.getTarget()).toBeNull();
  expect(sendDllFeature).toHaveBeenLastCalledWith('walkTargetActive', false);
});
it('sends a bounded atomic group preference without changing aim or waypoint ownership', () => {
  vi.mocked(sendDllFeature).mockClear();
  const movement = new MovementController({ clientRef: { current: { connected: true } } } as unknown as BridgeDeps);
  expect(movement.setGroupPreference(42, 10, 20)).toBe(true);
  expect(sendDllFeature).toHaveBeenCalledOnce();
  expect(sendDllFeature).toHaveBeenCalledWith('scriptMbcGroupGoal', '42,10,20');
  expect(movement.setGroupPreference(42, NaN, 20)).toBe(false);
  movement.clearGroupPreference();
  expect(sendDllFeature).toHaveBeenLastCalledWith('scriptMbcGroupGoal', '');
});
