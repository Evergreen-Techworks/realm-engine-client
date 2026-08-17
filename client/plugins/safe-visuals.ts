import type { PluginContext } from '../src/plugins/PluginContext.js';
import { sendDllFeature } from '../src/bridge/DllFeatureBus.js';

export function register(ctx: PluginContext) {
  ctx.name = 'Safe Visuals';
  ctx.category = 'visual';

  let skinOverrideEnabled = false;
  let skinOverrideId = 0;

  function flush(forceOff = false) {
    sendDllFeature('skinOverrideEnabled', !forceOff && ctx.enabled && skinOverrideEnabled);
    sendDllFeature('skinOverrideId', skinOverrideId);
  }

  ctx.registerSetting('skinOverrideEnabled', {
    label: 'Override skin',
    type: 'boolean',
    value: skinOverrideEnabled,
  }, (val: boolean) => {
    skinOverrideEnabled = val;
    flush();
  });

  ctx.registerSetting('skinOverrideId', {
    label: 'Skin ID',
    type: 'number',
    value: skinOverrideId,
  }, (val: number) => {
    skinOverrideId = Math.trunc(val);
    flush();
  });

  ctx.onEnabledChange((enabled) => {
    flush(!enabled);
  });
  ctx.on('clientConnected', () => {
    flush();
  });
  ctx.on('clientDisconnected', () => {
    flush(true);
  });

  ctx.hookCommand('sv', (client, _cmd, args) => {
    if (args.length > 0) {
      const val = parseInt(args[0], 10);
      if (!isNaN(val) && val >= 0) {
        skinOverrideId = val;
        ctx.updateSetting('skinOverrideId', val);
        skinOverrideEnabled = true;
        ctx.updateSetting('skinOverrideEnabled', true);
        ctx.enabled = true;
        flush();
        ctx.sendNotification(client, ctx.name, `Skin override set to ID: ${val}`);
        return;
      }
    }
    skinOverrideEnabled = !skinOverrideEnabled;
    ctx.updateSetting('skinOverrideEnabled', skinOverrideEnabled);
    flush();
    ctx.sendNotification(client, ctx.name, `Safe Visuals skin override ${skinOverrideEnabled ? 'ON' : 'OFF'}`);
  });

  ctx.registerCleanup(() => {
    flush(true);
  });
}
