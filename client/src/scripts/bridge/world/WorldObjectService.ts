import { Position } from '@realmengine/sdk';
import type { GameObject, Portal, ObjectCategory } from '@realmengine/sdk';
import type { BridgeDeps } from '../BridgeDeps.js';
import type { TrackedEntity } from '../../../state/GameWorldState.js';
import { StatType } from '../../../constants/StatType.js';

const REALM_CAPACITY = 85;
const REALM_PORTAL_TYPES = new Set([0x0704, 0x070e, 0x0712, 0x071c]);

/**
 * Canonical projection from unified packet world-state + game-data metadata to
 * stable SDK domain objects. SDK bridges must consume this service instead of
 * independently reconstructing entities and guessing their semantics.
 */
export class WorldObjectService {
  constructor(private readonly deps: BridgeDeps) {}

  private nameOf(entity: TrackedEntity): string {
    const def = this.deps.gameData.getObject(entity.objectType);
    return def?.displayId || def?.id || `Object 0x${entity.objectType.toString(16)}`;
  }

  toGameObject(entity: TrackedEntity): GameObject {
    const def = this.deps.gameData.getObject(entity.objectType);
    const hp = Number(entity.stats?.[String(StatType.HP)]);
    const maxHp = Number(entity.stats?.[String(StatType.MaxHP)] ?? def?.maxHp);
    return {
      isEventBoss: def?.isEventBoss,
      minimapIcon: def?.minimapIcon,
      minimapColor: def?.minimapColor,
      hp: Number.isFinite(hp) ? hp : undefined,
      maxHp: Number.isFinite(maxHp) ? maxHp : undefined,
      objectType: entity.objectType,
      objectClass: def?.objectClass,
      objectId: entity.objectId,
      name: this.nameOf(entity),
      position: new Position(entity.pos.x, entity.pos.y),
    };
  }

  all(): GameObject[] {
    return this.deps.worldState.getEntitiesSnapshot().map((entity) => this.toGameObject(entity));
  }

  entity(objectId: number): TrackedEntity | undefined {
    return this.deps.worldState.getEntity(objectId);
  }

  category(objectType: number): ObjectCategory | null {
    return this.deps.gameData.getObject(objectType)
      ? this.deps.gameData.getObjectCategory(objectType) as ObjectCategory
      : null;
  }

  byCategory(category: ObjectCategory): GameObject[] {
    return this.deps.worldState.getEntitiesSnapshot()
      .filter((entity) => this.category(entity.objectType) === category)
      .map((entity) => this.toGameObject(entity));
  }

  private destinationOf(entity: TrackedEntity): string {
    const def = this.deps.gameData.getObject(entity.objectType);
    if (def?.dungeonName) return def.dungeonName;
    const name = def?.displayId || def?.id || '';
    if (REALM_PORTAL_TYPES.has(entity.objectType) || /realm portal/i.test(name)) return 'Realm';
    return name.replace(/\s+portal$/i, '').trim();
  }

  private enterPortal(objectId: number): boolean {
    const client = this.deps.clientRef.current;
    if (!client?.connected || !this.deps.worldState.getEntity(objectId)) return false;
    try {
      const packet = this.deps.proxy.packetFactory.createByName('USEPORTAL');
      packet.data.objectId = objectId;
      packet.modified = true;
      client.sendToServer(packet);
      return true;
    } catch {
      return false;
    }
  }

  toPortal(entity: TrackedEntity): Portal | null {
    if (this.category(entity.objectType) !== 'Portal') return null;
    const base = this.toGameObject(entity);
    const count = Number(entity.stats?.[String(StatType.PortalPlayerCount)] ?? 0);
    const playerCount = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
    const destination = this.destinationOf(entity);
    const isRealm = destination.toLowerCase() === 'realm'
      || destination.toLowerCase() === 'random realm';
    return {
      ...base,
      destination,
      isRealm,
      isOpen: playerCount < REALM_CAPACITY,
      playerCount,
      enter: () => this.enterPortal(entity.objectId),
    };
  }

  portals(): Portal[] {
    const origin = this.deps.clientRef.current?.playerData.pos;
    const portals = this.deps.worldState.getEntitiesSnapshot()
      .map((entity) => this.toPortal(entity))
      .filter((portal): portal is Portal => portal != null);
    if (!origin) return portals;
    return portals.sort((a, b) =>
      Math.hypot(a.position.x - origin.x, a.position.y - origin.y)
      - Math.hypot(b.position.x - origin.x, b.position.y - origin.y));
  }
}
