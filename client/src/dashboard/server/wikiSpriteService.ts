// WikiSpriteService — resolves & serves RotMG wiki sprite/texture PNGs from extracted
// game data (spritesheet.xml + atlas images). Extracted from DevServer; collaborates
// via injected deps (publicDir, getRotmgPath, getExtractorGameDataPath).
import http from 'http';
import sharp, { type Metadata } from 'sharp';
import { XMLParser } from 'fast-xml-parser';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { Logger } from '../../util/Logger.js';
import { getRealmengineDataDir } from '../../util/rotmgAssetExtractor.js';

const WIKI_EXTRACT_ATLAS_BASES = ['groundTiles', 'characters', 'characters_masks', 'mapObjects'] as const;

interface WikiSpriteFrame {
  atlasId: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface WikiSpriteSheetCache {
  gameDataDir: string;
  sheetMtime: number;
  byGroup: Map<string, Map<number, WikiSpriteFrame>>;
}

export class WikiSpriteService {
  private wikiSpriteSheetCache: WikiSpriteSheetCache | null = null;

  constructor(
    private readonly publicDir: string,
    private readonly getRotmgPath: () => string | null,
    private readonly getExtractorGameDataPath: () => string | undefined,
  ) {}

  /** Clear the cached spritesheet (called when game data is reloaded). */
  resetCache(): void {
    this.wikiSpriteSheetCache = null;
  }

  /** Case-insensitive `name.png` lookup under a Drawings-style directory (Windows-friendly). */
  private findCaseInsensitiveDrawingsPng(dir: string, baseName: string): string | null {
    const wanted = `${baseName}.png`.toLowerCase();
    if (!existsSync(dir)) return null;
    try {
      for (const f of readdirSync(dir)) {
        if (!f.toLowerCase().endsWith('.png')) continue;
        if (f.toLowerCase() === wanted) return join(dir, f);
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * BFS for `baseName.png` under `root` (bounded depth + max dirs) for nested extractor / Drawings layouts.
   */
  private findCaseInsensitivePngUnderTree(
    root: string,
    baseName: string,
    maxDepth: number,
    maxDirsVisited: number,
  ): string | null {
    const wanted = `${baseName}.png`.toLowerCase();
    if (!existsSync(root)) return null;
    let rootAbs: string;
    try {
      rootAbs = resolve(root);
    } catch {
      return null;
    }
    const queue: { dir: string; depth: number }[] = [{ dir: rootAbs, depth: 0 }];
    const seen = new Set<string>();
    let visited = 0;
    while (queue.length > 0 && visited < maxDirsVisited) {
      const next = queue.shift();
      if (!next) break;
      const { dir, depth } = next;
      const key = dir.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      visited++;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const full = join(dir, name);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isFile()) {
          if (!name.toLowerCase().endsWith('.png')) continue;
          if (name.toLowerCase() === wanted) return full;
        } else if (st.isDirectory() && depth < maxDepth) {
          const bn = name.toLowerCase();
          if (bn === 'node_modules' || bn === '.git') continue;
          queue.push({ dir: full, depth: depth + 1 });
        }
      }
    }
    return null;
  }

  /**
   * Resolve `file` from objects.xml &lt;Texture&gt;&lt;File&gt; to an on-disk PNG (Exalt / Steam layouts).
   */
  private resolveWikiTexturePngPath(fileBase: string): string | null {
    const safe = fileBase.replace(/[^a-zA-Z0-9_]/g, '');
    if (!safe) return null;
    const base = this.getRotmgPath();
    if (!base) return null;
    const roots: string[] = [];
    if (base.toLowerCase().endsWith('.exe')) {
      roots.push(dirname(base), base);
    } else {
      roots.push(base);
    }
    const drawingDirs: string[] = [];
    for (const root of roots) {
      drawingDirs.push(
        join(root, 'Drawings'),
        join(root, 'Resources', 'Drawings'),
        join(root, 'App', 'Drawings'),
        join(root, 'Production', 'Drawings'),
        join(root, 'assets', 'Drawings'),
        join(root, 'Assets', 'Drawings'),
        join(root, 'Resources', 'App', 'Drawings'),
        join(root, 'Resources', 'Embedded', 'Drawings'),
      );
    }
    const exGd = this.resolveExtractorGameDataDir();
    if (exGd) {
      for (const d of this.listWikiExtractorLoosePngFlatDirs(exGd)) {
        drawingDirs.push(d);
      }
    }
    const local = process.env.LOCALAPPDATA;
    if (local) {
      drawingDirs.push(
        join(local, 'RealmOfTheMadGod', 'Drawings'),
        join(local, 'RealmOfTheMadGod', 'Production', 'Drawings'),
        join(local, 'RotMG Exalt', 'Drawings'),
      );
    }
    for (const dir of drawingDirs) {
      if (!existsSync(dir)) continue;
      const hit = this.findCaseInsensitiveDrawingsPng(dir, safe);
      if (hit) return hit;
      const nested = this.findCaseInsensitivePngUnderTree(dir, safe, 3, 200);
      if (nested) return nested;
    }
    return null;
  }

  /**
   * Bundled copy under `data/rotmg-extractor-game/GameData/` (spritesheet.xml + images/), when present.
   * Populated locally from RotMGAssetExtractor output; see docs/game-wiki-extractor.md.
   */
  private resolveBundledExtractorGameDataDir(): string | null {
    const nested = join(this.publicDir, '..', '..', '..', 'data', 'rotmg-extractor-game', 'GameData');
    if (existsSync(join(nested, 'spritesheet.xml')) && existsSync(join(nested, 'images'))) return nested;
    // Auto-extracted data written by rotmgAssetExtractor at startup
    const realmDir = getRealmengineDataDir();
    if (existsSync(join(realmDir, 'spritesheet.xml')) && existsSync(join(realmDir, 'images'))) return realmDir;
    return null;
  }

  /**
   * Resolve RotMGAssetExtractor `GameData` directory (contains `spritesheet.xml` + `images/`).
   * Uses Settings path when set; otherwise falls back to the bundled repo copy.
   */
  private resolveExtractorGameDataDir(): string | null {
    const raw = (this.getExtractorGameDataPath() || '').trim();
    if (raw) {
      const abs = resolve(raw);
      const direct = join(abs, 'spritesheet.xml');
      if (existsSync(direct) && existsSync(join(abs, 'images'))) return abs;
      const nested = join(abs, 'GameData');
      if (existsSync(join(nested, 'spritesheet.xml')) && existsSync(join(nested, 'images'))) return nested;
    }
    return this.resolveBundledExtractorGameDataDir();
  }

  /** Atlas ids in spritesheet.xml map directly to our extracted atlas order after converting to zero-based. */
  private mapWikiAtlasRawToSheetIndex(rawAtlasId: number): number {
    const a = Math.trunc(rawAtlasId) - 1;
    if (a < 0 || a >= WIKI_EXTRACT_ATLAS_BASES.length) return -1;
    return a;
  }

  private parseWikiSpritesheetXml(xml: string): Map<string, Map<number, WikiSpriteFrame>> {
    const out = new Map<string, Map<number, WikiSpriteFrame>>();
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
    });
    let parsed: unknown;
    try {
      parsed = parser.parse(xml);
    } catch {
      return out;
    }
    const root = (parsed as { DecompiledSpriteSheet?: { SpriteGroups?: { SpriteGroup?: unknown } } })
      .DecompiledSpriteSheet;
    if (!root?.SpriteGroups) return out;
    let groups = root.SpriteGroups.SpriteGroup;
    if (groups == null) return out;
    if (!Array.isArray(groups)) groups = [groups];
    for (const g of groups as Record<string, unknown>[]) {
      const name = String(g['@_Name'] ?? '').trim();
      if (!name) continue;
      let sprites = g.Sprite;
      const inner = new Map<number, WikiSpriteFrame>();
      if (sprites != null) {
        if (!Array.isArray(sprites)) sprites = [sprites];
        for (const s of sprites as Record<string, unknown>[]) {
          const idx = Number(s['@_Index']);
          const atlasId = Number(s['@_AtlasId']);
          const x = Number(s['@_X']);
          const y = Number(s['@_Y']);
          const w = Number(s['@_W']);
          const h = Number(s['@_H']);
          if (!Number.isFinite(idx) || !Number.isFinite(atlasId)) continue;
          inner.set(idx, {
            atlasId,
            x: Number.isFinite(x) ? x : 0,
            y: Number.isFinite(y) ? y : 0,
            w: Number.isFinite(w) ? w : 0,
            h: Number.isFinite(h) ? h : 0,
          });
        }
      }
      out.set(name.toLowerCase(), inner);
    }
    return out;
  }

  private ensureLoadedWikiSpriteCache(gameDataDir: string): void {
    const sheetPath = join(gameDataDir, 'spritesheet.xml');
    if (!existsSync(sheetPath)) return;
    let mtime = 0;
    try {
      mtime = statSync(sheetPath).mtimeMs;
    } catch {
      return;
    }
    if (
      this.wikiSpriteSheetCache &&
      this.wikiSpriteSheetCache.gameDataDir === gameDataDir &&
      this.wikiSpriteSheetCache.sheetMtime === mtime
    ) {
      return;
    }
    const xml = readFileSync(sheetPath, 'utf8');
    const byGroup = this.parseWikiSpritesheetXml(xml);
    this.wikiSpriteSheetCache = { gameDataDir, sheetMtime: mtime, byGroup };
    Logger.log('DevServer', `Game Wiki: loaded extractor spritesheet (${byGroup.size} groups)`);
  }

  private lookupWikiSpriteFrame(fileBase: string, index: number): WikiSpriteFrame | null {
    if (!this.wikiSpriteSheetCache) return null;
    const g = this.wikiSpriteSheetCache.byGroup.get(fileBase.toLowerCase());
    if (!g) return null;
    return g.get(index) ?? null;
  }

  private async tryServeExtractorWikiSprite(
    gameDataDir: string,
    safe: string,
    index: number,
    res: http.ServerResponse,
  ): Promise<boolean> {
    this.ensureLoadedWikiSpriteCache(gameDataDir);
    const frame = this.lookupWikiSpriteFrame(safe, index);
    if (!frame || frame.w <= 0 || frame.h <= 0) return false;

    const sheetIdx = this.mapWikiAtlasRawToSheetIndex(frame.atlasId);
    if (sheetIdx < 0) return false;

    const imagesDir = join(gameDataDir, 'images');
    const atlasBase = WIKI_EXTRACT_ATLAS_BASES[sheetIdx];
    const atlasPath = this.findCaseInsensitiveDrawingsPng(imagesDir, atlasBase);
    if (!atlasPath) return false;

    let meta: Metadata;
    try {
      meta = await sharp(atlasPath).metadata();
    } catch {
      return false;
    }
    const iw = meta.width ?? 0;
    const ih = meta.height ?? 0;
    if (
      frame.x < 0 ||
      frame.y < 0 ||
      frame.x + frame.w > iw ||
      frame.y + frame.h > ih
    ) {
      return false;
    }

    try {
      const buf = await sharp(atlasPath)
        .extract({ left: frame.x, top: frame.y, width: frame.w, height: frame.h })
        .png()
        .toBuffer();
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
        'X-Wiki-Sprite-Cropped': '1',
      });
      res.end(buf);
      return true;
    } catch (err) {
      Logger.warn('DevServer', `Game Wiki extractor crop failed: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Flat dirs that may hold per-sheet PNGs: RotMGAssetExtractor `GameData/images/`, and
   * [exalt-extractor](https://github.com/rotmg-network/exalt-extractor) `output/spritesheets/`.
   */
  private listWikiExtractorLoosePngFlatDirs(gameDataDir: string): string[] {
    const parent = dirname(gameDataDir);
    return [
      join(gameDataDir, 'images'),
      join(gameDataDir, 'spritesheets'),
      join(gameDataDir, 'Spritesheets'),
      join(parent, 'spritesheets'),
      join(parent, 'Spritesheets'),
      join(parent, 'images'),
    ];
  }

  private findExtractorLoosePngFlat(gameDataDir: string, safe: string): string | null {
    for (const d of this.listWikiExtractorLoosePngFlatDirs(gameDataDir)) {
      const h = this.findCaseInsensitiveDrawingsPng(d, safe);
      if (h) return h;
    }
    return null;
  }

  private findExtractorLoosePng(gameDataDir: string, safe: string): string | null {
    const flatHit = this.findExtractorLoosePngFlat(gameDataDir, safe);
    if (flatHit) return flatHit;
    const parent = dirname(gameDataDir);
    return (
      this.findCaseInsensitivePngUnderTree(gameDataDir, safe, 6, 600) ??
      this.findCaseInsensitivePngUnderTree(parent, safe, 6, 1000)
    );
  }

  /**
   * When extractor `images/` contains a standalone sheet (e.g. `beacons32x32.png`) but spritesheet
   * crop failed (missing group, lite atlas, etc.), serve that PNG so the wiki can still grid-slice by index.
   */
  private tryServeWikiExtractorImagesLooseSheet(
    gameDataDir: string,
    safe: string,
    res: http.ServerResponse,
  ): boolean {
    const hit = this.findExtractorLoosePng(gameDataDir, safe);
    if (!hit) return false;
    try {
      const buf = readFileSync(hit);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(buf);
      return true;
    } catch {
      return false;
    }
  }

  private serveDrawingsWikiTextureFullSheet(
    safe: string,
    res: http.ServerResponse,
  ): boolean {
    const resolved = this.resolveWikiTexturePngPath(safe);
    if (!resolved) {
      Logger.warn(
        'DevServer',
        `Game Wiki texture not found for "${safe}" (set RotMG path and/or extractor GameData in Settings)`,
      );
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not_found');
      return true;
    }
    try {
      const buf = readFileSync(resolved);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(buf);
      return true;
    } catch (err) {
      Logger.warn('DevServer', `Game Wiki texture read failed: ${(err as Error).message}`);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('read_error');
      return true;
    }
  }

  /**
   * Serve a RotMG drawings sheet PNG (e.g. lofiObj3) from extractor dump (cropped by index) or Exalt Drawings.
   */
  tryServeWikiTextureFile(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (req.method !== 'GET' || !req.url?.startsWith('/api/wiki-texture-file')) return false;
    const qIdx = req.url.indexOf('?');
    const q = qIdx >= 0 ? req.url.slice(qIdx + 1) : '';
    const params = new URLSearchParams(q);
    const rawFile = (params.get('file') || '').trim();
    const safe = rawFile.replace(/[^a-zA-Z0-9_]/g, '');
    if (!safe || safe.length > 80) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('bad_file');
      return true;
    }

    const rawIndex = params.get('index');
    let index: number | null = null;
    if (rawIndex != null && rawIndex !== '') {
      const hex = /^0x/i.test(String(rawIndex).trim());
      const n = parseInt(String(rawIndex).trim().replace(/^0x/i, ''), hex ? 16 : 10);
      index = Number.isFinite(n) ? n : null;
    }

    const gameDataDir = this.resolveExtractorGameDataDir();

    void (async () => {
      try {
        if (gameDataDir && index !== null) {
          const ok = await this.tryServeExtractorWikiSprite(gameDataDir, safe, index, res);
          if (ok) return;
        }
        if (gameDataDir && !res.headersSent && this.tryServeWikiExtractorImagesLooseSheet(gameDataDir, safe, res)) {
          return;
        }
        if (!this.getRotmgPath()) {
          if (!res.headersSent) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('not_found');
          }
          return;
        }
        if (!res.headersSent) {
          this.serveDrawingsWikiTextureFullSheet(safe, res);
        }
      } catch (err) {
        Logger.warn('DevServer', `Game Wiki texture handler: ${(err as Error).message}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('error');
        }
      }
    })();

    return true;
  }
}
