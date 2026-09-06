import type { PluginContext } from './api.js';
import { sendDllFeature } from './api.js';

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

  ctx.registerCleanup(() => {
    flush(true);
  });
}
