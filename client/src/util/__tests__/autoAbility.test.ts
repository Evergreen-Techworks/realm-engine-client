import { afterEach, expect, it, vi } from 'vitest';
import type { PluginContext } from '../../../plugins/api.js';
import { register } from '../../../plugins/auto-ability.js';
import { pauseAutomaticAbility, automaticAbilityPaused } from '../../bridge/AutomaticAbilityPause.js';
import { GameWorldState } from '../../state/GameWorldState.js';
import { PlayerData } from '../../state/PlayerData.js';
import { StatType } from '../../constants/StatType.js';
import type { Proxy } from '../../proxy/Proxy.js';
afterEach(() => { vi.useRealTimers(); });
it('honors renewable connection-scoped script pauses and automatically expires them', () => {
  const f = fixture();
  pauseAutomaticAbility(f.client, 1000); f.tick();
  expect(f.client.sendToServer).not.toHaveBeenCalled();
  expect(automaticAbilityPaused({})).toBe(false);
  vi.setSystemTime(10500); pauseAutomaticAbility(f.client, 1000);
  vi.setSystemTime(11000); f.tick();
  expect(f.client.sendToServer).not.toHaveBeenCalled();
  vi.setSystemTime(11500); f.tick();
  expect(f.client.sendToServer).toHaveBeenCalledOnce();
});
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const hooks = new Map<string, (...args: any[]) => void>();
  const settings = new Map<string, { def: any; set: (v: any) => void }>();
  const worldHooks = new Map<string, (...args: any[]) => void>();
  const world = new GameWorldState();
  world.attach({ hookPacket: (name: string, fn: any) => worldHooks.set(name, fn) } as unknown as Proxy);
  const pd = new PlayerData();
  pd.maxMana = 100; pd.manaBonus = 30; pd.exaltedMaxMP = 70; pd.mana = 100;
  pd.classType = 775; pd.pos = { x: 1, y: 1 }; pd.inventory[1] = 321; pd.mapName = 'Realm';
  const client: any = { connected: true, objectId: 1, time: 9999, playerData: pd, sendToServer: vi.fn() };
  let xml: string | undefined = '<Object><MpCost>20</MpCost></Object>';
  const gd = { getRawObjectXml: () => xml, getObjectCategory: () => 'Enemy',
    getObject: () => ({ maxHp: 100, occupySquare: false, projectiles: new Map() }) };
  const ctx = { enabled: true, gameData: gd, getWorldState: () => world,
    registerSetting: (name: string, def: any, set: any) => settings.set(name, { def, set }),
    hookPacket: (name: string, fn: any) => hooks.set(name, fn), on: vi.fn(), log: vi.fn(),
    createPacket: (name: string) => ({ name, data: {} }) };
  register(ctx as unknown as PluginContext);
  const enemy = () => worldHooks.get('UPDATE')!(client, { isDefined: true, data: { newObjs: [
    { objectType: 2, status: { objectId: 2, position: { x: 5, y: 1 },
      data: [{ id: StatType.HP, value: 100 }, { id: StatType.MaxHP, value: 100 }] } },
  ] } });
  enemy();
  return { client, pd, settings, world, ctx, hooks, enemy,
    setXml: (value: string | undefined) => { xml = value; },
    tick: () => hooks.get('NEWTICK')!(client, { isDefined: true, data: {} }) };
}
it('uses effective max MP and preserves the post-cast reserve with fresh setting keys', () => {
  const f = fixture();
  expect(f.settings.has('mpFloorPct')).toBe(false);
  expect(f.settings.has('minTargetMaxHp')).toBe(false);
  expect(f.settings.get('mpReservePct')?.def.value).toBe(25);
  expect(f.settings.get('targetMinMaxHp')?.def.value).toBe(0);
  f.pd.mana = 60; f.tick(); // 60-20 < 25% of 200; old incomplete max would allow
  expect(f.client.sendToServer).not.toHaveBeenCalled();
  f.pd.mana = 70; f.tick();
  expect(f.client.sendToServer).toHaveBeenCalledWith(expect.objectContaining({ name: 'USEITEM',
    data: expect.objectContaining({ itemUsePos: { x: 5, y: 1 }, slotObject: { objectId: 1, slotId: 1, objectType: 321 } }) }));
});
it('enforces the absolute MP cost even at zero reserve and refreshes cached XML metadata', () => {
  const f = fixture(); f.settings.get('mpReservePct')!.set(0);
  f.pd.mana = 10; f.tick(); expect(f.client.sendToServer).not.toHaveBeenCalled();
  f.setXml('<Object><MpCost>5</MpCost></Object>'); f.tick();
  expect(f.client.sendToServer).toHaveBeenCalledTimes(1);
});
it('accepts missing MpCost, rejects invalid costs, and never sends movement abilities', () => {
  const f = fixture();
  for (const cost of ['NaN', '-1', '']) {
    f.setXml(`<Object><MpCost>${cost}</MpCost></Object>`); f.tick();
  }
  f.setXml('<Object><Activate>Teleport</Activate></Object>'); f.tick();
  expect(f.client.sendToServer).not.toHaveBeenCalled();
  f.setXml('<Object/>'); f.tick(); expect(f.client.sendToServer).toHaveBeenCalledTimes(1);
});
it('retains stationary targets for 3000 ms, and zero disables only the freshness filter', () => {
  const f = fixture(); vi.setSystemTime(12000); f.tick();
  expect(f.client.sendToServer).toHaveBeenCalledTimes(1);
  vi.setSystemTime(14000); f.tick(); expect(f.client.sendToServer).toHaveBeenCalledTimes(1);
  f.settings.get('targetMaxStaleMs')!.set(0); f.tick();
  expect(f.client.sendToServer).toHaveBeenCalledTimes(2);
});
it('allows optional self-casts without targets while aimed classes still need targets', () => {
  const f = fixture(); f.world.clear(); f.pd.classType = 784;
  f.tick(); expect(f.client.sendToServer).not.toHaveBeenCalled();
  f.settings.get('selfNeedsTarget')!.set(false); f.tick();
  expect(f.client.sendToServer).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ itemUsePos: { x: 1, y: 1 } }) }));
  vi.setSystemTime(14000); f.pd.classType = 775; f.tick();
  expect(f.client.sendToServer).toHaveBeenCalledTimes(1);
});
it('keeps cooldowns, manual-use pause and safe-zone pause', () => {
  const f = fixture(); f.tick(); f.tick();
  expect(f.client.sendToServer).toHaveBeenCalledTimes(1);
  f.hooks.get('USEITEM')!(f.client, { data: { slotObject: { slotId: 1 } } });
  vi.setSystemTime(12000); f.tick(); expect(f.client.sendToServer).toHaveBeenCalledTimes(1);
  vi.setSystemTime(13100); f.enemy(); f.tick(); expect(f.client.sendToServer).toHaveBeenCalledTimes(2);
  f.hooks.get('MAPINFO')!(f.client, { data: { name: 'Nexus' } });
  vi.setSystemTime(15000); f.tick(); expect(f.client.sendToServer).toHaveBeenCalledTimes(2);
});
it('logs accurate gate reasons without repeating diagnostic scans every tick', () => {
  const f = fixture(); f.settings.get('diagnostics')!.set(true);
  f.settings.get('targetMinMaxHp')!.set(1000);
  const query = vi.spyOn(f.world, 'getNearestEnemy');
  f.tick(); expect(f.ctx.log).toHaveBeenLastCalledWith(expect.stringContaining('max-HP floor'));
  const before = query.mock.calls.length;
  f.tick(); expect(query.mock.calls.length - before).toBe(1);
  expect(f.ctx.log).toHaveBeenCalledTimes(1);
  f.settings.get('targetMinMaxHp')!.set(0);
  vi.setSystemTime(14000); f.tick(); expect(f.ctx.log).toHaveBeenLastCalledWith(expect.stringContaining('stale'));
});
