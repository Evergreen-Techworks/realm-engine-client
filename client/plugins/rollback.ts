import type { PluginContext } from '../src/plugins/PluginContext.js';
import type { ClientConnection } from '../src/proxy/ClientConnection.js';

/**
 * Rollback plugin — exact port of the RealmStock MultiTool /rollback feature.
 *
 * How the MultiTool does it (Class72 / packet id 74 = HELLO):
 *   1. Every HELLO the client sends to the server is intercepted by the proxy.
 *      All fields are cached in Settings.LatestRollbackPacket* (int_0=gameId,
 *      string_0=buildVersion, string_1=accessToken, int_1=keyTime, byte_3=key,
 *      string_2=gameNet, string_3=playPlatform, string_4=platformToken,
 *      string_5=userToken, string_6=clientIdentification).
 *   2. /rollback reconstructs the HELLO from those cached fields and calls
 *      method_4 (sendToServer) — sending it directly to the game server
 *      mid-session, with no RECONNECT injected to the client at all.
 *
 * bot-client mapping:
 *   - Hook HELLO (client→server).  ReconnectHandler fires first and patches
 *     the key back in (pendingKeyRestore), so by the time our hook runs the
 *     packet already has the real session key.  We snapshot all fields then.
 *   - /rollback recreates the HELLO packet from the snapshot and calls
 *     client.sendToServer() — identical to the MultiTool's method_4 call.
 */

interface CachedHello {
  gameId:               number;
  buildVersion:         string;
  accessToken:          string;
  keyTime:              number;
  key:                  number[];   // Buffer serialised as plain array
  gameNet:              string;
  playPlatform:         string;
  platformToken:        string;
  userToken:            string;
  clientIdentification: string;
}

const STORE_KEY = 'rollback.hello';

export function register(ctx: PluginContext) {
  ctx.name     = 'Rollback';
  ctx.category = 'network';

  let currentClient: ClientConnection | null = null;

  ctx.on('clientConnected',    (c) => { currentClient = c; });
  ctx.on('clientDisconnected', ()  => { currentClient = null; });

  // ─── Dashboard ────────────────────────────────────────────────────
  ctx.registerSetting('lastGameId', {
    label:  'Last Cached gameId',
    type:   'text',
    value:  '(none)',
  });

  ctx.registerSetting('rollback', {
    label: 'Rollback',
    type:  'button',
    value: null,
  }, () => {
    if (currentClient) doRollback(currentClient);
    else ctx.log('No client connected');
  });

  // ─── Step 1: capture every HELLO the client sends ─────────────────
  //
  // ReconnectHandler's HELLO hook fires before ours (it registered first).
  // It has already restored the real session key into packet.data.key, so
  // we snapshot the packet with the correct key the server will actually see.

  ctx.hookPacket('HELLO', (client, packet) => {
    if (!client.state) return;

    const raw = packet.data;

    const cached: CachedHello = {
      gameId:               raw.gameId               as number,
      buildVersion:         raw.buildVersion          as string  ?? '',
      accessToken:          raw.accessToken           as string  ?? '',
      keyTime:              raw.keyTime               as number,
      key:                  Array.from(Buffer.isBuffer(raw.key) ? raw.key as Buffer : Buffer.alloc(0)),
      gameNet:              raw.gameNet               as string  ?? '',
      playPlatform:         raw.playPlatform          as string  ?? '',
      platformToken:        raw.platformToken         as string  ?? '',
      userToken:            raw.userToken             as string  ?? '',
      clientIdentification: raw.clientIdentification  as string  ?? '',
    };

    client.state.set(STORE_KEY, cached);
    currentClient = client;

    ctx.updateSetting('lastGameId', String(cached.gameId));
    ctx.log(`Cached HELLO — gameId=${cached.gameId} buildVersion="${cached.buildVersion}" keyLen=${cached.key.length}`);
  });

  // ─── Step 2: /rollback or /rb — send the cached HELLO to the server ──────
  const handleRollback = (client: ClientConnection, _cmd: string, args: string[]) => {
    if (args.length !== 0) {
      ctx.sendNotification(client, 'Rollback', 'Usage: /rb or /rollback');
      return;
    }
    doRollback(client);
  };

  ctx.hookCommand('rollback', handleRollback);
  ctx.hookCommand('rb', handleRollback);

  // ─── Core logic ───────────────────────────────────────────────────

  function doRollback(client: ClientConnection): void {
    if (!client.state) {
      ctx.sendNotification(client, 'Rollback', 'No active connection');
      return;
    }

    const cached = client.state.get<CachedHello>(STORE_KEY);
    if (!cached) {
      ctx.sendNotification(client, 'Rollback', 'No HELLO captured yet — connect to the game first');
      return;
    }

    ctx.log(`/rollback — sending HELLO to server (gameId=${cached.gameId})`);
    ctx.sendNotification(client, 'Rollback', 'Sending rollback packet!');

    // Reconstruct the HELLO packet exactly as the MultiTool does (Class72
    // fields → Class72.Write → networkStream_1 via method_4 / sendToServer).
    const hello = ctx.createPacket('HELLO');
    hello.data = {
      gameId:               cached.gameId,
      buildVersion:         cached.buildVersion,
      accessToken:          cached.accessToken,
      keyTime:              cached.keyTime,
      key:                  Buffer.from(cached.key),
      gameNet:              cached.gameNet,
      playPlatform:         cached.playPlatform,
      platformToken:        cached.platformToken,
      userToken:            cached.userToken,
      clientIdentification: cached.clientIdentification,
    };
    hello.modified = true;

    // Send directly to the game server — no RECONNECT to the client.
    client.sendToServer(hello);
  }

  ctx.log('Loaded — /rollback or dashboard button to re-send last HELLO to the server');
}
