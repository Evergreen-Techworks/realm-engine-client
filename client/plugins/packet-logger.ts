import type { PluginContext } from './api.js';

/**
 * Example plugin: logs all defined packets to console.
 * Filters out noisy packets (MOVE, NEWTICK, PING, PONG) by default.
 */
const NOISY = new Set(['MOVE', 'NEWTICK', 'PING', 'PONG', 'UPDATEACK', 'GOTOACK', 'AOEACK']);

export function register(ctx: PluginContext) {
  ctx.name = 'Packet Logger';
  ctx.category = 'network';

  // Hook all server packets
  ctx.hookPacket('FAILURE', (client, packet) => {
    ctx.dashboardLog(`FAILURE: ${packet.data.errorId} - ${packet.data.errorMessage}`);
  });

  ctx.hookPacket('TEXT', (client, packet) => {
    ctx.dashboardLog(`TEXT: [${packet.data.name}] ${packet.data.text}`);
  });

  ctx.hookPacket('CREATESUCCESS', (client, packet) => {
    ctx.dashboardLog(`CREATESUCCESS: objectId=${packet.data.objectId}, charId=${packet.data.charId}`);
  });

  ctx.hookPacket('MAPINFO', (client, packet) => {
    ctx.dashboardLog(`MAPINFO: ${packet.data.name} (${packet.data.width}x${packet.data.height})`);
  });

  ctx.hookPacket('RECONNECT', (client, packet) => {
    ctx.dashboardLog(`RECONNECT: ${packet.data.name} -> ${packet.data.host}:${packet.data.port}`);
  });

  ctx.hookPacket('DEATH', (client, packet) => {
    ctx.dashboardLog(`DEATH: killed by ${packet.data.killedBy}`);
  });

  ctx.hookCommand('logger', (client, cmd, args) => {
    ctx.sendNotification(client, 'Packet Logger', `Logger is ${ctx.enabled ? 'ON' : 'OFF'}`);
  });
}
