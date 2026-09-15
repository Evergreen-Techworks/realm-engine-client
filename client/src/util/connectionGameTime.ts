/**
 * The int32 `time` field of client packets the proxy writes itself (USEITEM).
 *
 * `client.time` is `Date.now() + relativeTime`, and `relativeTime` is learned
 * from the game client's own time-bearing packets (first MOVE, PONG or
 * PLAYERSHOOT of the connection). Every map change opens a new connection, so
 * for the first moments after "Player created" `client.time` is plain epoch ms
 * (~1.79e12), which is outside int32: PacketFactory refuses to serialize and the
 * packet is silently never sent ("Failed to serialize USEITEM ... Received
 * 1_789_434_968_802", 2026-09-14). Report no time rather than a wrong one, and
 * let the caller skip the send until the next attempt.
 */
export function connectionGameTime(client: { time?: unknown } | null | undefined): number | null {
  const time = Math.trunc(Number(client?.time));
  return Number.isFinite(time) && time >= -0x80000000 && time <= 0x7fffffff ? time : null;
}
