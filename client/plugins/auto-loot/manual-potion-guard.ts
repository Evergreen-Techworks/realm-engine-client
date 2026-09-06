/**
 * Manual potion guard.
 *
 * When the player manually uses or moves HP/MP potions or quickslots, Auto Loot
 * must back off: an in-flight auto-loot swap plus a manual quaff can desync the
 * client's inventory. This guard (a) blocks the player's own manual potion
 * packets while an Auto Loot HP/MP swap is settling, and (b) pauses Auto Loot for
 * a short window after any manual potion/quickslot action.
 */

import type { PluginContext } from '../api.js';
import type { ClientConnection } from '../api.js';
import type { AutoLootSettings } from './settings.js';
import { StateStore, clearPendingDest, type AutoLootState } from './state.js';
import { isQuickslotPacketSlot } from './inventory.js';
import { isAnyPotion } from './items.js';
import {
  PENDING_DEST_TIMEOUT_MS,
  MANUAL_POTION_SUPPRESS_LOG_MS,
  MANUAL_POTION_PACKET_BLOCK_LOG_MS,
} from './constants.js';

const GUARDED_PACKETS = new Set(['INVENTORYSWAP', 'INVDROP', 'USEITEM']);

export class ManualPotionGuard {
  constructor(
    private readonly ctx: PluginContext,
    private readonly settings: AutoLootSettings,
    private readonly store: StateStore,
  ) {}

  private diag(msg: string): void {
    if (this.settings.diagEnabled) this.ctx.log(`[DIAG] ${msg}`);
  }

  private static packetTouchesQuickslotOrPotion(packet: any): boolean {
    const data = packet?.data ?? {};
    const slotObjects = [data.slotObject1, data.slotObject2, data.slotObject].filter(Boolean);

    for (const slotObject of slotObjects) {
      const slotId = Number(slotObject?.slotId ?? -1);
      const objectType = Number(slotObject?.objectType ?? -1);
      if (Number.isFinite(slotId) && isQuickslotPacketSlot(slotId)) return true;
      if (Number.isFinite(objectType) && isAnyPotion(objectType)) return true;
    }
    return false;
  }

  /** True while an Auto-Loot-initiated HP/MP swap is still pending/settling. */
  isPendingHpMpAutoLootActive(state: AutoLootState, now: number): boolean {
    return state.pendingPotionItemId != null
      && state.pendingDestSlotId != null
      && (now - state.pendingSince) < PENDING_DEST_TIMEOUT_MS;
  }

  /** Pause Auto Loot for the configured window after a manual potion/quickslot action. */
  suppressAfterManualAction(client: ClientConnection, reason: string, clearPendingAutoLoot = true): void {
    const state = this.store.get(client);
    const now = Date.now();
    const pauseMs = this.settings.manualPotionSuppressMsClamped();

    state.manualPotionSuppressUntil = Math.max(state.manualPotionSuppressUntil, now + pauseMs);
    if (clearPendingAutoLoot) clearPendingDest(state);
    state.recentAttempts.clear();
    state.reservedDestSlots.clear();
    state.consumedBagSlots.clear();

    if ((now - state.lastManualPotionSuppressLogAt) >= MANUAL_POTION_SUPPRESS_LOG_MS) {
      state.lastManualPotionSuppressLogAt = now;
      this.ctx.log(`[Manual Potion Guard] Pausing Auto Loot for ${pauseMs}ms after ${reason}`);
    }
  }

  private blockManualPacket(client: ClientConnection, packetName: string): void {
    const state = this.store.get(client);
    const now = Date.now();

    // The block deadline is set once when Auto Loot sends the HP/MP swap; do not
    // extend it here, as that can desync the client during manual potion spam.
    const remainingMs = Math.max(0, Math.ceil(state.manualPotionPacketBlockUntil - now))
      || this.settings.manualPotionPacketBlockMsClamped();

    this.suppressAfterManualAction(client, packetName, false);

    if ((now - state.lastManualPotionPacketBlockLogAt) >= MANUAL_POTION_PACKET_BLOCK_LOG_MS) {
      state.lastManualPotionPacketBlockLogAt = now;
      this.ctx.log(`[Manual Potion Guard] Blocked ${packetName} for ${remainingMs}ms while pending swap settles`);
    }
  }

  /**
   * Outgoing-packet handler (wire to `hookAllPackets`). Blocks the player's manual
   * potion/quickslot packets while an Auto Loot swap is settling, otherwise records
   * the manual action so Auto Loot pauses.
   */
  handleOutgoingPacket(client: ClientConnection, packet: any, fromClient: boolean): void {
    if (!fromClient) return;
    if (!GUARDED_PACKETS.has(packet.name)) return;
    if (!ManualPotionGuard.packetTouchesQuickslotOrPotion(packet)) return;

    const state = this.store.get(client);
    const now = Date.now();
    const blocked = this.isPendingHpMpAutoLootActive(state, now) || now < state.manualPotionPacketBlockUntil;

    if (blocked) {
      packet.send = false;
      this.blockManualPacket(client, packet.name);
      this.diag(`manualGuard BLOCKED ${packet.name}`);
      return;
    }

    this.suppressAfterManualAction(client, packet.name, true);
    this.diag(`manualGuard ALLOWED ${packet.name}`);
  }
}
