import { Dodge } from '@realmengine/sdk';
import type { Position, DodgeMode } from '@realmengine/sdk';
import type { MovementController } from '../movement/MovementController.js';

export class BridgeDodge {
  static install(movement: MovementController): void {
    Dodge.setMode = (mode: DodgeMode) => movement.setMode(mode);
    Dodge.navigateTo = (x: number, y: number) => movement.navigateTo(x, y);
    Dodge.navigateToPosition = (p: Position) => Dodge.navigateTo(Number(p?.x), Number(p?.y));
    Dodge.clearWaypoint = () => movement.clearWaypoint();
    Dodge.lockEnemy = (objectId: number) => movement.lockEnemy(objectId);
    Dodge.clearEnemyLock = () => movement.clearEnemyLock();
    Dodge.setLockFollow = (enabled: boolean) => movement.setLockFollow(enabled);
    Dodge.setAutopilot = (enabled: boolean) => movement.setAutopilot(enabled);
    Dodge.setSafeWalk = (enabled: boolean) => movement.setSafeWalk(enabled);
  }
}
