import { afterEach, expect, it, vi } from 'vitest';
import type { PluginContext } from '../../../plugins/api.js';
import { StatType } from '../../constants/StatType.js';
vi.mock('../../../plugins/api.js', async () => ({
  StatType: (await import('../../constants/StatType.js')).StatType,
  sendDllFeature: vi.fn(),
  getDllThreats: vi.fn(() => [{ fallbackDamage: 29000, tHitMs: 0 }]),
  getDllGround: vi.fn(() => ({ damage: 9999 })),
}));
import { sendDllFeature, getDllThreats } from '../../../plugins/api.js';
import { register } from '../../../plugins/auto-nexus.js';
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks(); });
function fixture() {
  vi.useFakeTimers();
  const hooks = new Map<string, (...args: any[]) => void>();
  const settings = new Map<string, (...args: any[]) => void>();
  const events = new Map<string, (...args: any[]) => void>();
  const cleanup: (() => void)[] = [];
  let onEnable = () => {};
  const client: any = { connected: true, objectId: 1, sendToServer: vi.fn(),
    playerData: { effectiveMaxHealth: 1000, health: 800, mapName: 'Realm' } };
  const ctx = { enabled: true,
    registerSetting: (name: string, _def: any, fn: any) => settings.set(name, fn),
    onEnabledChange: (fn: any) => { onEnable = fn; },
    registerCleanup: (fn: any) => cleanup.push(fn), on: (name: string, fn: any) => events.set(name, fn),
    hookCommand: vi.fn(), updateSetting: vi.fn(), log: vi.fn(),
    hookPacket: (name: string, fn: (...args: any[]) => void) => hooks.set(name, fn),
    createPacket: (name: string) => ({ name }), sendNotification: vi.fn() };
  register(ctx as unknown as PluginContext);
  const emit = (name: string, data: any = {}) => {
    const packet = { isDefined: true, data, send: true };
    hooks.get(name)?.(client, packet); return packet;
  };
  const hp = (value: number) => emit('NEWTICK', { statuses: [{ objectId: 1, data: [{ id: StatType.HP, value }] }] });
  return { client, ctx, settings, events, cleanup, emit, hp, disable: () => { ctx.enabled = false; onEnable(); } };
}
it('ignores all forecasts, guessed client hits and ground/AoE warnings, including legacy configuration', () => {
  const f = fixture(); f.hp(800);
  for (const name of ['PLAYERHIT','GROUNDDAMAGE','AOE','AOEACK','MOVE'])
    expect(f.emit(name, { damage: 29000, objectId: 2, bulletId: 3 }).send).toBe(true);
  vi.advanceTimersByTime(10000);
  expect(f.client.sendToServer).not.toHaveBeenCalled();
  expect(getDllThreats).not.toHaveBeenCalled();
  for (const key of ['PredictedAutoNexusHealth','PredictedAutoNexusTime','UnattributedMargin','HoldLethalPlayerHit'])
    expect(f.settings.has(key)).toBe(false);
  for (const key of ['autoNexusEnabled','autoNexusProjPredict','autoNexusTilePredict'])
    expect(sendDllFeature).toHaveBeenCalledWith(key, false);
});
it('uses the current server HP packet and preserves its delivery', () => {
  const f = fixture(); f.hp(800);
  const packet = f.hp(250); // cached playerData still says 800
  expect(f.client.sendToServer).toHaveBeenCalledWith(expect.objectContaining({ name: 'ESCAPE' }));
  expect(packet.send).toBe(true);
});
it('counts confirmed damage once and does not reset it from delta ticks without HP', () => {
  const f = fixture(); f.hp(800);
  f.emit('DAMAGE', { targetId: 1, damageAmount: 300 });
  f.emit('NEWTICK', { statuses: [] });
  f.emit('DAMAGE', { targetId: 1, damageAmount: 200 });
  expect(f.client.sendToServer).not.toHaveBeenCalled(); // 300 HP: no extra unseen-damage margin
  f.emit('DAMAGE', { targetId: 1, damageAmount: 51 });
  expect(f.client.sendToServer).toHaveBeenCalledTimes(1);
});
it('authoritative HP heals replace the confirmed ledger without guessed recovery', () => {
  const f = fixture(); f.hp(800);
  f.emit('DAMAGE', { targetId: 1, damageAmount: 400 });
  f.hp(800);
  f.emit('DAMAGE', { targetId: 1, damageAmount: 400 });
  expect(f.client.sendToServer).not.toHaveBeenCalled();
});
it('does not escape in safe zones and resets health on map/character entry', () => {
  const f = fixture(); f.emit('MAPINFO', { name: 'Nexus' }); f.emit('CREATESUCCESS'); f.hp(100);
  f.emit('DAMAGE', { targetId: 1, kill: true });
  expect(f.client.sendToServer).not.toHaveBeenCalled();
  f.emit('MAPINFO', { name: 'Realm' }); f.emit('CREATESUCCESS'); f.hp(800);
  expect(f.client.sendToServer).not.toHaveBeenCalled();
  f.hp(100); expect(f.client.sendToServer).toHaveBeenCalledTimes(1);
});
it('ignores invalid damage and other targets, while honoring confirmed zero HP', () => {
  const f = fixture(); f.hp(800);
  for (const amount of [NaN, Infinity, -29000, '9999', 0])
    f.emit('DAMAGE', { targetId: 1, damageAmount: amount });
  f.emit('DAMAGE', { targetId: 2, kill: true, damageAmount: 9999 });
  expect(f.client.sendToServer).not.toHaveBeenCalled();
  f.settings.get('ForceAutoNexusHealth')!(0);
  f.hp(0); expect(f.client.sendToServer).toHaveBeenCalledTimes(1);
  expect(f.emit('DEATH').send).toBe(true);
});
it('stops escape retries on disable, disconnect and cleanup', () => {
  const f = fixture(); f.hp(100); vi.advanceTimersByTime(400);
  expect(f.client.sendToServer).toHaveBeenCalledTimes(2);
  f.disable(); vi.advanceTimersByTime(5000);
  expect(f.client.sendToServer).toHaveBeenCalledTimes(2);
  f.events.get('clientDisconnected')!(f.client);
  for (const clean of f.cleanup) clean();
  expect(vi.getTimerCount()).toBe(0);
});
