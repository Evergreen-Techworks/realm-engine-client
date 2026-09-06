import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { Proxy } from '../proxy/Proxy.js';
import type { ClientConnection } from '../proxy/ClientConnection.js';
import { Logger } from '../util/Logger.js';
import { GAME_PORT } from '../constants/GameId.js';

/** Simple IPv4 validator for /con <ip>. */
const IPV4_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Build abbreviation from server name: uppercase letters + digits, e.g. USSouth3 → USS3, EUEast → EUE */
function abbreviation(name: string): string {
  return name.replace(/[^A-Z0-9]/g, '');
}

/**
 * Registers built-in in-game commands that always work (no plugin enabled required):
 * - /ip — show current server IP and name
 * - /con (servername) or /con (abbreviation) — switch server (e.g. /con USSouth3 or /con USS3)
 */
export function attachCoreCommands(proxy: Proxy, dataDir: string, bakedServers?: Record<string, string> | null): void {
  const serversPath = join(dataDir, 'servers.json');
  let servers: Record<string, string> = bakedServers ? { ...bakedServers } : {};
  const ipToName = new Map<string, string>();
  const abbrToName = new Map<string, string>();

  if (!bakedServers && existsSync(serversPath)) {
    try {
      servers = JSON.parse(readFileSync(serversPath, 'utf8'));
      for (const [name, ip] of Object.entries(servers)) {
        ipToName.set(ip, name);
        const abbr = abbreviation(name).toLowerCase();
        if (abbr && !abbrToName.has(abbr)) abbrToName.set(abbr, name);
      }
      Logger.log('CoreCommands', `Loaded ${Object.keys(servers).length} servers, /ip and /con ready`);
    } catch (err) {
      Logger.warn('CoreCommands', `Failed to load servers.json: ${(err as Error).message}`);
    }
  } else if (bakedServers) {
    for (const [name, ip] of Object.entries(servers)) {
      ipToName.set(ip, name);
      const abbr = abbreviation(name).toLowerCase();
      if (abbr && !abbrToName.has(abbr)) abbrToName.set(abbr, name);
    }
    Logger.log('CoreCommands', `Loaded ${Object.keys(servers).length} baked servers, /ip and /con ready`);
  }

  function sendNotification(client: ClientConnection, sender: string, message: string): void {
    const textPacket = proxy.packetFactory.createByName('TEXT');
    textPacket.data = {
      name: sender,
      objectId: -1,
      numStars: -1,
      bubbleTime: 0,
      recipient: '',
      text: message,
      cleanText: message,
      isSupporter: false,
      starBg: 0,
    };
    client.sendToClient(textPacket);
  }

  function switchServer(client: ClientConnection, serverName: string, ip: string): void {
    if (!client.state) {
      sendNotification(client, 'Proxy', 'No connection state — cannot switch.');
      return;
    }
    Logger.log('CoreCommands', `Switching to ${serverName} (${ip})...`);
    sendNotification(client, 'Proxy', `Connecting to ${serverName}...`);
    client.state.conTargetAddress = ip;
    client.state.conTargetPort = GAME_PORT;
    client.state.conRealKey = Buffer.alloc(0);
    const reconnect = proxy.packetFactory.createByName('RECONNECT');
    reconnect.data = {
      name: serverName,
      host: '127.0.0.1',
      port: GAME_PORT,
      gameId: -2,
      keyTime: -1,
      key: Buffer.from(client.state.guid, 'utf8'),
    };
    reconnect.modified = true;
    client.sendToClient(reconnect);
  }

  proxy.hookCommand('ip', (client, _cmd, _args) => {
    if (!client.state) {
      sendNotification(client, 'Proxy', 'Not connected.');
      return;
    }
    const ip = client.state.conTargetAddress || '';
    const name = ipToName.get(ip) || '(unknown)';
    sendNotification(client, 'Proxy', `${name}: ${ip}`);
  });

  proxy.hookCommand('con', (client, _cmd, args) => {
    const serverNames = Object.keys(servers);
    if (serverNames.length === 0) {
      sendNotification(client, 'Proxy', 'No servers loaded.');
      return;
    }
    if (args.length === 0) {
      sendNotification(
        client,
        'Proxy',
        `Servers: ${serverNames.join(', ')}. Use /con <name, abbr, or ip> e.g. /con USS3 or /con 54.234.226.24`,
      );
      return;
    }

    const raw = args[0];

    // Direct IP: /con 1.2.3.4
    if (IPV4_REGEX.test(raw)) {
      const ip = raw;
      const name = ipToName.get(ip) || ip;
      switchServer(client, name, ip);
      return;
    }

    const query = raw.toLowerCase();
    const byAbbr = abbrToName.get(query);
    if (byAbbr) {
      switchServer(client, byAbbr, servers[byAbbr]);
      return;
    }
    const byPrefix = serverNames.filter(n => n.toLowerCase().startsWith(query));
    if (byPrefix.length === 0) {
      sendNotification(client, 'Proxy', `No server matching "${args[0]}". Try /con for list.`);
      return;
    }
    if (byPrefix.length > 1) {
      const exact = byPrefix.find(n => n.toLowerCase() === query);
      if (exact) {
        switchServer(client, exact, servers[exact]);
        return;
      }
      sendNotification(client, 'Proxy', `Ambiguous: ${byPrefix.join(', ')}`);
      return;
    }
    switchServer(client, byPrefix[0], servers[byPrefix[0]]);
  });
}
