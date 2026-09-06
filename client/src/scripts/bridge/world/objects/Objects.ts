import { Objects, Enemies, Players, Position } from '@realmengine/sdk';
import type {
  GameObject,
  Enemy,
  PlayerEntity,
  Portal,
  Container,
  ObjectCategory,
} from '@realmengine/sdk';
import type { BridgeDeps } from '../../BridgeDeps.js';
import { WorldObjectService } from '../WorldObjectService.js';

export class BridgeObjects {
  static install(deps: BridgeDeps): void {
    const world = new WorldObjectService(deps);

    // ─── Basic lookup ─────────────────────────────────────────────────────
    Objects.getAll = (): GameObject[] => {
      return world.all();
    };
    Objects.getById = (objectId: number): GameObject | null => {
      const entity = world.entity(objectId);
      return entity ? world.toGameObject(entity) : null;
    };
    Objects.getByType = (objectType: number): GameObject[] => {
      return world.all().filter((object) => object.objectType === objectType);
    };
    Objects.count = (): number => {
      return world.all().length;
    };
    Objects.exists = (objectId: number): boolean => {
      return world.entity(objectId) != null;
    };

    // ─── By category ──────────────────────────────────────────────────────
    Objects.getByCategory = (category: ObjectCategory): GameObject[] => {
      return world.byCategory(category);
    };
    Objects.getEnemies = (): Enemy[] => {
      return Enemies.getAll();
    };
    Objects.getPlayers = (): PlayerEntity[] => {
      return Players.getAll();
    };
    Objects.getPortals = (): Portal[] => {
      return world.portals();
    };
    Objects.getContainers = (): Container[] => {
      return world.byCategory('Container') as Container[];
    };
    Objects.getPets = (): GameObject[] => {
      return world.byCategory('Pet');
    };
    Objects.getBeacons = (): GameObject[] => {
      return world.byCategory('Beacon');
    };

    Objects.getQuestObject = (): GameObject | null => {
      const c = deps.clientRef.current;
      if (!c) return null;
      const questOid = c.playerData.questObjectId;
      if (questOid <= 0) return null;
      const entity = world.entity(questOid);
      return entity ? world.toGameObject(entity) : null;
    };

    Objects.getQuestTargetId = (): number => {
      const c = deps.clientRef.current;
      const raw = c?.playerData?.questObjectId;
      const id = typeof raw === 'number' ? raw : Number(raw);
      return Number.isFinite(id) && id > 0 ? Math.trunc(id) : -1;
    };

    Objects.getQuestTargetType = (): number => {
      const c = deps.clientRef.current;
      if (!c) return -1;
      const qid = Number(c.playerData.questObjectId);
      if (!(qid > 0)) return -1;
      const resolved = deps.worldState.resolveQuestTargetObjectType(qid, deps.gameData);
      return resolved != null && resolved > 0 ? resolved : -1;
    };

    Objects.getQuestId = Objects.getQuestTargetId;
    Objects.getQuestType = Objects.getQuestTargetType;

    // ─── Spatial ──────────────────────────────────────────────────────────
    Objects.getNearest = (): GameObject | null => {
      return Objects.sortByDistance()[0] ?? null;
    };
    Objects.getNearestTo = (position: import('@realmengine/sdk').Position): GameObject | null => {
      return Objects.sortByDistanceFrom(position)[0] ?? null;
    };
    Objects.getNearestOfType = (objectType: number): GameObject | null => {
      const origin = deps.clientRef.current?.playerData.pos;
      const objects = Objects.getByType(objectType);
      return origin
        ? objects.sort((a, b) => Math.hypot(a.position.x - origin.x, a.position.y - origin.y)
          - Math.hypot(b.position.x - origin.x, b.position.y - origin.y))[0] ?? null
        : objects[0] ?? null;
    };
    Objects.getNearestOfCategory = (category: ObjectCategory): GameObject | null => {
      const allowed = new Set(Objects.getByCategory(category).map((object) => object.objectId));
      return Objects.sortByDistance().find((object) => allowed.has(object.objectId)) ?? null;
    };
    Objects.getWithinRadius = (radius: number): GameObject[] => {
      const origin = deps.clientRef.current?.playerData.pos;
      return origin ? Objects.getWithinRadiusFrom(new Position(origin.x, origin.y), radius) : [];
    };
    Objects.getWithinRadiusFrom = (position: import('@realmengine/sdk').Position, radius: number): GameObject[] => {
      const r = Math.max(0, Number(radius));
      return world.all().filter((object) =>
        Math.hypot(object.position.x - position.x, object.position.y - position.y) <= r);
    };
    Objects.getWithinBounds = (
      _minX: number,
      _minY: number,
      _maxX: number,
      _maxY: number,
    ): GameObject[] => {
      return world.all().filter((object) => object.position.x >= _minX && object.position.x <= _maxX
        && object.position.y >= _minY && object.position.y <= _maxY);
    };
    Objects.sortByDistance = (): GameObject[] => {
      const origin = deps.clientRef.current?.playerData.pos;
      return origin ? Objects.sortByDistanceFrom(new Position(origin.x, origin.y)) : world.all();
    };
    Objects.sortByDistanceFrom = (position: import('@realmengine/sdk').Position): GameObject[] => {
      return world.all().sort((a, b) => Math.hypot(a.position.x - position.x, a.position.y - position.y)
        - Math.hypot(b.position.x - position.x, b.position.y - position.y));
    };

    // ─── Name lookups ─────────────────────────────────────────────────────
    Objects.findByName = (name: string): GameObject | null => {
      const q = name.trim().toLowerCase();
      return world.all().find((object) => object.name.trim().toLowerCase() === q) ?? null;
    };
    Objects.findAllByName = (name: string): GameObject[] => {
      const q = name.trim().toLowerCase();
      return world.all().filter((object) => object.name.trim().toLowerCase() === q);
    };

    // ─── Portal helpers ───────────────────────────────────────────────────
    Objects.findPortal = (name: string): Portal | null => {
      const q = name.trim().toLowerCase();
      return Objects.getPortals().find((p) => p.name.toLowerCase() === q
        || p.destination.toLowerCase() === q) ?? null;
    };
    Objects.getNearestPortal = (): Portal | null => {
      return Objects.getPortals()[0] ?? null;
    };
    Objects.getOpenPortals = (): Portal[] => {
      return Objects.getPortals().filter((p) => p.isOpen);
    };

    // ─── Container helpers ────────────────────────────────────────────────
    Objects.getNearestContainer = (): Container | null => {
      return Objects.getNearestOfCategory('Container') as Container | null;
    };
    Objects.findContainer = (name: string): Container | null => {
      const object = Objects.findByName(name);
      return object && world.category(object.objectType) === 'Container' ? object as Container : null;
    };

    // ─── Introspection ────────────────────────────────────────────────────
    Objects.getCategory = (_objectType: number): ObjectCategory | null => {
      return world.category(_objectType);
    };
    Objects.getTypeName = (_objectType: number): string => {
      const def = deps.gameData.getObject(_objectType);
      return def?.displayId || def?.id || '';
    };
    Objects.isEnemy = (_objectType: number): boolean => {
      return world.category(_objectType) === 'Enemy';
    };
    Objects.isPortal = (_objectType: number): boolean => {
      return deps.gameData.getObjectCategory(_objectType) === 'Portal';
    };
    Objects.isContainer = (_objectType: number): boolean => {
      return world.category(_objectType) === 'Container';
    };
    Objects.isBoss = (_objectType: number): boolean => {
      return deps.gameData.isBoss(_objectType);
    };

    // ─── Presence ─────────────────────────────────────────────────────────
    Objects.hasType = (_objectType: number): boolean => {
      return deps.worldState.getEntitiesSnapshot().some((entity) => entity.objectType === _objectType);
    };
  }
}
