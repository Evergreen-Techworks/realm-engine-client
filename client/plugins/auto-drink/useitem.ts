/** Auto Drink — build and send the USEITEM packet that drinks a potion. */

import type { PluginContext } from '../api.js';
import type { ClientConnection } from '../api.js';

/**
 * Send a USEITEM for the potion at `slotId`.
 *
 * The `time` field is an int32 game time. It MUST come from `client.time`
 * (`Date.now() + relativeTime` → small, connection-relative, like pyrelay's
 * getTime()), NOT `client.lastUpdate` — that holds raw `Date.now()` epoch ms
 * (~1.78e12), which overflows int32 and makes PacketFactory throw
 * "value out of range", so the packet is silently dropped and nothing drinks.
 * auto-loot uses `Math.trunc(client.time)` for the same reason.
 */
export function sendUseItem(
  ctx: PluginContext,
  client: ClientConnection,
  slotId: number,
  itemType: number,
): void {
  const pos = client.playerData.pos ?? { x: 0, y: 0 };
  const pkt = ctx.createPacket('USEITEM');
  pkt.data = {
    time: Math.trunc(client.time ?? 0),
    slotObject: { objectId: client.objectId, slotId, objectType: itemType },
    itemUsePos: { x: pos.x, y: pos.y },
    useType: 1,
    unknownInt: 0,
  };
  pkt.modified = true;
  client.sendToServer(pkt);
}
