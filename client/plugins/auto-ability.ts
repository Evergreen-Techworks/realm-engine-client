import type { PluginContext } from './api.js';
import { sendDllFeature } from './api.js';

export function register(ctx: PluginContext) {
  ctx.name = 'Auto Ability';
  ctx.category = 'combat';

  let wizardMode = 0;

  function flush(forceOff = false) {
    const enabled = !forceOff && ctx.enabled && !!ctx.getSetting('enabled');
    const mpPct = ctx.getSetting<number>('abilityMpPct');
    sendDllFeature('autoAbilityEnabled', enabled);
    sendDllFeature('autoAbilityMpPct', mpPct);
    sendDllFeature('autoAbilityWizardMode', wizardMode);
  }

  ctx.registerSetting('enabled', {
    label: 'Auto ability',
    type: 'boolean',
    value: false,
  }, () => flush());

  ctx.registerSetting('abilityMpPct', {
    label: 'Min MP % (0 = always)',
    type: 'range',
    value: 0,
    min: 0,
    max: 100,
    step: 5,
  }, () => flush());

  ctx.registerSetting('wizardTargetMode', {
    label: 'Wizard target',
    type: 'select',
    value: 'autoaim',
    options: [
      { label: 'Auto-aim target', value: 'autoaim' },
      { label: 'Densest cluster', value: 'cluster' },
    ],
  }, (val: string) => {
    wizardMode = val === 'cluster' ? 1 : 0;
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
