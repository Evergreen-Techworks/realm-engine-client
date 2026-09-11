import type {
  ClientConnection,
  CosmeticCatalogEntry,
  PluginContext,
  SettingOption,
} from './api.js';
import { sendDllFeature, StatType } from './api.js';

type StatValue = number | string;
type StatusData = {
  objectId: number;
  data?: Array<{ id: number; value: StatValue; stackCount?: number }>;
};
type NewObjectData = {
  objectType?: number;
  status?: StatusData;
};

const SPOOFED_STATS = [StatType.NameStat, StatType.Stars, StatType.GuildName] as const;
// PetType (79) is deliberately absent. It selects the base pet object, whose
// sprite is a shared placeholder — the renderer draws the skin's own
// ObjectProperties instead, so the pet override runs through the DLL.
const COSMETIC_STATS = [StatType.Texture1, StatType.Texture2] as const;
const ALL_REFRESH_STATS = [...SPOOFED_STATS, ...COSMETIC_STATS] as const;

type ClientSpoofState = {
  pending: Set<number>;
  actual: Map<number, StatValue>;
  lastObjectId?: number;
  lastClassType?: number;
};

function finiteInt(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

function replaceName(value: string, actualName: string, alias: string): string {
  if (!actualName) return value;
  return value.split(actualName).join(alias);
}

function rewriteStrings(value: unknown, actualName: string, alias: string): boolean {
  if (!value || typeof value !== 'object') return false;

  let changed = false;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string') {
      const rewritten = replaceName(child, actualName, alias);
      if (rewritten !== child) {
        (value as Record<string, unknown>)[key] = rewritten;
        changed = true;
      }
    } else if (rewriteStrings(child, actualName, alias)) {
      changed = true;
    }
  }
  return changed;
}

export function register(ctx: PluginContext): void {
  ctx.name = 'Spoofing';
  ctx.category = 'visual';

  let spoofName = false;
  let displayedName = 'Streamer';
  let spoofStars = false;
  let displayedStars = 0;
  let spoofGuild = false;
  let displayedGuild = '';

  let skinOverrideEnabled = false;
  let skinOverrideId = '';
  let petOverrideEnabled = false;
  let petOverrideId = '';
  let clothingOverrideEnabled = false;
  let clothingOverrideId = '';
  let accessoryOverrideEnabled = false;
  let accessoryOverrideId = '';
  let titleOverrideEnabled = false;
  let titleOverrideId = '';
  let titleOverrideSlot = 0;
  let entranceOverrideEnabled = false;
  let entranceOverrideId = '';
  let graveOverrideEnabled = false;
  let graveOverrideId = '';

  const clients = new Set<ClientConnection>();
  const clientStates = new Map<ClientConnection, ClientSpoofState>();
  let catalog = ctx.gameData?.getCosmeticCatalog() ?? [];
  let catalogById = new Map(catalog.map((entry) => [entry.id, entry]));
  let graveObjectTypes = new Set(
    catalog.filter((entry) => entry.kind === 'gravestone').map((entry) => entry.values.objectType),
  );

  function stateFor(client: ClientConnection): ClientSpoofState {
    let state = clientStates.get(client);
    if (!state) {
      state = { pending: new Set<number>(), actual: new Map<number, StatValue>() };
      clientStates.set(client, state);
    }
    return state;
  }

  function refreshForAll(statId: number): void {
    for (const client of clients) stateFor(client).pending.add(statId);
  }

  function markAllPending(client: ClientConnection): void {
    const pending = stateFor(client).pending;
    for (const statId of ALL_REFRESH_STATS) pending.add(statId);
  }

  function entry(id: string, kind: CosmeticCatalogEntry['kind']): CosmeticCatalogEntry | undefined {
    const selected = catalogById.get(id);
    if (selected?.kind === kind) return selected;
    const legacyObjectType = finiteInt(id);
    if (legacyObjectType === undefined) return undefined;
    return catalog.find((item) =>
      item.kind === kind && item.values.objectType === legacyObjectType);
  }

  function optionFor(item: CosmeticCatalogEntry): SettingOption {
    return {
      label: item.label,
      value: item.id,
      ...(item.iconUrl ? { iconUrl: item.iconUrl } : {}),
      ...(item.swatchColor ? { swatchColor: item.swatchColor } : {}),
      metadata: {
        kind: item.kind,
        classType: item.classType,
        ...item.values,
      },
    };
  }

  function optionsFor(kind: CosmeticCatalogEntry['kind']): SettingOption[] {
    return [
      { label: 'Default', value: '' },
      ...catalog.filter((item) => item.kind === kind).map(optionFor),
    ];
  }

  function dyeOptions(field: 'tex1' | 'tex2'): SettingOption[] {
    return [
      { label: 'Default', value: '' },
      ...catalog
        .filter((item) => item.kind === 'dye' && item.values[field] !== undefined)
        .map(optionFor),
    ];
  }

  function updateSkinOptions(classType?: number): void {
    ctx.updateSettingOptions(
      'skinOverrideId',
      [
        { label: 'Default', value: '' },
        ...catalog
          .filter((item) =>
            item.kind === 'skin'
            && classType !== undefined
            && (item.classType ?? item.values.playerClassType) === classType)
          .map(optionFor),
      ],
    );
  }

  function refreshCatalogOptions(): void {
    catalog = ctx.gameData?.getCosmeticCatalog() ?? [];
    catalogById = new Map(catalog.map((item) => [item.id, item]));
    graveObjectTypes = new Set(
      catalog.filter((item) => item.kind === 'gravestone').map((item) => item.values.objectType),
    );
    const currentClass = [...clients]
      .map((client) => finiteInt(client.playerData?.classType))
      .find((classType) => classType !== undefined);
    updateSkinOptions(currentClass);
    ctx.updateSettingOptions('petOverrideId', optionsFor('pet'));
    ctx.updateSettingOptions('clothingOverrideId', dyeOptions('tex1'));
    ctx.updateSettingOptions('accessoryOverrideId', dyeOptions('tex2'));
    ctx.updateSettingOptions('titleOverrideId', optionsFor('title'));
    ctx.updateSettingOptions('entranceOverrideId', optionsFor('entrance'));
    ctx.updateSettingOptions('graveOverrideId', optionsFor('gravestone'));
    flushNative();
  }

  function inferTitleSlot(selected: CosmeticCatalogEntry | undefined): number | undefined {
    if (!selected) return undefined;
    const extended = selected as CosmeticCatalogEntry & {
      metadata?: Record<string, unknown>;
      values: CosmeticCatalogEntry['values'] & { titleSlot?: unknown; slot?: unknown };
    };
    const metadata = extended.metadata;
    return finiteInt(
      extended.values.titleSlot
      ?? extended.values.slot
      ?? metadata?.titleSlot
      ?? metadata?.slot
      ?? metadata?.placementSlot,
    );
  }

  function effectiveTitleSlot(): number {
    return inferTitleSlot(entry(titleOverrideId, 'title')) ?? titleOverrideSlot;
  }

  function flushNative(forceOff = false): void {
    const enabled = !forceOff && ctx.enabled;
    const skinId = entry(skinOverrideId, 'skin');
    const titleId = entry(titleOverrideId, 'title');
    const entranceId = entry(entranceOverrideId, 'entrance');
    const petId = entry(petOverrideId, 'pet');
    sendDllFeature('skinOverrideId', skinId?.values.objectType ?? 0);
    sendDllFeature('skinOverrideEnabled', enabled && skinOverrideEnabled && !!skinId);
    sendDllFeature('titleOverrideId', titleId?.values.objectType ?? 0);
    sendDllFeature('titleOverrideSlot', effectiveTitleSlot());
    sendDllFeature('titleOverrideEnabled', enabled && titleOverrideEnabled && !!titleId);
    sendDllFeature('entranceOverrideId', entranceId?.values.objectType ?? 0);
    sendDllFeature('entranceOverrideEnabled', enabled && entranceOverrideEnabled && !!entranceId);
    sendDllFeature('petSkinOverrideId', petId?.values.objectType ?? 0);
    sendDllFeature('petSkinOverrideEnabled', enabled && petOverrideEnabled && !!petId);
  }

  function flushNativeTransition(): void {
    flushNative(true);
    flushNative(false);
  }

  function observeIdentity(client: ClientConnection): void {
    const state = stateFor(client);
    const objectId = client.objectId;
    const classType = finiteInt(client.playerData?.classType);
    if (state.lastObjectId === objectId && state.lastClassType === classType) return;
    const classChanged = state.lastClassType !== classType;
    state.lastObjectId = objectId;
    state.lastClassType = classType;
    state.actual.clear();
    markAllPending(client);
    if (classChanged) updateSkinOptions(classType);
    flushNativeTransition();
  }

  ctx.registerSetting('spoofName', {
    label: 'Spoof local player name',
    type: 'boolean',
    value: spoofName,
  }, (value: boolean) => {
    spoofName = value;
    refreshForAll(StatType.NameStat);
  });

  ctx.registerSetting('displayedName', {
    label: 'Displayed name',
    type: 'text',
    value: displayedName,
    visibleWhen: { key: 'spoofName', value: true },
  }, (value: string) => {
    displayedName = value;
    if (spoofName) refreshForAll(StatType.NameStat);
  });

  ctx.registerSetting('spoofStars', {
    label: 'Spoof local rank (stars)',
    type: 'boolean',
    value: spoofStars,
  }, (value: boolean) => {
    spoofStars = value;
    refreshForAll(StatType.Stars);
  });

  ctx.registerSetting('displayedStars', {
    label: 'Displayed stars',
    type: 'number',
    value: displayedStars,
    step: 1,
    visibleWhen: { key: 'spoofStars', value: true },
  }, (value: number) => {
    displayedStars = Math.trunc(value);
    if (spoofStars) refreshForAll(StatType.Stars);
  });

  ctx.registerSetting('spoofGuild', {
    label: 'Spoof local guild name',
    type: 'boolean',
    value: spoofGuild,
  }, (value: boolean) => {
    spoofGuild = value;
    refreshForAll(StatType.GuildName);
  });

  ctx.registerSetting('displayedGuild', {
    label: 'Displayed guild name',
    type: 'text',
    value: displayedGuild,
    visibleWhen: { key: 'spoofGuild', value: true },
  }, (value: string) => {
    displayedGuild = value;
    if (spoofGuild) refreshForAll(StatType.GuildName);
  });

  ctx.registerSetting('skinOverrideEnabled', {
    label: 'Override skin',
    type: 'boolean',
    value: skinOverrideEnabled,
  }, (value: boolean) => {
    skinOverrideEnabled = value;
    flushNative();
  });

  ctx.registerSetting('skinOverrideId', {
    label: 'Skin',
    type: 'select',
    value: skinOverrideId,
    options: [],
    visibleWhen: { key: 'skinOverrideEnabled', value: true },
  }, (value: string) => {
    skinOverrideId = value;
    flushNative();
  });

  ctx.registerSetting('petOverrideEnabled', {
    label: 'Override pet sprite',
    type: 'boolean',
    value: petOverrideEnabled,
  }, (value: boolean) => {
    petOverrideEnabled = value;
    flushNative();
  });

  ctx.registerSetting('petOverrideId', {
    label: 'Pet sprite',
    type: 'select',
    value: petOverrideId,
    options: optionsFor('pet'),
    visibleWhen: { key: 'petOverrideEnabled', value: true },
  }, (value: string) => {
    petOverrideId = value;
    flushNative();
  });

  ctx.registerSetting('clothingOverrideEnabled', {
    label: 'Override clothing dye',
    type: 'boolean',
    value: clothingOverrideEnabled,
  }, (value: boolean) => {
    clothingOverrideEnabled = value;
    refreshForAll(StatType.Texture1);
  });

  ctx.registerSetting('clothingOverrideId', {
    label: 'Clothing dye',
    type: 'select',
    value: clothingOverrideId,
    options: dyeOptions('tex1'),
    visibleWhen: { key: 'clothingOverrideEnabled', value: true },
  }, (value: string) => {
    clothingOverrideId = value;
    if (clothingOverrideEnabled) refreshForAll(StatType.Texture1);
  });

  ctx.registerSetting('accessoryOverrideEnabled', {
    label: 'Override accessory dye',
    type: 'boolean',
    value: accessoryOverrideEnabled,
  }, (value: boolean) => {
    accessoryOverrideEnabled = value;
    refreshForAll(StatType.Texture2);
  });

  ctx.registerSetting('accessoryOverrideId', {
    label: 'Accessory dye',
    type: 'select',
    value: accessoryOverrideId,
    options: dyeOptions('tex2'),
    visibleWhen: { key: 'accessoryOverrideEnabled', value: true },
  }, (value: string) => {
    accessoryOverrideId = value;
    if (accessoryOverrideEnabled) refreshForAll(StatType.Texture2);
  });

  ctx.registerSetting('titleOverrideEnabled', {
    label: 'Override title',
    type: 'boolean',
    value: titleOverrideEnabled,
  }, (value: boolean) => {
    titleOverrideEnabled = value;
    flushNative();
  });

  ctx.registerSetting('titleOverrideId', {
    label: 'Title',
    type: 'select',
    value: titleOverrideId,
    options: optionsFor('title'),
    visibleWhen: { key: 'titleOverrideEnabled', value: true },
  }, (value: string) => {
    titleOverrideId = value;
    flushNative();
  });

  ctx.registerSetting('titleOverrideSlot', {
    label: 'Title placement',
    type: 'select',
    value: String(titleOverrideSlot),
    options: [
      { label: 'Prefix', value: '0' },
      { label: 'Suffix', value: '1' },
      { label: 'Full', value: '2' },
    ],
    visibleWhen: { key: 'titleOverrideEnabled', value: true },
  }, (value: string) => {
    titleOverrideSlot = finiteInt(value) ?? 0;
    flushNative();
  });

  ctx.registerSetting('entranceOverrideEnabled', {
    label: 'Override entrance',
    type: 'boolean',
    value: entranceOverrideEnabled,
  }, (value: boolean) => {
    entranceOverrideEnabled = value;
    flushNative();
  });

  ctx.registerSetting('entranceOverrideId', {
    label: 'Entrance',
    type: 'select',
    value: entranceOverrideId,
    options: optionsFor('entrance'),
    visibleWhen: { key: 'entranceOverrideEnabled', value: true },
  }, (value: string) => {
    entranceOverrideId = value;
    flushNative();
  });

  ctx.registerSetting('graveOverrideEnabled', {
    label: 'Override gravestone',
    type: 'boolean',
    value: graveOverrideEnabled,
  }, (value: boolean) => {
    graveOverrideEnabled = value;
  });

  ctx.registerSetting('graveOverrideId', {
    label: 'Gravestone',
    type: 'select',
    value: graveOverrideId,
    options: optionsFor('gravestone'),
    visibleWhen: { key: 'graveOverrideEnabled', value: true },
  }, (value: string) => {
    graveOverrideId = value;
  });

  refreshCatalogOptions();
  ctx.onGameDataReload(refreshCatalogOptions);

  ctx.on('clientConnected', (client) => {
    clients.add(client);
    markAllPending(client);
    observeIdentity(client);
  });
  ctx.on('clientDisconnected', (client) => {
    clients.delete(client);
    clientStates.delete(client);
    flushNative(true);
  });

  function actualValue(client: ClientConnection, statId: number): StatValue {
    if (statId === StatType.NameStat) return client.playerData?.name ?? '';
    if (statId === StatType.Stars) return client.playerData?.stars ?? 0;
    return client.playerData?.guildName ?? '';
  }

  function displayedValue(client: ClientConnection, statId: number): StatValue {
    if (statId === StatType.NameStat) return spoofName ? displayedName : actualValue(client, statId);
    if (statId === StatType.Stars) return spoofStars ? displayedStars : actualValue(client, statId);
    return spoofGuild ? displayedGuild : actualValue(client, statId);
  }

  function isActive(statId: number): boolean {
    if (statId === StatType.NameStat) return spoofName;
    if (statId === StatType.Stars) return spoofStars;
    return spoofGuild;
  }

  function cosmeticValue(statId: number): number | undefined {
    if (statId === StatType.Texture1) {
      return clothingOverrideEnabled ? entry(clothingOverrideId, 'dye')?.values.tex1 : undefined;
    }
    return accessoryOverrideEnabled ? entry(accessoryOverrideId, 'dye')?.values.tex2 : undefined;
  }

  function cosmeticActive(statId: number): boolean {
    if (statId === StatType.Texture1) return clothingOverrideEnabled;
    return accessoryOverrideEnabled;
  }

  function rewriteLocalStatus(
    client: ClientConnection,
    status: StatusData,
    allowInjection: boolean,
  ): boolean {
    if (status.objectId !== client.objectId || !status.data) return false;

    observeIdentity(client);
    const state = stateFor(client);
    const pending = state.pending;
    let changed = false;
    for (const statId of SPOOFED_STATS) {
      if (!isActive(statId) && !pending.has(statId)) continue;

      const value = displayedValue(client, statId);
      const stat = status.data.find((candidate) => candidate.id === statId);
      if (stat) {
        if (stat.value !== value) {
          stat.value = value;
          changed = true;
        }
        pending.delete(statId);
      } else if (allowInjection && pending.has(statId)) {
        status.data.push({ id: statId, value });
        pending.delete(statId);
        changed = true;
      }
    }

    for (const statId of COSMETIC_STATS) {
      const stat = status.data.find((candidate) => candidate.id === statId);
      if (stat) state.actual.set(statId, stat.value);

      const active = cosmeticActive(statId);
      if (!active && !pending.has(statId)) continue;
      const value = active ? cosmeticValue(statId) : state.actual.get(statId);
      if (value === undefined) continue;
      if (stat) {
        if (stat.value !== value) {
          stat.value = value;
          changed = true;
        }
        pending.delete(statId);
      } else if (allowInjection) {
        status.data.push({ id: statId, value });
        pending.delete(statId);
        changed = true;
      }
    }
    return changed;
  }

  function isGravestone(objectType: number): boolean {
    if (graveObjectTypes.has(objectType)) return true;
    return ctx.gameData?.getObject(objectType)?.cosmetic?.kind === 'gravestone';
  }

  /**
   * A themed set has one stone per character-level bracket. Swapping to a fixed
   * object type would advertise the wrong bracket, so keep the tier the server
   * chose and only change the theme.
   */
  function graveTypeFor(selected: CosmeticCatalogEntry, serverType: number): number {
    const tiers = selected.values.tierObjectTypes;
    if (!tiers) return selected.values.objectType;
    const serverCosmetic = ctx.gameData?.getObject(serverType)?.cosmetic;
    const serverTier = serverCosmetic?.kind === 'gravestone' ? serverCosmetic.itemTier : undefined;
    if (serverTier === undefined) return selected.values.objectType;
    return tiers[serverTier] ?? selected.values.objectType;
  }

  ctx.hookPacket('UPDATE', (client, packet) => {
    if (!packet.isDefined) return;
    observeIdentity(client);
    const objects = (
      Array.isArray(packet.data.newObjs) ? packet.data.newObjs : packet.data.newObjects
    ) as NewObjectData[] | undefined;
    if (!Array.isArray(objects)) return;

    let changed = false;
    const selectedGrave = entry(graveOverrideId, 'gravestone');
    for (const object of objects) {
      if (object.status && rewriteLocalStatus(client, object.status, true)) changed = true;

      const graveAccount = object.status?.data?.find((stat) => stat.id === StatType.GraveAccountId);
      if (
        graveOverrideEnabled
        && selectedGrave
        && object.objectType !== undefined
        && isGravestone(object.objectType)
        && graveAccount?.value === client.playerData?.accountId
      ) {
        const graveType = graveTypeFor(selectedGrave, object.objectType);
        if (object.objectType !== graveType) {
          object.objectType = graveType;
          changed = true;
        }
      }
    }
    if (changed) packet.modified = true;
  });

  ctx.hookPacket('NEWTICK', (client, packet) => {
    if (!packet.isDefined || !Array.isArray(packet.data.statuses)) return;
    observeIdentity(client);

    let changed = false;
    for (const status of packet.data.statuses as StatusData[]) {
      if (rewriteLocalStatus(client, status, true)) changed = true;
    }
    if (changed) packet.modified = true;
  });

  for (const packetName of ['MAPINFO', 'CREATESUCCESS']) {
    ctx.hookPacket(packetName, (client) => {
      markAllPending(client);
      flushNativeTransition();
    });
  }

  for (const packetName of [
    'TEXT',
    'INCOMINGPARTYMEMBERINFO',
    'PARTYMEMBERADDED',
    'PARTYJOINREQUESTRESPONSE',
  ]) {
    ctx.hookPacket(packetName, (client, packet) => {
      if (!packet.isDefined) return;

      const actualName = client.playerData?.name ?? '';
      const isSelfText = packetName === 'TEXT'
        && actualName !== ''
        && packet.data.name === actualName;
      let changed = false;
      if (spoofStars && isSelfText && packet.data.numStars !== displayedStars) {
        packet.data.numStars = displayedStars;
        changed = true;
      }
      if (spoofName && rewriteStrings(packet.data, actualName, displayedName)) changed = true;
      if (changed) packet.modified = true;
    });
  }

  ctx.onEnabledChange((enabled) => {
    if (enabled) {
      for (const client of clients) markAllPending(client);
      flushNativeTransition();
    } else {
      flushNative(true);
    }
  });

  ctx.registerCleanup(() => {
    flushNative(true);
    clients.clear();
    clientStates.clear();
  });

  ctx.log('Loaded — local-only identity and cosmetic visual spoofing');
}
