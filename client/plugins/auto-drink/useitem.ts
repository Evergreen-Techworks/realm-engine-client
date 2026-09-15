/** Auto Drink — build and send the USEITEM packet that drinks a potion. */

import type { PluginContext } from '../api.js';
import type { ClientConnection } from '../api.js';
import { connectionGameTime, tryConsumePlayerItem } from '../api.js';

/**
 * Send a USEITEM for the potion at `slotId`. Returns false, sending nothing,
 * while the connection's game time is unknown.
 *
 * The `time` field is an int32 game time from `connectionGameTime` — never
 * `client.lastUpdate` or an uncalibrated `client.time`: both are epoch ms
 * (~1.78e12), which overflows int32 and makes PacketFactory throw
 * "value out of range", so the packet is silently dropped and nothing drinks.
 */
export function sendUseItem(
  ctx: PluginContext,
  client: ClientConnection,
  slotId: number,
  itemType: number,
): boolean {
  const time = connectionGameTime(client);
  if (time === null) return false;
  const pos = client.playerData.pos ?? { x: 0, y: 0 };
  const pkt = ctx.createPacket('USEITEM');
  pkt.data = {
    time,
    slotObject: { objectId: client.objectId, slotId, objectType: itemType },
    itemUsePos: { x: pos.x, y: pos.y },
    useType: 1,
    unknownInt: 0,
  };
  pkt.modified = true;
  return tryConsumePlayerItem(client, slotId, itemType, () => client.sendToServer(pkt));
}
