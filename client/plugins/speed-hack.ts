import type { PluginContext } from '../src/plugins/PluginContext.js';
import { sendDllFeature } from '../src/bridge/DllFeatureBus.js';

export function register(ctx: PluginContext) {
  ctx.name = 'Speed Hack';
  ctx.category = 'movement';

  ctx.registerSetting('speedMult', {
    label: 'Speed multiplier',
    type: 'range',
    value: 1.0,
    min: 1.0,
    step: 0.1,
  }, (v: number) => sendDllFeature('speedHackMult', v));

  ctx.onEnabledChange((enabled) => {
    if (!enabled) sendDllFeature('speedHackMult', 1.0);
    else sendDllFeature('speedHackMult', ctx.getSetting<number>('speedMult'));
  });

  ctx.on('clientConnected', () => {
    if (ctx.enabled) {
      sendDllFeature('speedHackMult', ctx.getSetting<number>('speedMult'));
    }
  });

  ctx.on('clientDisconnected', () => {
    sendDllFeature('speedHackMult', 1.0);
  });

  ctx.hookCommand('sh', (client, _cmd, args) => {
    if (args.length > 0) {
      const val = parseFloat(args[0]);
      if (!isNaN(val) && val >= 1.0) {
        ctx.updateSetting('speedMult', val);
        if (ctx.enabled) sendDllFeature('speedHackMult', val);
        ctx.sendNotification(client, ctx.name, `Speed multiplier set to ${val.toFixed(1)}x`);
        return;
      }
    }
    ctx.enabled = !ctx.enabled;
    const cur = ctx.enabled ? ctx.getSetting<number>('speedMult') : 1.0;
    sendDllFeature('speedHackMult', cur);
    ctx.sendNotification(client, ctx.name, `Speed Hack ${ctx.enabled ? 'ON' : 'OFF'} (${cur}x)`);
  });

  ctx.registerCleanup(() => {
    sendDllFeature('speedHackMult', 1.0);
  });
}
