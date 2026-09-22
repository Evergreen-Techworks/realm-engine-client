/**
 * Shared harness for the Auto Nexus plugin tests. The test file must mock
 * `plugins/api.js` (see autoNexusForecast.test.ts) before this module loads the plugin.
 *
 * ENEMYSHOOT, SERVERPLAYERSHOOT and PLAYERHIT frames are built byte by byte and
 * parsed by the real PacketFactory, so the plugin sees the wire field shapes.
 */
import { expect, vi } from 'vitest';
import type { PluginContext } from '../../../../plugins/api.js';
import { register } from '../../../../plugins/auto-nexus.js';
import { StatType } from '../../../constants/StatType.js';
import { ConditionEffect } from '../../../constants/ConditionEffect.js';
import { PacketFactory } from '../../../packets/PacketFactory.js';
import type { Packet } from '../../../packets/Packet.js';
import PACKET_DEFINITIONS from '../../../packets/packetDefinitions.generated.js';
import STAT_TYPES from '../../../packets/statTypes.generated.js';
import { RecoveryCoordinator } from '../../../proxy/RecoveryCoordinator.js';

const factory = new PacketFactory(PACKET_DEFINITIONS as any, STAT_TYPES as any);

const u8 = (v: number) => Buffer.from([v & 0xff]);
const i16 = (v: number) => { const b = Buffer.alloc(2); b.writeInt16BE(v); return b; };
const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); return b; };
const i32 = (v: number) => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; };
const f32 = (v: number) => { const b = Buffer.alloc(4); b.writeFloatBE(v); return b; };
function frame(id: number, parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([i32(5 + body.length), u8(id), body]);
}

export interface ProjectileFixture {
  damage?: number;
  armorPiercing?: boolean;
  lifetimeMs?: number;
  conditionEffects?: { effect: string; durationSec: number }[];
}

/** Deep-freeze so any write to parsed packet data throws inside the hook. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    for (const key of Object.keys(value as object)) deepFreeze((value as any)[key]);
    Object.freeze(value);
  }
  return value;
}

export function fixture() {
  vi.useFakeTimers();
  const hooks = new Map<string, (...args: any[]) => void>();
  const settings = new Map<string, (...args: any[]) => void>();
  const events = new Map<string, (...args: any[]) => void>();
  const cleanup: (() => void)[] = [];
  const commands = new Map<string, (...args: any[]) => void>();
  let onEnable = () => {};
  const entityTypes = new Map<number, number>();
  const objects = new Map<number, { id: string; displayId: string; isEnemy: boolean; projectiles: Map<number, ProjectileFixture> }>();
  const client: any = { connected: true, objectId: 1, sendToServer: vi.fn(),
    playerData: { effectiveMaxHealth: 1000, health: 800, mapName: 'Realm', defense: 0, effects: [0, 0] } };
  client.recovery = new RecoveryCoordinator({
    isConnected: () => client.connected,
    sendEscape: () => client.sendToServer({ name: 'ESCAPE', modified: true }),
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  });
  client.admission = { generation: client.recovery.beginGeneration(), phase: 'loaded' };
  const ctx = { enabled: true,
    registerSetting: (name: string, _def: any, fn: any) => settings.set(name, fn),
    onEnabledChange: (fn: any) => { onEnable = fn; },
    registerCleanup: (fn: any) => cleanup.push(fn), on: (name: string, fn: any) => events.set(name, fn),
    hookCommand: vi.fn((name: string, fn: any) => commands.set(name, fn)), updateSetting: vi.fn(), log: vi.fn(),
    hookPacket: (name: string, fn: (...args: any[]) => void) => hooks.set(name, fn),
    createPacket: (name: string) => ({ name }), sendNotification: vi.fn(),
    getWorldState: () => ({ getEntityType: (id: number) => entityTypes.get(id) }),
    gameData: {
      getObject: (type: number) => objects.get(type),
      getProjectile: (type: number, id: number) => {
        const p = objects.get(type)?.projectiles.get(id);
        return p && { id, speed: 0, hitRadius: 0.5, multiHit: false, passesCover: false, maxHealthDamage: 0,
          damage: p.damage ?? 0, armorPiercing: p.armorPiercing === true, lifetimeMs: p.lifetimeMs ?? 2000,
          conditionEffects: p.conditionEffects ?? [] };
      },
    },
  };
  const controls = register(ctx as unknown as PluginContext);

  const emit = (name: string, data: any = {}) => {
    if (name === 'MAPINFO') client.admission.generation = client.recovery.beginGeneration();
    if (name === 'RECONNECT') client.recovery.acceptReconnect(client.admission.generation);
    const packet = { isDefined: true, data, send: true };
    hooks.get(name)?.(client, packet); return packet;
  };
  const hp = (value: number) => emit('NEWTICK', { statuses: [{ objectId: 1, data: [{ id: StatType.HP, value }] }] });

  /** Register an enemy object and put one instance of it in the world. */
  const enemy = (objectId: number, type: number, displayId: string, projectiles: Record<number, ProjectileFixture>) => {
    objects.set(type, { id: displayId, displayId, isEnemy: true,
      projectiles: new Map(Object.entries(projectiles).map(([k, v]) => [Number(k), v])) });
    entityTypes.set(objectId, type);
  };

  const deliver = (name: string, bytes: Buffer, direction: 'client' | 'server'): Packet => {
    const packet = factory.createFromBytes(bytes, direction);
    expect(packet.isDefined).toBe(true);
    expect(packet.name).toBe(name);
    hooks.get(name)?.(client, packet);
    return packet;
  };

  /** Server ENEMYSHOOT; `numShots` omitted means the optional tail is absent on the wire. */
  const enemyShoot = (ownerId: number, bulletId: number, bulletType: number, damage: number, numShots?: number) =>
    deliver('ENEMYSHOOT', frame(35, [u16(bulletId), i32(ownerId), u8(bulletType), f32(10), f32(10), f32(0), i16(damage),
      ...(numShots === undefined ? [] : [u8(numShots), f32(0.1)])]), 'server');

  const serverPlayerShoot = (ownerId: number, bulletId: number, containerType: number, damage: number, bulletType = 0) =>
    deliver('SERVERPLAYERSHOOT', frame(12, [u16(bulletId), i32(ownerId), i32(containerType), f32(10), f32(10), f32(0),
      i16(damage), i32(ownerId), u8(bulletType), u8(1), f32(0)]), 'server');

  /**
   * Outgoing PLAYERHIT from the game client. Asserts the proxy would forward it
   * byte-identical: still sent, not marked modified, raw bytes untouched, data unwritten.
   */
  const playerHit = (bulletId: number, objectId: number) => {
    const bytes = frame(90, [u16(bulletId), i32(objectId)]);
    const original = Buffer.from(bytes);
    const packet = factory.createFromBytes(bytes, 'client');
    expect(packet.name).toBe('PLAYERHIT');
    const dataBefore = JSON.stringify(packet.data);
    const raw = packet.rawBytes;
    deepFreeze(packet.data);
    hooks.get('PLAYERHIT')?.(client, packet);
    expect(packet.send).toBe(true);
    expect(packet.modified).toBe(false);
    expect(packet.rawBytes).toBe(raw);
    expect(Buffer.compare(packet.rawBytes, original)).toBe(0);
    expect(packet.unreadData.length).toBe(0);
    expect(JSON.stringify(packet.data)).toBe(dataBefore);
    return packet;
  };

  const damage = (bulletId: number, objectId: number, amount: number) => {
    const bytes = frame(75, [i32(client.objectId), u8(0), u16(amount), u8(0), u16(bulletId), i32(objectId), Buffer.from([0xde, 0xad])]);
    const original = Buffer.from(bytes);
    const packet = factory.createFromBytes(bytes, 'server');
    expect(packet.name).toBe('DAMAGE');
    const before = JSON.stringify(packet.data);
    deepFreeze(packet.data);
    hooks.get('DAMAGE')?.(client, packet);
    expect(packet.send).toBe(true);
    expect(packet.modified).toBe(false);
    expect(packet.rawBytes).toEqual(original);
    expect(JSON.stringify(packet.data)).toBe(before);
    expect(factory.serialize(packet)).toEqual(original);
    return packet;
  };

  const setCondition = (name: keyof typeof ConditionEffect, on = true) => {
    const bit = ConditionEffect[name];
    const effects = client.playerData.effects as [number, number];
    const slot = bit < 31 ? 0 : 1;
    const mask = 1 << (bit < 31 ? bit : bit - 31);
    effects[slot] = on ? effects[slot] | mask : effects[slot] & ~mask;
  };

  const escapes = () => (client.sendToServer.mock.calls as any[][]).filter(([p]) => p?.name === 'ESCAPE').length;
  const escapeLog = () => (ctx.log.mock.calls as any[][]).map(([line]) => String(line)).filter(l => l.startsWith('AUTO NEXUS'));

  return {
    client, ctx, settings, events, cleanup, commands, emit, hp, enemy, enemyShoot, serverPlayerShoot, playerHit, damage,
    setCondition, escapes, escapeLog, entityTypes, observation: () => controls.observation(client),
    transitions: () => controls.transitions(client),
    disable: () => { ctx.enabled = false; onEnable(); },
    enable: () => { ctx.enabled = true; onEnable(); },
  };
}
