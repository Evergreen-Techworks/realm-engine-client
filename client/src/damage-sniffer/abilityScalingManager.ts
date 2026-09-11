/**
 * Port of Tomato {@code AbilityScalingManager} — parses equip.xml Activate scaling attributes.
 */

import { readFileSync, existsSync } from 'fs';
import { XMLParser } from 'fast-xml-parser';
import { Logger } from '../util/Logger.js';

export interface AbilityScalingData {
  weaponId: number;
  scalingStatId: number;
  scalingMin: number;
  damagePerStat: number;
  numShots: number;
}

function parseStatNameToId(statName: string): number | null {
  switch (statName.toUpperCase()) {
    case 'WIS':
    case 'WISDOM':
      return 27;
    case 'DEX':
    case 'DEXTERITY':
      return 28;
    case 'ATT':
    case 'ATTACK':
      return 20;
    case 'DEF':
    case 'DEFENSE':
      return 21;
    case 'SPD':
    case 'SPEED':
      return 22;
    case 'VIT':
    case 'VITALITY':
      return 26;
    case 'HP':
    case 'HEALTH':
    case 'LIFE':
      return 0;
    case 'MP':
    case 'MANA':
      return 3;
    default:
      return null;
  }
}

function calculateDamagePerStat(attrs: Record<string, string>): number {
  const statModDamage = attrs.statModDamage;
  const statModFlat = attrs.statModFlat;
  const statModPerc = attrs.statModPerc;
  if (statModDamage) {
    const v = parseFloat(statModDamage);
    return Number.isFinite(v) ? v : 0;
  }
  if (statModFlat && statModPerc) {
    const flat = parseFloat(statModFlat);
    const perc = parseFloat(statModPerc);
    if (Number.isFinite(flat) && Number.isFinite(perc)) {
      return flat + perc * 100;
    }
  }
  return 0;
}

function parseScalingData(activateAttrs: Record<string, string>, weaponId: number): AbilityScalingData | null {
  const scalingStatAttr = activateAttrs.scalingStat ?? '';
  if (!scalingStatAttr) return null;
  const scalingStatId = parseStatNameToId(scalingStatAttr);
  if (scalingStatId == null) return null;
  const damagePerStat = calculateDamagePerStat(activateAttrs);
  if (damagePerStat <= 0) return null;
  let scalingMin = 50;
  const sm = activateAttrs.statModScalingMin;
  if (sm) {
    const p = parseInt(sm, 10);
    if (Number.isFinite(p)) scalingMin = p;
  }
  let numShots = 1;
  const ns = activateAttrs.numShots;
  if (ns) {
    const p = parseInt(ns, 10);
    if (Number.isFinite(p)) numShots = p;
  }
  return { weaponId, scalingStatId, scalingMin, damagePerStat, numShots };
}

function isProjectileObjectId(id: string): boolean {
  return id.includes('Proj') || id.includes('Missile') || id.includes('Proc');
}

function parseWeaponIdHex(typeAttr: string): number {
  if (!typeAttr) return -1;
  try {
    return parseInt(typeAttr.replace(/^0x/i, ''), 16);
  } catch {
    return -1;
  }
}

function extractReferencedHexIds(raw: string): number[] {
  if (!raw) return [];
  const matches = raw.match(/0x[0-9a-fA-F]+/g);
  if (!matches) return [];
  const out: number[] = [];
  for (const match of matches) {
    const value = parseWeaponIdHex(match);
    if (value !== -1) out.push(value);
  }
  return out;
}

function collectProjectileRefs(nodes: unknown): number[] {
  if (nodes == null) return [];
  const list = Array.isArray(nodes) ? nodes : [nodes];
  const refs = new Set<number>();
  for (const act of list) {
    if (!act || typeof act !== 'object') continue;
    const typeAttr = String((act as { '@_type'?: string })['@_type'] ?? '').trim();
    const text = String((act as { '#text'?: string })['#text'] ?? '').trim();
    for (const value of extractReferencedHexIds(typeAttr || text)) {
      refs.add(value);
    }
  }
  return [...refs];
}

export class AbilityScalingManager {
  private readonly scalingData = new Map<number, AbilityScalingData>();
  private readonly projectileToWeaponMap = new Map<number, number>();

  loadEquipXml(xmlPath: string): void {
    this.scalingData.clear();
    this.projectileToWeaponMap.clear();
    if (!existsSync(xmlPath)) {
      Logger.log('AbilityScaling', `equip.xml not found at ${xmlPath} — ability scaling disabled`);
      return;
    }
    try {
      const xml = readFileSync(xmlPath, 'utf8');
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        isArray: (name) =>
          name === 'Object' ||
          name === 'Activate' ||
          name === 'OnConditionEndActivate' ||
          name === 'OnPlayerShootActivate',
      });
      const parsed = parser.parse(xml);
      this.loadFromParsedObjects(parsed.Objects?.Object ?? []);
    } catch (e) {
      Logger.warn('AbilityScaling', `Failed to parse equip.xml: ${(e as Error).message}`);
    }
  }

  /**
   * Build the scaling table from an already-parsed objects.xml tree.
   *
   * On the startup path this is fed from GameDataLoader.takeParsedObjects() so
   * the 32MB file is parsed once instead of twice (~2.7s saved, measured). The
   * caller's parser must force the Activate / OnConditionEndActivate /
   * OnPlayerShootActivate names to arrays, as loadEquipXml's own parser does.
   */
  loadFromParsedObjects(objects: unknown): void {
    this.scalingData.clear();
    this.projectileToWeaponMap.clear();
    try {
      const objectList = (Array.isArray(objects) ? objects : [objects]) as any[];
      const projectileIds = new Set<number>();
      const referencedProjectileIdsByWeapon = new Map<number, Set<number>>();

      for (const obj of objectList) {
        if (!obj || typeof obj !== 'object') continue;
        const typeStr = obj['@_type'] as string | undefined;
        if (!typeStr) continue;
        const weaponId = parseWeaponIdHex(typeStr);
        if (weaponId === -1) continue;

        const objectId = String(obj['@_id'] ?? '');
        if (objectId && isProjectileObjectId(objectId)) {
          projectileIds.add(weaponId);
        }

        const referencedProjectileIds = new Set<number>();
        for (const projectileId of collectProjectileRefs((obj as Record<string, unknown>).OnPlayerShootActivate)) {
          referencedProjectileIds.add(projectileId);
        }
        for (const projectileId of collectProjectileRefs((obj as Record<string, unknown>).Activate)) {
          referencedProjectileIds.add(projectileId);
        }
        if (referencedProjectileIds.size > 0) {
          referencedProjectileIdsByWeapon.set(weaponId, referencedProjectileIds);
        }

        const parseActivateTag = (tag: string): void => {
          const nodes = (obj as Record<string, unknown>)[tag];
          if (nodes == null) return;
          const list = Array.isArray(nodes) ? nodes : [nodes];
          for (const act of list) {
            if (!act || typeof act !== 'object') continue;
            const attrs: Record<string, string> = {};
            for (const [k, v] of Object.entries(act)) {
              if (k.startsWith('@_')) attrs[k.slice(2)] = String(v);
            }
            const data = parseScalingData(attrs, weaponId);
            if (data) {
              this.scalingData.set(weaponId, data);
              return;
            }
          }
        };
        parseActivateTag('Activate');
        if (!this.scalingData.has(weaponId)) parseActivateTag('OnConditionEndActivate');
      }

      for (const [weaponId, referencedProjectileIds] of referencedProjectileIdsByWeapon) {
        for (const projectileId of referencedProjectileIds) {
          if (!projectileIds.has(projectileId)) continue;
          if (!this.projectileToWeaponMap.has(projectileId)) {
            this.projectileToWeaponMap.set(projectileId, weaponId);
          }
        }
      }
      Logger.log(
        'AbilityScaling',
        `Loaded ${this.scalingData.size} scaling abilities from equip.xml (${this.projectileToWeaponMap.size} projectile links)`,
      );
    } catch (e) {
      Logger.warn('AbilityScaling', `Failed to build ability scaling table: ${(e as Error).message}`);
    }
  }

  getScalingData(weaponId: number): AbilityScalingData | undefined {
    const direct = this.scalingData.get(weaponId);
    if (direct) return direct;
    const parent = this.projectileToWeaponMap.get(weaponId);
    if (parent !== undefined) return this.scalingData.get(parent);
    return undefined;
  }

  hasScaling(weaponId: number): boolean {
    if (this.scalingData.has(weaponId)) return true;
    const parent = this.projectileToWeaponMap.get(weaponId);
    if (parent !== undefined && this.scalingData.has(parent)) return true;
    return false;
  }

  /**
   * Port of {@code AbilityScalingManager.calculateStatBonus(weaponId, statSnapshot, player)}.
   * {@code getEnchantStatDamageMultiplier} defaults to 1 when unknown (ParseEnchants not ported).
   */
  calculateStatBonus(
    weaponId: number,
    statSnapshot: number | null,
    getPlayerStat: (statId: number) => number | undefined,
    getAbilitySlot1ItemId: () => number | undefined,
    getEnchantStatDamageMultiplier: (abilityItemId: number) => number,
  ): number {
    const data = this.getScalingData(weaponId);
    if (!data || data.damagePerStat <= 0) return 0;

    let statValue: number | undefined =
      statSnapshot != null ? statSnapshot : getPlayerStat(data.scalingStatId);
    if (statValue == null || statValue <= data.scalingMin) return 0;

    const statBonus = statValue - data.scalingMin;
    let baseDamage = statBonus * data.damagePerStat;
    const abilityId = getAbilitySlot1ItemId();
    let statDamageMultiplier = 1;
    if (abilityId != null && abilityId === weaponId) {
      statDamageMultiplier = getEnchantStatDamageMultiplier(abilityId);
    }
    return Math.floor(baseDamage * statDamageMultiplier);
  }
}
