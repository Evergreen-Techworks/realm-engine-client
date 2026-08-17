import type { PluginContext } from '../src/plugins/PluginContext.js';
import { sendDllFeature } from '../src/bridge/DllFeatureBus.js';

export function register(ctx: PluginContext) {
  ctx.name = 'Admin';
  ctx.category = 'admin';

  let aoeackSpoof = false;
  let playerhitRedirect = false;

  ctx.registerSetting('aoeackSpoof', {
    label: 'AOEACK Position Spoof',
    type: 'boolean',
    value: false,
  }, (v: boolean) => { aoeackSpoof = v; });

  ctx.registerSetting('playerhitRedirect', {
    label: 'Redirect PLAYERHIT to nearby player',
    type: 'boolean',
    value: false,
  }, (v: boolean) => { playerhitRedirect = v; });

  ctx.registerSetting('unloadDll', {
    label: 'Unload DLL',
    type: 'button',
    value: null,
  }, () => {
    if (!sendDllFeature('internalUnloadDll', true)) {
      ctx.log('Unload DLL requested, but the internal bridge is not connected');
    }
  });

  // Draws each live bullet's predicted future trajectory (magenta polyline
  // sampled finer than the danger-grid stamping) so we can visually
  // compare ComputePosAt against where bullets actually go in-game.
  // Useful for diagnosing slow / speed-changing projectile aliasing.
  // Independent of the planned-path overlay (auto-dodge → Draw planned
  // path); either can be on by itself or together.
  ctx.registerSetting('drawProjPred', {
    label: 'Draw predicted projectile paths (debug)',
    type: 'boolean',
    value: false,
  }, (v: boolean) => sendDllFeature('xdodgeDrawProjPred', v ? 1 : 0));

  // Long-horizon probe for the tracking-residual HUD. 50ms is always
  // measured (matches the planner slice); this is the second probe.
  // Compounding error from accelerating bullets shows up here when 50ms
  // looks clean — pick something like 250-400ms to see late-horizon
  // drift. Range 80-1000ms.
  ctx.registerSetting('debugPredLongMs', {
    label: 'Tracking HUD: long-horizon probe (ms)',
    type: 'range',
    value: 250,
    min: 80,
    max: 1000,
    step: 10,
  }, (v: number) => sendDllFeature('xdodgeDebugPredLongMs', v));

  ctx.hookPacket('AOEACK', (_client, packet) => {
    if (!aoeackSpoof || !packet.isDefined) return;
    const pos = packet.data.position as { x: number; y: number };
    if (!pos) return;
    pos.x += 500;
    packet.modified = true;
  });

  ctx.hookPacket('PLAYERHIT', (client, packet) => {
    if (!playerhitRedirect || !packet.isDefined) return;

    const myPos = client.playerData?.pos;
    if (!myPos) return;

    const myOid = client.objectId;
    const worldState = ctx.worldState;
    const gameData = ctx.gameData;
    if (!worldState || !gameData) return;

    // Find the nearest player within 4 tiles (excluding ourselves)
    const nearby = worldState.getEntitiesInRadius(myPos, 4);
    let targetId: number | null = null;
    let bestDist = Infinity;
    for (const e of nearby) {
      if (e.objectId === myOid) continue;
      if (gameData.getObjectCategory(e.objectType) !== 'Player') continue;
      const dx = e.pos.x - myPos.x;
      const dy = e.pos.y - myPos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < bestDist) {
        bestDist = dist;
        targetId = e.objectId;
      }
    }

    if (targetId === null) return;

    // Block the original hit on us
    packet.send = false;

    // Resend as OTHERHIT targeting the nearby player
    const otherHit = ctx.createPacket('OTHERHIT');
    otherHit.data = {
      time: client.gameTime,
      bulletId: packet.data.bulletId as number,
      objectId: packet.data.objectId as number,
      targetId,
    };
    client.sendToServer(otherHit);
  });

  ctx.hookCommand('da', (client) => {
    ctx.enabled = !ctx.enabled;
    ctx.sendNotification(client, ctx.name, `Admin plugin ${ctx.enabled ? 'ON' : 'OFF'}`);
  });
}
