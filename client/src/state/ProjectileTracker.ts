import type { Proxy } from '../proxy/Proxy.js';
import type { ClientConnection } from '../proxy/ClientConnection.js';
import type { Packet } from '../packets/Packet.js';
import type { GameDataLoader, ProjectileDef } from '../game-data/GameDataLoader.js';
import type { GameWorldState } from './GameWorldState.js';
import { Logger } from '../util/Logger.js';
import { sendDllFeature } from '../bridge/DllFeatureBus.js';

export interface TrackedProjectile {
  bulletId: number;
  ownerId: number;
  bulletType: number;
  /** Starting position (from ENEMYSHOOT). */
  startX: number;
  startY: number;
  /** Firing angle in radians. */
  angle: number;
  /** Raw damage from ENEMYSHOOT. */
  damage: number;
  /** Timestamp (ms) when the bullet was created. */
  spawnTime: number;
  /** Projectile definition from game data (null if unknown). */
  projDef: ProjectileDef | null;
}

/**
 * Tracks all active enemy projectiles from ENEMYSHOOT packets.
 * Stores spawn position, angle, damage, and linked ProjectileDef.
 * Trajectory prediction itself lives in the DLL and reaches the client
 * over DllThreatBus.
 *
 * Bullets are keyed by "${ownerId}:${bulletId}" and expire after
 * their lifetime (from game data) or a hard cap of 10 seconds.
 */
export class ProjectileTracker {
  private bullets = new Map<string, TrackedProjectile>();
  private gameData: GameDataLoader | null;
  private worldState: GameWorldState | null;

  constructor(gameData?: GameDataLoader, worldState?: GameWorldState) {
    this.gameData = gameData ?? null;
    this.worldState = worldState ?? null;
  }

  /** Last time expired bullets were swept; the sweep runs at most once per interval. */
  private lastCleanupAt = 0;
  private static readonly CLEANUP_INTERVAL_MS = 1000;

  attach(proxy: Proxy): void {
    proxy.hookPacket('ENEMYSHOOT', (c, p) => this.onEnemyShoot(c, p));
    proxy.hookPacket('MAPINFO', () => this.clear());
    // cleanup() used to have no caller, so every enemy bullet of a realm visit
    // stayed in the map until the next MAPINFO: ~37 MB of retained heap per ten
    // busy realm minutes in the proxy hot-path bench (2026-09-12). Sweep on the
    // server tick, which arrives several times a second while in a world.
    proxy.hookPacket('NEWTICK', () => this.cleanupIfDue());
  }

  private cleanupIfDue(): void {
    const now = Date.now();
    if (now - this.lastCleanupAt < ProjectileTracker.CLEANUP_INTERVAL_MS) return;
    this.lastCleanupAt = now;
    this.cleanup();
  }

  private onEnemyShoot(_client: ClientConnection, packet: Packet): void {
    if (!packet.isDefined) return;

    const bulletId = (packet.data.bulletId as number) & 0xffff;
    const ownerId = packet.data.ownerId as number;
    const bulletType = packet.data.bulletType as number;
    const position = (packet.data.position as { x: number; y: number } | undefined)
      ?? (packet.data.startingPos as { x: number; y: number } | undefined);
    if (!position) return;
    const angle = packet.data.angle as number;
    const damage = packet.data.damage as number;
    const rawNumShots = packet.data.numShots as number | undefined;
    const rawAngleInc = packet.data.angleInc as number | undefined;

    // ENEMYSHOOT optional fields are absent on some packets/builds.
    // Treat missing/invalid as single-shot with no spread.
    let actualShots = Number.isFinite(rawNumShots as number) ? (rawNumShots as number) : 1;
    if (actualShots === 255 || actualShots <= 0) actualShots = 1;
    const angleInc = Number.isFinite(rawAngleInc as number) ? (rawAngleInc as number) : 0;

    // Look up projectile definition from game data
    let projDef: ProjectileDef | null = null;
    if (this.gameData && this.worldState) {
      const entityType = this.worldState.getEntityType(ownerId);
      if (entityType !== undefined) {
        projDef = this.gameData.getProjectile(entityType, bulletType) ?? null;
      }
    }

    for (let i = 0; i < actualShots; i++) {
      const key = `${ownerId}:${bulletId + i}`;
      const shotAngle = angle + i * angleInc;

      this.bullets.set(key, {
        bulletId: bulletId + i,
        ownerId,
        bulletType,
        startX: position.x,
        startY: position.y,
        angle: shotAngle,
        damage,
        spawnTime: Date.now(),
        projDef,
      });

      // Immediate recovery feed for shooters/projectiles that the game runtime
      // has not streamed yet. The DLL deduplicates this provisional record once
      // its authoritative projectile hook sees the same owner/bullet pair.
      const d = projDef;
      sendDllFeature('udodgePacketShot', [
        ownerId, (bulletId + i) & 0xffff, position.x, position.y, shotAngle,
        d?.speed ?? 0, d?.lifetimeMs ?? 0, d?.hitRadius ?? 0.5,
      ].join(','));
    }
  }

  /**
   * Remove expired bullets. Runs from the NEWTICK hook (see attach). A bullet is
   * kept for a grace period past its lifetime because the game client's
   * PLAYERHIT for it (looked up via getBullet) reaches the proxy a network
   * round trip after the hit happened.
   */
  private static readonly EXPIRY_GRACE_MS = 2000;
  cleanup(): void {
    const now = Date.now();
    for (const [key, bullet] of this.bullets) {
      const lifetime = bullet.projDef?.lifetimeMs ?? 10000;
      // Hard cap at 10 seconds even if game data says longer
      const maxLife = Math.min(lifetime, 10000) + ProjectileTracker.EXPIRY_GRACE_MS;
      if (now - bullet.spawnTime > maxLife) {
        this.bullets.delete(key);
      }
    }
  }

  clear(): void {
    this.bullets.clear();
    sendDllFeature('udodgePacketShot', 'clear');
  }

  getBullet(key: string): TrackedProjectile | undefined {
    return this.bullets.get(key);
  }

  /** Get all currently active projectiles. */
  getActiveProjectiles(): TrackedProjectile[] {
    return [...this.bullets.values()];
  }

  /** Iterate bullets without allocating an array copy. */
  forEachBullet(fn: (bullet: TrackedProjectile, key: string) => void): void {
    for (const [key, bullet] of this.bullets) {
      fn(bullet, key);
    }
  }

  get bulletCount(): number {
    return this.bullets.size;
  }
}
