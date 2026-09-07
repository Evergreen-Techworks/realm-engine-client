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
