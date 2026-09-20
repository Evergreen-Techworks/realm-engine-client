import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameDataLoader } from '../../game-data/GameDataLoader.js';
import { ProjectileTracker } from '../ProjectileTracker.js';
import { Proxy } from '../../proxy/Proxy.js';
import { PacketFactory } from '../../packets/PacketFactory.js';
import PACKET_DEFINITIONS from '../../packets/packetDefinitions.generated.js';
import STAT_TYPES from '../../packets/statTypes.generated.js';
import { setDllFeatureSender } from '../../bridge/DllFeatureBus.js';
import type { GameWorldState } from '../GameWorldState.js';

vi.mock('../../util/Logger.js', () => ({
  Logger: { log: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn(), isPacketDebugEnabled: () => false },
}));

afterEach(() => setDllFeatureSender(null));

function loadProjectile(collision: string, size = 100): GameDataLoader {
  const directory = mkdtempSync(join(tmpdir(), 'projectile-collision-'));
  try {
    const path = join(directory, 'objects.xml');
    writeFileSync(path, `<Objects><Object type="0x1234" id="Enemy">
      <Class>Character</Class><Enemy/><Projectile id="0">
      <ObjectId>Large Sprite</ObjectId><Size>${size}</Size>${collision}
      <Speed>100</Speed><LifetimeMS>1000</LifetimeMS></Projectile>
      </Object><Object type="0x1235" id="Large Sprite"><Class>Projectile</Class><Size>400</Size></Object></Objects>`);
    const data = new GameDataLoader();
    data.load(path);
    return data;
  } finally {
    rmSync(directory, { recursive: true });
  }
}

it.each([
  ['', 0.5],
  ['<CollisionMult>1.5</CollisionMult>', 0.75],
  ['<CollisionMult>2.5</CollisionMult>', 1.25],
  ['<CollisionMult>20</CollisionMult>', 10],
  ['<CollisionMult>0</CollisionMult>', 0.5],
  ['<CollisionMult>-2</CollisionMult>', 0.5],
  ['<CollisionMult>21</CollisionMult>', 0.5],
  ['<CollisionMult>NaN</CollisionMult>', 0.5],
  ['<CollisionMult>Infinity</CollisionMult>', 0.5],
])('publishes native-compatible collision metadata for %s', (collision, expected) => {
  const definition = loadProjectile(collision).getProjectile(0x1234, 0);
  expect(definition).toMatchObject({ collisionHalf: expected, hitRadius: 0.15 });
});

it('keeps collision width independent of the preserved visual size estimate', () => {
  expect(loadProjectile('<CollisionMult>1.5</CollisionMult>', 400).getProjectile(0x1234, 0))
    .toMatchObject({ collisionHalf: 0.75, hitRadius: 0.6 });
});

it.each([true, false])('sends contact width rather than sprite size for provisional shots (known=%s)', known => {
  const factory = new PacketFactory(PACKET_DEFINITIONS as any, STAT_TYPES as any);
  const proxy = new Proxy(factory);
  const data = loadProjectile('<CollisionMult>1.5</CollisionMult>');
  const world = { getEntityType: () => known ? 0x1234 : undefined } as unknown as GameWorldState;
  const tracker = new ProjectileTracker(data, world);
  tracker.attach(proxy);
  const send = vi.fn();
  setDllFeatureSender(send);
  const outgoing = factory.createByName('ENEMYSHOOT');
  Object.assign(outgoing.data, {
    bulletId: 17, ownerId: 77, bulletType: 0, position: { x: 1, y: 2 },
    angle: 0, damage: 50, numShots: 1, angleInc: 0,
  });
  const packet = factory.createFromBytes(factory.serialize(outgoing), 'server');
  proxy.fireServerPacket({} as any, packet);
  expect(send).toHaveBeenCalledWith('udodgePacketShot', `77,17,1,2,0,${known ? '100,1000,0.75' : '0,0,0.5'}`);
  expect(tracker.getBullet('77:17')?.projDef?.hitRadius).toBe(known ? 0.15 : undefined);
});
