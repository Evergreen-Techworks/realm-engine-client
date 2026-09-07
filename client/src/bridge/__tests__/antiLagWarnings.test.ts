import { describe, expect, it } from 'vitest';
import { register } from '../../../plugins/anti-lag.js';
import type { PluginContext } from '../../../plugins/api.js';

describe('anti-lag attack warnings', () => {
  function sendEffect(effect: number): boolean {
    const hooks = new Map<string, (client: unknown, packet: unknown) => void>();
    const settings: Record<string, unknown> = {
      blockShowEffect: true,
      blockedShowEffects: '4,5,7,16,23,26,39',
    };
    register({
      registerSetting() {},
      getSetting: (key: string) => settings[key],
      hookPacket: (name: string, handler: (client: unknown, packet: unknown) => void) => hooks.set(name, handler),
      log() {},
    } as unknown as PluginContext);
    const packet = {
      isDefined: true, unreadData: Buffer.from([effect]), rawBytes: Buffer.alloc(0), send: true,
    };
    hooks.get('SHOWEFFECT')!(null, packet);
    return packet.send;
  }

  it.each([4, 5, 16, 23, 26, 39])('preserves attack warning %i even in a custom blocklist', (effect) => {
    expect(sendEffect(effect)).toBe(true);
  });
  it('still suppresses a listed cosmetic line effect', () => {
    expect(sendEffect(7)).toBe(false);
  });
});
