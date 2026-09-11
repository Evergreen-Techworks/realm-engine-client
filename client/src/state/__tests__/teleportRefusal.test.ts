import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Walking } from '@realmengine/sdk';
import { StateManager } from '../StateManager.js';
import { PacketFactory } from '../../packets/PacketFactory.js';
import type { Packet } from '../../packets/Packet.js';
import PACKET_DEFINITIONS from '../../packets/packetDefinitions.generated.js';
import STAT_TYPES from '../../packets/statTypes.generated.js';
import { Proxy } from '../../proxy/Proxy.js';
import { ClientConnection } from '../../proxy/ClientConnection.js';
import { BridgeWalking } from '../../scripts/bridge/walking/Walking.js';
import type { BridgeDeps } from '../../scripts/bridge/BridgeDeps.js';
import type { MovementController } from '../../scripts/bridge/movement/MovementController.js';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../util/Logger.js', () => ({
  Logger: { log: vi.fn(), debug: vi.fn(), error: vi.fn(), warn, isPacketDebugEnabled: () => false },
}));

// ─── The server's teleport refusal, straight off the wire ────────────────────
// S->C NOTIFICATION, verbatim from the user's capture
// packets_2026-09-10T05_30_36.json (row 687). It answered a TELEPORT (row 685)
// 59 ms later, right after a server change.
const REFUSAL_HEX =
  '00000038430902002f57616974203438207365636f6e647320746f2074656c65706f727420616674657220736572766572206368616e6765';
const REFUSAL_REPLY_DELAY_MS = 59;
const CAPTURE_TELEPORT_AT = 1_789_018_200_593;   // row 685's timestamp
const SERVER_STATED_WAIT_MS = 48_000;

// StateManager's clamps, restated so a change to them is a deliberate test edit.
const MARGIN_MS = 250;
const FALLBACK_MS = 10_000;
const REPLY_WINDOW_MS = 1_500;

const factory = new PacketFactory(PACKET_DEFINITIONS as any, STAT_TYPES as any);
const fromHex = (hex: string): Packet => factory.createFromBytes(Buffer.from(hex, 'hex'));

/** A packet built, serialized and re-read by the real factory, as the proxy would see it. */
function wire(name: string, data: Record<string, unknown>, trailing?: Buffer): Packet {
  const p = factory.createByName(name);
  Object.assign(p.data, data);
  if (trailing) p.unreadData = trailing;
  return factory.createFromBytes(factory.serialize(p));
}

/** int16 length prefix + UTF-8, the protocol's string encoding. */
function protocolString(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  const len = Buffer.alloc(2);
  len.writeInt16BE(body.length);
  return Buffer.concat([len, body]);
}

const teleportRefusal = (message?: string) =>
  wire('NOTIFICATION', { typeValue: 9, textByte: 2 }, message === undefined ? undefined : protocolString(message));

/** A TELEPORT the GAME CLIENT sent: it reaches StateManager through the packet hooks. */
const gameClientTeleport = (objectId: number) => wire('TELEPORT', { objectId, playerName: 'Target' });

/**
 * A real Proxy + StateManager + ClientConnection. Only the two TCP sockets are
 * stand-ins; the server-side one records what would have been written.
 */
function session() {
  const proxy = new Proxy(factory);
  const state = new StateManager();
  state.attach(proxy);
  const gameSocket = Object.assign(new EventEmitter(), { setNoDelay() {} });
  const conn = new ClientConnection(proxy, gameSocket as any);
  const sentToServer: Buffer[] = [];
  (conn as any).serverSocket = {
    destroyed: false,
    write: (b: Buffer) => { sentToServer.push(Buffer.from(b)); return true; },
  };
  conn.playerData.teleportAllowed = true;
  return { proxy, state, conn, sentToServer };
}

beforeEach(() => { vi.useFakeTimers(); warn.mockClear(); });
afterEach(() => vi.useRealTimers());

describe('the captured refusal frame', () => {
  it('parses as TELEPORT_ERROR with the message left in unreadData', () => {
    const p = fromHex(REFUSAL_HEX);
    expect(p.name).toBe('NOTIFICATION');
    expect(p.isDefined).toBe(true);
    expect(p.data).toMatchObject({ typeValue: 9, textByte: 2 });
    // Our definition stops after the two tag bytes, so the message is NOT a
    // parsed field — it is the int16-prefixed string in the trailing bytes.
    expect(p.unreadData.equals(protocolString('Wait 48 seconds to teleport after server change'))).toBe(true);
  });
});

describe('teleport refusal (game-client TELEPORT)', () => {
  it('holds teleports for the wait the server states, not the 10 s fallback', () => {
    const { proxy, conn } = session();
    vi.setSystemTime(CAPTURE_TELEPORT_AT);
    proxy.fireClientPacket(conn, gameClientTeleport(275515));

    const answeredAt = CAPTURE_TELEPORT_AT + REFUSAL_REPLY_DELAY_MS;
    vi.setSystemTime(answeredAt);
    proxy.fireServerPacket(conn, fromHex(REFUSAL_HEX));

    const heldFor = conn.teleportBlockedUntil - answeredAt;
    expect(heldFor).not.toBe(FALLBACK_MS);
    expect(heldFor).toBe(SERVER_STATED_WAIT_MS + MARGIN_MS);
    expect(warn).toHaveBeenCalledWith('State',
      expect.stringContaining('msg="Wait 48 seconds to teleport after server change"'));
  });

  it('falls back to 10 s when the refusal carries no message', () => {
    const { proxy, conn } = session();
    vi.setSystemTime(1_000_000);
    proxy.fireClientPacket(conn, gameClientTeleport(1));
    proxy.fireServerPacket(conn, teleportRefusal());
    expect(conn.teleportBlockedUntil - 1_000_000).toBe(FALLBACK_MS);
  });

  // The stated wait (plus margin) must land inside 1 s–10 min, or it is treated
  // as a mis-decode and the fallback applies instead.
  it.each([
    ['Wait 1 seconds to teleport', 1_000 + MARGIN_MS],
    ['Wait 599 seconds to teleport', 599_000 + MARGIN_MS],
    ['Wait 600 seconds to teleport', FALLBACK_MS],
    ['Wait 0 seconds to teleport', FALLBACK_MS],
    ['Wait 5000 seconds to teleport', FALLBACK_MS],
    ['Teleport failed', FALLBACK_MS],
  ])('"%s" holds for %d ms', (message, expected) => {
    const { proxy, conn } = session();
    vi.setSystemTime(1_000_000);
    proxy.fireClientPacket(conn, gameClientTeleport(1));
    proxy.fireServerPacket(conn, teleportRefusal(message));
    expect(conn.teleportBlockedUntil - 1_000_000).toBe(expected);
  });

  it('ignores a NOTIFICATION that is not answering a teleport', () => {
    const { proxy, conn } = session();
    vi.setSystemTime(1_000_000);
    proxy.fireServerPacket(conn, fromHex(REFUSAL_HEX));        // nothing pending
    expect(conn.teleportBlockedUntil).toBe(0);

    proxy.fireClientPacket(conn, gameClientTeleport(1));
    vi.setSystemTime(1_000_000 + REPLY_WINDOW_MS + 1);          // reply window lapsed
    proxy.fireServerPacket(conn, fromHex(REFUSAL_HEX));
    expect(conn.teleportBlockedUntil).toBe(0);
  });
});

// ─── Other NOTIFICATIONs share the reply window ──────────────────────────────
// NOTIFICATION carries every kind of pop-up. In the same capture, an OBJECT
// notification (typeValue 6, a "+9" pop-up over another player, row 702)
// arrived 567 ms after the TELEPORT, well inside the 1.5 s reply window. Only
// TELEPORT_ERROR (typeValue 9) is the server answering the teleport.
const OBJECT_POPUP_HEX =
  '0000003a43061a00297b226b223a22732e706c75735f73796d626f6c222c2274223a7b22616d6f756e74223a2239222c7d7d000438e8006084e0';

describe('only TELEPORT_ERROR answers a teleport', () => {
  it('parses the captured pop-up as an OBJECT notification, not TELEPORT_ERROR', () => {
    expect(fromHex(OBJECT_POPUP_HEX).data).toMatchObject({ typeValue: 6 });
  });

  it('a pop-up landing first does not swallow the real refusal', () => {
    const { proxy, conn } = session();
    vi.setSystemTime(CAPTURE_TELEPORT_AT);
    proxy.fireClientPacket(conn, gameClientTeleport(275515));
    vi.setSystemTime(CAPTURE_TELEPORT_AT + 30);
    proxy.fireServerPacket(conn, fromHex(OBJECT_POPUP_HEX));

    const answeredAt = CAPTURE_TELEPORT_AT + REFUSAL_REPLY_DELAY_MS;
    vi.setSystemTime(answeredAt);
    proxy.fireServerPacket(conn, fromHex(REFUSAL_HEX));
    expect(conn.teleportBlockedUntil - answeredAt).toBe(SERVER_STATED_WAIT_MS + MARGIN_MS);
  });

  it('a pop-up before the GOTO does not turn a successful teleport into a refusal', () => {
    const { proxy, conn } = session();
    conn.playerData.ownerObjectId = 4242;
    vi.setSystemTime(CAPTURE_TELEPORT_AT);
    proxy.fireClientPacket(conn, gameClientTeleport(275515));
    vi.setSystemTime(CAPTURE_TELEPORT_AT + 30);
    proxy.fireServerPacket(conn, fromHex(OBJECT_POPUP_HEX));
    vi.setSystemTime(CAPTURE_TELEPORT_AT + 80);
    proxy.fireServerPacket(conn, wire('GOTO', { objectId: 4242, position: { x: 10, y: 20 }, unknown: 0 }));

    expect(conn.teleportBlockedUntil).toBe(0);
    expect(conn.lastTeleportGotoAt).toBe(CAPTURE_TELEPORT_AT + 80);
  });
});

// The farmer does not click teleport in the game: it calls the SDK, and the
// bridge injects the TELEPORT with ClientConnection.sendToServer. That path
// writes straight to the server socket and never passes through the packet
// hooks, so StateManager cannot see this TELEPORT on the wire.
describe('teleport refusal (script-sent TELEPORT, the farmer path)', () => {
  const TARGET = { objectId: 275515, name: 'Target' };

  function scriptSession() {
    const s = session();
    BridgeWalking.install({
      clientRef: { current: s.conn },
      proxy: s.proxy,
      stateManager: s.state,
      worldState: { getAllPlayersRawStatsForDashboard: () => [TARGET] },
    } as unknown as BridgeDeps, {} as MovementController);
    return s;
  }

  it.each([
    ['teleportToBeacon', () => Walking.teleportToBeacon(TARGET.objectId)],
    ['teleportToPlayer', () => Walking.teleportToPlayer(TARGET.name)],
  ])('%s: the server-stated wait blocks re-sending until it lapses', (_name, teleport) => {
    const { proxy, conn, sentToServer } = scriptSession();
    vi.setSystemTime(CAPTURE_TELEPORT_AT);
    expect(teleport()).toBe(true);
    expect(sentToServer).toHaveLength(1);

    const answeredAt = CAPTURE_TELEPORT_AT + REFUSAL_REPLY_DELAY_MS;
    vi.setSystemTime(answeredAt);
    proxy.fireServerPacket(conn, fromHex(REFUSAL_HEX));

    expect(Walking.teleportCooldownRemainingMs()).toBe(SERVER_STATED_WAIT_MS + MARGIN_MS);
    expect(Walking.canTeleport()).toBe(false);
    expect(teleport()).toBe(false);
    expect(sentToServer).toHaveLength(1);                       // refused locally, never sent

    vi.setSystemTime(answeredAt + SERVER_STATED_WAIT_MS + MARGIN_MS);
    expect(Walking.teleportCooldownRemainingMs()).toBe(0);
    expect(teleport()).toBe(true);
    expect(sentToServer).toHaveLength(2);
  });
});
