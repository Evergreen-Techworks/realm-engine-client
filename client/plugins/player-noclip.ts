import type { PluginContext } from './api.js';
import { sendDllFeature } from './api.js';

export function register(ctx: PluginContext) {
  ctx.name = 'Player Noclip';
  ctx.category = 'movement';

  let noclipEnabled = false;
  let hotkey = 'N';

  function flush(forceOff = false) {
    const active = !forceOff && ctx.enabled;
    sendDllFeature('playerNoclipActive', active);
    sendDllFeature('playerNoclipEnabled', active && noclipEnabled);
    sendDllFeature('playerNoclipHotkey', hotkey.trim());
  }

  function setNoclipEnabled(enabled: boolean) {
    noclipEnabled = enabled;
    if (!ctx.updateSetting('noclipEnabled', enabled))
      flush();
  }

  ctx.registerSetting('noclipEnabled', {
    label: 'Noclip enabled',
    type: 'boolean',
    value: noclipEnabled,
  }, (val: boolean) => {
    noclipEnabled = val;
    flush();
  });

  ctx.registerSetting('hotkey', {
    label: 'Hotkey',
    type: 'text',
    value: hotkey,
  }, (val: string) => {
    hotkey = String(val || '').trim();
    flush();
  });

  ctx.registerSetting('toggleNoclip', {
    label: 'Toggle Noclip',
    type: 'button',
    value: null,
  }, () => {
    setNoclipEnabled(!noclipEnabled);
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
