/**
 * Extracts game assets from the local RotMG installation at first startup.
 *
 * Reads RotMG Exalt_Data/resources.assets (Unity SerializedFile v22) and extracts:
 *   - All <Objects> / <GroundTypes> TextAssets → merged objects.xml + tiles.xml
 *   - spritesheetf TextAsset (FlatBuffer binary) → spritesheet.xml
 *   - Key Texture2D atlases (RGBA32) → images/*.png
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { Logger } from './Logger.js';

// Sharp is loaded lazily because it's a native module (~50 MB of
// platform-specific binaries) and only used by the first-run RotMG
// asset extractor below. Static-importing it here would force every
// plugin that touches anything in this file (via re-exports through
// rotmgAssetExtractor) to bundle sharp's native deps even though
// they never call extractLocalGameAssets. Dynamic + esbuild-external
// keeps the plugin bundle clean.
type SharpModule = typeof import('sharp');
let _sharp: SharpModule['default'] | null = null;
async function loadSharp(): Promise<SharpModule['default']> {
  if (_sharp) return _sharp;
  const mod = await import('sharp');
  _sharp = mod.default;
  return _sharp;
}

// Bump this when the parser logic changes so old on-disk spritesheet.xml gets regenerated.
const SPRITESHEET_PARSER_VERSION = 2;

// ─── Game directory discovery ─────────────────────────────────────────────────

export function findLocalGameDataDir(): string | null {
  const home = homedir();

  // Windows: %LOCALAPPDATA%\RealmOfTheMadGod\Production\RotMG Exalt_Data
  const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  const winDir = join(localAppData, 'RealmOfTheMadGod', 'Production', 'RotMG Exalt_Data');
  if (existsSync(join(winDir, 'resources.assets'))) return winDir;

  // macOS: ~/Library/Application Support/com.decagames.rotmgexalt/Data
  const macDir = join(home, 'Library', 'Application Support', 'com.decagames.rotmgexalt', 'Data');
  if (existsSync(join(macDir, 'resources.assets'))) return macDir;

  return null;
}

// ─── Texture names to extract ─────────────────────────────────────────────────

const ATLAS_NAMES = new Set([
  'mapObjects',
  'characters',
  'characters_masks',
  'groundTiles',
  'cursors_32x32',
  'mbox_closed',
  'mbox_open_1',
  'mbox_open_2',
  'mbox_open_full',
  'mbox_squish_horizontal',
  'mbox_squish_vertical',
  'chest_placeholder',
]);

// ─── Unity SerializedFile constants ──────────────────────────────────────────

const CLASS_TEXTASSET = 49;
const CLASS_TEXTURE2D = 28;
const TEXTURE_FORMAT_RGBA32 = 4;

// ─── Binary helpers ───────────────────────────────────────────────────────────

function alignUp4(n: number): number {
  return (n + 3) & ~3;
}

/** Read a length-prefixed UTF-8 string, aligned to 4 bytes. Returns new position. */
function readStr(buf: Buffer, pos: number): { s: string; pos: number } {
  const len = buf.readUInt32LE(pos);
  pos += 4;
  const s = buf.toString('utf8', pos, pos + len);
  pos += len;
  pos = alignUp4(pos);
  return { s, pos };
}

/** Read a length-prefixed byte array, aligned to 4 bytes. Returns new position. */
function readBytes(buf: Buffer, pos: number): { b: Buffer; pos: number } {
  const len = buf.readUInt32LE(pos);
  pos += 4;
  const b = Buffer.from(buf.subarray(pos, pos + len));
  pos += len;
  pos = alignUp4(pos);
  return { b, pos };
}

// ─── FlatBuffer spritesheet parser ───────────────────────────────────────────

/**
 * Parses the `spritesheetf` FlatBuffer binary and returns TadusPro-format
 * spritesheet.xml content.
 *
 * FlatBuffer structure (reverse-engineered from RotMG resources.assets):
 *   Root → Sprites: vector<SpriteSheet>, AnimatedSprites: vector<AnimatedSprite>
 *   SpriteSheet → Name: string, AtlasId: uint64, Sprites: vector<Sprite>
 *   AnimatedSprite → Name(0), Index(1), Set(2), Direction(3), Action(4), Sprite(5)
 *   Sprite → Position: struct{X,Y,H,W: float32} @0, Index: int32 @3, AtlasId: uint64 @7
 */
function parseSpriteSheetFlatBuffer(data: Buffer): string {
  const rootPos = data.readUInt32LE(0);

  function getFieldPos(tablePos: number, fieldIndex: number): number | null {
    const vtablePos = tablePos - data.readInt32LE(tablePos);
    const vtableSize = data.readUInt16LE(vtablePos);
    const byteIdx = 4 + fieldIndex * 2;
    if (byteIdx + 2 > vtableSize) return null;
    const offset = data.readUInt16LE(vtablePos + byteIdx);
    if (offset === 0) return null;
    return tablePos + offset;
  }

  function readFbString(fieldPos: number): string {
    const strPos = fieldPos + data.readInt32LE(fieldPos);
    const len = data.readUInt32LE(strPos);
    return data.toString('utf8', strPos + 4, strPos + 4 + len);
  }

  function readFbVector(fieldPos: number): { count: number; firstElemPos: number } {
    const vecPos = fieldPos + data.readInt32LE(fieldPos);
    return { count: data.readUInt32LE(vecPos), firstElemPos: vecPos + 4 };
  }

  function getVecTablePos(elemPos: number): number {
    return elemPos + data.readInt32LE(elemPos);
  }

  interface SpriteRec {
    index: number;
    x: number;
    y: number;
    w: number;
    h: number;
    atlasId: bigint;
  }

  /** Decode a Sprite sub-table (same layout in regular Sprites and AnimatedSprite.Sprite). */
  function decodeSprite(spritePos: number, fallbackAtlasId: bigint): SpriteRec {
    const posFieldPos = getFieldPos(spritePos, 0);
    const indexFieldPos = getFieldPos(spritePos, 3);
    const atlasFieldPos = getFieldPos(spritePos, 7);
    const x = posFieldPos ? Math.round(data.readFloatLE(posFieldPos + 0)) : 0;
    const y = posFieldPos ? Math.round(data.readFloatLE(posFieldPos + 4)) : 0;
    const h = posFieldPos ? Math.round(data.readFloatLE(posFieldPos + 8)) : 0;
    const w = posFieldPos ? Math.round(data.readFloatLE(posFieldPos + 12)) : 0;
    const index = indexFieldPos ? data.readInt32LE(indexFieldPos) : 0;
    const atlasId = atlasFieldPos ? data.readBigUInt64LE(atlasFieldPos) : fallbackAtlasId;
    return { index, x, y, w, h, atlasId };
  }

  // Unified insertion-ordered map: groupName → (Index → SpriteRec)
  // Regular Sprites populate first (insertion order preserved); AnimatedSprites merge
  // into existing groups when names match (e.g. Rookie_24x24), otherwise append.
  const allGroups = new Map<string, Map<number, SpriteRec>>();

  // ── Regular Sprites vector (root field[0]) ───────────────────────────────────
  const spritesFieldPos = getFieldPos(rootPos, 0);
  if (!spritesFieldPos) throw new Error('spritesheetf root has no Sprites field');
  const { count: groupCount, firstElemPos: groupsStart } = readFbVector(spritesFieldPos);

  for (let g = 0; g < groupCount; g++) {
    const groupPos = getVecTablePos(groupsStart + g * 4);
    const nameFieldPos = getFieldPos(groupPos, 0);
    const atlasIdFieldPos = getFieldPos(groupPos, 1);
    const groupSpritesFieldPos = getFieldPos(groupPos, 2);
    const groupName = nameFieldPos ? readFbString(nameFieldPos) : `group_${g}`;
    const groupAtlasId = atlasIdFieldPos ? data.readBigUInt64LE(atlasIdFieldPos) : 0n;

    let map = allGroups.get(groupName);
    if (!map) {
      map = new Map();
      allGroups.set(groupName, map);
    }
    if (groupSpritesFieldPos) {
      const { count: spriteCount, firstElemPos: spritesStart } = readFbVector(groupSpritesFieldPos);
      for (let s = 0; s < spriteCount; s++) {
        const r = decodeSprite(getVecTablePos(spritesStart + s * 4), groupAtlasId);
        map.set(r.index, r);
      }
    }
  }

  // ── AnimatedSprites vector (root field[1]) ───────────────────────────────────
  //
  // ~48000 entries; each (Name, frame Index) has multiple animation variants
  // (Set × Direction × Action). TadusPro keeps one sprite per (Name, Index) —
  // vector iteration order, last wins.
  const animFieldPos = getFieldPos(rootPos, 1);
  let animCount = 0;
  if (animFieldPos) {
    const { count: total, firstElemPos: animStart } = readFbVector(animFieldPos);
    animCount = total;
    for (let i = 0; i < total; i++) {
      const animPos = getVecTablePos(animStart + i * 4);
      const nameField = getFieldPos(animPos, 0);
      const spriteField = getFieldPos(animPos, 5);
      if (!nameField || !spriteField) continue;
      const name = readFbString(nameField);
      const indexField = getFieldPos(animPos, 1);
      const animIndex = indexField ? data.readInt32LE(indexField) : 0;
      const subSpritePos = spriteField + data.readInt32LE(spriteField);
      const rec = decodeSprite(subSpritePos, 0n);
      // Use the AnimatedSprite's own Index (field[1]); the Sprite sub-table's field[3]
      // is always absent (default 0) for animated frames.
      rec.index = animIndex;
      let map = allGroups.get(name);
      if (!map) {
        map = new Map();
        allGroups.set(name, map);
      }
      // Only fill gaps — Regular Sprites (field[0]) already have the correct
      // representative frame; AnimatedSprites supply entries only for groups that
      // have no regular sprite at this index.
      if (!map.has(rec.index)) {
        map.set(rec.index, rec);
      }
    }
  }

  // ── Emit XML ─────────────────────────────────────────────────────────────────
  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<DecompiledSpriteSheet>',
    '  <SpriteGroups>',
  ];
  for (const [groupName, indexMap] of allGroups) {
    lines.push(`    <SpriteGroup Name="${escapeXmlAttr(groupName)}">`);
    // String-wise sort to match TadusPro output ("0","1","10",…,"19","2","20",…)
    const sortedIndices = [...indexMap.keys()].sort((a, b) => String(a).localeCompare(String(b)));
    for (const idx of sortedIndices) {
      const r = indexMap.get(idx)!;
      lines.push(
        `      <Sprite Index="${r.index}" AtlasId="${r.atlasId}" X="${r.x}" Y="${r.y}" W="${r.w}" H="${r.h}"/>`,
      );
    }
    lines.push('    </SpriteGroup>');
  }
  lines.push('  </SpriteGroups>', '</DecompiledSpriteSheet>');

  Logger.log(
    'LocalExtractor',
    `Parsed spritesheetf: ${groupCount} base groups + ${animCount} anim entries → ${allGroups.size} merged groups`,
  );
  return lines.join('\n');
}

function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Main extraction ──────────────────────────────────────────────────────────

export interface LocalExtractResult {
  objectsXml: string | null;
  tilesXml: string | null;
  imagesDir: string | null;
}

/**
 * Read resources.assets from the local game installation, extract game XML,
 * spritesheet.xml (from FlatBuffer), and sprite-atlas images, write to outDir.
 */
export async function extractLocalGameAssets(
  gameDataDir: string,
  outDir: string,
): Promise<LocalExtractResult> {
  const assetsPath = join(gameDataDir, 'resources.assets');
  Logger.log('LocalExtractor', `Reading ${assetsPath} …`);
  const buf = readFileSync(assetsPath);

  // ── Parse header (Unity SerializedFile version 22) ─────────────────────────
  const version = buf.readUInt32BE(8);
  if (version !== 22) {
    throw new Error(`Unsupported Unity SerializedFile version: ${version} (expected 22)`);
  }
  const dataOffset = buf.readUInt32BE(36);

  // ── Parse metadata section ─────────────────────────────────────────────────
  let pos = 48;

  // Unity version string (null-terminated C-string)
  let vEnd = pos;
  while (buf[vEnd]) vEnd++;
  const unityVersion = buf.toString('utf8', pos, vEnd);
  Logger.log('LocalExtractor', `Unity version: ${unityVersion}`);
  pos = vEnd + 1;

  pos += 4; // targetPlatform (int32 LE)
  const enableTypeTree = buf[pos++];

  // ── Type table ─────────────────────────────────────────────────────────────
  const typeCount = buf.readInt32LE(pos);
  pos += 4;
  const types: number[] = [];
  for (let i = 0; i < typeCount; i++) {
    const classId = buf.readInt32LE(pos); pos += 4;
    pos++;    // isStripped (uint8)
    pos += 2; // scriptTypeIndex (int16)
    if (classId === 114) pos += 16; // scriptId for MonoBehaviour
    pos += 16; // oldTypeHash
    if (enableTypeTree) {
      const nodeCount = buf.readInt32LE(pos); pos += 4;
      const strBufSize = buf.readInt32LE(pos); pos += 4;
      pos += nodeCount * 32 + strBufSize;
    }
    types.push(classId);
  }

  // ── Object table ───────────────────────────────────────────────────────────
  const objectCount = buf.readInt32LE(pos);
  pos += 4;
  Logger.log('LocalExtractor', `Parsing ${objectCount} objects …`);

  const objectsXmlParts: Buffer[] = [];
  const tilesXmlParts: Buffer[] = [];
  let spritesheetfData: Buffer | null = null;
  const namedXmlFiles = new Map<string, Buffer>(); // name → data, for direct-write XMLs
  const atlasesToWrite: Array<{
    name: string;
    width: number;
    height: number;
    pixels: Buffer;
  }> = [];

  for (let i = 0; i < objectCount; i++) {
    if (pos % 4 !== 0) pos = alignUp4(pos);

    const _pathId = buf.readBigInt64LE(pos); pos += 8;
    const byteStart = Number(buf.readBigInt64LE(pos)); pos += 8;
    const _byteSize = buf.readUInt32LE(pos); pos += 4;
    const typeIndex = buf.readInt32LE(pos); pos += 4;
    const classId = types[typeIndex];
    const off = dataOffset + byteStart;

    // ── TextAsset (classId 49) ──────────────────────────────────────────────
    if (classId === CLASS_TEXTASSET) {
      const { s: name, pos: p1 } = readStr(buf, off);
      const { b: data } = readBytes(buf, p1);

      if (name === 'spritesheetf') {
        spritesheetfData = data;
      } else if (name === 'enchantments' || name === 'enchantmentLists' || name === 'enchanterSettings') {
        namedXmlFiles.set(`${name}.xml`, data);
      } else if (data.length > 10 && data.subarray(0, 5).toString('ascii') === '<?xml') {
        const snippet = data.toString('utf8', 0, 256);
        if (snippet.includes('<Objects>')) {
          objectsXmlParts.push(data);
        } else if (snippet.includes('<GroundTypes>')) {
          tilesXmlParts.push(data);
        }
      }
      continue;
    }

    // ── Texture2D (classId 28) ─────────────────────────────────────────────
    if (classId === CLASS_TEXTURE2D) {
      const { s: name, pos: absAfterName } = readStr(buf, off);
      if (!ATLAS_NAMES.has(name)) continue;

      const f = absAfterName;
      const width = buf.readInt32LE(f + 4);
      const height = buf.readInt32LE(f + 8);
      const format = buf.readInt32LE(f + 20);
      const dataLen = buf.readUInt32LE(f + 88);

      if (format !== TEXTURE_FORMAT_RGBA32 || dataLen === 0) {
        Logger.warn(
          'LocalExtractor',
          `${name}: format=${format} dataLen=${dataLen} — skipping (only RGBA32 inline supported)`,
        );
        continue;
      }

      const pixels = Buffer.from(buf.subarray(f + 92, f + 92 + dataLen));
      atlasesToWrite.push({ name, width, height, pixels });
      Logger.log('LocalExtractor', `Queued texture: ${name} (${width}×${height})`);
    }
  }

  // If we found nothing useful, throw so the orchestrator moves on to CDN
  // instead of silently stamping .local-build-hash and short-circuiting future runs.
  if (objectsXmlParts.length === 0 && tilesXmlParts.length === 0) {
    throw new Error('No <Objects> or <GroundTypes> TextAssets found in resources.assets');
  }

  // ── Write output files ────────────────────────────────────────────────────
  mkdirSync(outDir, { recursive: true });
  const imagesDir = join(outDir, 'images');
  mkdirSync(imagesDir, { recursive: true });

  // Merge and write objects.xml
  let objectsXmlPath: string | null = null;
  if (objectsXmlParts.length > 0) {
    const merged = mergeXmlParts(objectsXmlParts, 'Objects');
    const dest = join(outDir, 'objects.xml');
    writeFileSync(dest, merged);
    objectsXmlPath = dest;
    Logger.log(
      'LocalExtractor',
      `Wrote objects.xml (${objectsXmlParts.length} parts, ${(merged.length / 1024 / 1024).toFixed(1)} MB)`,
    );
  }

  // Merge and write tiles.xml
  let tilesXmlPath: string | null = null;
  if (tilesXmlParts.length > 0) {
    const merged = mergeXmlParts(tilesXmlParts, 'GroundTypes');
    const dest = join(outDir, 'tiles.xml');
    writeFileSync(dest, merged);
    tilesXmlPath = dest;
    Logger.log(
      'LocalExtractor',
      `Wrote tiles.xml (${tilesXmlParts.length} parts, ${(merged.length / 1024 / 1024).toFixed(1)} MB)`,
    );
  }

  // Write enchantments + enchantmentLists + enchanterSettings
  for (const [filename, data] of namedXmlFiles) {
    writeFileSync(join(outDir, filename), data);
    Logger.log('LocalExtractor', `Wrote ${filename} (${(data.length / 1024).toFixed(0)} KB)`);
  }

  // Parse spritesheetf FlatBuffer → spritesheet.xml
  if (spritesheetfData) {
    try {
      const spriteXml = parseSpriteSheetFlatBuffer(spritesheetfData);
      writeFileSync(join(outDir, 'spritesheet.xml'), spriteXml, 'utf8');
      Logger.log('LocalExtractor', 'Wrote spritesheet.xml');
    } catch (e) {
      Logger.warn('LocalExtractor', `spritesheet.xml generation failed: ${(e as Error).message}`);
    }
  } else {
    Logger.warn('LocalExtractor', 'spritesheetf TextAsset not found — spritesheet.xml not written');
  }

  // Write atlas PNGs (Unity stores pixels bottom-up → flip vertically)
  if (atlasesToWrite.length > 0) {
    const sharp = await loadSharp();
    for (const { name, width, height, pixels } of atlasesToWrite) {
      const dest = join(imagesDir, `${name}.png`);
      await sharp(pixels, { raw: { width, height, channels: 4 } })
        .flip()
        .png({ compressionLevel: 6 })
        .toFile(dest);
      Logger.log('LocalExtractor', `Wrote ${name}.png (${width}×${height})`);
    }
  }

  // Write the local build hash so we can skip re-extraction next run.
  // Format: "<mtime>:v<parserVersion>" — bump SPRITESHEET_PARSER_VERSION to force re-extract.
  try {
    const stamp = `${statSync(assetsPath).mtimeMs}:v${SPRITESHEET_PARSER_VERSION}`;
    writeFileSync(join(outDir, '.local-build-hash'), stamp);
  } catch {
    // non-fatal
  }

  return {
    objectsXml: objectsXmlPath,
    tilesXml: tilesXmlPath,
    imagesDir: atlasesToWrite.length > 0 ? imagesDir : null,
  };
}

/**
 * Returns true if resources.assets mtime matches the last extraction stamp.
 */
export function isLocalCacheFresh(gameDataDir: string, outDir: string): boolean {
  if (!existsSync(join(outDir, '.local-build-hash'))) return false;
  if (!existsSync(join(outDir, 'objects.xml'))) return false;
  if (!existsSync(join(outDir, 'tiles.xml'))) return false;
  if (!existsSync(join(outDir, 'spritesheet.xml'))) return false;
  if (!existsSync(join(outDir, 'enchantments.xml'))) return false;
  if (!existsSync(join(outDir, 'enchantmentLists.xml'))) return false;
  if (!existsSync(join(outDir, 'enchanterSettings.xml'))) return false;
  try {
    const stored = readFileSync(join(outDir, '.local-build-hash'), 'utf8').trim();
    const current = `${statSync(join(gameDataDir, 'resources.assets')).mtimeMs}:v${SPRITESHEET_PARSER_VERSION}`;
    return stored === current;
  } catch {
    return false;
  }
}

// ─── XML merge helper ─────────────────────────────────────────────────────────

function mergeXmlParts(parts: Buffer[], rootTag: string): Buffer {
  const inner = parts
    .map((p) => {
      const text = p.toString('utf8');
      const openClose = `<${rootTag}>`;
      const closeTag = `</${rootTag}>`;
      const start = text.indexOf(openClose);
      const end = text.lastIndexOf(closeTag);
      if (start === -1 || end === -1) return '';
      return text.substring(start + openClose.length, end).trim();
    })
    .filter(Boolean)
    .join('\n');
  const xml = `<?xml version="1.0" encoding="utf-8"?>\n<${rootTag}>\n${inner}\n</${rootTag}>`;
  return Buffer.from(xml, 'utf8');
}
