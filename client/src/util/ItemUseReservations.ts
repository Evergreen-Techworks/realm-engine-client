interface QuantityReservation { itemType: number; quantity: number; pending: number }
const reservationsKey = Symbol.for('realm-engine.item-use-reservations');
type InventoryOwner = { mapName: string; inventory: number[]; backpack: number[];
  quickSlots?: Array<{ itemType: number; quantity: number }>;
  [reservationsKey]?: { map: string; slots: Map<number, QuantityReservation> } };
type Owner = { playerData: InventoryOwner };

export function observeItemQuantity(player: InventoryOwner, slotId: number, itemType: number, quantity: number): QuantityReservation {
  let state = player[reservationsKey];
  if (!state || state.map !== player.mapName) {
    state = { map: player.mapName, slots: new Map() };
    player[reservationsKey] = state;
  }
  let reservation = state.slots.get(slotId);
  if (!reservation || reservation.itemType !== itemType) {
    reservation = { itemType, quantity, pending: 0 };
    state.slots.set(slotId, reservation);
  } else {
    reservation.pending = Math.max(0, reservation.pending - Math.max(0, reservation.quantity - quantity));
    reservation.quantity = quantity;
  }
  return reservation;
}

function observe(client: Owner, slotId: number, itemType: number): QuantityReservation {
  const player = client.playerData;
  const belt = slotId >= 1000000 ? player.quickSlots?.[slotId - 1000000] : undefined;
  const currentType = slotId >= 1000000 ? belt?.itemType
    : slotId >= 12 ? player.backpack[slotId - 12] : player.inventory[slotId];
  const quantity = currentType !== undefined && currentType > 0
    ? (slotId >= 1000000 ? Number(belt?.quantity ?? 0) : 1) : 0;
  return observeItemQuantity(player, slotId, currentType ?? -1, quantity);
}

export function availablePlayerItemCount(client: Owner, slotId: number, itemType: number): number {
  const reservation = observe(client, slotId, itemType);
  return reservation.itemType === itemType && Number.isInteger(reservation.quantity)
    ? Math.max(0, reservation.quantity - reservation.pending) : 0;
}

export function tryConsumePlayerItem(client: Owner, slotId: number, itemType: number, send: () => void): boolean {
  if (availablePlayerItemCount(client, slotId, itemType) <= 0) return false;
  const reservation = observe(client, slotId, itemType);
  send();
  reservation.pending++;
  return true;
}
