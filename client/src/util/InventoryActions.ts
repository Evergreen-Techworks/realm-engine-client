// Shared by script and plugin senders. Observe authoritative slot changes before
// allowing the next automatic inventory operation, rather than racing NEWTICK.
const key = Symbol.for('realm-engine.inventory-actions');

/** Identity of one side of an INVENTORYSWAP, matching the server's INVRESULT fields. */
export interface SlotRef { objectId: number; slotId: number }

/**
 * Both slots an in-flight INVENTORYSWAP touches. When supplied to
 * `tryInventoryAction`, a matching `resolveInventoryAction` call (from the
 * server's INVRESULT) releases the gate immediately instead of waiting on the
 * `read()`/timeout fallback below — see `resolveInventoryAction` for why this
 * matters for a rejected swap.
 */
export interface SwapIdentity { fromSlot: SlotRef; toSlot: SlotRef }

interface Pending { at: number; map: string; read: () => string; before: string; swapIdentity?: SwapIdentity }
type Owner = { playerData: { mapName: string }; [key]?: Pending };

export function tryInventoryAction(
  client: Owner,
  read: () => string,
  send: () => void,
  swapIdentity?: SwapIdentity,
): boolean {
  const now = Date.now();
  const pending = client[key];
  if (pending && pending.map === client.playerData.mapName) {
    if (now - pending.at < 1300) return false;
    // Bound a failed/unacknowledged action so it cannot disable looting forever.
    if (now - pending.at < 5000 && pending.read() === pending.before) return false;
  }
  const next: Pending = { at: now, map: client.playerData.mapName, read, before: read(), swapIdentity };
  client[key] = next;
  try { send(); } catch (error) { delete client[key]; throw error; }
  return true;
}

/**
 * Called from the server's INVRESULT for an INVENTORYSWAP. Live evidence
 * (2026-09-27, rig realm-engine-proxy.log 02:46:06-11 UTC): a pickup's swap was
 * rejected by the server (INVRESULT ok:false) within ~100ms, but nothing
 * client-side ever changes on a rejection — the item stays in the bag, the
 * destination slot stays empty — so the old read()-based settle check could
 * never become true. The gate then held for its full 5000ms bound before
 * anything else (another pickup, an equip, Auto Loot's own swap) could go out,
 * even though the server had already told us, near-instantly, that nothing
 * was in flight any more.
 *
 * Whether the swap succeeded or was rejected, once we hear the server's own
 * answer for these exact slots there is nothing left in flight, so the gate
 * releases immediately either way. An INVRESULT that names different slots
 * (some other client action, or a stale/duplicate packet) is ignored — it
 * cannot be the answer to the pending action, and must not release a gate
 * that is still legitimately held.
 */
export function resolveInventoryAction(client: Owner, fromSlot: SlotRef, toSlot: SlotRef): void {
  const pending = client[key];
  const id = pending?.swapIdentity;
  if (!id) return;
  if (id.fromSlot.objectId === fromSlot.objectId && id.fromSlot.slotId === fromSlot.slotId
    && id.toSlot.objectId === toSlot.objectId && id.toSlot.slotId === toSlot.slotId) {
    delete client[key];
  }
}
