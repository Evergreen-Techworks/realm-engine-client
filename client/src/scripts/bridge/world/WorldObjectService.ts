import { Position } from '@realmengine/sdk';
import type { GameObject, Portal, ObjectCategory } from '@realmengine/sdk';
import type { BridgeDeps } from '../BridgeDeps.js';
import type { TrackedEntity } from '../../../state/GameWorldState.js';
import { StatType } from '../../../constants/StatType.js';
import { Logger } from '../../../util/Logger.js';

const REALM_CAPACITY = 85;
const REALM_PORTAL_TYPES = new Set([0x0704, 0x070e, 0x0712, 0x071c]);

/**
 * An attempt that produced neither a map load nor a refusal within this window
 * went unanswered — let a retry through instead of latching forever.
 */
const PORTAL_ATTEMPT_TIMEOUT_MS = 5000;
/**
 * Hard floor on how often this connection sends USEPORTAL, independent of the
 * attempt latch above. Rapid automated portal use has gotten this project's
 * egress IP temp-banned before — keep it human-paced no matter what the caller does.
 */
const PORTAL_MIN_SEND_INTERVAL_MS = 3000;
/** A drop reason logs once immediately, then at most once per this interval. */
const PORTAL_DROP_LOG_INTERVAL_MS = 10000;
/** Fallback dedupe store for the (practically nonexistent) case there is no client to hang state on. */
const noClientDropLogAt: Record<string, number> = {};

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
      blocksMovement: def?.occupySquare === true,
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

  /**
   * Logs a USEPORTAL drop with its reason, rate-limited per reason so a fast
   * retry loop cannot flood the log: first occurrence logs immediately, then
   * at most once every PORTAL_DROP_LOG_INTERVAL_MS for that same reason.
   */
  private logPortalDrop(client: BridgeDeps['clientRef']['current'], objectId: number, reasonKind: string, detail: string): void {
    const now = Date.now();
    const store = client ? (client.portalDropLogAt ??= {}) : noClientDropLogAt;
    const last = store[reasonKind];
    if (last !== undefined && now - last < PORTAL_DROP_LOG_INTERVAL_MS) return;
    store[reasonKind] = now;
    Logger.log('Portal', `USEPORTAL drop objectId=${objectId} reason=${detail}`);
  }

  private enterPortal(objectId: number, owner: BridgeDeps['clientRef']['current'], generation: number | undefined): boolean {
    const client = this.deps.clientRef.current;
    const now = Date.now();
    if (!client?.connected || !this.deps.worldState.getEntity(objectId)) {
      this.logPortalDrop(client, objectId, 'not-connected', 'not-connected');
      return false;
    }
    if (client !== owner || client.admission?.generation !== generation) {
      this.logPortalDrop(client, objectId, 'stale-owner', 'stale-owner');
      return false;
    }
    const admission = client.admission;
    if (!admission || !['loaded', 'entry-refused'].includes(admission.phase)) {
      this.logPortalDrop(client, objectId, 'phase', `phase=${admission?.phase ?? 'none'}`);
      return false;
    }
    if (admission.phase === 'entry-refused' && admission.portalId === objectId && (admission.retryAt ?? Infinity) > now) {
      this.logPortalDrop(client, objectId, 'refused-until', `refused-until=${admission.retryAt}`);
      return false;
    }
    if (client.lastAttemptedPortalId !== null) {
      const pendingMs = now - (client.lastPortalAttemptAt ?? 0);
      if (pendingMs < PORTAL_ATTEMPT_TIMEOUT_MS) {
        this.logPortalDrop(client, objectId, 'attempt-pending', `attempt-pending ${pendingMs}ms`);
        return false;
      }
      // The last attempt produced neither a map load nor a refusal within the
      // timeout: it went unanswered. Do not theorise why here — just stop
      // latching forever and let a retry through, on its own pace below.
      client.lastAttemptedPortalId = null;
    }
    const sinceLastSend = now - (client.lastPortalAttemptAt ?? 0);
    if (sinceLastSend < PORTAL_MIN_SEND_INTERVAL_MS) {
      this.logPortalDrop(client, objectId, 'attempt-pending', `attempt-pending ${sinceLastSend}ms`);
      return false;
    }
    try {
      const packet = this.deps.proxy.packetFactory.createByName('USEPORTAL');
      packet.data.objectId = objectId;
      packet.modified = true;
      client.lastAttemptedPortalId = objectId;
      client.lastPortalAttemptAt = now;
      client.portalAttemptCount = client.portalAttemptObjectId === objectId ? (client.portalAttemptCount ?? 0) + 1 : 1;
      client.portalAttemptObjectId = objectId;
      client.sendToServer(packet);
      Logger.log('Portal', `USEPORTAL sent objectId=${objectId} attempt=${client.portalAttemptCount}`);
      return true;
    } catch {
      client.lastAttemptedPortalId = null;
      this.logPortalDrop(client, objectId, 'serialize-error', 'serialize-error');
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
    const owner = this.deps.clientRef.current;
    const admission = owner?.admission;
    const generation = admission?.generation;
    const queued = admission?.phase === 'queued' || admission?.phase === 'admission-pending';
    const refused = admission?.phase === 'entry-refused' && admission.portalId === entity.objectId && (admission.retryAt ?? Infinity) > Date.now();
    return {
      ...base,
      destination,
      isRealm,
      isOpen: playerCount < REALM_CAPACITY,
      playerCount,
      availability: queued ? 'queued' : refused ? 'full' : admission?.phase === 'loaded' || admission?.phase === 'entry-refused' ? 'available' : 'unknown',
      retryAt: refused ? admission?.retryAt ?? undefined : undefined,
      enter: () => this.enterPortal(entity.objectId, owner, generation),
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
