import { Position } from '../types/world/Position';
import { Enemy } from '../types/entities/Enemy';

export type CombatAimTarget = number | { objectId: number };

export class Combat {
    /** Enable or disable the native automatic weapon trigger. */
    static setAutoFire(enabled: boolean): boolean {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** Enable or disable the native KillAura target/origin controller. */
    static setKillAura(enabled: boolean): boolean {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** Auto-aim weapon shots at a tracked object id until stopped or changed. */
    static aimAt(target: CombatAimTarget): boolean {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** Aim at a tile; pass world **X** and **Y** as two numbers (same units as `Walking.walkTo`). */
    static aimAtPosition(x: number, y: number): boolean {
        throw new Error('Must be run inside RealmEngine client');
    }

    static stopAiming(): void {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** Disable SDK auto-aim and leave weapon shots at the player's manual aim angle. */
    static autoAimOff(): void {
        throw new Error('Must be run inside RealmEngine client');
    }

    static useAbility(): boolean {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** Use ability toward a tile; **x** and **y** are world coordinates as numbers. */
    static useAbilityAt(x: number, y: number): boolean {
        throw new Error('Must be run inside RealmEngine client');
    }

    static useAbilityOn(enemy: Enemy): boolean {
        throw new Error('Must be run inside RealmEngine client');
    }

    /**
     * Shot accuracy since tracking began (or since the last reset).
     * Returns a 0–1 fraction (multiply by 100 for a percentage).
     * Returns 0 if no shots have been fired.
     */
    static accuracy(): number {
        throw new Error('Must be run inside RealmEngine client');
    }

    /**
     * Shot accuracy over the last `minutes` minutes.
     * Returns a 0–1 fraction. Returns 0 if no shots in the window.
     */
    static recentAccuracy(minutes: number): number {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** Reset the accuracy counters. */
    static resetAccuracy(): void {
        throw new Error('Must be run inside RealmEngine client');
    }
}
