import type { ObjectDef } from './GameDataLoader.js';

export type CosmeticKind =
  | 'skin'
  | 'dye'
  | 'pet'
  | 'gravestone'
  | 'title'
  | 'entrance';

export interface CosmeticTexture {
  file: string;
  index: number;
}

interface CosmeticBaseMetadata {
  texture?: CosmeticTexture;
  animatedTexture?: CosmeticTexture;
}

export interface SkinCosmeticMetadata extends CosmeticBaseMetadata {
  kind: 'skin';
  playerClassType: number;
}

export interface DyeCosmeticMetadata extends CosmeticBaseMetadata {
  kind: 'dye';
  tex1?: number;
  tex2?: number;
}

export interface TitleCosmeticMetadata extends CosmeticBaseMetadata {
  kind: 'title';
  /** Which argument of the native nameplate call carries this id. */
  titleSlot: 0 | 1 | 2;
}

export interface GravestoneCosmeticMetadata extends CosmeticBaseMetadata {
  kind: 'gravestone';
  /** Set this stone belongs to; absent on the untimed legacy stones. */
  themeName?: string;
  /** Character-level bracket within the set. */
  itemTier?: number;
}

export type CosmeticMetadata =
  | SkinCosmeticMetadata
  | DyeCosmeticMetadata
  | TitleCosmeticMetadata
  | GravestoneCosmeticMetadata
  | (CosmeticBaseMetadata & {
      kind: Exclude<CosmeticKind, 'skin' | 'dye' | 'title' | 'gravestone'>;
    });

export interface CosmeticCatalogValues {
  objectType: number;
  playerClassType?: number;
  tex1?: number;
  tex2?: number;
  titleSlot?: 0 | 1 | 2;
  /** Gravestone sets only: `ItemTier` → object type for every stone in the set. */
  tierObjectTypes?: Record<number, number>;
}

export interface CosmeticCatalogEntry {
  /** Stable across labels and XML ordering. */
  id: string;
  label: string;
  kind: CosmeticKind;
  /** Player class object type for skins. */
  classType?: number;
  /** Protocol-ready values represented by this catalog choice. */
  values: CosmeticCatalogValues;
  iconUrl?: string;
  /** `#rrggbb` preview for solid dyes, which have no sprite of their own. */
  swatchColor?: string;
}

function iconUrl(texture: CosmeticTexture | undefined): string | undefined {
  if (!texture) return undefined;
  return `/api/wiki-texture-file?file=${encodeURIComponent(texture.file)}&index=${texture.index}`;
}

/**
 * Dye Tex1/Tex2 wire values pack an encoding tag in the high byte: `0x01` carries a
 * solid RGB colour in the low 24 bits, `0x04/0x05/0x09/0x0A` index the matching
 * textile sheet, and `0xFF` marks the dye removers. The dye's own `<Texture>` is just
 * the shared vial/bolt item sprite, so it says nothing about the resulting colour.
 */
const DYE_SOLID_TAG = 0x01;
const DYE_REMOVER = 0xffffffff;
const DYE_TEXTILE_SHEETS: Record<number, string> = {
  0x04: 'textile4x4',
  0x05: 'textile5x5',
  0x09: 'textile9x9',
  0x0a: 'textile10x10',
};

function dyeAppearance(value: number): Pick<CosmeticCatalogEntry, 'iconUrl' | 'swatchColor'> {
  const tag = (value >>> 24) & 0xff;
  const payload = value & 0xffffff;
  if (tag === DYE_SOLID_TAG) {
    return { swatchColor: `#${payload.toString(16).padStart(6, '0')}` };
  }
  const sheet = DYE_TEXTILE_SHEETS[tag];
  return sheet ? { iconUrl: iconUrl({ file: sheet, index: payload }) } : {};
}

/** objects.xml ships untranslated keys such as `{dyes.Alice_Blue_Clothing_Dye}`. */
function displayLabel(raw: string): string {
  const key = /^\{[A-Za-z0-9_]+\.([^}]+)\}$/.exec(raw);
  return key ? key[1].replace(/_/g, ' ') : raw;
}

interface GravestoneTheme {
  label: string;
  tierObjectTypes: Record<number, number>;
  topTier: number;
  iconUrl?: string;
}

export function buildCosmeticCatalog(objects: Iterable<ObjectDef>): CosmeticCatalogEntry[] {
  const entries: CosmeticCatalogEntry[] = [];
  const graveThemes = new Map<string, GravestoneTheme>();

  for (const object of objects) {
    const cosmetic = object.cosmetic;
    if (!cosmetic) continue;

    // A themed gravestone set is one choice, not eleven. Collapse the tiers into
    // a single entry that remembers every variant, so the override can keep
    // whichever level bracket the server assigned.
    if (cosmetic.kind === 'gravestone' && cosmetic.themeName) {
      const tier = cosmetic.itemTier ?? 0;
      const theme = graveThemes.get(cosmetic.themeName) ?? {
        label: cosmetic.themeName,
        tierObjectTypes: {},
        topTier: -1,
      };
      theme.tierObjectTypes[tier] = object.type;
      if (tier > theme.topTier) {
        theme.topTier = tier;
        theme.iconUrl = iconUrl(cosmetic.animatedTexture ?? cosmetic.texture);
      }
      graveThemes.set(cosmetic.themeName, theme);
      continue;
    }

    const values: CosmeticCatalogValues = { objectType: object.type };
    let classType: number | undefined;
    let appearance: Pick<CosmeticCatalogEntry, 'iconUrl' | 'swatchColor'> = {
      iconUrl: iconUrl(cosmetic.animatedTexture ?? cosmetic.texture),
    };
    if (cosmetic.kind === 'skin') {
      classType = cosmetic.playerClassType;
      values.playerClassType = cosmetic.playerClassType;
    } else if (cosmetic.kind === 'dye') {
      const tex = cosmetic.tex1 ?? cosmetic.tex2;
      if (tex === undefined || tex >>> 0 === DYE_REMOVER) continue;
      if (cosmetic.tex1 !== undefined) values.tex1 = cosmetic.tex1;
      if (cosmetic.tex2 !== undefined) values.tex2 = cosmetic.tex2;
      appearance = dyeAppearance(tex);
    } else if (cosmetic.kind === 'title') {
      values.titleSlot = cosmetic.titleSlot;
    }

    entries.push({
      id: `${cosmetic.kind}:${object.type.toString(16).padStart(4, '0')}`,
      label: displayLabel(object.displayId || object.id || `0x${object.type.toString(16)}`),
      kind: cosmetic.kind,
      ...(classType === undefined ? {} : { classType }),
      values,
      ...(appearance.iconUrl ? { iconUrl: appearance.iconUrl } : {}),
      ...(appearance.swatchColor ? { swatchColor: appearance.swatchColor } : {}),
    });
  }

  for (const theme of graveThemes.values()) {
    entries.push({
      id: `gravestone:theme:${theme.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      label: theme.label,
      kind: 'gravestone',
      values: {
        objectType: theme.tierObjectTypes[theme.topTier],
        tierObjectTypes: theme.tierObjectTypes,
      },
      ...(theme.iconUrl ? { iconUrl: theme.iconUrl } : {}),
    });
  }

  return entries.sort((a, b) =>
    a.kind.localeCompare(b.kind)
    || a.label.localeCompare(b.label)
    || a.values.objectType - b.values.objectType,
  );
}
