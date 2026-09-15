import http from 'http';
import net from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { networkInterfaces, tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

vi.mock('../../../util/Logger.js', () => ({
  Logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { DevServer as DevServerType } from '../DevServer.js';
import { stopSmartTrimScheduler } from '../../trim/smartTrimScheduler.js';
import { stopExaltTuneWatchdog } from '../../process/exaltTuneWatchdog.js';

// The dashboard's HTTP API and WebSocket have no authentication and handle
// Deca accounts (saved logins, credential launches). Bound to every interface,
// anyone on the same LAN or Wi-Fi could drive it, and Windows Firewall prompted
// on first launch. A web page could also reach it through DNS rebinding (a
// foreign Host) or by opening ws://localhost itself (a foreign Origin).

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const savedEnv = { USERPROFILE: process.env.USERPROFILE, REALM_ENGINE_USER_CONFIG_PATH: process.env.REALM_ENGINE_USER_CONFIG_PATH };
let profile: string;
let server: DevServerType;
let httpServer: http.Server;
let port: number;

beforeAll(async () => {
  // Keep the real Documents/Realmengine (exalt tune settings, config overlay) out of it.
  profile = mkdtempSync(join(tmpdir(), 're-devserver-loopback-'));
  process.env.USERPROFILE = profile;
  process.env.REALM_ENGINE_USER_CONFIG_PATH = join(profile, 'config.json');
  const { DevServer } = await import('../DevServer.js');
  const { PacketInspector } = await import('../PacketInspector.js');
  const { PluginManager } = await import('../../../plugins/PluginManager.js');

  // As index.ts does it, on an ephemeral port so a running Realm Engine cannot collide.
  const pluginManager = new PluginManager({} as any, join(profile, 'plugins'), join(profile, 'Plugins'));
  server = new DevServer(new PacketInspector(), pluginManager, publicDir);
  (server as any).autoUpdateCheckDone = true; // no Deca CDN request when a socket connects
  server.start(0);
  httpServer = (server as any).httpServer as http.Server;
  if (!httpServer.listening) await new Promise((r) => httpServer.once('listening', r));
  port = (httpServer.address() as net.AddressInfo).port;
});

afterAll(async () => {
  await new Promise((r) => httpServer.close(() => r(undefined)));
  stopSmartTrimScheduler();
  stopExaltTuneWatchdog();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(profile, { recursive: true, force: true });
});

function get(headers: Record<string, string>): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/plugins', method: 'GET', headers }, (res) => {
      res.resume();
      resolveStatus(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

function upgrade(headers: Record<string, string>): Promise<number | 'open'> {
  return new Promise((resolveResult) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers });
    ws.on('open', () => { ws.terminate(); resolveResult('open'); });
    ws.on('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolveResult(res.statusCode ?? 0); });
    ws.on('error', () => {});
  });
}

describe('dashboard server exposure', () => {
  it('binds 127.0.0.1 only, so no other address of this machine reaches it', async () => {
    expect((httpServer.address() as net.AddressInfo).address).toBe('127.0.0.1');
    const external = Object.values(networkInterfaces()).flat()
      .filter((a): a is NonNullable<typeof a> => !!a && a.family === 'IPv4' && !a.internal)
      .map((a) => a.address);
    const reachable = await Promise.all(external.map((address) => new Promise<string | null>((r) => {
      const socket = net.connect({ host: address, port });
      socket.setTimeout(1500, () => { socket.destroy(); r(null); });
      socket.once('connect', () => { socket.destroy(); r(`${address}:${port}`); });
      socket.once('error', () => r(null));
    })));
    expect(reachable.filter(Boolean), 'dashboard reachable on another address').toEqual([]);
  }, 10000);

  it('answers a loopback Host and refuses any other with 403', async () => {
    expect(await get({ Host: `127.0.0.1:${port}` })).toBe(200);
    expect(await get({ Host: `localhost:${port}` })).toBe(200);
    expect(await get({ Host: `rebind.attacker.example:${port}` })).toBe(403);
    expect(await get({ Host: `192.168.1.20:${port}` })).toBe(403);
    expect(await get({ Host: `localhost:${port + 1}` })).toBe(403);
  });

  it('refuses a request carrying another site\'s Origin', async () => {
    expect(await get({ Host: `localhost:${port}`, Origin: `http://localhost:${port}` })).toBe(200);
    expect(await get({ Host: `localhost:${port}`, Origin: 'https://attacker.example' })).toBe(403);
  });

  it('applies the same check to the WebSocket upgrade', async () => {
    expect(await upgrade({ Host: `localhost:${port}`, Origin: `http://localhost:${port}` })).toBe('open');
    expect(await upgrade({ Host: `rebind.attacker.example:${port}` })).toBe(403);
    expect(await upgrade({ Host: `localhost:${port}`, Origin: 'https://attacker.example' })).toBe(403);
  });
});
