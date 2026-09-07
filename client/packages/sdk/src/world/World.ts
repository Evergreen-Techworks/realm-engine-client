export class World {
    /** Full server map dimensions; zero until MAPINFO arrives. */
    static getSize(): { width: number; height: number } {
        throw new Error('Must be run inside RealmEngine client');
    }

    static isNexus(): boolean {
        throw new Error('Must be run inside RealmEngine client');
    }

    static isRealm(): boolean {
        throw new Error('Must be run inside RealmEngine client');
    }

    static isDungeon(): boolean {
        throw new Error('Must be run inside RealmEngine client');
    }

    static isVault(): boolean {
        throw new Error('Must be run inside RealmEngine client');
    }

    static getName(): string {
        throw new Error('Must be run inside RealmEngine client');
    }
}
