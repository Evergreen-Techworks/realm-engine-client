import type { Position } from '../types/world/Position';

export type DodgeMode = 'off' | 'xdodge' | 'rollout-grid' | 'rollout-quad' | 'zdodge' | 're-plus-plus' | 'pj-dodge' | 'unified';

export interface NavigationStatus {
    goalKind: 'point' | 'ring';
    goalId: number;
    generation: number;
    state: 'routing' | 'arrived' | 'partial' | 'unreachable';
    reason: string;
    position: { x: number; y: number };
}

/** Script-facing control surface for the native dodge/pathfinding system. */
export class Dodge {
    static setMode(_mode: DodgeMode): boolean { throw new Error('Must be run inside RealmEngine client'); }
    static navigateTo(_x: number, _y: number): boolean { throw new Error('Must be run inside RealmEngine client'); }
    static navigateToPosition(_position: Position): boolean { throw new Error('Must be run inside RealmEngine client'); }
    static onNavigationStatus(_handler: (status: NavigationStatus) => void): () => void { throw new Error('Must be run inside RealmEngine client'); }
    static clearWaypoint(): void { throw new Error('Must be run inside RealmEngine client'); }
    static setGroupPreference(_bossId: number, _x: number, _y: number): boolean { throw new Error('Must be run inside RealmEngine client'); }
    static clearGroupPreference(): void { throw new Error('Must be run inside RealmEngine client'); }
    /** Force both uDodge lock-follow and KillAura to use this enemy instance. */
    static lockEnemy(_objectId: number): boolean { throw new Error('Must be run inside RealmEngine client'); }
    static clearEnemyLock(): void { throw new Error('Must be run inside RealmEngine client'); }
    static setLockFollow(_enabled: boolean): boolean { throw new Error('Must be run inside RealmEngine client'); }
    /** Enable native automatic enemy selection. Scripts that own locks should disable this. */
    static setAutopilot(_enabled: boolean): boolean { throw new Error('Must be run inside RealmEngine client'); }
    static setSafeWalk(_enabled: boolean): boolean { throw new Error('Must be run inside RealmEngine client'); }
}
