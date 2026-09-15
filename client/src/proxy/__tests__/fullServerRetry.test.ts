// A game server that is full can end the proxy's server connection before it has
// sent a single packet: a reset, a clean close, or a FAILURE that Windows drops
// because the reset arrives first. The proxy used to treat that like any other
// disconnect, so the game got a bare close and sat on the loading screen.
//
// These tests drive real loopback sockets: a fake game -> the real Proxy and
// ReconnectHandler -> a scripted fake game server. Only setTimeout/clearTimeout
// are faked, so socket I/O is real and every retry delay is advanced by hand.
// Every frame is built byte by byte with Buffer, not with PacketWriter.
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

/** length (int32, whole frame) + id (byte) + body, as the proxy sees a decrypted frame. */
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

/** The FAILURE the game must get when every attempt ended silently. */
const FULL_SERVER_FAILURE = failure(0, FULL_SERVER_MESSAGE);

/** Splits a TCP stream into frames and decrypts each with one stateful RC4. */
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

// ─── Waiting on real I/O while setTimeout is faked ──────────────────────────
// vi.waitFor advances fake timers on every poll, which would blur the 5 s
// boundary under test, so poll with setImmediate against the real clock.

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

// ─── Fake game server ───────────────────────────────────────────────────────

interface ServerConn {
  index: number;
  sock: net.Socket;
  frames: Buffer[];
  closed: boolean;
  send(f: Buffer): void;
}

/** What one server connection does once it has read the HELLO. */
type Script = (conn: ServerConn) => void;

const silentReset: Script = (c) => { c.sock.resetAndDestroy(); };
const silentEnd: Script = (c) => { c.sock.end(); };
const hold: Script = () => {};
const answer = (...frames: Buffer[]): Script => (c) => { for (const f of frames) c.send(f); };
const answerThenEnd = (...frames: Buffer[]): Script => (c) => { for (const f of frames) c.send(f); c.sock.end(); };

interface FakeServer {
  port: number;
  conns: ServerConn[];
  /** Plaintext HELLO frames, one per connection that sent one, in order. */
  hellos: Buffer[];
  close(): Promise<void>;
}

/** Connection i runs scripts[i]; later connections repeat the last script. */
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

// ─── Fake game ──────────────────────────────────────────────────────────────

interface Game {
  sock: net.Socket;
  frames: Buffer[];
  closed: boolean;
  /** Frames received before the socket closed, captured at close time. */
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

// ─── Proxy under test ───────────────────────────────────────────────────────

/** A fresh HELLO would otherwise target the hard-coded USWest default on port 2050. */
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

/** Wait until the proxy has handled silent end number `attempt`, then prove the retry waits the full 5 s. */
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

describe('a server that ends the connection before answering', () => {
  for (const [how, script] of [['resets', silentReset], ['closes cleanly', silentEnd]] as const) {
    it(`${how} on every attempt: 3 retries at 5 s, then one synthesized full-server FAILURE and a close`, async () => {
      const srv = await server([script]);
      const { port } = await startProxy(srv.port);
      const g = await game(port);
      const gameHello = hello(-2, 0, Buffer.alloc(0));
      g.send(gameHello);

      for (let attempt = 1; attempt <= 3; attempt++) {
        await expectRetryAfterFullDelay(srv, attempt);
        expect(g.closed, `game socket stays open through attempt ${attempt}`).toBe(false);
        expect(g.frames, 'the game hears nothing while the proxy retries').toEqual([]);
      }

      await until(() => g.closed, 'the game socket closes after the last silent attempt');
      expect(g.framesAtClose).toEqual([FULL_SERVER_FAILURE]);

      // It is the FAILURE the proxy's own definitions read, with nothing left over.
      const parsed = factory.createFromBytes(Buffer.from(g.framesAtClose![0]), 'server');
      expect(parsed.name).toBe('FAILURE');
      expect(parsed.data).toEqual({ errorId: 0, errorMessage: FULL_SERVER_MESSAGE });
      expect(parsed.unreadData.length).toBe(0);

      // Every attempt sent the game's HELLO bytes, unchanged.
      expect(srv.hellos).toHaveLength(4);
      for (const h of srv.hellos) expect(h).toEqual(gameHello);

      expect(silentWarnings()).toEqual([1, 2, 3].map((n) => expectedSilentWarning(srv.port, n)));
      expect(syntheticWarnings()).toHaveLength(1);
      expect(syntheticWarnings()[0]).toContain('after 3 silent attempts');

      await until(() => logs.includes('[Client] Disconnected.'), 'the connection is disposed');
      expect(vi.getTimerCount(), 'no timer left behind').toBe(0);
      vi.advanceTimersByTime(60_000);
      await settle();
      expect(srv.conns).toHaveLength(4);
    });
  }

  it('refuses the TCP connection on every attempt: same retries and the same synthesized FAILURE', async () => {
    const closedPort = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const { port } = await startProxy(closedPort);
    const g = await game(port);
    g.send(hello(-2, 0, Buffer.alloc(0)));

    for (let attempt = 1; attempt <= 3; attempt++) {
      await until(() => silentWarnings().length >= attempt, `silent-end WARN ${attempt}`);
      expect(silentWarnings()).toHaveLength(attempt);
      vi.advanceTimersByTime(RETRY_MS - 1);
      await settle();
      expect(silentWarnings(), `no reconnect before ${RETRY_MS} ms`).toHaveLength(attempt);
      expect(syntheticWarnings()).toHaveLength(0);
      vi.advanceTimersByTime(1);
    }

    await until(() => g.closed, 'the game socket closes after the last refused attempt');
    expect(g.framesAtClose).toEqual([FULL_SERVER_FAILURE]);
    expect(silentWarnings()).toEqual([1, 2, 3].map((n) => expectedSilentWarning(closedPort, n)));
    expect(syntheticWarnings()).toHaveLength(1);
  });

  it('resets once, then the next attempt answers: the game carries on and never sees a FAILURE', async () => {
    const srv = await server([silentReset, answer(ping(1234), ping(5678))]);
    const { port } = await startProxy(srv.port);
    const g = await game(port);
    const gameHello = hello(-2, 0, Buffer.alloc(0));
    g.send(gameHello);

    await expectRetryAfterFullDelay(srv, 1);
    await until(() => g.frames.length === 2, 'the answer reaches the game');
    // Decrypting with the game's one continuous RC4 proves the retry did not disturb it.
    expect(g.frames).toEqual([ping(1234), ping(5678)]);
    expect(srv.hellos).toEqual([gameHello, gameHello]);

    // The game keeps talking to the server over the retried connection.
    g.send(load(42));
    await until(() => srv.conns[1].frames.length === 2, 'the game packet reaches the server');
    expect(srv.conns[1].frames[1]).toEqual(load(42));

    vi.advanceTimersByTime(60_000);
    await settle();
    expect(g.closed).toBe(false);
    expect(srv.conns).toHaveLength(2);
    expect(silentWarnings()).toEqual([expectedSilentWarning(srv.port, 1)]);
    expect(syntheticWarnings()).toHaveLength(0);
  });

  it('sends only part of a frame and closes: nothing parseable arrived, so it still retries', async () => {
    const partial: Script = (c) => { c.send(failure(0, FULL_SERVER_MESSAGE).subarray(0, 12)); c.sock.end(); };
    const srv = await server([partial, answer(ping(9))]);
    const { port } = await startProxy(srv.port);
    const g = await game(port);
    g.send(hello(-2, 0, Buffer.alloc(0)));

    await expectRetryAfterFullDelay(srv, 1);
    await until(() => g.frames.length === 1, 'the answer reaches the game');
    expect(g.frames).toEqual([ping(9)]);
    expect(g.closed).toBe(false);
    expect(silentWarnings()).toEqual([expectedSilentWarning(srv.port, 1)]);
  });

  it('sends a real FAILURE on a retry: forwarded unchanged, no further retries', async () => {
    const realFailure = failure(4, 'Server is restarting');
    const srv = await server([silentReset, answerThenEnd(realFailure)]);
    const { port } = await startProxy(srv.port);
    const g = await game(port);
    g.send(hello(-2, 0, Buffer.alloc(0)));

    await expectRetryAfterFullDelay(srv, 1);
    await until(() => g.closed, 'the game socket closes after the real FAILURE');
    expect(g.framesAtClose).toEqual([realFailure]);

    vi.advanceTimersByTime(60_000);
    await settle();
    expect(srv.conns).toHaveLength(2);
    expect(silentWarnings()).toEqual([expectedSilentWarning(srv.port, 1)]);
    expect(syntheticWarnings()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries the escape reconnect (gameId -2 with the real key) with the same key, gameId and keyTime', async () => {
    const realKey = Buffer.from('REAL-NEXUS-KEY-0123456789abcdef', 'utf8');
    const keyTime = 1789441354;
    const nexus = await server([silentReset, answer(ping(77))]);
    const realm = await server([answer(reconnect('127.0.0.1', nexus.port, -2, keyTime, realKey))]);
    const { port } = await startProxy(realm.port);

    // In the realm: the server sends RECONNECT, which the proxy points back at itself.
    const inRealm = await game(port);
    inRealm.send(hello(0, 0, Buffer.alloc(0)));
    await until(() => inRealm.frames.length === 1, 'the rewritten RECONNECT reaches the game');
    const rec = inRealm.frames[0];
    let off = 5;
    off += 2 + rec.readInt16BE(off); // name
    off += 2 + rec.readInt16BE(off); // host
    off += 2; // port
    const recGameId = rec.readInt32BE(off); off += 4;
    const recKeyTime = rec.readInt32BE(off); off += 4;
    const guidKey = Buffer.from(rec.subarray(off + 2, off + 2 + rec.readInt16BE(off)));
    inRealm.sock.destroy();
    await until(() => logs.includes('[Client] Disconnected.'), 'the realm connection is disposed');

    // The game reconnects to the proxy with the guid; the proxy swaps the real key back in.
    const toNexus = await game(port);
    toNexus.send(hello(recGameId, recKeyTime, guidKey));

    await expectRetryAfterFullDelay(nexus, 1);
    await until(() => toNexus.frames.length === 1, 'the Nexus answer reaches the game');
    expect(toNexus.frames).toEqual([ping(77)]);

    const expectedNexusHello = hello(-2, keyTime, realKey);
    expect(nexus.hellos).toEqual([expectedNexusHello, expectedNexusHello]);
    expect(silentWarnings()).toEqual([expectedSilentWarning(nexus.port, 1)]);
  });
});

describe('connections the retry must leave alone', () => {
  it('a server that answered and closes later is a normal disconnect: no retry', async () => {
    const srv = await server([answer(ping(1))]);
    const { port } = await startProxy(srv.port);
    const g = await game(port);
    g.send(hello(-2, 0, Buffer.alloc(0)));

    await until(() => g.frames.length === 1, 'the answer reaches the game');
    srv.conns[0].sock.end();
    await until(() => g.closed, 'the game socket closes with the server');
    expect(g.framesAtClose).toEqual([ping(1)]);

    vi.advanceTimersByTime(60_000);
    await settle();
    expect(srv.conns).toHaveLength(1);
    expect(silentWarnings()).toHaveLength(0);
    expect(syntheticWarnings()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the game closing first disposes at once: server socket closed, no retry', async () => {
    const srv = await server([hold]);
    const { port } = await startProxy(srv.port);
    const g = await game(port);
    g.send(hello(-2, 0, Buffer.alloc(0)));
    await until(() => srv.hellos.length === 1, 'the HELLO reaches the server');

    g.sock.destroy();
    await until(() => srv.conns[0].closed, 'the proxy closes the server connection');
    expect(vi.getTimerCount(), 'the HELLO timer is cancelled').toBe(0);

    vi.advanceTimersByTime(60_000);
    await settle();
    expect(srv.conns).toHaveLength(1);
    expect(silentWarnings()).toHaveLength(0);
  });

  it('the game closing during the 5 s wait cancels the retry timer', async () => {
    const srv = await server([silentReset]);
    const { port } = await startProxy(srv.port);
    const g = await game(port);
    g.send(hello(-2, 0, Buffer.alloc(0)));
    await until(() => silentWarnings().length === 1, 'the first silent end is handled');
    expect(vi.getTimerCount(), 'the retry is waiting').toBe(1);

    g.sock.destroy();
    await until(() => logs.includes('[Client] Disconnected.'), 'the connection is disposed');
    expect(vi.getTimerCount(), 'the retry timer is cancelled').toBe(0);

    vi.advanceTimersByTime(60_000);
    await settle();
    expect(srv.conns).toHaveLength(1);
    expect(syntheticWarnings()).toHaveLength(0);
  });

  it('the game closing while a retry is connected destroys that server socket and leaves no timer', async () => {
    const srv = await server([silentReset, hold]);
    const { port, clients } = await startProxy(srv.port);
    const g = await game(port);
    g.send(hello(-2, 0, Buffer.alloc(0)));
    await expectRetryAfterFullDelay(srv, 1);

    g.sock.destroy();
    await until(() => srv.conns[1].closed, 'the proxy closes the retried server connection');
    await until(() => !clients[0].connected, 'the connection is disposed');
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(60_000);
    await settle();
    expect(srv.conns).toHaveLength(2);
    expect(syntheticWarnings()).toHaveLength(0);
  });
});

describe('QUEUE_INFORMATION', () => {
  it('logs one info line per packet, with its fields, and still forwards it', async () => {
    const srv = await server([answer(queueInformation(7, 120), queueInformation(6, 120))]);
    const { port } = await startProxy(srv.port);
    const g = await game(port);
    g.send(hello(-2, 0, Buffer.alloc(0)));

    await until(() => g.frames.length === 2, 'both queue packets reach the game');
    expect(g.frames).toEqual([queueInformation(7, 120), queueInformation(6, 120)]);
    expect(logs.filter((l) => l.includes('QUEUE_INFORMATION'))).toEqual([
      '[Client] QUEUE_INFORMATION curPos=7 maxPos=120',
      '[Client] QUEUE_INFORMATION curPos=6 maxPos=120',
    ]);
  });
});
