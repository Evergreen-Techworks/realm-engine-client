import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectileTracker } from '../ProjectileTracker.js';
import { Proxy } from '../../proxy/Proxy.js';
import { PacketFactory } from '../../packets/PacketFactory.js';
import PACKET_DEFINITIONS from '../../packets/packetDefinitions.generated.js';
import STAT_TYPES from '../../packets/statTypes.generated.js';

vi.mock('../../util/Logger.js', () => ({
  Logger: { log: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn(), isPacketDebugEnabled: () => false },
}));

const factory = new PacketFactory(PACKET_DEFINITIONS as any, STAT_TYPES as any);
const client = {} as any;

function packet(name: string, data: Record<string, unknown>) {
  const p = factory.createByName(name);
  Object.assign(p.data, data);
  return factory.createFromBytes(factory.serialize(p), p.direction as 'client' | 'server');
}
const shot = (bulletId: number, numShots = 1) => packet('ENEMYSHOOT', {
  bulletId, ownerId: 77, bulletType: 0, position: { x: 1, y: 2 }, angle: 0, damage: 50, numShots, angleInc: 0.1,
});
const tick = () => packet('NEWTICK', { tickId: 1, tickTime: 200, serverRealTimeMs: 1, serverLastRttMs: 1, statuses: [] });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => vi.useRealTimers());

// Before 2026-09-12 nothing called cleanup(): every enemy bullet of a realm visit
// stayed tracked until the next MAPINFO (~37 MB per ten busy minutes in the bench).
it('sweeps expired enemy bullets on the server tick, keeping a grace period for late hit reports', () => {
  const proxy = new Proxy(factory);
  const tracker = new ProjectileTracker();       // no game data: 10 s lifetime cap
  tracker.attach(proxy);

  proxy.fireServerPacket(client, shot(10, 3));
  expect(tracker.getActiveProjectiles()).toHaveLength(3);

  vi.setSystemTime(1_000_000 + 11_000);          // past the lifetime, inside the 2 s grace
  proxy.fireServerPacket(client, shot(20));
  proxy.fireServerPacket(client, tick());
  expect(tracker.getBullet('77:10')).toBeDefined();

  vi.setSystemTime(1_000_000 + 12_500);          // past lifetime + grace
  proxy.fireServerPacket(client, tick());
  expect(tracker.getActiveProjectiles().map((b) => b.bulletId)).toEqual([20]);
});

it('sweeps at most once a second however many ticks arrive', () => {
  const proxy = new Proxy(factory);
  const tracker = new ProjectileTracker();
  tracker.attach(proxy);
  const sweep = vi.spyOn(tracker, 'cleanup');
  for (let i = 0; i < 10; i++) { proxy.fireServerPacket(client, tick()); vi.advanceTimersByTime(200); }
  expect(sweep).toHaveBeenCalledTimes(2);        // t=0 and t=1000 of a 2 s run
});
