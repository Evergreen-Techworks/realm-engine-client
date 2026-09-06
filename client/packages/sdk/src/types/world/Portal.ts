import { GameObject } from '../entities/GameObject';

/** A tracked portal enriched with its game-data destination semantics. */
export interface Portal extends GameObject {
    /** Destination from `<DungeonName>`, or an inferred stable destination. */
    destination: string;
    /** True only for entrances that lead from Nexus into a Realm. */
    isRealm: boolean;
    isOpen: boolean;
    playerCount: number;
    enter(): boolean;
}
