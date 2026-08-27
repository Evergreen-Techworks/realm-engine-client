import { ConditionEffect, type ConditionEffectName } from '../constants/ConditionEffect.js';
import { StatType } from '../constants/StatType.js';

function toStatInt(value: number | string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}

/**
 * Comprehensive player state tracking.
 * Ported from KRelayBetter's PlayerData.cs.
 *
 * **Combined (gear + exalt)** on the wire -> these are the stat ids to read:
 *   46 HP max boost, 47 MP max boost, 48 ATK, 49 DEF, 50 SPD, 51 VIT, 52 WIS, 53 DEX.
 *
 * **Exalt-only** slices (subtract from the matching combined row above for true gear):
 *   105 ATK, 106 DEF, 107 SPD, 108 VIT, 109 DEX, 110 WIS, 111 max HP, 112 max MP.
 *
 * Public `healthBonus` through `dexterityBonus` = max(0, combined - exalt). `exalted*` holds the exalt slice.
 */
export class PlayerData {
  ownerObjectId = 0;
  accountId = '';
  name = '';
  classType = 0;
  level = 1;

  // Combat stats
  health = 0;
  maxHealth = 0;
  mana = 0;
  maxMana = 0;
  attack = 0;
  defense = 0;
  speed = 0;
  vitality = 0;
  wisdom = 0;
  dexterity = 0;

  // Boost stats (gear-only; combined wire values minus exalted, see applyGearBonusesFromWireMinusExalt)
  healthBonus = 0;
  manaBonus = 0;
  attackBonus = 0;
  defenseBonus = 0;
  speedBonus = 0;
  vitalityBonus = 0;
  wisdomBonus = 0;
  dexterityBonus = 0;

  // Exaltation stats
  exaltedAttack = 0;
  exaltedDefense = 0;
  exaltedSpeed = 0;
  exaltedVitality = 0;
  exaltedWisdom = 0;
  exaltedDexterity = 0;
  exaltedMaxHP = 0;
  exaltedMaxMP = 0;
  exaltationDamageMultiplier = 0;

  /** Latest wire **combined** (gear+exalt): 46,47,48-53 -> null until that stat appears in a status batch. */
  private _wireHpBoost: number | null = null;
  private _wireMpBoost: number | null = null;
  private _wireAttackBonus: number | null = null;
  private _wireDefenseBonus: number | null = null;
  private _wireSpeedBonus: number | null = null;
  private _wireVitalityBonus: number | null = null;
  private _wireWisdomBonus: number | null = null;
  private _wireDexterityBonus: number | null = null;

  // Inventory: slots 0-11, backpack 0-15
  inventory: number[] = new Array(12).fill(-1);
  backpack: number[] = new Array(16).fill(-1);
  quickSlots: Array<{ itemType: number; quantity: number }> = Array.from({ length: 3 }, () => ({ itemType: -1, quantity: 0 }));
  healthStackCount = 0;
  magicStackCount = 0;

  // Condition effects (two 32-bit bitmasks)
  effects: [number, number] = [0, 0];

  // Position
  pos = { x: 0, y: 0 };

  // Map info
  mapName = '';
  mapWidth = 0;
  mapHeight = 0;
  teleportAllowed = false;

  /**
   * S->C `QUESTOBJECTID`: current quest target entity id.
   * `-1` = not yet known or cleared (e.g. new map), `0` = none, `>0` = object id.
   */
  questObjectId = -1;

  // Other
  stars = 0;
  currentFame = 0;
  /** Stat 57: fame on this character while alive (wire updates). */
  characterAliveFame = 0;
  credits = 0;
  skin = 0;
  tex1 = 0;
  tex2 = 0;
  sinkLevel = 0;
  guildName = '';
  guildRank = 0;
  hasBackpack = false;
  /**
   * Stat 130 (`BackpackTier`): 0 = none, 8 = backpack unlocked, 16 = backpack + extender.
   * Fallback: `legacyHasBackpackStat75` when stat 130 absent or zero.
   */
  backpackTier = 0;
  /** Only used when tier is 0; stat 75 can still imply backpack on older payloads. */
  legacyHasBackpackStat75 = false;
  /**
   * True if the server has ever reported a non-empty QuickSlot2 (itemType > 0).
   * The server sends QuickSlot2 as a -1 placeholder for 2-quickslot characters, so
   * we only confirm the 3rd slot exists when an actual item appears in it.
   */
  hasThirdQuickSlot = false;

  /** Last VAULTCONTENT grid for main vault (-1 = empty). Cleared on map change. */
  vaultContent: number[] = [];

  /** Storage chest `objectId` from VAULTCONTENT (main vault). -1 if unknown. */
  vaultChestObjectId = -1;

  /** Stat 124: power level. */
  powerLevel = 0;

  /** Gear-only = max(0, combined - exalted); exalted <= 0 treated as 0. */
  private static gearOnlyFromCombined(combined: number, exalted: number): number {
    const c = Math.trunc(Number(combined)) || 0;
    const e = Math.trunc(Number(exalted)) || 0;
    const ex = e > 0 ? e : 0;
    return Math.max(0, c - ex);
  }

  private refreshBackpackPresenceFromStats(): void {
    this.hasBackpack = this.backpackTier !== 0 || this.legacyHasBackpackStat75;
  }

  /** Stat 130 tier >= 16 -> backpack + extender. */
  get hasBackpackExtender(): boolean {
    return this.backpackTier >= 16;
  }

  /**
   * True max HP as the in-game bar shows it. `maxHealth` is stat 3, the gearless
   * base; the combined gear+exalt boost is stat 46, which is split here into
   * `healthBonus` (gear) and `exaltedMaxHP` (exalt). Reading the bare base makes
   * every HP ratio read high, so thresholds never trip when they should.
   */
  get effectiveMaxHealth(): number {
    return this.maxHealth + this.healthBonus + Math.max(0, this.exaltedMaxHP);
  }

  /** True max MP, same base + gear + exalt split as `effectiveMaxHealth`. */
  get effectiveMaxMana(): number {
    return this.maxMana + this.manaBonus + Math.max(0, this.exaltedMaxMP);
  }

  /** True VIT (base + gear + exalt), for HP regen prediction. */
  get effectiveVitality(): number {
    return this.vitality + this.vitalityBonus + Math.max(0, this.exaltedVitality);
  }

  private applyGearBonusesFromWireMinusExalt(): void {
    if (this._wireHpBoost !== null) {
      this.healthBonus = PlayerData.gearOnlyFromCombined(this._wireHpBoost, this.exaltedMaxHP);
    }
    if (this._wireMpBoost !== null) {
      this.manaBonus = PlayerData.gearOnlyFromCombined(this._wireMpBoost, this.exaltedMaxMP);
    }
    if (this._wireAttackBonus !== null) {
      this.attackBonus = PlayerData.gearOnlyFromCombined(this._wireAttackBonus, this.exaltedAttack);
    }
    if (this._wireDefenseBonus !== null) {
      this.defenseBonus = PlayerData.gearOnlyFromCombined(this._wireDefenseBonus, this.exaltedDefense);
    }
    if (this._wireSpeedBonus !== null) {
      this.speedBonus = PlayerData.gearOnlyFromCombined(this._wireSpeedBonus, this.exaltedSpeed);
    }
    if (this._wireVitalityBonus !== null) {
      this.vitalityBonus = PlayerData.gearOnlyFromCombined(this._wireVitalityBonus, this.exaltedVitality);
    }
    if (this._wireWisdomBonus !== null) {
      this.wisdomBonus = PlayerData.gearOnlyFromCombined(this._wireWisdomBonus, this.exaltedWisdom);
    }
    if (this._wireDexterityBonus !== null) {
      this.dexterityBonus = PlayerData.gearOnlyFromCombined(this._wireDexterityBonus, this.exaltedDexterity);
    }
  }

  /** Check if the player has a specific condition effect. */
  hasConditionEffect(effect: ConditionEffectName): boolean {
    const bit = ConditionEffect[effect];
    if (bit === undefined) return false;
    if (bit < 31) {
      return (this.effects[0] & (1 << bit)) !== 0;
    }
    return (this.effects[1] & (1 << (bit - 31))) !== 0;
  }

  /** Parse a single stat update. */
  parseStat(id: number, value: number | string, stackCount?: number): void {
    switch (id) {
      case StatType.MaxHP: this.maxHealth = value as number; break;
      case StatType.HP: this.health = value as number; break;
      case StatType.MaxMP: this.maxMana = value as number; break;
      case StatType.MP: this.mana = value as number; break;
      case StatType.Attack: this.attack = value as number; break;
      case StatType.Defense: this.defense = value as number; break;
      case StatType.Speed: this.speed = value as number; break;
      case StatType.Vitality: this.vitality = value as number; break;
      case StatType.Wisdom: this.wisdom = value as number; break;
      case StatType.Dexterity: this.dexterity = value as number; break;
      case StatType.Level: this.level = value as number; break;
      case StatType.Stars: this.stars = value as number; break;
      case StatType.NameStat: this.name = value as string; break;
      case StatType.AccountId: this.accountId = value as string; break;
      case StatType.CurrentFame: this.currentFame = value as number; break;
      case StatType.CharacterAliveFame: this.characterAliveFame = toStatInt(value); break;
      case StatType.PowerLevel: this.powerLevel = toStatInt(value); break;
      case StatType.Credits: this.credits = value as number; break;
      case StatType.Effects: this.effects[0] = value as number; break;
      case StatType.Effects2: this.effects[1] = value as number; break;
      case StatType.Texture1: this.tex1 = value as number; break;
      case StatType.Texture2: this.tex2 = value as number; break;
      case StatType.HpBoost: this._wireHpBoost = toStatInt(value); break; // 46 combined
      case StatType.MpBoost: this._wireMpBoost = toStatInt(value); break; // 47 combined
      case StatType.AttackBonus: this._wireAttackBonus = toStatInt(value); break; // 48 combined
      case StatType.DefenseBonus: this._wireDefenseBonus = toStatInt(value); break; // 49 combined
      case StatType.SpeedBonus: this._wireSpeedBonus = toStatInt(value); break; // 50 combined
      case StatType.VitalityBonus: this._wireVitalityBonus = toStatInt(value); break; // 51 combined
      case StatType.WisdomBonus: this._wireWisdomBonus = toStatInt(value); break; // 52 combined
      case StatType.DexterityBonus: this._wireDexterityBonus = toStatInt(value); break; // 53 combined
      /** Exaltation damage received multiplier /1000 (default 1000 in game); MultiTool Class27 Int32_47. */
      case StatType.ExaltationDamageMultiplier: this.exaltationDamageMultiplier = toStatInt(value); break;
      case StatType.Skin: this.skin = value as number; break;
      case StatType.GuildName: this.guildName = value as string; break;
      case StatType.GuildRank: this.guildRank = value as number; break;
      case StatType.HealthStackCount: this.healthStackCount = toStatInt(value); break;
      case StatType.MagicStackCount: this.magicStackCount = toStatInt(value); break;
      case StatType.HasBackpack:
        this.legacyHasBackpackStat75 = (value as number) !== 0;
        this.refreshBackpackPresenceFromStats();
        break;
      case StatType.BackpackTier:
        this.backpackTier = toStatInt(value);
        this.refreshBackpackPresenceFromStats();
        break;
      case StatType.QuickSlot0: this.quickSlots[0] = { itemType: toStatInt(value), quantity: Math.max(0, toStatInt(stackCount ?? 0)) }; break;
      case StatType.QuickSlot1: this.quickSlots[1] = { itemType: toStatInt(value), quantity: Math.max(0, toStatInt(stackCount ?? 0)) }; break;
      case StatType.QuickSlot2: {
        const qs2ItemType = toStatInt(value);
        this.quickSlots[2] = { itemType: qs2ItemType, quantity: Math.max(0, toStatInt(stackCount ?? 0)) };
        if (qs2ItemType > 0) this.hasThirdQuickSlot = true;
        break;
      }
      case StatType.WireExaltAttack: this.exaltedAttack = toStatInt(value); break; // 105 -> subtract from 48
      case StatType.WireExaltDefense: this.exaltedDefense = toStatInt(value); break; // 106 -> from 49
      case StatType.WireExaltSpeed: this.exaltedSpeed = toStatInt(value); break; // 107 -> from 50
      case StatType.WireExaltVitality: this.exaltedVitality = toStatInt(value); break; // 108 -> from 51
      case StatType.WireExaltDexterity: this.exaltedDexterity = toStatInt(value); break; // 109 -> from 53
      case StatType.WireExaltWisdom: this.exaltedWisdom = toStatInt(value); break; // 110 -> from 52
      case StatType.WireExaltMaxHP: this.exaltedMaxHP = toStatInt(value); break; // 111 -> from 46
      case StatType.WireExaltMaxMP: this.exaltedMaxMP = toStatInt(value); break; // 112 -> from 47
      default:
        // Inventory slots 8-19
        if (id >= 8 && id <= 19) {
          this.inventory[id - 8] = value as number;
        }
        // Live capture observed on this client: backpack slots 131-146
        if (id >= 131 && id <= 146) {
          this.backpack[id - 131] = value as number;
        }
        break;
    }
  }

  /** Parse stats from a Status data array. */
  parseStatus(statDataArray: any[]): void {
    for (const stat of statDataArray) {
      this.parseStat(stat.id, stat.value, stat.stackCount);
    }
    this.applyGearBonusesFromWireMinusExalt();
  }
}
