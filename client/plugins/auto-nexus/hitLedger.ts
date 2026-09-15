/**
 * Auto Nexus — pure damage and shot-identity rules for the hit ledger (layer 2)
 * and the short forecast (layer 3).
 *
 * Every number here comes from a server packet: ENEMYSHOOT / SERVERPLAYERSHOOT
 * `damage`, the local player's wire DEFENSE stat and condition bitmasks. Nothing
 * is estimated. A bullet without a packet damage is not charged and not forecast.
 */
import { ConditionEffect, tomatoDamageWithDefense } from '../api.js';

/** Signature of the fabricated AoE threats old native builds published (bullet ids 20000+index, raw 9999). */
export const SYNTHETIC_BULLET_ID_MIN = 20000;
export const SYNTHETIC_BULLET_ID_MAX = 20127;
export const SYNTHETIC_RAW_DAMAGE = 9999;

/** A bullet the server announced, with the damage the server stated for it. */
export interface ShotRecord {
  ownerId: number;
  /** Object type of the owner when the shot arrived; null if the world state did not know it. */
  ownerType: number | null;
  bulletType: number;
  /** Per-bullet damage from the packet, before defense. */
  rawDamage: number;
  /** From the owner's projectile properties; null when unknown (treated as armor-piercing). */
  armorPiercing: boolean | null;
  /** Condition effect names the projectile applies on hit. */
  onHitEffects: string[];
  /** Epoch ms after which a PLAYERHIT or forecast for it is no longer accepted. */
  expiresAt: number;
  /** True once the local player's PLAYERHIT (or a server DAMAGE) charged it. Each identity counts once. */
  charged: boolean;
}

/** PLAYERHIT carries a uint16 bullet id, so identities wrap exactly as the wire does. */
export function bulletKey(ownerId: number, bulletId: number): string {
  return `${ownerId}:${bulletId & 0xffff}`;
}

/** A packet damage we are willing to count: a real, finite, positive number. */
export function isPacketDamage(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * ENEMYSHOOT `numShots` is optional on the wire. Missing, invalid, 0 or the 255
 * default mean a single bullet — the same rule `ProjectileTracker` applies.
 */
export function shotCount(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : 1;
  return n === 255 || n <= 0 ? 1 : n;
}

/** How long a shot stays chargeable: its lifetime capped at 10 s, plus the PLAYERHIT round trip. */
export function shotTtlMs(lifetimeMs: number | undefined): number {
  const life = typeof lifetimeMs === 'number' && Number.isFinite(lifetimeMs) && lifetimeMs > 0 ? lifetimeMs : 10000;
  return Math.min(life, 10000) + 2000;
}

/** The fabricated-AoE signature; rejected even when a real bullet happens to share its identity. */
export function isSyntheticThreat(bulletId: number, rawDamage: number): boolean {
  return bulletId >= SYNTHETIC_BULLET_ID_MIN && bulletId <= SYNTHETIC_BULLET_ID_MAX
    && rawDamage === SYNTHETIC_RAW_DAMAGE;
}

function hasBit(effects: readonly [number, number], index: number): boolean {
  return index < 31 ? (effects[0] & (1 << index)) !== 0 : (effects[1] & (1 << (index - 31))) !== 0;
}

function withBit(effects: readonly [number, number], index: number): [number, number] {
  return index < 31
    ? [effects[0] | (1 << index), effects[1]]
    : [effects[0], effects[1] | (1 << (index - 31))];
}

/** Player takes no damage at all. */
export function isInvulnerable(effects: readonly [number, number]): boolean {
  return hasBit(effects, ConditionEffect.Invulnerable) || hasBit(effects, ConditionEffect.Invincible);
}

/**
 * Damage the player takes from one bullet: RealmShark/Tomato's
 * `damageWithDefense` (also what MultiTool's player path uses):
 * max(raw - def, floor(raw / 10)); armor-piercing or Armor Broken ignores
 * defense, Armored is x1.5 defense, Exposed is -20 defense, Invulnerable is 0,
 * Petrified x0.9, Curse x1.25. Invincible is 0 as well.
 *
 * `armorPiercing === null` (unknown projectile) is treated as piercing: an
 * unknown can only make the ledger charge more, never less.
 */
export function appliedDamage(
  rawDamage: number,
  armorPiercing: boolean | null,
  defense: number,
  effects: readonly [number, number],
): number {
  if (!isPacketDamage(rawDamage)) return 0;
  if (isInvulnerable(effects)) return 0;
  const def = Number.isFinite(defense) ? defense : 0;
  const dmg = tomatoDamageWithDefense(rawDamage, armorPiercing ?? true, def, effects[0] | 0, effects[1] | 0);
  return Number.isFinite(dmg) && dmg > 0 ? dmg : 0;
}

/**
 * Conditions a charged bullet puts on the player that raise the damage of the
 * bullets after it, before the server reports them: Exposed, Armor Broken,
 * Curse (skipped when the matching immunity is up). Damage-lowering effects
 * are deliberately not applied early.
 */
export function withOnHitEffects(effects: readonly [number, number], names: readonly string[]): [number, number] {
  let out: [number, number] = [effects[0], effects[1]];
  for (const name of names) {
    switch (String(name).replace(/\s+/g, '').toLowerCase()) {
      case 'exposed':
        out = withBit(out, ConditionEffect.Exposed);
        break;
      case 'armorbroken':
        if (!hasBit(out, ConditionEffect.ArmorBrokenImmune)) out = withBit(out, ConditionEffect.ArmorBroken);
        break;
      case 'curse':
      case 'cursed':
        if (!hasBit(out, ConditionEffect.CurseImmune)) out = withBit(out, ConditionEffect.Curse);
        break;
      default:
        break;
    }
  }
  return out;
}
