import { Position } from '@realmengine/sdk';
import type { DodgeMode, NavigationStatus } from '@realmengine/sdk';
import { nextNavigationId, subscribeNavigationStatus } from '../../../bridge/DllNavigationBus.js';
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
  private requestId = 0;
  private generation = -1;
  private listeners = new Set<(status: NavigationStatus) => void>();
  private unsubscribe: (() => void) | null = null;

  /** Avoid flooding the native feature pipe from script loops that reaffirm a waypoint. */
  private static readonly TARGET_EPSILON = 0.25;

  constructor(private readonly deps: BridgeDeps) {
    for (const packet of ['HELLO', 'MAPINFO']) deps.proxy?.hookPacket(packet, () => this.clearWaypoint());
    // The DLL bridge replays ordinary feature toggles on reconnect but deliberately
    // excludes scriptNavigationGoal (see InternalBridge.setFeature) — a blind replay
    // would resend a goal from a map we've since left. clearWaypoint() on HELLO/MAPINFO
    // already drops a goal that's gone stale; if `this.target` is still set here, it's
    // still valid for the current map, so reissue it with a fresh id — the DLL may only
    // half-know the old one after losing the pipe.
    deps.dllBridge?.on('authenticated', () => this.reissueOnReconnect());
  }

  private reissueOnReconnect(): void {
    if (!this.target) return;
    const requestId = nextNavigationId();
    const sent = sendDllFeature('scriptNavigationGoal', `${requestId},${this.target.x},${this.target.y}`);
    if (sent) {
      this.requestId = requestId;
      this.generation = -1;
    }
  }

  onNavigationStatus(handler: (status: NavigationStatus) => void): () => void {
    this.listeners.add(handler);
    this.unsubscribe ??= subscribeNavigationStatus(status => {
      if (!this.target || status.goalKind !== 'point' || status.goalId !== this.requestId
        || status.generation < this.generation) return;
      this.generation = status.generation;
      const event = { ...status, position: { x: this.target.x, y: this.target.y } };
      if (status.state === 'unreachable' || status.state === 'arrived') this.clearWaypoint();
      for (const listener of this.listeners) {
        try { listener(event); } catch { }
      }
    });
    return () => {
      this.listeners.delete(handler);
      if (this.listeners.size === 0) { this.unsubscribe?.(); this.unsubscribe = null; }
    };
  }

  setMode(mode: DodgeMode): boolean {
    return sendDllFeature('autoDodgeMode', MODE_INDEX[mode]);
  }

  navigateTo(x: number, y: number): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !this.deps.clientRef.current?.connected) return false;
    if (this.target && Math.hypot(this.target.x - x, this.target.y - y) < MovementController.TARGET_EPSILON) {
      return true;
    }

    const requestId = nextNavigationId();
    const sent = sendDllFeature('scriptNavigationGoal', `${requestId},${x},${y}`);
    if (sent) {
      this.target = new Position(x, y);
      this.requestId = requestId;
      this.generation = -1;
    }
    return sent;
  }

  clearWaypoint(): void {
    // Native/manual waypoints may exist even when this adapter has no target.
    // A clear command must reach the movement owner, including on map entry.
    this.requestId = 0;
    this.generation = -1;
    this.target = null;
    sendDllFeature('walkTargetActive', false);
  }

  setGroupPreference(bossId: number, x: number, y: number): boolean {
    if (!this.deps.clientRef.current?.connected || !Number.isInteger(bossId) || bossId <= 0 || bossId > 2147483647
      || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 100000 || Math.abs(y) > 100000) return false;
    return sendDllFeature('scriptMbcGroupGoal', `${bossId},${x},${y}`);
  }

  clearGroupPreference(): void {
    sendDllFeature('scriptMbcGroupGoal', '');
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
