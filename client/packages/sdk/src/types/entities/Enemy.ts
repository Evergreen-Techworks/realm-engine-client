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
    isEnraged: boolean;
    isBoss: boolean;
    isTargetingMe: boolean;
    /** False while dead, stasised, invincible, or invulnerable. */
    isTargetable: boolean;
    isInvulnerable: boolean;
}
