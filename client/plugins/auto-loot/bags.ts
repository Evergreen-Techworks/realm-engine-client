/**
 * Loot bags in the world: nearby-bag tracking, the optional "bag appeared"
 * notifier, public-bag pickup delay, and the "Big Loot Bags" size rewrite.
 */

import type { PluginContext } from '../api.js';
import type { ClientConnection } from '../api.js';
import type { TrackedEntity } from '../api.js';
import { StatType } from '../api.js';
import type { AutoLootState } from './state.js';
import type { AutoLootSettings } from './settings.js';
import { LootCatalog } from './catalog.js';
import { getBagSlotEnchantIds } from './items.js';
import {
  BAG_TYPES,
  PUBLIC_BAG_TYPES,
  ON_TOP_DISTANCE,
  PUBLIC_BAG_DELAY_MS,
  BAG_NOTIFY_RADIUS,
  BAG_NOTIFY_ITEM_LIMIT,
  MULTITOOL_BIG_BAG_SIZE,
} from './constants.js';

/** Item id occupying a bag slot, or -1 if empty/invalid. */
export function getBagItemId(entity: TrackedEntity, bagSlot: number): number {
  const itemId = Number(entity.stats?.[String(StatType.Inventory0 + bagSlot)]);
  return Number.isFinite(itemId) ? Math.trunc(itemId) : -1;
}

/** Planar distance from a point to an entity's position (0 when unknown). */
export function entityDistance(from: { x: number; y: number }, entity: TrackedEntity): number {
  return Math.hypot(Number(entity.pos?.x || 0) - from.x, Number(entity.pos?.y || 0) - from.y);
}

export class BagScanner {
  constructor(
    private readonly ctx: PluginContext,
    private readonly settings: AutoLootSettings,
    private readonly catalog: LootCatalog,
  ) {}

  /** All tracked bag entities within `radius` of the player, nearest first. */
  getTrackedBags(client: ClientConnection, radius?: number): TrackedEntity[] {
    if (!this.ctx.worldState) return [];
    const playerPos = client.playerData.pos;
    if (!playerPos) return [];

    return this.ctx.worldState
      .getEntitiesInRadius(playerPos, radius ?? Number.MAX_SAFE_INTEGER)
      .filter((entity) => BAG_TYPES.has(entity.objectType))
      .sort((a, b) => entityDistance(playerPos, a) - entityDistance(playerPos, b));
  }

  /** Bags the player is standing on, recording first-seen time for public delay. */
  getNearbyBags(client: ClientConnection, state: AutoLootState): TrackedEntity[] {
    const found = new Map<number, TrackedEntity>();
    const now = Date.now();

    for (const entity of this.getTrackedBags(client, ON_TOP_DISTANCE + 0.1)) {
      found.set(entity.objectId, entity);
      if (!state.bagSeenAt.has(entity.objectId)) {
        state.bagSeenAt.set(entity.objectId, now);
      }
    }

    for (const objectId of state.bagSeenAt.keys()) {
      if (!found.has(objectId) && !this.ctx.worldState?.getEntity(objectId)) {
        state.bagSeenAt.delete(objectId);
      }
    }

    return [...found.values()];
  }

  /** True while a freshly-seen public bag is still within its grace delay. */
  shouldDelayPublicBag(bag: TrackedEntity, state: AutoLootState, now: number): boolean {
    if (!this.settings.publicDelay || !PUBLIC_BAG_TYPES.has(bag.objectType)) return false;
    const seenAt = state.bagSeenAt.get(bag.objectId) ?? 0;
    return seenAt > 0 && (now - seenAt) < PUBLIC_BAG_DELAY_MS;
  }

  /** Notify (once) for each bag that appears within the notify radius. */
  notifyNewBags(client: ClientConnection, state: AutoLootState): void {
    if (!this.settings.bagNotifierEnabled || !this.ctx.worldState) return;
    const playerPos = client.playerData.pos;
    if (!playerPos) return;

    for (const objectId of state.notifiedBagIds) {
      if (!this.ctx.worldState.getEntity(objectId)) state.notifiedBagIds.delete(objectId);
    }

    for (const bag of this.getTrackedBags(client, BAG_NOTIFY_RADIUS)) {
      if (state.notifiedBagIds.has(bag.objectId)) continue;
      const distance = entityDistance(playerPos, bag).toFixed(1);
      const bagName = this.catalog.getBagDisplayName(bag.objectType);
      this.ctx.sendNotification(
        client,
        'Auto Loot',
        `Bag appeared (${bagName}, ${distance}t): ${this.formatBagContents(bag)}`,
      );
      state.notifiedBagIds.add(bag.objectId);
    }
  }

  private formatBagContents(entity: TrackedEntity): string {
    const names: string[] = [];
    for (let bagSlot = 0; bagSlot < 8; bagSlot++) {
      const itemId = getBagItemId(entity, bagSlot);
      if (itemId <= 0) continue;
      const label = this.catalog.getItemDisplayName(itemId);
      const enchantIds = getBagSlotEnchantIds(entity.stats, bagSlot);
      names.push(enchantIds.length > 0 ? `${label} (${enchantIds.join(', ')})` : label);
    }

    if (names.length === 0) return 'empty';
    if (names.length <= BAG_NOTIFY_ITEM_LIMIT) return names.join(', ');
    return `${names.slice(0, BAG_NOTIFY_ITEM_LIMIT).join(', ')} (+${names.length - BAG_NOTIFY_ITEM_LIMIT} more)`;
  }
}

// ─── Big Loot Bags ─────────────────────────────────────────────────────────────

function toStatInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** Force numeric `Size` entries on a bag's status to {@link MULTITOOL_BIG_BAG_SIZE}. */
function rewriteBigBagSize(status: { data?: Array<{ id: unknown; value: unknown }> } | undefined): boolean {
  if (!Array.isArray(status?.data)) return false;
  let changed = false;
  for (const s of status.data) {
    if (toStatInt(s.id) !== StatType.Size) continue;
    if (typeof s.value === 'string' || toStatInt(s.value) === MULTITOOL_BIG_BAG_SIZE) continue;
    s.value = MULTITOOL_BIG_BAG_SIZE;
    changed = true;
  }
  return changed;
}

/**
 * Hook the UPDATE packet to enlarge loot bags when the setting is enabled, so they
 * render larger / easier to see. Mirrors Multitool `Class88.method_2` over newObjs.
 */
export function registerBigBags(ctx: PluginContext, settings: AutoLootSettings): void {
  ctx.hookPacket('UPDATE', (_client, packet) => {
    if (!settings.bigLootBags || !packet.isDefined) return;
    const newObjs = packet.data.newObjs as Array<{
      objectType?: number;
      status?: { data?: Array<{ id: unknown; value: unknown }> };
    }> | undefined;
    if (!Array.isArray(newObjs) || newObjs.length === 0) return;

    let changed = false;
    for (const obj of newObjs) {
      if (!BAG_TYPES.has(toStatInt(obj.objectType)) || !obj.status) continue;
      if (rewriteBigBagSize(obj.status)) changed = true;
    }
    if (changed) packet.modified = true;
  });
}
