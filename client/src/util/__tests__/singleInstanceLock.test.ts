import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// electron/services/single-instance.cjs is plain CommonJS with no Electron
// dependency, so the lock itself runs here under Node.
interface Owner { pid: number | null }
type LockResult =
  | { status: 'acquired'; release: () => Promise<void> }
  | { status: 'focused'; owner: Owner }
  | { status: 'unreachable'; error: NodeJS.ErrnoException; owner: Owner | null }
  | { status: 'unavailable'; error: NodeJS.ErrnoException };
interface LockOptions {
  onFocusRequest?: (request: Owner) => void;
  beforeFocus?: (owner: Owner) => void;
  replyTimeoutMs?: number;
  attempts?: number;
}
interface SingleInstanceModule {
  acquireInstanceLock(pipePath: string, options?: LockOptions): Promise<LockResult>;
  machineInstancePipePath(options?: { platform?: string; user?: { username: string; domain?: string } }): string | null;
}

const require = createRequire(import.meta.url);
const modulePath = require.resolve('../../../electron/services/single-instance.cjs');
const lock = require(modulePath) as SingleInstanceModule;

// A kernel-owned name on each platform, so a killed holder releases it the way
// the Windows pipe does: \\.\pipe\ on Windows, the abstract namespace on Linux.
// macOS only has file sockets, which outlive a killed holder.
const pathForId = (id: string) =>
  process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : process.platform === 'linux' ? `\0${id}` : join(tmpdir(), `${id}.sock`);
const newId = () => `RealmEngine-instance-test-${process.pid}-${randomBytes(6).toString('hex')}`;

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function acquireOwned(pipePath: string, options?: LockOptions) {
  const result = await lock.acquireInstanceLock(pipePath, options);
  if (result.status === 'acquired') cleanups.push(result.release);
  return result;
}

describe('acquireInstanceLock', () => {
  it('grants the first caller, sends later callers to it with a focus request, and frees on release', async () => {
    const pipePath = pathForId(newId());
    const focusRequests: Owner[] = [];
    const first = await acquireOwned(pipePath, { onFocusRequest: (request) => focusRequests.push(request) });
    expect(first.status).toBe('acquired');

    const seenOwners: Owner[] = [];
    const second = await lock.acquireInstanceLock(pipePath, { beforeFocus: (owner) => seenOwners.push(owner) });
    expect(second).toEqual({ status: 'focused', owner: { pid: process.pid } });
    // The caller learns the owner before asking, so it can grant it the foreground.
    expect(seenOwners).toEqual([{ pid: process.pid }]);
    expect(focusRequests).toEqual([{ pid: process.pid }]);

    const third = await lock.acquireInstanceLock(pipePath);
    expect(third.status).toBe('focused');
    expect(focusRequests).toHaveLength(2);

    if (first.status !== 'acquired') throw new Error('unreachable');
    await first.release();
    await first.release(); // idempotent

    const again = await acquireOwned(pipePath);
    expect(again.status).toBe('acquired');
  });

  it('still sends the caller away when the owner fails to show its window', async () => {
    const pipePath = pathForId(newId());
    await acquireOwned(pipePath, { onFocusRequest: () => { throw new Error('window gone'); } });
    const second = await lock.acquireInstanceLock(pipePath);
    expect(second.status).toBe('focused');
  });

  it('ignores a connection that is not a focus request and keeps serving', async () => {
    const pipePath = pathForId(newId());
    let focusRequests = 0;
    await acquireOwned(pipePath, { onFocusRequest: () => { focusRequests++; } });

    await new Promise<void>((resolve) => {
      const junk = net.connect(pipePath, () => junk.write('{"type":"quit"}\n'));
      junk.on('error', () => {});
      junk.resume(); // read the owner's hello, so its hang-up reaches 'close'
      junk.on('close', () => resolve());
    });
    expect(focusRequests).toBe(0);

    expect((await lock.acquireInstanceLock(pipePath)).status).toBe('focused');
    expect(focusRequests).toBe(1);
  });

  it('reports a holder that never answers as unreachable instead of starting', async () => {
    const pipePath = pathForId(newId());
    const silent = net.createServer((socket) => socket.on('error', () => {}));
    const sockets = new Set<net.Socket>();
    silent.on('connection', (socket) => sockets.add(socket));
    await new Promise<void>((resolve) => silent.listen(pipePath, resolve));
    cleanups.push(() => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      silent.close(() => resolve());
    }));

    const started = Date.now();
    const result = await lock.acquireInstanceLock(pipePath, { replyTimeoutMs: 250 });
    expect(result.status).toBe('unreachable');
    if (result.status !== 'unreachable') throw new Error('unreachable');
    expect(result.error.code).toBe('ETIMEDOUT');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reports a holder speaking another protocol as unreachable', async () => {
    const pipePath = pathForId(newId());
    const foreign = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    await new Promise<void>((resolve) => foreign.listen(pipePath, resolve));
    cleanups.push(() => new Promise<void>((resolve) => foreign.close(() => resolve())));

    const result = await lock.acquireInstanceLock(pipePath, { replyTimeoutMs: 1000 });
    expect(result.status).toBe('unreachable');
  });

  it.skipIf(process.platform === 'darwin')('is released when the holding process is killed', async () => {
    const id = newId();
    const pipePath = pathForId(id);
    const holderScript = `
      const { acquireInstanceLock } = require(process.argv[1]);
      const id = process.argv[2];
      const pipePath = process.platform === 'win32' ? '\\\\\\\\.\\\\pipe\\\\' + id : '\\0' + id;
      acquireInstanceLock(pipePath, {
        onFocusRequest: ({ pid }) => process.stdout.write('focus ' + pid + '\\n'),
      }).then((result) => process.stdout.write(result.status + '\\n'));
      setInterval(() => {}, 1000);
    `;
    const holder: ChildProcess = spawn(process.execPath, ['-e', holderScript, modulePath, id], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise<void>((resolve) => holder.once('exit', () => resolve()));
    cleanups.push(async () => { if (holder.exitCode === null && holder.signalCode === null) { holder.kill('SIGKILL'); await exited; } });
    let output = '';
    holder.stdout!.setEncoding('utf8');
    const waitFor = (text: string) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`holder never printed ${JSON.stringify(text)}; got ${JSON.stringify(output)}`)), 10000);
      const check = () => { if (output.includes(text)) { clearTimeout(timer); resolve(); } };
      holder.stdout!.on('data', (chunk: string) => { output += chunk; check(); });
      check();
    });
    await waitFor('acquired\n');

    // Another process owns it: this one is sent there, and the holder hears it.
    const whileHeld = await lock.acquireInstanceLock(pipePath);
    expect(whileHeld).toEqual({ status: 'focused', owner: { pid: holder.pid } });
    await waitFor(`focus ${process.pid}\n`);

    holder.kill('SIGKILL'); // TerminateProcess on Windows: no cleanup code runs
    await exited;

    const afterKill = await acquireOwned(pipePath);
    expect(afterKill.status).toBe('acquired');
  }, 20000);
});

describe('machineInstancePipePath', () => {
  it('is Windows-only', () => {
    expect(lock.machineInstancePipePath({ platform: 'linux', user: { username: 'jesse' } })).toBeNull();
    expect(lock.machineInstancePipePath({ platform: 'darwin', user: { username: 'jesse' } })).toBeNull();
  });

  it('names one pipe per Windows account, whatever the folder or copy', () => {
    const jesse = lock.machineInstancePipePath({ platform: 'win32', user: { username: 'Jesse', domain: 'DESKTOP-1' } });
    expect(jesse).toMatch(/^\\\\\.\\pipe\\RealmEngine-instance-jesse-[0-9a-f]{12}$/);
    // Windows account names are case-insensitive.
    expect(lock.machineInstancePipePath({ platform: 'win32', user: { username: 'jesse', domain: 'desktop-1' } })).toBe(jesse);
    expect(lock.machineInstancePipePath({ platform: 'win32', user: { username: 'Jesse', domain: 'OTHERDOMAIN' } })).not.toBe(jesse);
    expect(lock.machineInstancePipePath({ platform: 'win32', user: { username: 'Alex', domain: 'DESKTOP-1' } })).not.toBe(jesse);
  });

  it('keeps the name valid for any account name', () => {
    const odd = lock.machineInstancePipePath({ platform: 'win32', user: { username: 'Jö sé/\\:*', domain: 'D' } })!;
    expect(odd.slice('\\\\.\\pipe\\'.length)).not.toMatch(/[\\/:*\s]/);
    const lookalike = lock.machineInstancePipePath({ platform: 'win32', user: { username: 'J_ s_____', domain: 'D' } });
    expect(lookalike).not.toBe(odd);
  });
});
