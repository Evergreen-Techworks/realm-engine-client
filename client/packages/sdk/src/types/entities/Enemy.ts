import { GameObject } from './GameObject';
import { Stats } from './Stats';

export interface Enemy extends GameObject {
    /** Spawn biome and enemy group from the loaded game definitions. */
    biome?: string;
    group?: string;
    hp: number;
    maxHp: number;
    defense: number;
    stats: Stats;
    phase: number;
    /** Raw server animation state when available. */
    animation?: number;
    /** Known damage-counter guard animation (currently Oryx 3). */
    isGuarding?: boolean;
    isEnraged: boolean;
    isBoss: boolean;
    isTargetingMe: boolean;
    /** False while dead, stasised, invincible, or invulnerable. */
    isTargetable: boolean;
    isInvulnerable: boolean;
}
