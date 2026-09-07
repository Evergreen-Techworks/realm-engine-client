import { tryInventoryAction } from '../../../util/InventoryActions.js';
import { loot } from '@realmengine/sdk';
import type { LootBag, LootItem, LootRarity, PickupOptions } from '@realmengine/sdk';
import type { BridgeDeps } from '../BridgeDeps.js';
import type { ClientConnection } from '../../../proxy/ClientConnection.js';
import type { Packet } from '../../../packets/Packet.js';
import { StatType } from '../../../constants/StatType.js';
import { Logger } from '../../../util/Logger.js';

// ─── Bag type constants ───────────────────────────────────────────────────────

const BAG_TYPES = new Set<number>([
  1280, 1281, 1283, 1286, 1287, 1288, 1289, 1291, 1292, 1294, 1295, 1296,
  1708, 1709, 1710, 1722, 1723, 1724, 1725, 1726, 1727, 1728, 8239,
]);

const BAG_RARITY: Readonly<Record<number, LootRarity>> = {
  1280: 'common',  // Brown Bag (public)
  1281: 'common',  // Brown Bag (alt)
  1283: 'green',   // Cyan Bag (public)
  1286: 'purple',  // Purple Bag (public)
  1287: 'purple',  // Purple Bag (soulbound)
  1288: 'blue',    // Blue Bag (public)
  1289: 'blue',    // Blue Bag (soulbound)
  1291: 'white',   // White Bag (public)
  1292: 'white',   // White Bag (soulbound)
  1294: 'purple',  // Orange/ST Bag (public) — no 'orange' in LootRarity
  1295: 'purple',  // Orange/ST Bag (soulbound)
  1296: 'purple',  // Orange Bag (alt)
  1708: 'common',
  1709: 'common',
  1710: 'blue',
  1722: 'purple',
  1723: 'purple',
  1724: 'white',
  1725: 'white',
  1726: 'purple',
  1727: 'purple',
  1728: 'purple',
  8239: 'common',
};

// ─── Item classification sets (mirrors auto-loot) ────────────────────────────

const HP_POTION_IDS = new Set<number>([2594, 2736]);
const MP_POTION_IDS = new Set<number>([2595, 2781]);
const LIFE_MANA_POTION_IDS = new Set<number>([
  2793, 2794, 5471, 5472, 9070, 9071,
]);
const STAT_POTION_IDS = new Set<number>([
  2591, 2592, 2593, 2612, 2613, 2636,
  5465, 5466, 5467, 5468, 5469, 5470,
  5094,
  9064, 9065, 9066, 9067, 9068, 9069,
]);

type PotStat = 'attack' | 'defense' | 'speed' | 'dexterity' | 'vitality' | 'wisdom' | 'maxHitPoints' | 'maxMagicPoints';
const POT_STAT = new Map<number, PotStat>([
  [2593, 'attack'], [5465, 'attack'], [9064, 'attack'],
  [2591, 'defense'], [5466, 'defense'], [9065, 'defense'],
  [2592, 'speed'], [5467, 'speed'], [9066, 'speed'],
  [2636, 'dexterity'], [5470, 'dexterity'], [9069, 'dexterity'],
  [2613, 'vitality'], [5468, 'vitality'], [9067, 'vitality'],
  [2612, 'wisdom'], [5469, 'wisdom'], [9068, 'wisdom'],
  [2793, 'maxHitPoints'], [5471, 'maxHitPoints'], [9070, 'maxHitPoints'],
  [2794, 'maxMagicPoints'], [5472, 'maxMagicPoints'], [9071, 'maxMagicPoints'],
]);

const WEAPON_SLOT_TYPES = new Set<number>([1, 2, 3, 8, 17, 24]);
const ABILITY_SLOT_TYPES = new Set<number>([4, 5, 11, 12, 13, 15, 16, 18, 19, 20, 21, 22, 23, 25, 27, 28, 29, 30, 31]);
const ARMOR_SLOT_TYPES = new Set<number>([6, 7, 14]);
const RING_SLOT_TYPES = new Set<number>([9]);
// Slot types excluded from UT looting (tomes / orbs excluded from generic UT loot)
const EXCLUDED_UT_SLOT_TYPES = new Set<number>([10, 26]);

function isGearSlotType(slotType: number): boolean {
  return WEAPON_SLOT_TYPES.has(slotType)
    || ABILITY_SLOT_TYPES.has(slotType)
    || ARMOR_SLOT_TYPES.has(slotType)
    || RING_SLOT_TYPES.has(slotType);
}

function isMultitoolUtTier(normalizedTier: string, slotType: number): boolean {
  if (normalizedTier === 'ST') return false;
  if (normalizedTier === 'UT') return true;
  if (normalizedTier !== '') return false;
  return isGearSlotType(slotType);
}

type GearCategory = 'weapon' | 'ability' | 'armor' | 'ring';

function getGearCategory(slotType: number): GearCategory | null {
  if (WEAPON_SLOT_TYPES.has(slotType)) return 'weapon';
  if (ABILITY_SLOT_TYPES.has(slotType)) return 'ability';
  if (ARMOR_SLOT_TYPES.has(slotType)) return 'armor';
  if (RING_SLOT_TYPES.has(slotType)) return 'ring';
  return null;
}

function gearSlotIndex(category: GearCategory): number {
  return category === 'weapon' ? 0 : category === 'ability' ? 1 : category === 'armor' ? 2 : 3;
}

function gearRank(info: ItemInfo | undefined): number {
  if (!info) return -1;
  if (info.isUT) return 1000;
  if (info.isST) return 900;
  return info.tier ?? -1;
}

// ─── ItemInfo catalog ────────────────────────────────────────────────────────

interface ItemInfo {
  slotType: number;
  tier: number | null;
  isUT: boolean;
  isST: boolean;
  name: string;
  quickslotAllowed: boolean;
}

let catalog: Map<number, ItemInfo> = new Map();

function buildCatalog(deps: BridgeDeps): void {
  catalog = new Map();
  for (const obj of deps.gameData.getAllObjects()) {
    const slotTypeRaw = Number(obj.slotType ?? -1);
    if (!Number.isFinite(slotTypeRaw) || slotTypeRaw < 0) continue;
    const slotType = Math.trunc(slotTypeRaw);
    const normalizedTier = String(obj.tierStr ?? '').trim().toUpperCase();
    const isST = normalizedTier === 'ST';
    const isUT = isMultitoolUtTier(normalizedTier, slotType);
    const tier = (isUT || isST || !/^-?\d+$/.test(normalizedTier)) ? null : Number(normalizedTier);
    const name = String(obj.id || '').trim() || `0x${obj.type.toString(16)}`;
    catalog.set(obj.type, { slotType, tier, isUT, isST, name, quickslotAllowed: obj.quickslotAllowed === true });
  }
}

// ─── Rarity ranking ──────────────────────────────────────────────────────────

const RARITY_RANK: Record<LootRarity, number> = {
  unknown: -1,
  common: 0,
  green: 1,
  blue: 2,
  purple: 3,
  white: 4,
};

// ─── Active bag tracking ─────────────────────────────────────────────────────

const activeBags: Map<number, LootBag> = new Map();

type AnyHandler = (e: any) => void;
const listeners: Map<string, AnyHandler[]> = new Map();

function register(key: string, handler: AnyHandler): () => void {
  if (!listeners.has(key)) listeners.set(key, []);
  listeners.get(key)!.push(handler);
  return () => {
    const arr = listeners.get(key) ?? [];
    listeners.set(key, arr.filter((h) => h !== handler));
  };
}

function fireSafe(key: string, event: any): void {
  for (const h of listeners.get(key) ?? []) {
    try {
      h(event);
    } catch (err) {
      Logger.warn('BridgeLoot', `listener error: ${(err as Error).message}`);
    }
  }
}

function buildBagFromObj(obj: any, deps: BridgeDeps): LootBag | null {
  const objectType = Number(obj.objectType);
  if (!BAG_TYPES.has(objectType)) return null;
  const status = obj.status;
  if (!status) return null;

  const objectId = Number(status.objectId);
  const pos = status.position
    ? { x: Number(status.position.x), y: Number(status.position.y) }
    : { x: 0, y: 0 };

  const stats: Record<string, number> = {};
  if (status.data && Array.isArray(status.data)) {
    for (const s of status.data) {
      if (s && s.id != null) stats[String(s.id)] = Number(s.value);
    }
  }

  const items: LootItem[] = [];
  for (let slot = 0; slot < 8; slot++) {
    const itemType = stats[String(StatType.Inventory0 + slot)];
    if (!Number.isFinite(itemType) || itemType <= 0) continue;
    const itemDef = deps.gameData.getObject(itemType);
    items.push({ objectType: itemType, slotIndex: slot, itemName: itemDef?.id });
  }

  const rarity: LootRarity = BAG_RARITY[objectType] ?? 'unknown';
  return { objectId, bagType: objectType, rarity, position: pos, items, droppedAt: Date.now() };
}

function onUpdate(_client: ClientConnection, packet: Packet, deps: BridgeDeps): void {
  if (!packet.isDefined) return;
  if (packet.data.newObjs) {
    for (const obj of packet.data.newObjs as any[]) {
      const bag = buildBagFromObj(obj, deps);
      if (!bag) continue;
      activeBags.set(bag.objectId, bag);
      fireSafe('bagDropped', { bag });
    }
  }
  if (packet.data.drops) {
    for (const id of packet.data.drops as number[]) {
      const bag = activeBags.get(Number(id));
      if (!bag) continue;
      activeBags.delete(Number(id));
      fireSafe('bagRemoved', { bag });
    }
  }
}

// ─── Packet helpers ───────────────────────────────────────────────────────────

const QUICKSLOT_PACKET_BASE = 1000000;
const QUICK_SLOT_COUNT = 3;

function getCurrentBagSlotItem(deps: BridgeDeps, bagObjectId: number, slotIndex: number): number {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= 8) return -1;
  const entity = deps.worldState.getEntity(bagObjectId);
  if (!entity) return -1;
  const raw = entity.stats?.[String(StatType.Inventory0 + slotIndex)];
  const itemId = Number(raw);
  return Number.isFinite(itemId) ? Math.trunc(itemId) : -1;
}

function findFreeSlot(
  client: ClientConnection,
  useBackpack = true,
  exclude?: Set<number>,
): { packetSlotId: number; currentObjectType: number } | null {
  // Main inventory slots 4–11 (0–3 are gear slots)
  for (let slot = 4; slot <= 11; slot++) {
    if (exclude?.has(slot)) continue;
    const objectType = Number(client.playerData.inventory[slot] ?? -1);
    if (objectType === -1) return { packetSlotId: slot, currentObjectType: -1 };
  }
  if (useBackpack && client.playerData.hasBackpack) {
    for (let slot = 0; slot < (client.playerData.hasBackpackExtender ? 16 : 8); slot++) {
      const packetSlotId = 12 + slot;
      if (exclude?.has(packetSlotId)) continue;
      const objectType = Number(client.playerData.backpack[slot] ?? -1);
      if (objectType === -1) return { packetSlotId: packetSlotId, currentObjectType: -1 };
    }
  }
  return null;
}

function findQuickslotForItem(
  client: ClientConnection,
  itemId: number,
  exclude?: Set<number>,
): { packetSlotId: number; currentObjectType: number } | null {
  const info = catalog.get(itemId);
  if (!info?.quickslotAllowed) return null;
  const count = client.playerData.hasThirdQuickSlot ? QUICK_SLOT_COUNT : 2;
  const read = (slot: number) => {
    const raw = client.playerData.quickSlots[slot];
    return typeof raw === 'number'
      ? { itemType: raw, quantity: 0 }
      : (raw ?? { itemType: -1, quantity: 0 });
  };
  for (let slot = 0; slot < count; slot++) {
    const current = read(slot);
    if (current.itemType !== itemId) continue;
    if (exclude?.has(QUICKSLOT_PACKET_BASE + slot)) return null;
    return current.quantity > 0 && current.quantity < 6
      ? { packetSlotId: QUICKSLOT_PACKET_BASE + slot, currentObjectType: itemId }
      : null;
  }
  for (let slot = 0; slot < count; slot++) {
    if (exclude?.has(QUICKSLOT_PACKET_BASE + slot)) continue;
    if (read(slot).itemType <= 0)
      return { packetSlotId: QUICKSLOT_PACKET_BASE + slot, currentObjectType: -1 };
  }
  return null;
}

function sendInventorySwap(
  c: ClientConnection,
  deps: BridgeDeps,
  bagObjectId: number,
  bagSlot: number,
  itemId: number,
  dest: { packetSlotId: number; currentObjectType: number },
): boolean {
  const pkt = deps.proxy.packetFactory.createByName('INVENTORYSWAP');
  pkt.data.time = Math.trunc(c.time);
  pkt.data.position = {
    x: Number(c.playerData.pos?.x ?? 0),
    y: Number(c.playerData.pos?.y ?? 0),
  };
  pkt.data.slotObject1 = { objectId: bagObjectId, slotId: bagSlot, objectType: itemId };
  pkt.data.slotObject2 = { objectId: c.objectId, slotId: dest.packetSlotId, objectType: dest.currentObjectType };
  pkt.modified = true;
  const readDestination = () => JSON.stringify(dest.packetSlotId >= QUICKSLOT_PACKET_BASE
    ? c.playerData.quickSlots[dest.packetSlotId - QUICKSLOT_PACKET_BASE]
    : dest.packetSlotId >= 12 ? c.playerData.backpack[dest.packetSlotId - 12]
    : c.playerData.inventory[dest.packetSlotId]);
  const beforeDestination = readDestination();
  return tryInventoryAction(c,
    () => getCurrentBagSlotItem(deps, bagObjectId, bagSlot) !== itemId
      && readDestination() !== beforeDestination ? 'settled' : 'pending',
    () => c.sendToServer(pkt));
}

// ─── shouldPickup logic ───────────────────────────────────────────────────────

function runShouldPickup(objectType: number, opts: PickupOptions, deps: BridgeDeps): boolean {
  if (!Number.isFinite(objectType) || objectType <= 0) return false;

  const blacklistSet = opts.blacklist ? new Set(opts.blacklist) : null;
  const whitelistSet = opts.whitelist ? new Set(opts.whitelist) : null;

  if (blacklistSet?.has(objectType)) return false;
  if (whitelistSet?.has(objectType)) return true;

  if (HP_POTION_IDS.has(objectType)) return opts.includeHpPotions ?? false;
  if (MP_POTION_IDS.has(objectType)) return opts.includeMpPotions ?? false;
  if (LIFE_MANA_POTION_IDS.has(objectType)) return opts.includeLifeManaPotions ?? true;
  if (STAT_POTION_IDS.has(objectType)) return opts.includeStatPotions ?? true;

  const info = catalog.get(objectType);
  if (!info) {
    // Item not in gear catalog — try raw game data (catches recently-added items missing from catalog)
    const rawObj = deps.gameData.getObject(objectType);
    if (rawObj && (opts.includeUTs ?? true)) {
      const st = Math.trunc(Number(rawObj.slotType ?? -1));
      const tier = String(rawObj.tierStr ?? '').trim().toUpperCase();
      if (isMultitoolUtTier(tier, st) && !EXCLUDED_UT_SLOT_TYPES.has(st)) return true;
    }
    return false;
  }

  if (opts.includeMarks && info.name.includes('Mark of ')) return true;
  if (opts.includeEggs && info.name.endsWith(' Egg')) return true;

  if (info.isUT) {
    if (!(opts.includeUTs ?? true)) return false;
    return !EXCLUDED_UT_SLOT_TYPES.has(info.slotType);
  }

  if (info.isST) return opts.includeSTs ?? false;

  const category = getGearCategory(info.slotType);
  if (!category) return false;

  let minTier: number;
  switch (category) {
    case 'weapon': minTier = opts.minWeaponTier ?? 0; break;
    case 'ability': minTier = opts.minAbilityTier ?? 0; break;
    case 'armor': minTier = opts.minArmorTier ?? 0; break;
    case 'ring': minTier = opts.minRingTier ?? 0; break;
  }

  return info.tier != null && info.tier >= minTier;
}

// ─── install ──────────────────────────────────────────────────────────────────

let hookInstalled = false;

export function install(deps: BridgeDeps): void {
  if (!hookInstalled) {
    hookInstalled = true;
    buildCatalog(deps);

    deps.proxy.hookPacket('UPDATE', (client, packet) => {
      try {
        onUpdate(client, packet, deps);
      } catch (err) {
        Logger.warn('BridgeLoot', `UPDATE hook error: ${(err as Error).message}`);
      }
    });

    deps.proxy.hookPacket('MAPINFO', () => {
      activeBags.clear();
    });
  }

  // ─── Bag queries ────────────────────────────────────────────────────────────
  const liveBag = (bag: LootBag): LootBag | null => {
    const entity = deps.worldState.getEntity(bag.objectId);
    if (!entity) return null;
    const items: LootItem[] = [];
    for (let slot = 0; slot < 8; slot++) {
      const objectType = Number(entity.stats?.[String(StatType.Inventory0 + slot)] ?? -1);
      if (objectType <= 0) continue;
      items.push({ objectType, slotIndex: slot, itemName: deps.gameData.getObject(objectType)?.id });
    }
    return { ...bag, position: { x: entity.pos.x, y: entity.pos.y }, items };
  };
  const liveBags = () => Array.from(activeBags.values())
    .map(liveBag).filter((bag): bag is LootBag => bag != null);

  loot.getBags = liveBags;

  loot.getNearbyBags = (radius = 5) => {
    const pd = deps.clientRef.current?.playerData;
    if (!pd) return liveBags();
    const { x: px, y: py } = pd.pos;
    return liveBags().filter(
      (b) => Math.hypot(b.position.x - px, b.position.y - py) <= radius,
    );
  };

  loot.getBagsByRarity = (rarity) =>
    liveBags().filter((b) => b.rarity === rarity);

  loot.getBagsContaining = (objectType) =>
    liveBags().filter((b) => b.items.some((i) => i.objectType === objectType));

  // ─── Events ─────────────────────────────────────────────────────────────────
  loot.onBagDropped = (handler) => register('bagDropped', handler);

  loot.onRareBagDropped = (minRarity, handler) =>
    loot.onBagDropped((e) => {
      if (RARITY_RANK[e.bag.rarity] >= RARITY_RANK[minRarity]) handler(e);
    });

  loot.onItemDropped = (objectType, handler) =>
    loot.onBagDropped((e) => {
      const match = e.bag.items.find((i: LootItem) => i.objectType === objectType);
      if (match) handler({ bag: e.bag, item: match });
    });

  loot.onBagRemoved = (handler) => register('bagRemoved', handler);

  // ─── Pickup ──────────────────────────────────────────────────────────────────

  loot.pickup = (bag, slotIndex, opts) => {
    const c = deps.clientRef.current;
    if (!c?.connected || !c.objectId) return false;

    const itemId = getCurrentBagSlotItem(deps, bag.objectId, slotIndex);
    if (itemId <= 0) return false;
    const pos = deps.worldState.getEntity(bag.objectId)?.pos;
    if (!pos || Math.hypot(pos.x - c.playerData.pos.x, pos.y - c.playerData.pos.y) > 1) return false;

    const useBackpack = opts?.useBackpack ?? true;
    const destination = findQuickslotForItem(c, itemId) ?? findFreeSlot(c, useBackpack);
    if (!destination) return false;

    try {
      return sendInventorySwap(c, deps, bag.objectId, slotIndex, itemId, destination);
    } catch (err) {
      Logger.warn('BridgeLoot', `pickup failed: ${(err as Error).message}`);
      return false;
    }
  };

  loot.pickupId = (bagObjectId, opts) => {
    const c = deps.clientRef.current;
    if (!c?.connected || !c.objectId) return -1;

    // Look up bag — check activeBags first, fall back to worldState entity
    const bag = activeBags.get(bagObjectId);
    const entity = deps.worldState.getEntity(bagObjectId);
    if (!entity) return -1;

    // Use most up-to-date position from worldState
    const bx = Number(entity.pos?.x ?? (bag?.position.x ?? 0));
    const by = Number(entity.pos?.y ?? (bag?.position.y ?? 0));
    const px = Number(c.playerData.pos?.x ?? 0);
    const py = Number(c.playerData.pos?.y ?? 0);
    const maxDist = opts?.maxDistance ?? 1.0;
    if (Math.hypot(bx - px, by - py) > maxDist) return -1;

    const useBackpack = opts?.useBackpack ?? true;
    const claimedSlots = new Set<number>();
    let sent = 0;

    for (let slot = 0; slot < 8; slot++) {
      const itemId = getCurrentBagSlotItem(deps, bagObjectId, slot);
      if (itemId <= 0) continue;

      const destination = findQuickslotForItem(c, itemId, claimedSlots)
        ?? findFreeSlot(c, useBackpack, claimedSlots);
      if (!destination) continue; // inventory full for this item

      claimedSlots.add(destination.packetSlotId);
      try {
        if (sendInventorySwap(c, deps, bagObjectId, slot, itemId, destination)) sent++;
        break; // One authoritative inventory operation at a time.
      } catch (err) {
        Logger.warn('BridgeLoot', `pickupId slot ${slot} failed: ${(err as Error).message}`);
      }
    }

    return sent;
  };

  loot.useFromBag = (bag, slotIndex) => {
    const c = deps.clientRef.current;
    if (!c?.connected) return false;

    const itemId = getCurrentBagSlotItem(deps, bag.objectId, slotIndex);
    if (itemId <= 0) return false;
    const pos = deps.worldState.getEntity(bag.objectId)?.pos;
    if (!pos || Math.hypot(pos.x - c.playerData.pos.x, pos.y - c.playerData.pos.y) > 1) return false;

    try {
      const pkt = deps.proxy.packetFactory.createByName('USEITEM');
      pkt.data.time = Math.trunc(c.time);
      pkt.data.slotObject = {
        objectId: bag.objectId,
        slotId: slotIndex,
        objectType: itemId,
      };
      pkt.data.itemUsePos = { x: 0, y: 0 };
      pkt.data.useType = 0;
      pkt.data.unknownInt = 0;
      pkt.modified = true;
      return tryInventoryAction(c,
        () => String(getCurrentBagSlotItem(deps, bag.objectId, slotIndex)),
        () => c.sendToServer(pkt));
    } catch (err) {
      Logger.warn('BridgeLoot', `useFromBag failed: ${(err as Error).message}`);
      return false;
    }
  };

  // ─── Item classification + filter ────────────────────────────────────────────

  loot.shouldPickup = (objectType, opts = {}) => runShouldPickup(objectType, opts, deps);

  loot.isUT = (objectType) => {
    const info = catalog.get(objectType);
    if (info) return info.isUT;
    const raw = deps.gameData.getObject(objectType);
    if (!raw) return false;
    const st = Math.trunc(Number(raw.slotType ?? -1));
    return isMultitoolUtTier(String(raw.tierStr ?? '').trim().toUpperCase(), st);
  };

  loot.isST = (objectType) => {
    const info = catalog.get(objectType);
    if (info) return info.isST;
    const raw = deps.gameData.getObject(objectType);
    return raw ? String(raw.tierStr ?? '').trim().toUpperCase() === 'ST' : false;
  };

  loot.isStatPot = (objectType) => STAT_POTION_IDS.has(objectType);
  loot.isHpPot = (objectType) => HP_POTION_IDS.has(objectType);
  loot.isMpPot = (objectType) => MP_POTION_IDS.has(objectType);
  loot.isLifeManaPot = (objectType) => LIFE_MANA_POTION_IDS.has(objectType);

  loot.isUsefulStatPot = (objectType) => {
    const c = deps.clientRef.current;
    if (!c) return false;
    const caps = deps.gameData.getPlayerClassStatMaxes(c.playerData.classType);
    if (!caps) return false;
    const base: Record<PotStat, number> = {
      attack: c.playerData.attack, defense: c.playerData.defense,
      speed: c.playerData.speed, dexterity: c.playerData.dexterity,
      vitality: c.playerData.vitality, wisdom: c.playerData.wisdom,
      maxHitPoints: c.playerData.maxHealth - c.playerData.healthBonus - c.playerData.exaltedMaxHP,
      maxMagicPoints: c.playerData.maxMana - c.playerData.manaBonus - c.playerData.exaltedMaxMP,
    };
    const cap: Record<PotStat, number> = {
      attack: caps.attack, defense: caps.defense, speed: caps.speed, dexterity: caps.dexterity,
      vitality: caps.hpRegen, wisdom: caps.mpRegen,
      maxHitPoints: caps.maxHitPoints, maxMagicPoints: caps.maxMagicPoints,
    };
    if (objectType === 5094) {
      return (['attack', 'defense', 'speed', 'dexterity', 'vitality', 'wisdom'] as PotStat[])
        .some((key) => base[key] < cap[key]);
    }
    const key = POT_STAT.get(objectType);
    return key != null && base[key] < cap[key];
  };

  loot.isEquipmentUpgrade = (objectType) => {
    const c = deps.clientRef.current;
    const candidate = catalog.get(objectType);
    const category = candidate ? getGearCategory(candidate.slotType) : null;
    if (!c || !candidate || !category) return false;
    const equippedType = Number(c.playerData.inventory[gearSlotIndex(category)] ?? -1);
    if (equippedType <= 0) return true;
    const equipped = catalog.get(equippedType);
    // Exact SlotType compatibility prevents, for example, a sword replacing a wand.
    if (!equipped || equipped.slotType !== candidate.slotType) return false;
    return gearRank(candidate) > gearRank(equipped);
  };

  loot.getEquipmentSlot = (objectType) => {
    const info = catalog.get(objectType);
    const category = info ? getGearCategory(info.slotType) : null;
    return category ? gearSlotIndex(category) : -1;
  };

  loot.equipFromBag = (bag, slotIndex) => {
    const c = deps.clientRef.current;
    if (!c?.connected) return false;
    const itemId = getCurrentBagSlotItem(deps, bag.objectId, slotIndex);
    if (!loot.isEquipmentUpgrade(itemId)) return false;
    const pos = deps.worldState.getEntity(bag.objectId)?.pos;
    if (!pos || Math.hypot(pos.x - c.playerData.pos.x, pos.y - c.playerData.pos.y) > 1) return false;
    const info = catalog.get(itemId);
    const category = info ? getGearCategory(info.slotType) : null;
    if (!category) return false;
    const equipSlot = gearSlotIndex(category);
    try {
      return sendInventorySwap(c, deps, bag.objectId, slotIndex, itemId, {
        packetSlotId: equipSlot,
        currentObjectType: Number(c.playerData.inventory[equipSlot] ?? -1),
      });
    } catch (err) {
      Logger.warn('BridgeLoot', `equipFromBag failed: ${(err as Error).message}`);
      return false;
    }
  };
}
