import { describe, expect, it, vi } from 'vitest';
import { PluginContext } from '../PluginContext.js';

describe('PluginContext.updateSettingOptions', () => {
  it('replaces select options, preserves value/default, and notifies the manager hook', () => {
    const context = new PluginContext({} as any, 'test-plugin', 'test-plugin.ts');
    context.registerSetting('skin', {
      label: 'Skin',
      type: 'select',
      value: 'skin:1001',
      options: [{ label: 'Old', value: 'skin:1001' }],
    });
    const notify = vi.fn();
    context.onSettingOptionsChanged = notify;

    const options = [{
      label: 'Golden Knight',
      value: 'skin:1001',
      iconUrl: '/api/wiki-texture-file?file=players&index=7',
      metadata: { objectType: 0x1001, classType: 0x301 },
    }];
    expect(context.updateSettingOptions('skin', options)).toBe(true);

    expect(context.getSetting('skin')).toBe('skin:1001');
    expect(context.getSettings()[0].options).toEqual(options);
    expect(notify).toHaveBeenCalledWith('test-plugin', 'skin');
    expect(context.resetSettingsToDefaults()).toEqual([]);
  });

  it('rejects unknown and non-select settings without notifying', () => {
    const context = new PluginContext({} as any, 'test-plugin', 'test-plugin.ts');
    context.registerSetting('enabled', { label: 'Enabled', type: 'boolean', value: true });
    const notify = vi.fn();
    context.onSettingOptionsChanged = notify;

    expect(context.updateSettingOptions('missing', [])).toBe(false);
    expect(context.updateSettingOptions('enabled', [])).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });
});
