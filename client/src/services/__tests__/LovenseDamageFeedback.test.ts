import { describe, expect, it, vi } from 'vitest';
import {
  LovenseDamageFeedback,
  parseLovenseConfig,
  vibrationStrengthForDamage,
  type LovenseFunctionCommand,
} from '../LovenseDamageFeedback.js';

function enabledConfig(overrides: Record<string, unknown> = {}) {
  return parseLovenseConfig({
    enabled: true,
    endpoint: 'http://127.0.0.1:20010/command',
    minStrength: 3,
    maxStrength: 20,
    damagePercentForMaxStrength: 50,
    pulseSeconds: 2,
    cooldownMs: 250,
    ...overrides,
  });
}

describe('LovenseDamageFeedback', () => {
  it('ignores initial state, heals, unchanged HP, resets, and owner changes', async () => {
    const sent: LovenseFunctionCommand[] = [];
    const feedback = new LovenseDamageFeedback(enabledConfig(), async command => { sent.push(command); });
    const source = {};

    await feedback.observeHealth(source, 10, 800, 1_000);
    await feedback.observeHealth(source, 10, 900, 1_000);
    await feedback.observeHealth(source, 10, 900, 1_000);
    feedback.reset(source);
    await feedback.observeHealth(source, 10, 500, 1_000);
    await feedback.observeHealth(source, 11, 100, 1_000);

    expect(sent).toEqual([]);
  });

  it('maps confirmed HP loss to one bounded Function command', async () => {
    const sent: LovenseFunctionCommand[] = [];
    const feedback = new LovenseDamageFeedback(enabledConfig({ toyId: 'toy-123' }), async command => { sent.push(command); });
    const source = {};

    await feedback.observeHealth(source, 10, 1_000, 1_000);
    await feedback.observeHealth(source, 10, 750, 1_000);

    expect(sent).toEqual([{
      command: 'Function',
      action: 'Vibrate:12',
      timeSec: 2,
      apiVer: 1,
      toy: 'toy-123',
    }]);
  });

  it('suppresses damage inside cooldown and resumes afterward', async () => {
    let now = 1_000;
    const sender = vi.fn(async (_command: LovenseFunctionCommand) => {});
    const feedback = new LovenseDamageFeedback(enabledConfig(), sender, () => now);
    const source = {};

    await feedback.observeHealth(source, 10, 1_000, 1_000);
    await feedback.observeHealth(source, 10, 900, 1_000);
    now += 100;
    await feedback.observeHealth(source, 10, 800, 1_000);
    now += 151;
    await feedback.observeHealth(source, 10, 700, 1_000);

    expect(sender).toHaveBeenCalledTimes(2);
  });

  it('keeps sender failures non-fatal', async () => {
    const feedback = new LovenseDamageFeedback(enabledConfig(), async () => { throw new Error('offline'); });
    const source = {};

    await feedback.observeHealth(source, 10, 1_000, 1_000);
    await expect(feedback.observeHealth(source, 10, 900, 1_000)).resolves.toBeUndefined();
  });
});

describe('Lovense config and scaling', () => {
  it('disables invalid endpoints and clamps public command values', () => {
    const config = parseLovenseConfig({
      enabled: true,
      endpoint: 'file:///secret/command',
      minStrength: -5,
      maxStrength: 99,
      pulseSeconds: 0,
      cooldownMs: -1,
    });

    expect(config.enabled).toBe(false);
    expect(config.minStrength).toBe(1);
    expect(config.maxStrength).toBe(20);
    expect(config.pulseSeconds).toBe(2);
    expect(config.cooldownMs).toBe(0);
  });

  it('clamps strength between configured minimum and maximum', () => {
    const config = enabledConfig({ minStrength: 4, maxStrength: 18 });
    expect(vibrationStrengthForDamage(1, 1_000, config)).toBe(4);
    expect(vibrationStrengthForDamage(900, 1_000, config)).toBe(18);
  });
});
