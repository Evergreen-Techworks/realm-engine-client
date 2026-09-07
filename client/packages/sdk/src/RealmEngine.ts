import { Self } from './self/Self';
import { Walking } from './walking/Walking';
import { Combat } from './combat/Combat';
import { Players } from './players/Players';
import { Enemies } from './enemies/Enemies';
import { inventory } from './inventory';
import { Vault } from './vault/Vault';
import { World } from './world/World';
import { Tiles } from './world/tiles/Tiles';
import { Objects } from './world/objects/Objects';
import { Projectiles } from './world/projectiles/Projectiles';
import { Log } from './log/Log';
import { Settings } from './settings/Settings';
import { Timing } from './timing/Timing';
import { chat } from './chat';
import { party } from './party';
import { trade } from './trade';
import { events } from './events';
import { loot } from './loot';
import { discord } from './discord';
import { panel } from './ui/Panel';
import { Dodge } from './dodge/Dodge';

export const RealmEngine = {
    self: Self,
    walking: Walking,
    dodge: Dodge,
    combat: Combat,
    players: Players,
    enemies: Enemies,
    inventory,
    vault: Vault,
    world: {
        // Delegate at call time instead of copying the initial SDK stubs.
        // The host installs its implementations onto World after this facade
        // has been created, so captured references would keep throwing the
        // standalone-SDK "Must be run inside RealmEngine client" error.
        isNexus: () => World.isNexus(),
        isRealm: () => World.isRealm(),
        isDungeon: () => World.isDungeon(),
        isVault: () => World.isVault(),
        getName: () => World.getName(),
        getSize: () => World.getSize(),
        tiles: Tiles,
        objects: Objects,
        projectiles: Projectiles,
    },
    log: Log,
    settings: Settings,
    timing: Timing,
    chat,
    party,
    trade,
    events,
    loot,
    discord,
    /**
     * User-facing dashboard status (wired in Realm Engine host).
     * @example RealmEngine.ui.status('Killing Gods');
     */
    ui: {
        status(_label: string | null | undefined): void {
            throw new Error('Must be run inside RealmEngine client');
        },
        /** Same as `status` — clears when label is null/blank after trim. */
        setStatus(_label: string | null | undefined): void {
            throw new Error('Must be run inside RealmEngine client');
        },
        /**
         * Declarative popout panel for this script. Define widgets once; the
         * dashboard renders them in a centered modal and forwards events back.
         * See `@realmengine/sdk` `Panel` for widget factories.
         */
        panel,
    },
};
