/** Per-client Auto Loot state, kept in a WeakMap keyed by the connection. */

import type { ClientConnection } from '../api.js';
import type { TrackedEntity } from '../api.js';

/** Per-client runtime state, discarded with the connection (WeakMap-keyed). */
export interface AutoLootState {
  lastPickupAt: number;
  recentAttempts: Map<string, number>;
  pendingDestSlotId: number | null;
  pendingDestQuantity: number | null;
  pendingPotionItemId: number | null;
  pendingSince: number;
  bagSeenAt: Map<number, number>;
  bagContactSince: Map<number, number>;
  notifiedBagIds: Set<number>;
  lastPos: { x: number; y: number } | null;
  stationaryTicks: number;
  reservedDestSlots: Map<number, number>;
  /** Timestamps of loot packets sent in the last second, for the rate ceiling. */
  recentActions: number[];
  consumedBagSlots: Map<string, number>;
  manualPotionSuppressUntil: number;
  lastManualPotionSuppressLogAt: number;
  manualPotionPacketBlockUntil: number;
  lastManualPotionPacketBlockLogAt: number;
}

function createState(): AutoLootState {
  return {
    lastPickupAt: 0,
    recentAttempts: new Map<string, number>(),
    pendingDestSlotId: null,
    pendingDestQuantity: null,
    pendingPotionItemId: null,
    pendingSince: 0,
    bagSeenAt: new Map<number, number>(),
    bagContactSince: new Map<number, number>(),
    notifiedBagIds: new Set<number>(),
    lastPos: null,
    stationaryTicks: 0,
    reservedDestSlots: new Map<number, number>(),
    recentActions: [],
    consumedBagSlots: new Map<string, number>(),
    manualPotionSuppressUntil: 0,
    lastManualPotionSuppressLogAt: 0,
    manualPotionPacketBlockUntil: 0,
    lastManualPotionPacketBlockLogAt: 0,
  };
}

export class StateStore {
  private readonly states = new WeakMap<ClientConnection, AutoLootState>();

  get(client: ClientConnection): AutoLootState {
    let state = this.states.get(client);
    if (!state) {
      state = createState();
      this.states.set(client, state);
    }
    return state;
  }

  /** Reset a client's state (on map change / reconnect). */
  reset(client: ClientConnection): void {
    this.states.set(client, createState());
  }
}

/** Clear the in-flight pickup destination tracking. */
export function clearPendingDest(state: AutoLootState): void {
  state.pendingDestSlotId = null;
  state.pendingDestQuantity = null;
  state.pendingPotionItemId = null;
  state.pendingSince = 0;
}

/** Expire reserved destination slots and consumed bag-slot entries. */
export function cleanupReservations(state: AutoLootState, now: number): void {
  for (const [slot, until] of state.reservedDestSlots.entries()) {
    if (until <= now) state.reservedDestSlots.delete(slot);
  }
  for (const [key, until] of state.consumedBagSlots.entries()) {
    if (until <= now) state.consumedBagSlots.delete(key);
  }
}

/** Loot packets still inside the one-second send window. */
export function lootActionBudget(state: AutoLootState, now: number, maxPerSec: number): number {
  const cutoff = now - 1000;
  let expired = 0;
  while (expired < state.recentActions.length && state.recentActions[expired] <= cutoff) expired++;
  if (expired > 0) state.recentActions.splice(0, expired);
  return maxPerSec - state.recentActions.length;
}

export function isReservedDestination(state: AutoLootState, packetSlotId: number, now: number): boolean {
  return (state.reservedDestSlots.get(packetSlotId) ?? 0) > now;
}

export function makeBagSlotKey(bag: TrackedEntity, bagSlot: number, itemId: number): string {
  return `${bag.objectId}:${bagSlot}:${itemId}`;
}
