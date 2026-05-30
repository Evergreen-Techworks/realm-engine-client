/**
 * Placeholder catalog when no upstream market API is available, or when
 * GET ${botApiUrl|marketApiUrl}/api/market/catalog fails.
 * Shape matches SAUCE3100 bot-frontend Market.tsx for easy server alignment later.
 */

export type PriceType = 'free' | 'monthly' | 'per_run';
export type ScriptTier = 'free' | 'premium' | 'instanced';
export type Rarity = 'common' | 'uncommon' | 'rare' | 'legendary';

export interface ScriptRunBundle {
  runs: number;
  priceGems: number;
}

export interface MarketScript {
  id: number;
  name: string;
  author: string;
  updatedLabel: string;
  description: string;
  tier: ScriptTier;
  priceType: PriceType;
  /** Monthly subscription cost in gems (for priceType 'monthly'). */
  priceGems?: number;
  /** Cost per single run in gems (for priceType 'per_run'). */
  perRunGems?: number;
  /** Bulk run bundles — buy N runs at a discount (for priceType 'per_run'). */
  runBundles?: ScriptRunBundle[];
  category: string;
  tags: string[];
  isNew?: boolean;
  isFeatured?: boolean;
}

export interface MarketDupeItem {
  id: number;
  name: string;
  icon: string;
  /** RotMG object type (decimal) for rendering the real game sprite. */
  objectType?: number;
  tiers: { qty: number; priceGems: number }[];
}

export interface MarketItemListing {
  id: number;
  name: string;
  seller: string;
  postedLabel: string;
  itemType: string;
  rarity: Rarity;
  priceGems: number;
  stat?: string;
  isNew?: boolean;
}

export interface MarketCatalog {
  scripts: MarketScript[];
  dupes: MarketDupeItem[];
  items: MarketItemListing[];
  keyTiers: { qty: number; priceGems: number }[];
  key10StarSurcharge: number;
  scriptCategories: string[];
  sortOptions: string[];
  priceOptions: string[];
}

const SCRIPTS: MarketScript[] = [
  /* ── Free (always available) ── */
  { id: 2, name: 'Autoaim', author: 'RealmEngine', updatedLabel: 'Mar 14th', description: 'Smart auto-aim with target filtering — ignores invisible and untargetable enemies.', tier: 'free', priceType: 'free', category: 'Survival', tags: ['Free'], isFeatured: true },
  { id: 10, name: 'AutoNexus', author: 'RealmEngine', updatedLabel: 'Mar 14th', description: 'Hybrid autonexus with configurable HP thresholds, status effects, and enemy proximity triggers.', tier: 'free', priceType: 'free', category: 'Survival', tags: ['Free'], isNew: true },
  { id: 11, name: 'Autoloot', author: 'RealmEngine', updatedLabel: 'Mar 14th', description: 'Stand-on-pot auto-pickup. Automatically loots potions and configurable items on contact.', tier: 'free', priceType: 'free', category: 'Looting', tags: ['Free'] },
  { id: 7, name: 'Loot Filter Builder', author: 'ItemLogic', updatedLabel: 'Mar 9th', description: 'Visual loot filter editor. Whitelist by tier, class, stat boost, or name. Exports directly into script config.', tier: 'free', priceType: 'free', category: 'Utility', tags: [], isNew: true },

  /* ── Included with Premium subscription ($8/mo) ── */
  { id: 14, name: 'Godfarming', author: 'RealmEngine', updatedLabel: 'Mar 14th', description: 'Automated godlands farming — walks realm, kills gods, picks up stat pots, nexuses when full or in danger.', tier: 'premium', priceType: 'free', category: 'Farming', tags: ['Premium'], isFeatured: true },
  { id: 13, name: 'Autododge', author: 'RealmEngine', updatedLabel: 'Mar 14th', description: 'Advanced dodge automation — AOE avoidance, tracking projectiles, player speed awareness, and enemy condition detection.', tier: 'premium', priceType: 'free', category: 'Survival', tags: ['Premium'], isFeatured: true },

  /* ── Separate gem purchases (monthly sub OR per-run) ── */
  { id: 1, name: 'Dungeon AIO Farmer', author: 'VaultScript', updatedLabel: 'Mar 14th', description: 'Fully automated dungeon farming across all major realms. Handles portals, loot priority, nexus conditions, and multi-room routing with smart pathfinding.', tier: 'instanced', priceMonthly: 'free', priceGems: 0, perRunGems: 0, runBundles: [{ runs: 5, priceGems: 0 }, { runs: 10, priceGems: 0 }], category: 'Farming', tags: [], isFeatured: true },
  { id: 3, name: 'GraveyardBot', author: 'SkullForge', updatedLabel: 'Mar 12th', description: 'Optimized graveyard fame farming with intelligent dungeon detection, fame counter, and auto-logout on death.', tier: 'instanced', priceMonthly: 'free', priceGems: 0, perRunGems: 0, runBundles: [{ runs: 5, priceGems: 8 }, { runs: 10, priceGems: 14 }], category: 'Fame', tags: [] },
  { id: 4, name: 'Sprite World Rusher', author: 'GlitchRun', updatedLabel: 'Mar 11th', description: 'Blazing-fast Sprite World rushing with configurable loot filter, HP threshold, and auto-requeue. Supports all builds.', tier: 'instanced', priceMonthly: 'free', priceGems: 0, perRunGems: 1, runBundles: [{ runs: 5, priceGems: 0 }, { runs: 10, priceGems: 0 }], category: 'Farming', tags: [], isNew: true },
  { id: 5, name: 'Candyland AFK', author: 'SugarScript', updatedLabel: 'Mar 10th', description: 'AFK Candyland farming loop with boss detection, loot bag pickup optimization, and vault storage automation.', tier: 'instanced', priceMonthly: 'free', priceGems: 0, perRunGems: 0, runBundles: [{ runs: 5, priceGems: 0 }, { runs: 10, priceGems: 0 }], category: 'Farming', tags: [] },
  { id: 6, name: 'Realm Navigator', author: 'MapMaster', updatedLabel: 'Mar 14th', description: 'Intelligent realm crawler that finds and enters dungeons matching your criteria. Supports portal chaining and blacklists.', tier: 'instanced', priceMonthly: 'free', priceGems: 0, perRunGems: 0, runBundles: [{ runs: 5, priceGems: 0 }, { runs: 10, priceGems: 0 }], category: 'Navigation', tags: [], isFeatured: true },
  { id: 8, name: 'Void Entity Farmer', author: 'VoidRunner', updatedLabel: 'Mar 8th', description: 'End-game Void Entity farming script. Handles multi-phase boss, teleports, star align patterns, and loot priority.', tier: 'instanced', priceMonthly: 'free', priceGems: 0, perRunGems: 0, runBundles: [{ runs: 5, priceGems: 0 }, { runs: 10, priceGems: 0 }], category: 'Endgame', tags: [], isFeatured: true },
  { id: 9, name: 'Skull Shrine Looter', author: 'BoneScript', updatedLabel: 'Mar 7th', description: 'Automated skull shrine looting with smart bag management, UT-detection, and safe teleport fallback.', tier: 'instanced', priceMonthly: 'free', priceGems: 0, perRunGems: 0, runBundles: [{ runs: 5, priceGems: 0 }, { runs: 10, priceGems: 0 }], category: 'Looting', tags: [] },
  { id: 12, name: 'Auto Pot', author: 'RealmEngine', updatedLabel: 'Mar 14th', description: 'Automatic HP/MP potion consumption with configurable thresholds and smart timing.', tier: 'instanced', priceMonthly: 'free', priceGems: 0, perRunGems: 0, runBundles: [{ runs: 5, priceGems: 0 }, { runs: 10, priceGems: 7 }], category: 'Survival', tags: [] },
];

/* Bulk tiers: ~10% off ×5, ~15% off ×10, ~20% off ×20, ~25% off ×50, ~30% off ×100 */
/* objectType values are decimal RotMG object types from objects.xml (Greater Potion variants) */
const DUPE_ITEMS: MarketDupeItem[] = [
  { id: 1, name: 'Attack Potion',    icon: '⚔️', objectType: 0x2368, tiers: [{ qty: 1, priceGem: 0 }, { qty: 5, priceGems:  72 }, { qty: 10, priceGems: 136 }, { qty: 20, priceGems: 256 }, { qty: 50, priceGems: 0 }, { qty: 100, priceGems: 0 }] },
  { id: 2, name: 'Defense Potion',   icon: '🛡️', objectType: 0x2369, tiers: [{ qty: 1, priceGem: 0 }, { qty: 5, priceGems:  72 }, { qty: 10, priceGems: 136 }, { qty: 20, priceGems: 256 }, { qty: 50, priceGems: 0 }, { qty: 100, priceGems: 0 }] },
  { id: 3, name: 'Speed Potion',     icon: '💨', objectType: 0x236a, tiers: [{ qty: 1, priceGem: 0 }, { qty: 5, priceGems:  72 }, { qty: 10, priceGems: 136 }, { qty: 20, priceGems: 256 }, { qty: 50, priceGems: 0 }, { qty: 100, priceGems: 0 }] },
  { id: 4, name: 'Dexterity Potion', icon: '🏹', objectType: 0x236d, tiers: [{ qty: 1, priceGem: 0 }, { qty: 5, priceGems:  72 }, { qty: 10, priceGems: 136 }, { qty: 20, priceGems: 256 }, { qty: 50, priceGems: 0 }, { qty: 100, priceGems: 0 }] },
  { id: 5, name: 'Vitality Potion',  icon: '❤️', objectType: 0x236b, tiers: [{ qty: 1, priceGem: 0 }, { qty: 5, priceGems:  72 }, { qty: 10, priceGems: 136 }, { qty: 20, priceGems: 256 }, { qty: 50, priceGems: 0 }, { qty: 100, priceGems: 0 }] },
  { id: 6, name: 'Wisdom Potion',    icon: '🔮', objectType: 0x236c, tiers: [{ qty: 1, priceGem: 0 }, { qty: 5, priceGems:  72 }, { qty: 10, priceGems: 136 }, { qty: 20, priceGems: 256 }, { qty: 50, priceGems: 0 }, { qty: 100, priceGems: 0 }] },
  { id: 7, name: 'Life Potion',      icon: '💖', objectType: 0x236e, tiers: [{ qty: 1, priceGems: 20 }, { qty: 5, priceGems:  90 }, { qty: 10, priceGems: 170 }, { qty: 20, priceGems: 320 }, { qty: 50, priceGems: 0 }, { qty: 100, priceGems: 0 }] },
  { id: 8, name: 'Mana Potion',      icon: '💙', objectType: 0x236f, tiers: [{ qty: 1, priceGems: 20 }, { qty: 5, priceGems:  90 }, { qty: 10, priceGems: 170 }, { qty: 20, priceGems: 320 }, { qty: 50, priceGems: 0 }, { qty: 100, priceGems: 0 }] },
];

const KEY_TIERS = [
  { qty: 10, priceGems: 0 },
  { qty: 25, priceGems: 0 },
  { qty: 50, priceGem: 0 },
  { qty: 100, priceGems: 0 },
  { qty: 250, priceGems: 0 },
];

const KEY_10STAR_SURCHARGE = 0.4;

const ITEMS: MarketItemListing[] = [
  { id: 1, name: 'Void Blade', seller: 'LegendaryVault', postedLabel: 'Mar 14th', itemType: 'Weapon', rarity: 'legendary', priceGems: 45, stat: '+8 ATT', isNew: true },
  { id: 2, name: 'Ring of the Pyramid', seller: 'StatTrader', postedLabel: 'Mar 13th', itemType: 'Ring', rarity: 'rare', priceGems: 18, stat: '+10 HP +10 MP' },
  { id: 3, name: "Oryx's Escutcheon", seller: 'OryxLoot', postedLabel: 'Mar 12th', itemType: 'Ability', rarity: 'legendary', priceGems: 60, stat: '+5 DEF', isNew: true },
  { id: 4, name: 'T12 Armor Bundle', seller: 'ArmorMerch', postedLabel: 'Mar 11th', itemType: 'Armor', rarity: 'uncommon', priceGems: 6, stat: '+22 DEF' },
  { id: 5, name: 'Snake Eye Ring', seller: 'RingKing', postedLabel: 'Mar 10th', itemType: 'Ring', rarity: 'rare', priceGems: 22, stat: '+5 DEX' },
  { id: 6, name: "Tablet of the King's Avatar", seller: 'TabletDealer', postedLabel: 'Mar 9th', itemType: 'Ability', rarity: 'rare', priceGems: 30, stat: '+4 ATT' },
];

const SCRIPT_CATEGORIES = ['All', 'Farming', 'Survival', 'Fame', 'Navigation', 'Utility', 'Endgame', 'Looting'];
const SORT_OPTIONS = ['Recommended', 'Most Popular', 'Most Recently Updated', 'Price: High to Low', 'Price: Low to High'];
const PRICE_OPTIONS = ['Any', 'Free', 'Included (Premium)', 'Gem Purchase'];

export function getMarketCatalogStub(): MarketCatalog {
  return {
    scripts: SCRIPTS,
    dupes: DUPE_ITEMS,
    items: ITEMS,
    keyTiers: KEY_TIERS,
    key10StarSurcharge: KEY_10STAR_SURCHARGE,
    scriptCategories: SCRIPT_CATEGORIES,
    sortOptions: SORT_OPTIONS,
    priceOptions: PRICE_OPTIONS,
  };
}
