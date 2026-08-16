import type { PluginContext } from './api.js';
import { sendDllFeature } from './api.js';

export function register(ctx: PluginContext) {
  ctx.name = 'FPS Setter';
  ctx.category = 'utility';

  ctx.registerSetting('targetFps', {
    label: 'Target FPS (-1 = uncapped)',
    type: 'number',
    value: -1,
    min: -1,
    max: 300,
    step: 1,
  }, (val: number) => {
    sendDllFeature('targetFrameRate', Math.trunc(val));
  });

  ctx.on('clientConnected', () => {
    const fps = ctx.getSetting<number>('targetFps') ?? -1;
    sendDllFeature('targetFrameRate', Math.trunc(fps));
  });

  ctx.registerCleanup(() => {
    sendDllFeature('targetFrameRate', -1);
  });
}
