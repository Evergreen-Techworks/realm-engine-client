import type { PluginContext } from './api.js';
import { sendDllFeature } from './api.js';

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

  ctx.registerCleanup(() => {
    sendDllFeature('speedHackMult', 1.0);
  });
}
