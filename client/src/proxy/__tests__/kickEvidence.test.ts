import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PacketFactory } from '../../packets/PacketFactory.js';
import PACKET_DEFINITIONS from '../../packets/packetDefinitions.generated.js';
import STAT_TYPES from '../../packets/statTypes.generated.js';
import { Proxy } from '../Proxy.js';
import { ClientConnection } from '../ClientConnection.js';
import { RC4Cipher } from '../../crypto/RC4Cipher.js';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../util/Logger.js', () => ({
  Logger: { log: vi.fn(), debug: vi.fn(), error: vi.fn(), warn, isPacketDebugEnabled: () => false },
}));

// The keys the game uses; the proxy decrypts client traffic with the first and
// server traffic with the second (ClientConnection.ts).
const CLIENT_KEY = '5a4d2016bc16dc64883194ffd9';
const SERVER_KEY = 'c91d9eec420160730d825604e0';
const factory = new PacketFactory(PACKET_DEFINITIONS as any, STAT_TYPES as any);

function session() {
  const proxy = new Proxy(factory);
  const gameSocket = Object.assign(new EventEmitter(), { setNoDelay() {}, destroy() {}, write: () => true, destroyed: false });
  const conn = new ClientConnection(proxy, gameSocket as any);
  (conn as any).serverSocket = { destroyed: false, write: () => true, destroy() {} };
  const fromClient = new RC4Cipher(CLIENT_KEY);
  const fromServer = new RC4Cipher(SERVER_KEY);
  /** Put a packet on the wire exactly as the game or server would, through the real receive path. */
  const deliver = (name: string, data: Record<string, unknown>, isClient: boolean, trailing?: Buffer) => {
    const p = factory.createByName(name);
    Object.assign(p.data, data);
    if (trailing) p.unreadData = trailing;
    const bytes = Buffer.from(factory.serialize(p));
    (isClient ? fromClient : fromServer).cipher(bytes);
    (conn as any).processIncoming(bytes, isClient);
  };
  const move = (time: number) => deliver('MOVE', { tickId: 1, serverRealTimeMSofLastNewTick: 1, records: [{ time, x: 1, y: 1 }] }, true);
  const kick = (trailing?: Buffer) => deliver('FAILURE', { errorId: 0, errorMessage: '' }, false, trailing);
  const evidence = () => warn.mock.calls.map((c) => String(c[1])).find((m) => m.startsWith('[KICK-EVIDENCE]')) ?? '';
  return { proxy, conn, deliver, move, kick, evidence };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(2_000_000); warn.mockClear(); });
afterEach(() => vi.useRealTimers());

it('logs the C->S silence before a kick, with what the proxy altered on the way to the server', () => {
  const s = session();
  s.conn.serverConnectedAt = Date.now();
  // A plugin rewriting MOVE, as the auto-dodge outbound envelope does.
  s.proxy.hookPacket('MOVE', (_c, p) => { p.modified = true; });
  for (let i = 0; i < 5; i++) { vi.advanceTimersByTime(200); s.move(i * 200); }
  vi.advanceTimersByTime(2500);                     // the game client goes quiet
  s.move(3500);
  const use = factory.createByName('USEITEM');
  use.data = { time: 3500, slotObject: { objectId: 1, slotId: 1, objectType: 2 }, itemUsePos: { x: 1, y: 1 }, useType: 1, unknownInt: 0 };
  s.conn.sendToServer(use);                         // injected by a plugin
  vi.advanceTimersByTime(300);
  s.deliver('NEWTICK', { tickId: 2, tickTime: 200, serverRealTimeMs: 1, serverLastRttMs: 1, statuses: [] }, false);
  vi.advanceTimersByTime(100);
  s.kick();

  const line = s.evidence();
  expect(line).toContain('server connected 3900ms ago');
  expect(line).toContain('last C->S 400ms ago (MOVE)');
  expect(line).toContain('last S->C before this 100ms ago');
  expect(line).toContain('2500ms after MOVE (0.4s ago)');
  expect(line).toContain('MOVE modified x6');
  expect(line).toContain('USEITEM injected x1');
});

it('says so plainly when nothing was altered and the client never went quiet', () => {
  const s = session();
  for (let i = 0; i < 3; i++) { vi.advanceTimersByTime(200); s.move(i * 200); }
  s.kick();
  expect(s.evidence()).toContain('C->S gaps >=1000ms in last 60s: none');
  expect(s.evidence()).toContain('proxy-altered C->S in last 30s: none');
});

it('shows bytes past the defined FAILURE fields, where a newer layout would put its reason', () => {
  const s = session();
  s.kick(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  expect(warn).toHaveBeenCalledWith('Client', '[DIAG-FAILURE] errorId=0 errorMessage="" trailing=deadbeef');
});
