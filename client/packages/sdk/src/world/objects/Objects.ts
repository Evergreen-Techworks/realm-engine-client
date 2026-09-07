import { GameObject } from '../../types/entities/GameObject';
import { Enemy } from '../../types/entities/Enemy';
import { PlayerEntity } from '../../types/entities/PlayerEntity';
import { Container } from '../../types/entities/Container';
import { Portal } from '../../types/world/Portal';
import { Position } from '../../types/world/Position';
import { ObjectCategory } from '../../types/world/ObjectCategory';

/**
 * Everything standing on the current map (`RealmEngine.world.objects`).
 *
 * This is the **generic** view — every enemy, portal, player, container,
 * pet, beacon, projectile, prop etc. comes back as a {@link GameObject}
 * so scripts can filter by category, position, or name without caring
 * about its specialised namespace.
 *
 * Prefer {@link Enemies} / {@link Players} / {@link Portals} when you
 * already know what you're looking for — they return richer typed
 * entities (HP, class, portal helpers, etc.).
 */
export class Objects {
    // ─── Basic lookup ───────────────────────────────────────────────────────

    /** Every tracked object on the current map. */
    static getAll(): GameObject[] {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** Tracked object by runtime `objectId`, or `null` if it left the map. */
    /** True only when the server has confirmed this object's death in this map. */
    static isDead(objectId: number): boolean {
        throw new Error('Must be run inside RealmEngine client');
    }

    static getById(objectId: number): GameObject | null {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** All objects that share a specific non-instanced `objectType`. */
    static getByType(objectType: number): GameObject[] {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** Total number of tracked objects on the current map. */
    static count(): number {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** `true` when `objectId` is still present on the map. */
    static exists(objectId: number): boolean {
        throw new Error('Must be run inside RealmEngine client');
    }

    // ─── By category ────────────────────────────────────────────────────────

    /** Every object whose game-data category matches (e.g. `'Enemy'`, `'Container'`). */
    static getByCategory(category: ObjectCategory): GameObject[] {
        throw new Error('Must be run inside RealmEngine client');
    }

    /**
     * All enemies on the map with enemy-specific fields filled in.
     * Equivalent to `RealmEngine.enemies.getAll()` but returned through
     * the generic objects API.
     */
    static getEnemies(): Enemy[] {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** All player-like entities on the map (includes you). */
    static getPlayers(): PlayerEntity[] {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** All portals on the map (realm portals, dungeon portals, etc.). */
    static getPortals(): Portal[] {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** All containers on the map — loot bags, vault chests, gift chests, etc. */
    static getContainers(): Container[] {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** All pet entities on the map. */
    static getPets(): GameObject[] {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** All beacon entities on the map (guild beacons, event beacons, …). */
    static getBeacons(): GameObject[] {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** The current quest object (beacon/boss the server is pointing you at), or `null` if none. */
    static getQuestObject(): GameObject | null {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** Live instance id from the server's QUESTOBJECTID stat (>0 during a tracked step); `-1` if none. */
    static getQuestTargetId(): number {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** RotMG `objectType` for that instance when tracked, or inferred when exactly one `<Quest>` type is visible; `-1` if unknown. */
    static getQuestTargetType(): number {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** Alias for {@link getQuestTargetId}. */
    static getQuestId(): number {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** Alias for {@link getQuestTargetType}. */
    static getQuestType(): number {
        throw new Error('Must be run inside RealmEngine client');
    }

    // ─── Spatial ────────────────────────────────────────────────────────────

    /** Closest object to you of any kind, or `null` if the map is empty. */
    static getNearest(): GameObject | null {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** Closest object to the given world position, or `null`. */
    static getNearestTo(position: Position): GameObject | null {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** Closest object of a specific `objectType` to you, or `null`. */
    static getNearestOfType(objectType: number): GameObject | null {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** Closest object in a given category to you, or `null`. */
    static getNearestOfCategory(category: ObjectCategory): GameObject | null {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** All objects within `radius` tiles of you (unsorted). */
    static getWithinRadius(radius: number): GameObject[] {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** All objects within `radius` tiles of `position` (unsorted). */
    static getWithinRadiusFrom(position: Position, radius: number): GameObject[] {
        throw new Error('Must be run inside RealmEngine client');
    }

    /**
     * All objects inside an axis-aligned world rectangle, inclusive on every edge.
     * Useful for scanning a single room or a dungeon arena.
     */
    static getWithinBounds(minX: number, minY: number, maxX: number, maxY: number): GameObject[] {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** Every tracked object sorted by distance from you, nearest first. */
    static sortByDistance(): GameObject[] {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** Every tracked object sorted by distance from `position`, nearest first. */
    static sortByDistanceFrom(position: Position): GameObject[] {
        throw new Error('Must be run inside RealmEngine client');
    }

    // ─── Name lookups ───────────────────────────────────────────────────────

    /** First object whose display name case-insensitively equals `name`. */
    static findByName(name: string): GameObject | null {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** Every object whose display name case-insensitively equals `name`. */
    static findAllByName(name: string): GameObject[] {
        throw new Error('Must be run inside RealmEngine client');
    }

    // ─── Portal helpers ─────────────────────────────────────────────────────

    /** First portal whose display name case-insensitively equals `name`. */
    static findPortal(name: string): Portal | null {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** Closest portal to you, or `null` if the map has none. */
    static getNearestPortal(): Portal | null {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** Every portal currently in its "open" state (walkable by players). */
    static getOpenPortals(): Portal[] {
        throw new Error('Must be run inside RealmEngine client');
    }

    // ─── Container helpers ──────────────────────────────────────────────────

    /** Closest container to you — convenient for auto-loot logic. */
    static getNearestContainer(): Container | null {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** First container whose display name case-insensitively equals `name`. */
    static findContainer(name: string): Container | null {
        throw new Error('Must be run inside RealmEngine client');
    }

    // ─── Introspection (game-data lookups, no runtime required) ─────────────

    /**
     * Category bucket for an `objectType` (`'Enemy'`, `'Portal'`, `'Container'`, …),
     * or `null` when the type is not found in the loaded game data.
     */
    static getCategory(objectType: number): ObjectCategory | null {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** Display name from game data for a given `objectType` (e.g. `'Dungeon Portal'`). */
    static getTypeName(objectType: number): string {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** Shortcut for `getCategory(objectType) === 'Enemy'`. */
    static isEnemy(objectType: number): boolean {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** Shortcut for `getCategory(objectType) === 'Portal'`. */
    static isPortal(objectType: number): boolean {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** Shortcut for `getCategory(objectType) === 'Container'`. */
    static isContainer(objectType: number): boolean {
        throw new Error('Must be run inside RealmEngine client');
    }

    /** `true` when game data marks this type as a boss (quest flag or high maxHp). */
    static isBoss(objectType: number): boolean {
        throw new Error('Must be run inside RealmEngine client');
    }

    // ─── Presence checks ────────────────────────────────────────────────────

    /** `true` when at least one object of `objectType` is on the map. */
    static hasType(objectType: number): boolean {
        throw new Error('Must be run inside RealmEngine client');
    }
}
