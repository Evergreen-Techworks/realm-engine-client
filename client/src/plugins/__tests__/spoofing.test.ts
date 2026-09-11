import { afterEach, describe, expect, it, vi } from 'vitest';
import { register } from '../../../plugins/spoofing.js';
import { StatType, type PluginContext } from '../../../plugins/api.js';
import { setDllFeatureSender } from '../../bridge/DllFeatureBus.js';
import { createPacket, type Packet } from '../../packets/Packet.js';

describe('spoofing plugin', () => {
  const catalog = [
    { id: 'skin:wizard', label: 'Wizard Skin', kind: 'skin', classType: 0x030e, values: { objectType: 0x1001, playerClassType: 0x030e }, iconUrl: '/wizard.png' },
    { id: 'skin:rogue', label: 'Rogue Skin', kind: 'skin', classType: 0x0300, values: { objectType: 0x1002, playerClassType: 0x0300 }, iconUrl: '/rogue.png' },
    { id: 'pet:cat', label: 'Cat', kind: 'pet', values: { objectType: 0x2001 }, iconUrl: '/cat.png' },
    { id: 'dye:large', label: 'Large Dye', kind: 'dye', values: { objectType: 0x3001, tex1: 111 }, iconUrl: '/large.png' },
    { id: 'dye:small', label: 'Small Dye', kind: 'dye', values: { objectType: 0x3002, tex2: 222 }, iconUrl: '/small.png' },
    { id: 'grave:old', label: 'Old Grave', kind: 'gravestone', values: { objectType: 0x4001 }, iconUrl: '/old-grave.png' },
    { id: 'grave:new', label: 'New Grave', kind: 'gravestone', values: { objectType: 0x4002 }, iconUrl: '/new-grave.png' },
    { id: 'gravestone:theme:themed', label: 'Themed', kind: 'gravestone', values: { objectType: 0x4110, tierObjectTypes: { 0: 0x4100, 5: 0x4105, 10: 0x4110 } }, iconUrl: '/themed-grave.png' },
    { id: 'title:one', label: 'Title', kind: 'title', values: { objectType: 0x5001, titleSlot: 2 }, iconUrl: '/title.png' },
    { id: 'entrance:one', label: 'Entrance', kind: 'entrance', values: { objectType: 0x6001 }, iconUrl: '/entrance.png' },
  ] as any[];

  afterEach(() => {
    setDllFeatureSender(null);
  });

  function registerPlugin() {
    const hooks = new Map<string, (client: any, packet: Packet) => void>();
    const settingCallbacks = new Map<string, (value: any) => void>();
    const eventHandlers = new Map<string, (client: any) => void>();
    const settingConfigs = new Map<string, any>();
    const enabledHandlers: Array<(enabled: boolean) => void> = [];
    const cleanupHandlers: Array<() => void> = [];
    const ctx = {
      enabled: true,
      gameData: {
        getCosmeticCatalog: vi.fn(() => catalog),
        getObject: vi.fn((type: number) => {
          if (type === 0x4010) return { cosmetic: { kind: 'gravestone', itemTier: 5 } };
          if (type === 0x4001 || type === 0x4002) return { cosmetic: { kind: 'gravestone' } };
          return undefined;
        }),
      },
      registerSetting: vi.fn((key: string, config: unknown, callback?: (value: any) => void) => {
        settingConfigs.set(key, config);
        if (callback) settingCallbacks.set(key, callback);
      }),
      updateSettingOptions: vi.fn(() => true),
      hookPacket: vi.fn((name: string, handler: (client: any, packet: Packet) => void) => {
        hooks.set(name, handler);
      }),
      on: vi.fn((name: string, handler: (client: any) => void) => {
        eventHandlers.set(name, handler);
      }),
      onGameDataReload: vi.fn(),
      onEnabledChange: vi.fn((handler: (enabled: boolean) => void) => enabledHandlers.push(handler)),
      registerCleanup: vi.fn((handler: () => void) => cleanupHandlers.push(handler)),
      log: vi.fn(),
    } as unknown as PluginContext;

    register(ctx);
    return {
      ctx,
      hooks,
      settingCallbacks,
      settingConfigs,
      eventHandlers,
      enabledHandlers,
      cleanupHandlers,
    };
  }

  function client() {
    return {
      objectId: 42,
      playerData: {
        name: 'ActualName',
        stars: 67,
        guildName: 'Actual Guild',
        classType: 0x030e,
        accountId: 'account-1',
        tex1: 10,
        tex2: 20,
      },
    };
  }

  it('spoofs name, stars, and guild only on the local status', () => {
    const { hooks, settingCallbacks, eventHandlers } = registerPlugin();
    const connection = client();
    eventHandlers.get('clientConnected')!(connection);
    settingCallbacks.get('displayedName')!('Alias');
    settingCallbacks.get('displayedStars')!(5);
    settingCallbacks.get('displayedGuild')!('Hidden Guild');
    settingCallbacks.get('spoofName')!(true);
    settingCallbacks.get('spoofStars')!(true);
    settingCallbacks.get('spoofGuild')!(true);

    const packet = createPacket(10, 'NEWTICK', 'server');
    packet.isDefined = true;
    packet.data.statuses = [
      { objectId: 7, data: [{ id: StatType.NameStat, value: 'OtherPlayer' }] },
      { objectId: 42, data: [{ id: StatType.HP, value: 700 }] },
    ];

    hooks.get('NEWTICK')!(connection, packet);

    expect(packet.modified).toBe(true);
    expect(packet.data.statuses[0].data).toEqual([
      { id: StatType.NameStat, value: 'OtherPlayer' },
    ]);
    expect(packet.data.statuses[1].data).toEqual(expect.arrayContaining([
      { id: StatType.NameStat, value: 'Alias' },
      { id: StatType.Stars, value: 5 },
      { id: StatType.GuildName, value: 'Hidden Guild' },
    ]));
  });

  it('restores real values after each spoof toggle is disabled', () => {
    const { hooks, settingCallbacks, eventHandlers } = registerPlugin();
    const connection = client();
    eventHandlers.get('clientConnected')!(connection);
    for (const key of ['spoofName', 'spoofStars', 'spoofGuild']) {
      settingCallbacks.get(key)!(true);
      settingCallbacks.get(key)!(false);
    }

    const packet = createPacket(10, 'NEWTICK', 'server');
    packet.isDefined = true;
    packet.data.statuses = [{ objectId: 42, data: [] }];

    hooks.get('NEWTICK')!(connection, packet);

    expect(packet.data.statuses[0].data).toEqual(expect.arrayContaining([
      { id: StatType.NameStat, value: 'ActualName' },
      { id: StatType.Stars, value: 67 },
      { id: StatType.GuildName, value: 'Actual Guild' },
    ]));
  });

  it('spoofs the local sender name and stars in chat', () => {
    const { hooks, settingCallbacks } = registerPlugin();
    const connection = client();
    settingCallbacks.get('displayedName')!('Alias');
    settingCallbacks.get('displayedStars')!(3);
    settingCallbacks.get('spoofName')!(true);
    settingCallbacks.get('spoofStars')!(true);

    const packet = createPacket(44, 'TEXT', 'server');
    packet.isDefined = true;
    packet.data = {
      name: 'ActualName',
      numStars: 67,
      recipient: '',
      text: 'ActualName joined OtherPlayer.',
      cleanText: 'ActualName joined OtherPlayer.',
    };

    hooks.get('TEXT')!(connection, packet);

    expect(packet.modified).toBe(true);
    expect(packet.data.name).toBe('Alias');
    expect(packet.data.numStars).toBe(3);
    expect(packet.data.text).toBe('Alias joined OtherPlayer.');
  });

  it('filters skin icon options to the local player class', () => {
    const { ctx, eventHandlers } = registerPlugin();
    eventHandlers.get('clientConnected')!(client());

    const calls = vi.mocked(ctx.updateSettingOptions).mock.calls
      .filter(([key]) => key === 'skinOverrideId');
    const options = calls.at(-1)?.[1] as Array<{ value: string; iconUrl?: string }>;

    expect(options).toEqual(expect.arrayContaining([
      { label: 'Default', value: '' },
      expect.objectContaining({
      value: 'skin:wizard',
      iconUrl: '/wizard.png',
      }),
    ]));
    expect(options).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'skin:rogue' }),
    ]));
  });

  it('reapplies dyes and restores captured real values after disable', () => {
    const { hooks, settingCallbacks, eventHandlers } = registerPlugin();
    const connection = client();
    eventHandlers.get('clientConnected')!(connection);
    settingCallbacks.get('clothingOverrideId')!('dye:large');
    settingCallbacks.get('accessoryOverrideId')!('dye:small');
    settingCallbacks.get('clothingOverrideEnabled')!(true);
    settingCallbacks.get('accessoryOverrideEnabled')!(true);

    const first = createPacket(10, 'NEWTICK', 'server');
    first.isDefined = true;
    first.data.statuses = [{
      objectId: 42,
      data: [
        { id: StatType.Texture1, value: 10 },
        { id: StatType.Texture2, value: 20 },
      ],
    }];
    hooks.get('NEWTICK')!(connection, first);
    expect(first.data.statuses[0].data).toEqual(expect.arrayContaining([
      { id: StatType.Texture1, value: 111 },
      { id: StatType.Texture2, value: 222 },
    ]));

    const omitted = createPacket(10, 'NEWTICK', 'server');
    omitted.isDefined = true;
    omitted.data.statuses = [{ objectId: 42, data: [] }];
    hooks.get('NEWTICK')!(connection, omitted);
    expect(omitted.data.statuses[0].data).toEqual(expect.arrayContaining([
      { id: StatType.Texture1, value: 111 },
      { id: StatType.Texture2, value: 222 },
    ]));

    settingCallbacks.get('clothingOverrideEnabled')!(false);
    settingCallbacks.get('accessoryOverrideEnabled')!(false);
    const restore = createPacket(10, 'NEWTICK', 'server');
    restore.isDefined = true;
    restore.data.statuses = [{ objectId: 42, data: [] }];
    hooks.get('NEWTICK')!(connection, restore);
    expect(restore.data.statuses[0].data).toEqual(expect.arrayContaining([
      { id: StatType.Texture1, value: 10 },
      { id: StatType.Texture2, value: 20 },
    ]));
  });

  it('sends the pet skin to the DLL and leaves pet packets untouched', () => {
    const nativeSend = vi.fn();
    setDllFeatureSender(nativeSend);
    const { hooks, settingCallbacks, eventHandlers } = registerPlugin();
    const connection = client();
    eventHandlers.get('clientConnected')!(connection);
    settingCallbacks.get('petOverrideId')!('pet:cat');
    settingCallbacks.get('petOverrideEnabled')!(true);

    expect(nativeSend).toHaveBeenCalledWith('petSkinOverrideId', 0x2001);
    expect(nativeSend).toHaveBeenCalledWith('petSkinOverrideEnabled', true);

    const packet = createPacket(42, 'UPDATE', 'server');
    packet.isDefined = true;
    packet.data.newObjs = [
      { objectType: 0x030e, status: { objectId: 42, data: [
        { id: StatType.PetInstanceId, value: 500 },
        { id: StatType.PetType, value: 0x2000 },
      ] } },
      { objectType: 0x2000, status: { objectId: 500, data: [] } },
    ];

    hooks.get('UPDATE')!(connection, packet);

    // Stat 77 is the account-wide pet instance id, not a world object id, so the
    // spawn it used to match was never reliably the local pet. Nothing on the
    // wire carries the pet skin either, so the packets must be left alone.
    expect(packet.data.newObjs[0].status.data).toContainEqual({
      id: StatType.PetType,
      value: 0x2000,
    });
    expect(packet.data.newObjs[1].objectType).toBe(0x2000);
  });

  it('keeps the server-assigned tier when swapping a themed gravestone set', () => {
    const { hooks, settingCallbacks, eventHandlers } = registerPlugin();
    const connection = client();
    eventHandlers.get('clientConnected')!(connection);
    settingCallbacks.get('graveOverrideId')!('gravestone:theme:themed');
    settingCallbacks.get('graveOverrideEnabled')!(true);

    const packet = createPacket(42, 'UPDATE', 'server');
    packet.isDefined = true;
    packet.data.newObjs = [
      { objectType: 0x4010, status: { objectId: 700, data: [{ id: StatType.GraveAccountId, value: 'account-1' }] } },
    ];

    hooks.get('UPDATE')!(connection, packet);

    // The server sent tier 5, so the swap has to land on the theme's tier-5
    // stone rather than its top tier — otherwise the stone claims a level the
    // character never reached.
    expect(packet.data.newObjs[0].objectType).toBe(0x4105);
  });

  it('rewrites only a verified gravestone with the exact local account id', () => {
    const { hooks, settingCallbacks, eventHandlers } = registerPlugin();
    const connection = client();
    eventHandlers.get('clientConnected')!(connection);
    settingCallbacks.get('graveOverrideId')!('grave:new');
    settingCallbacks.get('graveOverrideEnabled')!(true);

    const packet = createPacket(42, 'UPDATE', 'server');
    packet.isDefined = true;
    packet.data.newObjs = [
      { objectType: 0x4001, status: { objectId: 700, data: [{ id: StatType.GraveAccountId, value: 'account-1' }] } },
      { objectType: 0x4001, status: { objectId: 701, data: [{ id: StatType.GraveAccountId, value: 'account-2' }] } },
      { objectType: 0x7777, status: { objectId: 702, data: [{ id: StatType.GraveAccountId, value: 'account-1' }] } },
      { objectType: 0x4001, status: { objectId: 703, data: [{ id: StatType.GraveAccountId, value: 1 }] } },
    ];

    hooks.get('UPDATE')!(connection, packet);

    expect(packet.data.newObjs.map((object: any) => object.objectType)).toEqual([
      0x4002,
      0x4001,
      0x7777,
      0x4001,
    ]);
  });

  it('emits native skin, title, and entrance commands and clears them on cleanup', () => {
    const nativeSend = vi.fn();
    setDllFeatureSender(nativeSend);
    const { hooks, settingCallbacks, cleanupHandlers } = registerPlugin();

    settingCallbacks.get('skinOverrideId')!('skin:wizard');
    settingCallbacks.get('skinOverrideEnabled')!(true);
    settingCallbacks.get('titleOverrideId')!('title:one');
    settingCallbacks.get('titleOverrideEnabled')!(true);
    settingCallbacks.get('entranceOverrideId')!('entrance:one');
    settingCallbacks.get('entranceOverrideEnabled')!(true);

    expect(nativeSend).toHaveBeenCalledWith('skinOverrideEnabled', true);
    expect(nativeSend).toHaveBeenCalledWith('skinOverrideId', 0x1001);
    expect(nativeSend).toHaveBeenCalledWith('titleOverrideEnabled', true);
    expect(nativeSend).toHaveBeenCalledWith('titleOverrideId', 0x5001);
    expect(nativeSend).toHaveBeenCalledWith('titleOverrideSlot', 2);
    expect(nativeSend).toHaveBeenCalledWith('entranceOverrideEnabled', true);
    expect(nativeSend).toHaveBeenCalledWith('entranceOverrideId', 0x6001);

    nativeSend.mockClear();
    const mapInfo = createPacket(1, 'MAPINFO', 'server');
    hooks.get('MAPINFO')!(client(), mapInfo);
    expect(nativeSend.mock.calls.filter(([key]) => key === 'skinOverrideEnabled')).toEqual([
      ['skinOverrideEnabled', false],
      ['skinOverrideEnabled', true],
    ]);

    nativeSend.mockClear();
    cleanupHandlers[0]();
    expect(nativeSend).toHaveBeenCalledWith('skinOverrideEnabled', false);
    expect(nativeSend).toHaveBeenCalledWith('titleOverrideEnabled', false);
    expect(nativeSend).toHaveBeenCalledWith('entranceOverrideEnabled', false);
  });
});
