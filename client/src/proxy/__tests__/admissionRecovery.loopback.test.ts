
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PacketFactory, type DefsFile } from '../../packets/PacketFactory.js';
import PACKET_DEFINITIONS from '../../packets/packetDefinitions.generated.js';
import STAT_TYPES from '../../packets/statTypes.generated.js';
import { RC4Cipher } from '../../crypto/RC4Cipher.js';
import type { State } from '../../state/State.js';
import { Logger } from '../../util/Logger.js';
import type { ClientConnection } from '../ClientConnection.js';
import { Proxy } from '../Proxy.js';
import { ReconnectHandler } from '../ReconnectHandler.js';

const CLIENT_KEY = '5a4d2016bc16dc64883194ffd9';
const SERVER_KEY = 'c91d9eec420160730d825604e0';
const ID = { FAILURE: 0, PING: 8, LOAD: 61, RECONNECT: 45, HELLO: 74, QUEUE_INFORMATION: 112 };
const FULL_SERVER_MESSAGE = 'Can not add player due to connection amount limits';
const RETRY_MS = 5000;

const u8 = (v: number) => Buffer.from([v & 0xff]);
const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
const i16 = (v: number) => { const b = Buffer.alloc(2); b.writeInt16BE(v); return b; };
const i32 = (v: number) => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; };
const str = (v: string) => { const s = Buffer.from(v, 'utf8'); return Buffer.concat([i16(s.length), s]); };
const bytes16 = (b: Buffer) => Buffer.concat([i16(b.length), b]);


const frame = (id: number, parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([i32(5 + body.length), u8(id), body]);
};

const hello = (gameId: number, keyTime: number, key: Buffer) => frame(ID.HELLO, [
  i32(gameId), str('7.0.0.2.0'), str('ACCESS-TOKEN'), i32(keyTime), bytes16(key),
  str('rotmg'), str('rotmg'), str(''), str('USER-TOKEN'), str('CLIENT-ID'),
]);
const failure = (errorId: number, message: string) => frame(ID.FAILURE, [i32(errorId), str(message)]);
const ping = (serial: number) => frame(ID.PING, [i32(serial)]);
const load = (charId: number) => frame(ID.LOAD, [i32(charId), u8(0)]);
const queueInformation = (curPos: number, maxPos: number) => frame(ID.QUEUE_INFORMATION, [u16(curPos), u16(maxPos)]);
const reconnect = (host: string, port: number, gameId: number, keyTime: number, key: Buffer) =>
  frame(ID.RECONNECT, [str('Nexus'), str(host), u16(port), i32(gameId), i32(keyTime), bytes16(key)]);


const FULL_SERVER_FAILURE = failure(0, FULL_SERVER_MESSAGE);


class Framer {
  private acc = Buffer.alloc(0);
  constructor(private readonly rc4: RC4Cipher, private readonly onFrame: (f: Buffer) => void) {}
  push(data: Buffer): void {
    this.acc = Buffer.concat([this.acc, data]);
    while (this.acc.length >= 4) {
      const len = this.acc.readInt32BE(0);
      if (this.acc.length < len) return;
      const f = Buffer.from(this.acc.subarray(0, len));
      this.acc = this.acc.subarray(len);
      this.rc4.cipher(f);
      this.onFrame(f);
    }
  }
}




const tick = () => new Promise<void>((r) => setImmediate(r));

async function until(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!cond()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await tick();
  }
}

async function settle(ms = 100): Promise<void> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) await tick();
}


interface ServerConn {
  index: number;
  sock: net.Socket;
  frames: Buffer[];
  closed: boolean;
  send(f: Buffer): void;
}


type Script = (conn: ServerConn) => void;

const silentReset: Script = (c) => { c.sock.resetAndDestroy(); };
const silentEnd: Script = (c) => { c.sock.end(); };
const hold: Script = () => {};
const answer = (...frames: Buffer[]): Script => (c) => { for (const f of frames) c.send(f); };
const answerThenEnd = (...frames: Buffer[]): Script => (c) => { for (const f of frames) c.send(f); c.sock.end(); };

interface FakeServer {
  port: number;
  conns: ServerConn[];
  
  hellos: Buffer[];
  close(): Promise<void>;
}


function fakeServer(scripts: Script[]): Promise<FakeServer> {
  return new Promise((resolve) => {
    const conns: ServerConn[] = [];
    const hellos: Buffer[] = [];
    const srv = net.createServer((sock) => {
      const sendRc4 = new RC4Cipher(SERVER_KEY);
      const conn: ServerConn = {
        index: conns.length,
        sock,
        frames: [],
        closed: false,
        send: (f) => { const c = Buffer.from(f); sendRc4.cipher(c); sock.write(c); },
      };
      conns.push(conn);
      sock.on('error', () => {});
      sock.on('close', () => { conn.closed = true; });
      const script = scripts[Math.min(conn.index, scripts.length - 1)];
      const framer = new Framer(new RC4Cipher(CLIENT_KEY), (f) => {
        conn.frames.push(f);
        if (f[4] === ID.HELLO) { hellos.push(f); script(conn); }
      });
      sock.on('data', (d) => framer.push(d));
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        port: (srv.address() as net.AddressInfo).port,
        conns,
        hellos,
        close: () => {
          for (const c of conns) c.sock.destroy();
          return new Promise<void>((r) => srv.close(() => r()));
        },
      });
    });
  });
}


interface Game {
  sock: net.Socket;
  frames: Buffer[];
  closed: boolean;
  
  framesAtClose: Buffer[] | null;
  send(f: Buffer): void;
}

function gameConnect(proxyPort: number): Promise<Game> {
  return new Promise((resolve) => {
    const sock = net.connect(proxyPort, '127.0.0.1');
    const sendRc4 = new RC4Cipher(CLIENT_KEY);
    const game: Game = {
      sock,
      frames: [],
      closed: false,
      framesAtClose: null,
      send: (f) => { const c = Buffer.from(f); sendRc4.cipher(c); sock.write(c); },
    };
    const framer = new Framer(new RC4Cipher(SERVER_KEY), (f) => game.frames.push(f));
    sock.on('data', (d) => framer.push(d));
    sock.on('error', () => {});
    sock.on('close', () => { game.closed = true; game.framesAtClose = [...game.frames]; });
    sock.on('connect', () => resolve(game));
  });
}



class TestProxy extends Proxy {
  freshTargetPort = 0;
  override getState(client: ClientConnection, key: Buffer): State {
    const state = super.getState(client, key);
    if (!state.pendingKeyRestore) {
      state.conTargetAddress = '127.0.0.1';
      state.conTargetPort = this.freshTargetPort;
    }
    return state;
  }
}

let logs: string[] = [];
let cleanups: Array<() => unknown> = [];
let factory: PacketFactory;

async function startProxy(freshTargetPort: number): Promise<{ proxy: TestProxy; port: number; clients: ClientConnection[] }> {
  const proxy = new TestProxy(factory);
  proxy.freshTargetPort = freshTargetPort;
  new ReconnectHandler().attach(proxy);
  const clients: ClientConnection[] = [];
  proxy.on('clientBeginConnect', (c: ClientConnection) => clients.push(c));
  await new Promise<void>((r) => { proxy.once('listenStarted', () => r()); proxy.start('127.0.0.1', 0); });
  cleanups.push(() => { for (const c of clients) c.dispose(); proxy.stop(); });
  const port = ((proxy as any).listener.address() as net.AddressInfo).port;
  return { proxy, port, clients };
}

async function server(scripts: Script[]): Promise<FakeServer> {
  const s = await fakeServer(scripts);
  cleanups.push(() => s.close());
  return s;
}

async function game(proxyPort: number): Promise<Game> {
  const g = await gameConnect(proxyPort);
  cleanups.push(() => g.sock.destroy());
  return g;
}

const silentWarnings = () => logs.filter((l) => l.includes('ended the connection before answering (attempt'));
const syntheticWarnings = () => logs.filter((l) => l.includes('synthesized full-server FAILURE'));
const expectedSilentWarning = (port: number, attempt: number) =>
  `[Client] WARN: server 127.0.0.1:${port} ended the connection before answering (attempt ${attempt}/3)`;


async function expectRetryAfterFullDelay(srv: FakeServer, attempt: number): Promise<void> {
  await until(() => silentWarnings().length >= attempt, `silent-end WARN ${attempt}`);
  const connectionsBefore = srv.conns.length;
  vi.advanceTimersByTime(RETRY_MS - 1);
  await settle();
  expect(srv.conns.length, `no reconnect before ${RETRY_MS} ms (attempt ${attempt})`).toBe(connectionsBefore);
  vi.advanceTimersByTime(1);
  await until(() => srv.hellos.length === connectionsBefore + 1, `retry ${attempt} HELLO reaches the server`);
}

beforeEach(() => {
  logs = [];
  cleanups = [];
  vi.spyOn(Logger, 'log').mockImplementation((m: string, msg: string) => { logs.push(`[${m}] ${msg}`); });
  vi.spyOn(Logger, 'warn').mockImplementation((m: string, msg: string) => { logs.push(`[${m}] WARN: ${msg}`); });
  vi.spyOn(Logger, 'error').mockImplementation((m: string, msg: string) => { logs.push(`[${m}] ERROR: ${msg}`); });
  factory = new PacketFactory(PACKET_DEFINITIONS as DefsFile, STAT_TYPES as any);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
  vi.useRealTimers();
  for (const fn of cleanups.reverse()) await fn();
  vi.restoreAllMocks();
});


describe('admission and recovery loopback', () => {
  it('preserves a real reconnect through the proxy after an unknown rejection', async () => {
    const rejection = failure(1234, 'unknown-current-game-rejection');
    const redirect = reconnect('127.0.0.2', 9999, 1, 123, Buffer.from([7]));
    const srv = await server([answer(rejection, redirect)]);
    const { port, clients } = await startProxy(srv.port);
    const player = await game(port);
    player.send(hello(-2, 0, Buffer.alloc(0)));
    await until(() => player.frames.length === 2, 'both server frames');
    expect(player.frames[0]).toEqual(rejection);
    const decoded = factory.createFromBytes(player.frames[1], 'server');
    expect(decoded.data.host).toBe('127.0.0.1');
    expect(decoded.data.key).toEqual(Buffer.from(clients[0].state.guid));
    expect(clients[0].state.conRealKey).toEqual(Buffer.from([7]));
  });
  it('does not reuse a reconnect handoff after the originating character generation changes', async () => {
    const srv = await server([answer(ping(1))]);
    const { port, clients, proxy } = await startProxy(srv.port);
    const player = await game(port);
    player.send(hello(-2, 0, Buffer.alloc(0)));
    await until(() => player.frames.length === 1, 'connected');
    const client = clients[0];
    const oldGuid = client.state.guid;
    const packet = factory.createFromBytes(reconnect('127.0.0.2', 9999, 1, 123, Buffer.from([7])), 'server');
    proxy.fireServerPacket(client, packet);
    client.admission = { ...client.admission, generation: client.recovery.beginGeneration() };
    const state = proxy.getState(client, Buffer.from(oldGuid));
    expect(state.pendingKeyRestore).toBe(false);
    expect(state.conRealKey).toEqual(Buffer.alloc(0));
  });
  it('requires MAPINFO followed by character readiness and fences stale generations', async () => {
    const srv = await server([answer(queueInformation(0, 120))]);
    const { port, clients } = await startProxy(srv.port);
    const player = await game(port);
    player.send(hello(-2, 0, Buffer.alloc(0)));
    await until(() => player.frames.length === 1, 'queue delivered');
    const generation = clients[0].admission.generation;
    const map = factory.createByName('MAPINFO');
    map.data = { width: 100, height: 100, name: 'Nexus', displayName: 'Nexus', realmName: '', fp: 0, background: 0, difficulty: 0, allowPlayerTeleport: false, noSave: false, showDisplays: false, maxPlayers: 85, gameOpenedTime: 0, serverVersion: '', viewDistance: 15 };
    const mapBytes = factory.serialize(map);
    expect(factory.createFromBytes(mapBytes, 'server').isDefined).toBe(true);
    srv.conns[0].send(mapBytes);
    await until(() => player.frames.length === 2, 'map delivered');
    expect(clients[0].admission.phase).toBe('connecting');
    expect(clients[0].admission.generation).toBeGreaterThan(generation);
    srv.conns[0].send(frame(101, [i32(10), i32(1), str('')]));
    await until(() => player.frames.length === 3, 'character ready');
    expect(clients[0].admission.phase).toBe('loaded');
    expect(player.frames[1]).toEqual(mapBytes);
  });
  it('queue zero remains pending and forwards original bytes', async () => {
    const queue = queueInformation(0, 120);
    const srv = await server([answer(queue)]);
    const { port, clients } = await startProxy(srv.port);
    const player = await game(port);
    player.send(hello(-2, 0, Buffer.alloc(0)));
    await until(() => player.frames.length === 1, 'queue delivery');
    expect(player.frames).toEqual([queue]);
    expect(clients[0].admission.phase).toBe('admission-pending');
    vi.advanceTimersByTime(15000);
    await settle();
    expect(srv.conns).toHaveLength(1);
    expect(srv.conns[0].frames).toHaveLength(1);
  });
  it('cancels pending transport retry on QUEUECANCEL without altering its frame', async () => {
    const srv = await server([silentEnd]);
    const { port, clients } = await startProxy(srv.port);
    const player = await game(port);
    player.send(hello(-2, 0, Buffer.alloc(0)));
    await until(() => silentWarnings().length === 1, 'scheduled retry');
    const packet = factory.createByName('QUEUECANCEL');
    packet.data.queueType = 'test-queue';
    player.send(factory.serialize(packet));
    await until(() => clients[0].admission.phase === 'cancelled', 'cancel observed');
    vi.advanceTimersByTime(30000);
    await settle();
    expect(srv.conns).toHaveLength(1);
  });
  it('a replacement HELLO cancels the old target retry', async () => {
    const oldServer = await server([silentEnd]);
    const nextServer = await server([answer(ping(7))]);
    const { port, clients, proxy } = await startProxy(oldServer.port);
    const player = await game(port);
    player.send(hello(-2, 0, Buffer.alloc(0)));
    await until(() => silentWarnings().length === 1, 'scheduled retry');
    const oldGeneration = clients[0].admission.generation;
    proxy.freshTargetPort = nextServer.port;
    player.send(hello(-2, 0, Buffer.alloc(0)));
    await until(() => nextServer.hellos.length === 1, 'new hello');
    vi.advanceTimersByTime(15000);
    await settle();
    expect(oldServer.conns).toHaveLength(1);
    expect(clients[0].admission.generation).toBeGreaterThan(oldGeneration);
  });
  it('real FAILURE is byte-identical and disables silent retries', async () => {
    const rejection = failure(1234, 'unknown-current-game-rejection');
    const srv = await server([answerThenEnd(rejection)]);
    const { port, clients } = await startProxy(srv.port);
    const player = await game(port);
    player.send(hello(-2, 0, Buffer.alloc(0)));
    await until(() => player.closed, 'forwarded rejection close');
    expect(player.frames).toEqual([rejection]);
    expect(clients[0].admission).toMatchObject({ phase: 'terminal', reason: 'server-rejection-unknown', source: 'server' });
    vi.advanceTimersByTime(15000);
    await settle();
    expect(srv.conns).toHaveLength(1);
  });
  it('cancels escape writes on close and ignores late reconnect hooks', async () => {
    const srv = await server([answer(ping(1))]);
    const { port, clients, proxy } = await startProxy(srv.port);
    const player = await game(port);
    player.send(hello(-2, 0, Buffer.alloc(0)));
    await until(() => player.frames.length === 1, 'server ready');
    const client = clients[0];
    expect(client.recovery.requestEscape(client.admission.generation, { retries: 2, retryMs: 100 })).toBe(true);
    await until(() => srv.conns[0].frames.length === 2, 'initial escape');
    const state = client.state;
    client.dispose();
    const late = factory.createFromBytes(reconnect('127.0.0.2', 9999, 1, 123, Buffer.from([7])), 'server');
    proxy.fireServerPacket(client, late);
    vi.advanceTimersByTime(1000);
    await settle();
    expect(state.conTargetPort).toBe(srv.port);
    expect(srv.conns[0].frames).toHaveLength(2);
  });
});
