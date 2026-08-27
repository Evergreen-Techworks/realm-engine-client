/**
 * Auto Loot configuration: the mutable settings object, whitelist/blacklist file
 * IO, and registration of every dashboard control.
 *
 * All tunable state lives on {@link AutoLootSettings} so the rest of the plugin
 * can read flags directly while the dashboard mutates them through the registered
 * setting callbacks.
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { PluginContext } from '../../src/plugins/PluginContext.js';
import type { LootCatalog, GearCategory } from './catalog.js';
import { getGearCategory } from './catalog.js';
import { minEnchantSelectToCount } from './items.js';
import {
  TIER_NEVER,
  FALLBACK_TIER_RANGE,
  DEFAULT_PICKUP_INTERVAL_MS,
  MIN_PICKUP_INTERVAL_MS,
  MAX_PICKUP_INTERVAL_MS,
  DEFAULT_MAX_LOOT_ACTIONS_PER_SEC,
  MIN_MAX_LOOT_ACTIONS_PER_SEC,
  MAX_MAX_LOOT_ACTIONS_PER_SEC,
  slotTypeName,
  DEFAULT_MIN_WEAPON_TIER,
  DEFAULT_MIN_ABILITY_TIER,
  DEFAULT_MIN_ARMOR_TIER,
  DEFAULT_MIN_RING_TIER,
  DEFAULT_MANUAL_POTION_SUPPRESS_MS,
  MIN_MANUAL_POTION_SUPPRESS_MS,
  MAX_MANUAL_POTION_SUPPRESS_MS,
  DEFAULT_MANUAL_POTION_PACKET_BLOCK_MS,
  MIN_MANUAL_POTION_PACKET_BLOCK_MS,
  MAX_MANUAL_POTION_PACKET_BLOCK_MS,
} from './constants.js';

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/** A list entry is either a bare item id or an object with an `id` field. */
function coerceItemId(entry: unknown): number {
  if (typeof entry === 'number') return entry;
  if (entry && typeof entry === 'object') return Number((entry as Record<string, unknown>).id);
  return Number.NaN;
}

export class AutoLootSettings {
  // Tier thresholds
  minWeaponTier = DEFAULT_MIN_WEAPON_TIER;
  minAbilityTier = DEFAULT_MIN_ABILITY_TIER;
  minArmorTier = DEFAULT_MIN_ARMOR_TIER;
  minRingTier = DEFAULT_MIN_RING_TIER;
  /**
   * Per-slot-type overrides, keyed by slot type. A slot absent from this map
   * inherits its category threshold, which is what the "Use category setting"
   * option in each per-item-type dropdown selects.
   */
  readonly minTierBySlot = new Map<number, number>();

  // Send pacing
  pickupIntervalMs = DEFAULT_PICKUP_INTERVAL_MS;
  maxLootActionsPerSec = DEFAULT_MAX_LOOT_ACTIONS_PER_SEC;

  // Loot toggles
  lootUTs = true;
  lootSTs = false;
  lootHpPotions = false;
  lootMpPotions = false;
  lootStatPotions = true;
  autodrinkStatPots = false;
  lootLifeManaPotions = true;
  lootMarks = false;
  lootEggs = false;
  minEnchantTier = 0;

  // Behaviour toggles
  publicDelay = true;
  disableWhenIdle = true;
  useBackpack = true;
  preferBackpack = false;
  bagNotifierEnabled = false;
  bigLootBags = false;
  diagEnabled = false;

  // Manual potion guard timings (raw values; use the clamped getters below)
  manualPotionSuppressMs = DEFAULT_MANUAL_POTION_SUPPRESS_MS;
  manualPotionPacketBlockMs = DEFAULT_MANUAL_POTION_PACKET_BLOCK_MS;

  // Item id lists, reloaded from disk
  whitelist = new Set<number>();
  blacklist = new Set<number>();

  constructor(private readonly ctx: PluginContext) {}

  manualPotionSuppressMsClamped(): number {
    return clamp(this.manualPotionSuppressMs, MIN_MANUAL_POTION_SUPPRESS_MS, MAX_MANUAL_POTION_SUPPRESS_MS);
  }

  manualPotionPacketBlockMsClamped(): number {
    return clamp(this.manualPotionPacketBlockMs, MIN_MANUAL_POTION_PACKET_BLOCK_MS, MAX_MANUAL_POTION_PACKET_BLOCK_MS);
  }

  // ─── Whitelist / blacklist file IO ──────────────────────────────────────────

  private getRealmengineDir(): string {
    return join(process.env.USERPROFILE || homedir(), 'Documents', 'Realmengine');
  }

  private parseListFile(filePath: string, listName: string): Set<number> {
    if (!existsSync(filePath)) return new Set();
    try {
      const data: any = JSON.parse(readFileSync(filePath, 'utf8'));
      let arr: unknown[] = [];
      if (Array.isArray(data)) arr = data;
      else if (Array.isArray(data?.items)) arr = data.items;
      const ids = new Set<number>();
      for (const entry of arr) {
        const id = Math.trunc(coerceItemId(entry));
        if (Number.isFinite(id) && id > 0) ids.add(id);
      }
      return ids;
    } catch (err) {
      this.ctx.log(`Auto Loot: failed to load ${listName}: ${(err as Error).message}`);
      return new Set();
    }
  }

  reloadLists(dashboard = false): void {
    const dir = this.getRealmengineDir();
    this.whitelist = this.parseListFile(join(dir, 'autoloot-whitelist.json'), 'whitelist');
    this.blacklist = this.parseListFile(join(dir, 'autoloot-blacklist.json'), 'blacklist');
    const msg = `Whitelist: ${this.whitelist.size} item(s) | Blacklist: ${this.blacklist.size} item(s)`;
    if (dashboard) this.ctx.dashboardLog(msg); else this.ctx.log(msg);
  }

  private readListFile(name: 'whitelist' | 'blacklist'): string {
    const p = join(this.getRealmengineDir(), `autoloot-${name}.json`);
    return existsSync(p) ? readFileSync(p, 'utf8') : '[]';
  }

  private saveListFile(name: 'whitelist' | 'blacklist', value: string): void {
    try {
      JSON.parse(value);
      writeFileSync(join(this.getRealmengineDir(), `autoloot-${name}.json`), value, 'utf8');
      this.reloadLists(true);
    } catch (err) {
      this.ctx.dashboardLog(`${name[0].toUpperCase()}${name.slice(1)} save failed: ${(err as Error).message}`);
    }
  }

  // ─── Dashboard registration ─────────────────────────────────────────────────

  /**
   * Tier dropdown options for one list of tiers. The tiers come from the loaded
   * catalog, so the menu offers exactly what the game ships: abilities stop at
   * T10 and skip T9, rings stop at T7. The old numeric input allowed 0-20
   * uniformly, most of which matched nothing.
   */
  private tierOptions(tiers: number[], inheritLabel?: string): { label: string; value: string }[] {
    const list = tiers.length > 0 ? tiers : FALLBACK_TIER_RANGE;
    const top = list[list.length - 1];
    const options = inheritLabel ? [{ label: inheritLabel, value: 'inherit' }] : [];
    for (const t of list) {
      const label = t === list[0] ? `T${t} and up (everything)`
        : t === top ? `T${t} only`
        : `T${t} and up`;
      options.push({ label, value: String(t) });
    }
    options.push({ label: 'Never loot', value: 'off' });
    return options;
  }

  /**
   * Turn a dropdown value into a threshold. Values above the category's real top
   * tier become TIER_NEVER, which is also where a legacy saved value of 20 lands,
   * so the old "park it at 20 to disable" habit keeps working.
   */
  private parseTier(raw: unknown, tiers: number[]): number {
    const text = String(raw ?? '').trim().toLowerCase();
    if (text === 'off' || text === '') return TIER_NEVER;
    const n = Math.trunc(Number(text));
    if (!Number.isFinite(n)) return TIER_NEVER;
    const list = tiers.length > 0 ? tiers : FALLBACK_TIER_RANGE;
    if (n > list[list.length - 1]) return TIER_NEVER;
    return Math.max(0, n);
  }

  /** Nearest offered tier at or above `preferred`, so a default always maps to a real option. */
  private defaultTierValue(tiers: number[], preferred: number): string {
    const list = tiers.length > 0 ? tiers : FALLBACK_TIER_RANGE;
    const hit = list.find((t) => t >= preferred);
    return String(hit ?? list[list.length - 1]);
  }

  register(catalog: LootCatalog): void {
    const ctx = this.ctx;

    const tierSetting = (
      key: string, label: string, tiers: number[], preferred: number, set: (v: number) => void,
    ) => {
      set(this.parseTier(this.defaultTierValue(tiers, preferred), tiers));
      ctx.registerSetting(key, {
        label, type: 'select',
        value: this.defaultTierValue(tiers, preferred),
        options: this.tierOptions(tiers),
      }, (value: string) => set(this.parseTier(value, tiers)));
    };

    const categories: [GearCategory, string, string, number, (v: number) => void][] = [
      ['weapon',  'minWeaponTier',  'Min Weapon Tier',  DEFAULT_MIN_WEAPON_TIER,  (v) => { this.minWeaponTier = v; }],
      ['ability', 'minAbilityTier', 'Min Ability Tier', DEFAULT_MIN_ABILITY_TIER, (v) => { this.minAbilityTier = v; }],
      ['armor',   'minArmorTier',   'Min Armor Tier',   DEFAULT_MIN_ARMOR_TIER,   (v) => { this.minArmorTier = v; }],
      ['ring',    'minRingTier',    'Min Ring Tier',    DEFAULT_MIN_RING_TIER,    (v) => { this.minRingTier = v; }],
    ];
    for (const [category, key, label, preferred, set] of categories) {
      tierSetting(key, label, catalog.tiersFor(category), preferred, set);
    }

    // Per-item-type overrides. One dropdown per gear slot that actually carries
    // tiered items, each defaulting to its category threshold so the simple
    // four-category view stays the whole story until someone opts out of it.
    for (const slotType of catalog.tieredGearSlotTypes()) {
      const category = getGearCategory(slotType);
      if (category == null) continue;
      const tiers = catalog.tiersForSlot(slotType);
      ctx.registerSetting(`minTierSlot${slotType}`, {
        label: `  ${slotTypeName(slotType)} tier`,
        advanced: true,
        type: 'select',
        value: 'inherit',
        options: this.tierOptions(tiers, `Use ${category} setting`),
      }, (value: string) => {
        if (String(value ?? '').trim().toLowerCase() === 'inherit') {
          this.minTierBySlot.delete(slotType);
          return;
        }
        this.minTierBySlot.set(slotType, this.parseTier(value, tiers));
      });
    }

    const boolSetting = (
      key: string, label: string, get: () => boolean, set: (v: boolean) => void, advanced = false,
    ) => {
      ctx.registerSetting(key, { label, advanced, type: 'boolean', value: get() },
        (value: boolean) => set(value === true));
    };
    boolSetting('lootUTs', 'Loot UTs', () => this.lootUTs, (v) => { this.lootUTs = v; });
    boolSetting('lootSTs', 'Loot STs', () => this.lootSTs, (v) => { this.lootSTs = v; });
    boolSetting('lootHpPotions', 'Loot HP Pots', () => this.lootHpPotions, (v) => { this.lootHpPotions = v; });
    boolSetting('lootMpPotions', 'Loot MP Pots', () => this.lootMpPotions, (v) => { this.lootMpPotions = v; });
    boolSetting('lootStatPotions', 'Loot Stat Pots', () => this.lootStatPotions, (v) => { this.lootStatPotions = v; });
    boolSetting('autodrinkStatPots', 'Autodrink Stat Pots (USEITEM from bag, 0,0 - no loot)',
      () => this.autodrinkStatPots, (v) => { this.autodrinkStatPots = v; }, true);

    ctx.registerSetting('pickupIntervalMs', {
      label: 'Pickup interval (ms)', advanced: true,
      type: 'number', value: this.pickupIntervalMs,
      min: MIN_PICKUP_INTERVAL_MS, max: MAX_PICKUP_INTERVAL_MS, step: 50,
    }, (v: number) => {
      this.pickupIntervalMs = clamp(
        Math.trunc(Number(v) || DEFAULT_PICKUP_INTERVAL_MS),
        MIN_PICKUP_INTERVAL_MS, MAX_PICKUP_INTERVAL_MS,
      );
    });

    ctx.registerSetting('maxLootActionsPerSec', {
      label: 'Max loot actions / sec', advanced: true,
      type: 'range', value: this.maxLootActionsPerSec,
      min: MIN_MAX_LOOT_ACTIONS_PER_SEC, max: MAX_MAX_LOOT_ACTIONS_PER_SEC, step: 1,
    }, (v: number) => {
      this.maxLootActionsPerSec = clamp(
        Math.trunc(Number(v) || DEFAULT_MAX_LOOT_ACTIONS_PER_SEC),
        MIN_MAX_LOOT_ACTIONS_PER_SEC, MAX_MAX_LOOT_ACTIONS_PER_SEC,
      );
    });

    ctx.registerSetting('minEnchant', {
      label: 'Min enchant (non-potions)', advanced: true,
      type: 'select',
      value: 'none',
      options: [
        { label: 'None', value: 'none' },
        { label: 'Uncommon (>=1 enchant)', value: 'uncommon' },
        { label: 'Rare (>=2)', value: 'rare' },
        { label: 'Legendary (>=3)', value: 'legendary' },
        { label: 'Divine (>=4)', value: 'divine' },
      ],
    }, (value: string) => {
      this.minEnchantTier = minEnchantSelectToCount(value);
    });

    boolSetting('lootLifeManaPotions', 'Loot Life/Mana Pots',
      () => this.lootLifeManaPotions, (v) => { this.lootLifeManaPotions = v; }, true);
    boolSetting('lootMarks', 'Loot Marks', () => this.lootMarks, (v) => { this.lootMarks = v; });
    boolSetting('lootEggs', 'Loot Eggs', () => this.lootEggs, (v) => { this.lootEggs = v; });
    boolSetting('publicDelay', 'Public Delay', () => this.publicDelay, (v) => { this.publicDelay = v; }, true);
    boolSetting('disableWhenIdle', 'Disable When Idle',
      () => this.disableWhenIdle, (v) => { this.disableWhenIdle = v; }, true);
    boolSetting('useBackpack', 'Use Backpack', () => this.useBackpack, (v) => { this.useBackpack = v; }, true);
    boolSetting('preferBackpack', 'Prefer Backpack',
      () => this.preferBackpack, (v) => { this.preferBackpack = v; }, true);

    ctx.registerSetting('manualPotionPauseSeconds', {
      label: 'Manual Potion Pause (seconds)', advanced: true,
      type: 'number',
      value: this.manualPotionSuppressMs / 1000,
      min: MIN_MANUAL_POTION_SUPPRESS_MS / 1000,
      max: MAX_MANUAL_POTION_SUPPRESS_MS / 1000,
      step: 0.5,
    }, (value: number) => {
      const seconds = Number(value);
      const ms = Math.trunc((Number.isFinite(seconds) ? seconds : DEFAULT_MANUAL_POTION_SUPPRESS_MS / 1000) * 1000);
      this.manualPotionSuppressMs = clamp(ms, MIN_MANUAL_POTION_SUPPRESS_MS, MAX_MANUAL_POTION_SUPPRESS_MS);
    });

    ctx.registerSetting('manualPotionPacketBlockSeconds', {
      label: 'Manual Potion Packet Block (seconds)', advanced: true,
      type: 'number',
      value: this.manualPotionPacketBlockMs / 1000,
      min: MIN_MANUAL_POTION_PACKET_BLOCK_MS / 1000,
      max: MAX_MANUAL_POTION_PACKET_BLOCK_MS / 1000,
      step: 0.1,
    }, (value: number) => {
      const seconds = Number(value);
      const ms = Math.trunc((Number.isFinite(seconds) ? seconds : DEFAULT_MANUAL_POTION_PACKET_BLOCK_MS / 1000) * 1000);
      this.manualPotionPacketBlockMs = clamp(ms, MIN_MANUAL_POTION_PACKET_BLOCK_MS, MAX_MANUAL_POTION_PACKET_BLOCK_MS);
    });

    ctx.registerSetting('toggleBagNotifier', {
      label: 'Bag Notifier: Off', advanced: true,
      type: 'button',
      value: null,
    }, () => {
      this.bagNotifierEnabled = !this.bagNotifierEnabled;
      const setting = ctx.getSettings().find((entry) => entry.key === 'toggleBagNotifier');
      if (setting) {
        setting.label = `Bag Notifier: ${this.bagNotifierEnabled ? 'On' : 'Off'}`;
      }
      ctx.log(`Bag notifier ${this.bagNotifierEnabled ? 'enabled' : 'disabled'}.`);
    });

    boolSetting('bigLootBags', 'Big Loot Bags', () => this.bigLootBags, (v) => { this.bigLootBags = v; }, true);

    // Hidden settings used by the edit-list modal to save content back to disk
    ctx.registerSetting('_saveWhitelist', {
      label: '_saveWhitelist', type: 'text', value: '', hidden: true,
    }, (value: string) => this.saveListFile('whitelist', value));
    ctx.registerSetting('_saveBlacklist', {
      label: '_saveBlacklist', type: 'text', value: '', hidden: true,
    }, (value: string) => this.saveListFile('blacklist', value));

    ctx.registerSetting('editWhitelist', {
      label: 'Edit Whitelist', advanced: true, type: 'button', value: null,
    }, () => {
      ctx.broadcastData('openModal', {
        modal: 'editList',
        list: 'whitelist',
        title: 'Edit Whitelist',
        description: 'Items on this list are <strong>always looted</strong>, even if below your tier threshold.',
        current: this.readListFile('whitelist'),
        saveKey: '_saveWhitelist',
      });
    });

    ctx.registerSetting('editBlacklist', {
      label: 'Edit Blacklist', advanced: true, type: 'button', value: null,
    }, () => {
      ctx.broadcastData('openModal', {
        modal: 'editList',
        list: 'blacklist',
        title: 'Edit Blacklist',
        description: 'Items on this list are <strong>never looted</strong>, overrides the whitelist and all tier settings.',
        current: this.readListFile('blacklist'),
        saveKey: '_saveBlacklist',
      });
    });

    ctx.registerSetting('listHelp', {
      label: 'List Help', advanced: true, type: 'button', value: null,
    }, () => {
      ctx.broadcastData('openModal', { modal: 'listHelp', title: 'Whitelist & Blacklist Help' });
    });

    ctx.registerSetting('reloadLists', {
      label: 'Reload Lists from Disk', advanced: true, type: 'button', value: null,
    }, () => {
      this.reloadLists(true);
    });

    ctx.registerSetting('diagEnabled', {
      label: 'Diagnostic Logging', advanced: true, type: 'boolean', value: false,
    }, (value: boolean) => {
      this.diagEnabled = value === true;
      ctx.log(`Auto Loot diagnostic logging: ${this.diagEnabled ? 'ON' : 'OFF'}`);
    });
  }
}
