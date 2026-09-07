import { GameObject } from './GameObject';
import { Stats } from './Stats';

export interface PlayerEntity extends GameObject {
    /** Timestamp of the last server update, in milliseconds. */
    lastUpdate?: number;
    hp: number;
    maxHp: number;
    mp: number;
    maxMp: number;
    stats: Stats;
    className: string;
}
