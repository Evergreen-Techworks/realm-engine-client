import type { Proxy } from '../proxy/Proxy.js';
import type { ClientConnection } from '../proxy/ClientConnection.js';
import type { Packet } from '../packets/Packet.js';
import type { GameDataLoader, ProjectileDef } from '../game-data/GameDataLoader.js';
import type { GameWorldState } from './GameWorldState.js';
import { Logger } from '../util/Logger.js';

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

  attach(proxy: Proxy): void {
    proxy.hookPacket('ENEMYSHOOT', (c, p) => this.onEnemyShoot(c, p));
    proxy.hookPacket('MAPINFO', () => this.clear());
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
    }
  }

  /** Remove expired bullets. Call periodically (e.g., each NEWTICK). */
  cleanup(): void {
    const now = Date.now();
    for (const [key, bullet] of this.bullets) {
      const lifetime = bullet.projDef?.lifetimeMs ?? 10000;
      // Hard cap at 10 seconds even if game data says longer
      const maxLife = Math.min(lifetime, 10000);
      if (now - bullet.spawnTime > maxLife) {
        this.bullets.delete(key);
      }
    }
  }

  clear(): void {
    this.bullets.clear();
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
