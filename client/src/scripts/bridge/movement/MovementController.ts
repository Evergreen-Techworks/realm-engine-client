import { Position } from '@realmengine/sdk';
import type { DodgeMode } from '@realmengine/sdk';
import type { BridgeDeps } from '../BridgeDeps.js';
import { sendDllFeature } from '../../../bridge/DllFeatureBus.js';

const MODE_INDEX: Record<DodgeMode, number> = {
  off: 0,
  xdodge: 1,
  'rollout-grid': 2,
  'rollout-quad': 3,
  zdodge: 4,
  're-plus-plus': 5,
  'pj-dodge': 6,
  unified: 7,
};

/** Single SDK movement adapter backed by the DLL's unified movement planner. */
export class MovementController {
  private target: Position | null = null;

  /** Avoid flooding the native feature pipe from script loops that reaffirm a waypoint. */
  private static readonly TARGET_EPSILON = 0.25;

  constructor(private readonly deps: BridgeDeps) {}

  setMode(mode: DodgeMode): boolean {
    return sendDllFeature('autoDodgeMode', MODE_INDEX[mode]);
  }

  navigateTo(x: number, y: number): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !this.deps.clientRef.current?.connected) return false;
    if (this.target && Math.hypot(this.target.x - x, this.target.y - y) < MovementController.TARGET_EPSILON) {
      return true;
    }

    const sentX = sendDllFeature('walkTargetX', x);
    const sentY = sendDllFeature('walkTargetY', y);
    const sentActive = sendDllFeature('walkTargetActive', true);
    if (sentX && sentY && sentActive) this.target = new Position(x, y);
    return sentX && sentY && sentActive;
  }

  clearWaypoint(): void {
    // Native/manual waypoints may exist even when this adapter has no target.
    // A clear command must reach the movement owner, including on map entry.
    if (sendDllFeature('walkTargetActive', false)) this.target = null;
  }

  getTarget(): Position | null {
    return this.target;
  }

  lockEnemy(objectId: number): boolean {
    if (!Number.isFinite(objectId) || objectId <= 0) return false;
    return sendDllFeature('scriptEnemyLockId', Math.trunc(objectId));
  }

  clearEnemyLock(): void {
    sendDllFeature('scriptEnemyLockId', 0);
  }

  setLockFollow(enabled: boolean): boolean {
    return sendDllFeature('udodgeLockFollow', !!enabled);
  }

  setAutopilot(enabled: boolean): boolean {
    return sendDllFeature('udodgeAutopilot', !!enabled);
  }

  setSafeWalk(enabled: boolean): boolean {
    return sendDllFeature('udodgeSafeWalk', !!enabled);
  }
}
