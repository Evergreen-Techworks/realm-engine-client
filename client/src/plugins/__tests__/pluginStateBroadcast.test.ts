import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginContext } from '../PluginContext.js';
import { register } from '../../../plugins/spoofing.js';
import { PlayerData } from '../../state/PlayerData.js';
import { createPacket, type Packet } from '../../packets/Packet.js';
import { setDllFeatureSender } from '../../bridge/DllFeatureBus.js';

// Every plugin-state broadcast makes the dashboard rebuild the whole Plugins
// page, which closes a settings dropdown the user has open: the click meant for
// "Off" lands on the settings grid and nothing is sent. Spoofing broadcast at
// least twice per connection (class 0 at connect, the real class on the first
// UPDATE), so every Nexus/realm hop rebuilt the page under the user's cursor.
describe('plugin-state broadcasts across map changes', () => {
  afterEach(() => setDllFeatureSender(null));

  function spoofingOnRealContext() {
    const hooks = new Map<string, (client: any, packet: Packet) => void>();
    const proxy = Object.assign(new EventEmitter(), {
      hookPacket: (name: string, handler: (client: any, packet: Packet) => void) => { hooks.set(name, handler); },
      hookCommand: () => {},
    });
    const catalog = [
      { id: 'skin:wizard', label: 'Wizard Skin', kind: 'skin', classType: 0x030e, values: { objectType: 0x1001, playerClassType: 0x030e } },
      { id: 'skin:rogue', label: 'Rogue Skin', kind: 'skin', classType: 0x0300, values: { objectType: 0x1002, playerClassType: 0x0300 } },
      { id: 'pet:cat', label: 'Cat', kind: 'pet', values: { objectType: 0x2001 } },
    ];
    const gameData = { getCosmeticCatalog: () => catalog, getObject: () => undefined, onReload: () => () => {} };
    const context = new PluginContext(proxy as any, 'spoofing', 'spoofing.ts', gameData as any);
    register(context);
    const broadcasts = vi.fn();
    context.onSettingOptionsChanged = broadcasts;

    /** One map visit the way the proxy delivers it: a fresh connection, then the first UPDATE. */
    function visitMap(classType: number) {
      const client = { objectId: 0, playerData: new PlayerData() };
      proxy.emit('clientConnected', client);
      client.objectId = 42;
      client.playerData.classType = classType;
      const update = createPacket(42, 'UPDATE', 'server');
      update.isDefined = true;
      update.data.newObjs = [];
      hooks.get('UPDATE')!(client, update);
      proxy.emit('clientDisconnected', client);
    }
    return { context, broadcasts, visitMap };
  }

  it('does not re-broadcast plugin state when the same character changes map', () => {
    const { broadcasts, visitMap } = spoofingOnRealContext();
    visitMap(0x030e);                       // first sight of the class builds its skin list
    const afterFirstVisit = broadcasts.mock.calls.length;
    visitMap(0x030e);                       // Nexus
    visitMap(0x030e);                       // realm
    expect(broadcasts.mock.calls.length).toBe(afterFirstVisit);
  });

  it('still broadcasts the new skin list when the class changes', () => {
    const { context, broadcasts, visitMap } = spoofingOnRealContext();
    visitMap(0x030e);
    broadcasts.mockClear();
    visitMap(0x0300);
    expect(broadcasts).toHaveBeenCalledWith('spoofing', 'skinOverrideId');
    const skin = context.getSettings().find((s) => s.key === 'skinOverrideId');
    expect(skin?.options?.map((o) => o.value)).toEqual(['', 'skin:rogue']);
  });
});
