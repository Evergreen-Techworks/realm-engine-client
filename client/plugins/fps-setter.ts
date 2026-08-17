import type { PluginContext } from '../src/plugins/PluginContext.js';
import { sendDllFeature } from '../src/bridge/DllFeatureBus.js';

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
    const fps = ctx.enabled ? (ctx.getSetting<number>('targetFps') ?? -1) : -1;
    sendDllFeature('targetFrameRate', Math.trunc(fps));
  });

  ctx.hookCommand('fs', (client, _cmd, args) => {
    if (args.length > 0) {
      const val = parseInt(args[0], 10);
      if (!isNaN(val) && val >= -1 && val <= 300) {
        ctx.updateSetting('targetFps', val);
        sendDllFeature('targetFrameRate', val);
        ctx.sendNotification(client, ctx.name, `Target FPS set to ${val === -1 ? 'uncapped' : val}`);
        return;
      }
    }
    ctx.enabled = !ctx.enabled;
    const cur = ctx.enabled ? (ctx.getSetting<number>('targetFps') ?? 60) : -1;
    sendDllFeature('targetFrameRate', cur);
    ctx.sendNotification(client, ctx.name, `FPS Setter ${ctx.enabled ? 'ON' : 'OFF'} (${cur === -1 ? 'uncapped' : cur + ' FPS'})`);
  });

  ctx.registerCleanup(() => {
    sendDllFeature('targetFrameRate', -1);
  });
}
