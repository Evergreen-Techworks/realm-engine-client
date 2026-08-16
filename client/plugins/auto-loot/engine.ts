/**
 * The Auto Loot orchestrator: runs once per NEWTICK and decides whether to pick
 * up an item, autodrink a stat pot, or do nothing this tick. Policy decisions are
 * delegated to the focused helpers; this file is the sequencing/timing glue.
 */

import type { PluginContext } from '../api.js';
import type { ClientConnection } from '../api.js';
import type { TrackedEntity } from '../api.js';
import type { AutoLootSettings } from './settings.js';
import { LootCatalog } from './catalog.js';
import { StateStore, cleanupReservations, clearPendingDest, makeBagSlotKey, type AutoLootState } from './state.js';
import { LootRules, shouldSkipMap } from './loot-rules.js';
import { BagScanner, getBagItemId, entityDistance } from './bags.js';
import { shouldSkipAutodrinkClassCap, isHpOrMpPotion } from './items.js';
import {
  isQuickslotPacketSlot,
  readQuickSlot,
  getPlayerSlotObjectType,
  getQuickslotDestination,
  getExpectedQuickslotQuantity,
  getFirstFreeLootDestination,
  sendUseItemFromBag,
  sendLootSwap,
  type LootDestination,
} from './inventory.js';
import {
  PICKUP_INTERVAL_MS,
  RETRY_ITEM_AFTER_MS,
  PENDING_DEST_TIMEOUT_MS,
  DEST_SLOT_RESERVE_MS,
  BAG_SLOT_CONSUME_MS,
  ON_TOP_DISTANCE,
  STATIONARY_TICK_LIMIT,
  MOVEMENT_EPSILON,
  QUICKSLOT_PACKET_BASE,
  STAT_POTION_IDS,
} from './constants.js';

export class LootEngine {
  private diagLastPeriodicMs = 0;

  constructor(
    private readonly ctx: PluginContext,
    private readonly settings: AutoLootSettings,
    private readonly catalog: LootCatalog,
    private readonly store: StateStore,
    private readonly rules: LootRules,
    private readonly bags: BagScanner,
  ) {}

  private diag(msg: string): void {
    if (this.settings.diagEnabled) this.ctx.log(`[DIAG] ${msg}`);
  }

  private itemLabel(itemId: number): string {
    return `${itemId}(${this.catalog.getItemDisplayName(itemId)})`;
  }

  tryAutoLoot(client: ClientConnection): void {
    if (!this.ctx.enabled || !this.ctx.worldState) return;
    if (!client?.connected || !client.objectId) return;
    if (shouldSkipMap(client.playerData.mapName || '')) return;

    const playerPos = client.playerData.pos;
    if (!playerPos || !Number.isFinite(playerPos.x) || !Number.isFinite(playerPos.y)) return;

    const state = this.store.get(client);
    const now = Date.now();
    if (!this.preflight(client, state, now)) return;

    const destination = getFirstFreeLootDestination(
      client, this.settings.useBackpack, this.settings.preferBackpack, state, now,
    );
    const bags = this.bags.getNearbyBags(client, state);
    this.logPeriodicDiag(client, state, bags, destination, now, playerPos);

    let onBag = false;
    for (const bag of bags) {
      if (entityDistance(playerPos, bag) > ON_TOP_DISTANCE) continue;
      onBag = true;
      if (this.bags.shouldDelayPublicBag(bag, state, now)) continue;
      // First pickup on a bag is immediate; later ones are spaced by PICKUP_INTERVAL_MS.
      if ((now - state.lastPickupAt) < PICKUP_INTERVAL_MS) continue;
      if (this.processBag(client, state, bag, destination, now)) return;
    }

    // Off all bags: clear the spacing cooldown so the next bag we step on loots at once.
    if (!onBag) state.lastPickupAt = 0;
  }

  /** Per-tick housekeeping and gating; returns false when the tick should stop. */
  private preflight(client: ClientConnection, state: AutoLootState, now: number): boolean {
    this.bags.notifyNewBags(client, state);
    this.updateIdleState(client, state);

    if (this.settings.disableWhenIdle && state.stationaryTicks > STATIONARY_TICK_LIMIT) return false;

    this.resolvePending(client, state, now);
    if (state.pendingDestSlotId != null) return false;

    for (const [key, attemptedAt] of state.recentAttempts.entries()) {
      if ((now - attemptedAt) >= RETRY_ITEM_AFTER_MS) state.recentAttempts.delete(key);
    }
    cleanupReservations(state, now);
    return true;
  }

  private updateIdleState(client: ClientConnection, state: AutoLootState): void {
    const pos = client.playerData.pos;
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;

    const moved = state.lastPos != null
      && (Math.abs(pos.x - state.lastPos.x) > MOVEMENT_EPSILON
        || Math.abs(pos.y - state.lastPos.y) > MOVEMENT_EPSILON);

    if (!state.lastPos || moved) {
      state.lastPos = { x: pos.x, y: pos.y };
      state.stationaryTicks = 0;
    } else {
      state.stationaryTicks += 1;
    }
  }

  /** Clear the pending destination once it has filled or timed out. */
  private resolvePending(client: ClientConnection, state: AutoLootState, now: number): void {
    if (state.pendingDestSlotId == null) return;
    const timedOut = (now - state.pendingSince) >= PENDING_DEST_TIMEOUT_MS;

    let filled: boolean;
    if (isQuickslotPacketSlot(state.pendingDestSlotId) && state.pendingDestQuantity != null) {
      const current = readQuickSlot(client, state.pendingDestSlotId - QUICKSLOT_PACKET_BASE);
      filled = current.quantity >= state.pendingDestQuantity;
    } else {
      filled = getPlayerSlotObjectType(client, state.pendingDestSlotId) !== -1;
    }

    if (filled || timedOut) clearPendingDest(state);
  }

  /** Scan one bag's slots; returns true once an action (drink/swap) was sent. */
  private processBag(
    client: ClientConnection,
    state: AutoLootState,
    bag: TrackedEntity,
    destination: LootDestination | null,
    now: number,
  ): boolean {
    for (let bagSlot = 0; bagSlot < 8; bagSlot++) {
      const itemId = getBagItemId(bag, bagSlot);
      if (itemId <= 0 || !this.isSlotEligible(state, bag, bagSlot, itemId, now)) continue;

      if (this.settings.autodrinkStatPots && STAT_POTION_IDS.has(itemId)) {
        if (this.handleAutodrink(client, state, bag, bagSlot, itemId, now)) return true;
        continue;
      }
      if (this.handleLootSwap(client, state, bag, bagSlot, itemId, destination, now)) return true;
    }
    return false;
  }

  /** Per-slot gating shared by the autodrink and swap paths. */
  private isSlotEligible(state: AutoLootState, bag: TrackedEntity, bagSlot: number, itemId: number, now: number): boolean {
    if (now < state.manualPotionSuppressUntil) return false;
    if ((state.consumedBagSlots.get(makeBagSlotKey(bag, bagSlot, itemId)) ?? 0) > now) return false;

    const eligible = STAT_POTION_IDS.has(itemId)
      ? this.rules.canInteractWithStatPotOnBag(itemId)
      : this.rules.shouldLootItem(itemId);
    if (!eligible) return false;

    return this.rules.passesMinEnchantGate(itemId, bag, bagSlot);
  }

  private onCooldown(state: AutoLootState, attemptKey: string, now: number): boolean {
    return (now - (state.recentAttempts.get(attemptKey) ?? 0)) < RETRY_ITEM_AFTER_MS;
  }

  /** Autodrink a stat pot straight off the bag (USEITEM, no inventory pickup). */
  private handleAutodrink(
    client: ClientConnection,
    state: AutoLootState,
    bag: TrackedEntity,
    bagSlot: number,
    itemId: number,
    now: number,
  ): boolean {
    const gameData = this.ctx.gameData;
    const capped = gameData != null
      && shouldSkipAutodrinkClassCap(
        client.playerData.classType,
        client.playerData,
        itemId,
        (ct) => gameData.getPlayerClassStatMaxes(ct),
      );
    const attemptKey = `drink:${bag.objectId}:${bagSlot}:${itemId}`;
    if (capped || this.onCooldown(state, attemptKey, now)) return false;

    this.diag(`SEND autodrink USEITEM bag#${bag.objectId} slot=${bagSlot} item=${this.itemLabel(itemId)}`);
    sendUseItemFromBag(this.ctx, client, bag, bagSlot, itemId);
    state.lastPickupAt = now;
    state.recentAttempts.set(attemptKey, now);
    return true;
  }

  /** Swap an item from a bag slot into inventory/backpack/quickslot. */
  private handleLootSwap(
    client: ClientConnection,
    state: AutoLootState,
    bag: TrackedEntity,
    bagSlot: number,
    itemId: number,
    generalDestination: LootDestination | null,
    now: number,
  ): boolean {
    const destination = getQuickslotDestination(client, itemId, this.catalog) ?? generalDestination;
    if (!destination) return false;

    const attemptKey = `${bag.objectId}:${bagSlot}:${itemId}`;
    if (this.onCooldown(state, attemptKey, now)) return false;

    const expectedQuantity = getExpectedQuickslotQuantity(client, destination, itemId);
    this.diag(`SEND INVENTORYSWAP bag#${bag.objectId} slot=${bagSlot} item=${this.itemLabel(itemId)} → slot=${destination.packetSlotId}`);
    if (!sendLootSwap(this.ctx, client, bag, bagSlot, itemId, destination, state)) return false;

    const isHpMp = isHpOrMpPotion(itemId);
    state.lastPickupAt = now;
    state.pendingDestSlotId = destination.packetSlotId;
    state.pendingDestQuantity = expectedQuantity;
    state.pendingPotionItemId = isHpMp ? itemId : null;
    state.pendingSince = now;
    state.recentAttempts.set(attemptKey, now);

    if (isHpMp) {
      const blockMs = this.settings.manualPotionPacketBlockMsClamped();
      state.manualPotionPacketBlockUntil = Math.max(state.manualPotionPacketBlockUntil, now + blockMs);
    }

    if (isHpMp || isQuickslotPacketSlot(destination.packetSlotId)) {
      state.reservedDestSlots.set(destination.packetSlotId, now + DEST_SLOT_RESERVE_MS);
      state.consumedBagSlots.set(makeBagSlotKey(bag, bagSlot, itemId), now + BAG_SLOT_CONSUME_MS);
    }
    return true;
  }

  // ─── Diagnostics ───────────────────────────────────────────────────────────

  private inventorySnapshot(client: ClientConnection): string {
    const inv = client.playerData.inventory ?? [];
    const bp = client.playerData.backpack ?? [];
    const qs = (client.playerData as any).quickSlots ?? [];
    const freeInv = [4, 5, 6, 7, 8, 9, 10, 11].filter((s) => Number(inv[s] ?? -1) === -1).length;
    const maxBpSize = client.playerData.hasBackpackExtender ? 16 : 8;
    const bpSize = client.playerData.hasBackpack ? maxBpSize : 0;
    const freeBp = bpSize > 0
      ? Array.from({ length: bpSize }, (_, i) => Number(bp[i] ?? -1)).filter((v) => v === -1).length
      : 0;
    const qsCount = client.playerData.hasThirdQuickSlot ? 3 : 2;
    const qsParts = Array.from({ length: qsCount }, (_, i) => {
      const s: any = qs[i];
      if (s && typeof s === 'object') return `qs${i}=${s.itemType}x${s.quantity}`;
      return `qs${i}=${typeof s === 'number' ? s : -1}`;
    });
    return `inv_free=${freeInv} bp_free=${bpSize > 0 ? freeBp : 'n/a'}(size=${bpSize}) ${qsParts.join(' ')}`;
  }

  private logPeriodicDiag(
    client: ClientConnection,
    state: AutoLootState,
    bags: TrackedEntity[],
    destination: LootDestination | null,
    now: number,
    playerPos: { x: number; y: number },
  ): void {
    if (!this.settings.diagEnabled || bags.length === 0 || (now - this.diagLastPeriodicMs) < 2000) return;
    this.diagLastPeriodicMs = now;

    const bagSummary = bags.map((b) => {
      const items: string[] = [];
      for (let s = 0; s < 8; s++) {
        const id = getBagItemId(b, s);
        if (id > 0) items.push(this.itemLabel(id));
      }
      return `bag#${b.objectId}(type=${b.objectType},dist=${entityDistance(playerPos, b).toFixed(2)})=[${items.join(',')}]`;
    }).join(' ');

    this.ctx.log(`[DIAG] ${this.inventorySnapshot(client)} dest=${destination ? destination.packetSlotId : 'full'} suppress=${Math.max(0, state.manualPotionSuppressUntil - now)}ms`);
    this.ctx.log(`[DIAG] nearbyBags(${bags.length}): ${bagSummary}`);
  }
}
