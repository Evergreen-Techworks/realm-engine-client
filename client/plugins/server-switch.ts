import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { PluginContext } from '../src/plugins/PluginContext.js';
import type { ClientConnection } from '../src/proxy/ClientConnection.js';
import { fetchServerList } from '../src/services/ServerListFetcher.js';
import { getBakedServers } from '../src/config/BakedData.js';

/**
 * Server Switch plugin.
 *
 * Changes the player's connected game server. Controllable from:
 *  - Dashboard: dropdown selector of all servers
 *  - In-game command: /con {abbreviation}
 *
 * On first client connection, fetches the live server list from the RotMG API
 * using the access token from the HELLO packet. Falls back to servers.json.
 */

export function register(ctx: PluginContext) {
  ctx.name = 'Server Switch';
  ctx.category = 'network';

  // Load fallback servers from data/servers.json
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const serversPath = resolve(__dirname, '..', 'data', 'servers.json');
  let servers: Record<string, string> = getBakedServers() ?? {};
  try {
    if (Object.keys(servers).length === 0) {
      servers = JSON.parse(readFileSync(serversPath, 'utf8'));
    }
  } catch (err) {
    ctx.log(`Failed to load servers.json: ${(err as Error).message}`);
  }

  let currentClient: ClientConnection | null = null;
  let hasFetchedFromApi = false;

  // Register the server dropdown (will be updated after API fetch)
  function rebuildDropdown(): void {
    const serverNames = Object.keys(servers);
    const options = serverNames.map(name => ({
      label: `${name} (${servers[name]})`,
      value: name,
    }));

    ctx.registerSetting('server', {
      label: 'Server',
      type: 'select',
      value: serverNames[0] ?? '',
      options,
    }, (val: string) => {
      if (!currentClient) {
        ctx.log('No client connected');
        return;
      }
      const ip = servers[val];
      if (!ip) {
        ctx.log(`Unknown server: ${val}`);
        return;
      }
      switchServer(currentClient, val, ip);
    });
  }

  // Initial dropdown from fallback data
  rebuildDropdown();

  // Track the active client + fetch live server list
  ctx.on('clientConnected', (client) => {
    currentClient = client;

    if (!hasFetchedFromApi && client.state?.accessToken) {
      hasFetchedFromApi = true;
      fetchServerList(client.state.accessToken)
        .then((apiServers) => {
          const count = Object.keys(apiServers).length;
          if (count > 0) {
            servers = apiServers;
            rebuildDropdown();
            ctx.log(`Fetched ${count} servers from API`);
          }
        })
        .catch((err) => {
          ctx.log(`API fetch failed, using fallback: ${(err as Error).message}`);
        });
    }
  });

  ctx.on('clientDisconnected', () => {
    currentClient = null;
  });

  // In-game command: /con or /ss {abbreviation}
  const handleConCommand = (client: ClientConnection, _cmd: string, args: string[]) => {
    const serverNames = Object.keys(servers);

    if (args.length === 0) {
      ctx.sendNotification(client, 'Server Switch', `Servers: ${serverNames.join(', ')}`);
      return;
    }

    const query = args[0].toLowerCase();
    const matches = serverNames.filter(name => name.toLowerCase().startsWith(query));

    if (matches.length === 0) {
      ctx.sendNotification(client, 'Server Switch', `No server matching "${args[0]}". Available: ${serverNames.join(', ')}`);
      return;
    }

    if (matches.length > 1) {
      const exact = matches.find(m => m.toLowerCase() === query);
      if (exact) {
        switchServer(client, exact, servers[exact]);
        return;
      }
      ctx.sendNotification(client, 'Server Switch', `Ambiguous: ${matches.join(', ')}`);
      return;
    }

    switchServer(client, matches[0], servers[matches[0]]);
  };

  ctx.hookCommand('con', handleConCommand);
  ctx.hookCommand('ss', handleConCommand);

  // ─── Core reconnect logic ──────────────────────────────

  function switchServer(client: ClientConnection, serverName: string, ip: string): void {
    if (!client.state) {
      ctx.log('Client has no state — cannot switch');
      return;
    }

    ctx.log(`Switching to ${serverName} (${ip})...`);
    ctx.sendNotification(client, 'Server Switch', `Connecting to ${serverName}...`);

    client.state.conTargetAddress = ip;
    client.state.conTargetPort = 2050;
    client.state.conRealKey = Buffer.alloc(0);

    const reconnect = ctx.createPacket('RECONNECT');
    reconnect.data = {
      name: serverName,
      host: '127.0.0.1',
      port: 2050,
      gameId: -2,
      keyTime: -1,
      key: Buffer.from(client.state.guid, 'utf8'),
    };
    reconnect.modified = true;
    client.sendToClient(reconnect);
  }

  ctx.log(`Loaded — ${Object.keys(servers).length} servers (fallback), will fetch live list on connect`);
}
