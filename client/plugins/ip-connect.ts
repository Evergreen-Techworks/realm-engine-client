import type { PluginContext } from './api.js';
import type { ClientConnection } from './api.js';

/**
 * IP Connect plugin.
 *
 * Connects the player to any server by IP address. Controllable from:
 *  - Dashboard: text input for IP, number inputs for port/gameId, connect button
 *  - In-game command: /goto {ip} or /goto {ip}:{port}
 *
 * Examples:
 *   /goto 54.241.208.233         → connect to IP on port 2050
 *   /goto 54.241.208.233:2050    → connect to IP on specific port
 *
 * Works by injecting a RECONNECT packet that routes the client back through
 * the proxy to the specified IP with a fresh connection.
 */

const IPV4_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export function register(ctx: PluginContext) {
  ctx.name = 'IP Connect';
  ctx.category = 'network';

  let targetIp = '';
  let targetPort = 2050;
  let targetGameId = -2;
  let currentClient: ClientConnection | null = null;

  // Track the active client
  ctx.on('clientConnected', (client) => {
    currentClient = client;
  });
  ctx.on('clientDisconnected', () => {
    currentClient = null;
  });

  // Dashboard settings
  ctx.registerSetting('ip', {
    label: 'IP Address',
    type: 'text',
    value: '',
  }, (val: string) => { targetIp = val; });

  ctx.registerSetting('port', {
    label: 'Port',
    type: 'number',
    value: targetPort,
    min: 1,
    max: 65535,
    step: 1,
  }, (val: number) => { targetPort = val; });

  ctx.registerSetting('gameId', {
    label: 'Game ID',
    type: 'number',
    value: targetGameId,
    min: -10,
    max: 999999,
    step: 1,
  }, (val: number) => { targetGameId = val; });

  ctx.registerSetting('connect', {
    label: 'Connect',
    type: 'button',
    value: null,
  }, () => {
    if (!currentClient) {
      ctx.log('No client connected');
      return;
    }
    if (!targetIp || !IPV4_REGEX.test(targetIp)) {
      ctx.log(`Invalid IP address: "${targetIp}"`);
      return;
    }
    connectToIp(currentClient, targetIp, targetPort, targetGameId);
  });

  // In-game command: /goto {ip} or /goto {ip}:{port}
  ctx.hookCommand('goto', (client, _cmd, args) => {
    if (args.length === 0) {
      ctx.sendNotification(client, 'IP Connect', 'Usage: /goto {ip} or /goto {ip}:{port}');
      return;
    }

    let ip: string;
    let port = 2050;

    // Parse ip:port format
    if (args[0].includes(':')) {
      const parts = args[0].split(':');
      ip = parts[0];
      port = parseInt(parts[1], 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        ctx.sendNotification(client, 'IP Connect', `Invalid port: ${parts[1]}`);
        return;
      }
    } else {
      ip = args[0];
    }

    if (!IPV4_REGEX.test(ip)) {
      ctx.sendNotification(client, 'IP Connect', `Invalid IP: ${ip}`);
      return;
    }

    connectToIp(client, ip, port, -2);
  });

  // ─── Core reconnect logic ──────────────────────────────

  function connectToIp(client: ClientConnection, ip: string, port: number, gameId: number): void {
    if (!client.state) {
      ctx.log('Client has no state — cannot connect');
      return;
    }

    ctx.log(`Connecting to ${ip}:${port} (gameId=${gameId})...`);
    ctx.sendNotification(client, 'IP Connect', `Connecting to ${ip}:${port}...`);

    // Set the new target on the state so ReconnectHandler picks it up
    client.state.conTargetAddress = ip;
    client.state.conTargetPort = port;
    client.state.conRealKey = Buffer.alloc(0);

    // Inject RECONNECT to the client
    const reconnect = ctx.createPacket('RECONNECT');
    reconnect.data = {
      name: `${ip}:${port}`,
      host: '127.0.0.1',
      port: 2050,
      gameId,
      keyTime: -1,
      key: Buffer.from(client.state.guid, 'utf8'),
    };
    reconnect.modified = true;
    client.sendToClient(reconnect);
  }

  ctx.log('Loaded — /goto {ip} or /goto {ip}:{port}');
}
