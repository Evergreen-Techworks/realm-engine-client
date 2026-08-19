import https from 'https';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join, extname } from 'path';
import { XMLParser } from 'fast-xml-parser';
import { Logger } from '../../util/Logger.js';
import { DebugManager } from '../../util/DebugManager.js';
import { getClientToken, clearCachedHwid } from '../../util/Hwid.js';
import {
  formatObjectTypeHex,
  parseCharListNumber,
  parseCharListBoolean,
  parseDashboardEquipmentTokens,
  buildDashboardUniqueItemLookup,
  decodeDashboardEnchantIds,
  parseCharListError,
  parseVerifySuccess,
  parseVerifyError,
  type DashboardAccountEquipmentToken,
} from './charListParsers.js';

// ── Debug logging (same channel as DevServer) ────────────────────────────────
const DEBUG_LOG_PATH = join(process.env.USERPROFILE || '', 'Documents', 'Realmengine', 'debug.log');
function debugLog(msg: string): void {
  if (!DebugManager.enabled('accounts')) return;
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { writeFileSync(DEBUG_LOG_PATH, line, { flag: 'a' }); } catch { /* ignore */ }
}

/**
 * True when a Deca account/verify `<Error>` says the token/secret is bound to a
 * different machine (HWID) — the one rejection a fresh-HWID retry can fix.
 */
function isHwidBindingError(rawError: string): boolean {
  const lower = String(rawError || '').toLowerCase();
  if (!lower) return false;
  return lower.includes('different machine') || lower.includes('token for different');
}

// ── Exported interfaces ──────────────────────────────────────────────────────

export interface DashboardAccountRecord {
  id: string;
  label: string;
  /** For Steam accounts this is the "guid" string Deca expects (often `steamworks:<id>`). */
  email: string;
  /** For Steam accounts this stores the Deca-issued Steam secret, not a Windows/email password. */
  password: string;
  serverName: string;
  notes: string;
  preferredScriptId: string;
  createdAt: number;
  updatedAt: number;
  mulingRole: 'none' | 'main' | 'mule';
  mulingStoreMode: 'any' | 'specific';
  mulingItemsToStore: string;
  mulingItemsFromMain: string;
  mulingItemsToMuleOff: string;
  proxy: string;
  proxyUsername: string;
  proxyPassword: string;
  /** Marks this as a Steam-linked account; changes the /account/verify request shape. */
  isSteam: boolean;
  /** Steam ID 64 (decimal string). Required when isSteam=true. */
  steamId: string;
}

export interface DashboardAccountOverviewItem {
  objectType: number;
  objectTypeHex: string;
  name: string;
  uniqueId: string | null;
  enchantIds: number[];
}

export interface DashboardAccountOverviewCharacter {
  charId: number;
  classType: number;
  classTypeHex: string;
  className: string;
  level: number;
  exp: number;
  fame: number;
  seasonal: boolean;
  dead: boolean;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  attack: number;
  defense: number;
  speed: number;
  dexterity: number;
  vitality: number;
  wisdom: number;
  equipment: DashboardAccountOverviewItem[];
  inventory: DashboardAccountOverviewItem[];
  backpacks: DashboardAccountOverviewItem[];
}

export interface DashboardAccountOverviewStorageSection {
  items: DashboardAccountOverviewItem[];
  totalCount: number;
  uniqueCount: number;
}

export interface DashboardAccountOverview {
  accountName: string;
  totalFame: number;
  aliveFame: number;
  bestCharFame: number;
  maxNumChars: number;
  characters: DashboardAccountOverviewCharacter[];
  vault: DashboardAccountOverviewStorageSection;
  gifts: DashboardAccountOverviewStorageSection;
  temporaryGifts: DashboardAccountOverviewStorageSection;
  materialStorage: DashboardAccountOverviewStorageSection;
  potions: DashboardAccountOverviewStorageSection;
}

export interface DashboardAccountOverviewCacheRecord {
  accountId: string;
  email: string;
  updatedAt: number;
  overview: DashboardAccountOverview;
}

/**
 * Account CRUD, overview caching, and Deca account verification.
 * Extracted from DevServer — does NOT know about WebSocket or HTTP.
 */
export class AccountService {
  constructor(
    private readonly accountsFilePath: string,
    private readonly cacheDir: string,
    private readonly getObjectDisplayName: (objectType: number) => string,
  ) {}

  // ── Helpers ───────────────────────────────────────────────────────────────

  private ensureDir(path: string): void {
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
  }

  private getDashboardAccountOverviewCacheFile(accountId: string): string {
    return join(this.cacheDir, `${String(accountId || '').trim()}.json`);
  }

  // ── Account CRUD ──────────────────────────────────────────────────────────

  generateDashboardAccountId(): string {
    return `acct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  normalizeDashboardAccountRecord(raw: any, index = 0): DashboardAccountRecord {
    const now = Date.now();
    const id = String(raw?.id || '').trim() || `${this.generateDashboardAccountId()}-${index}`;
    const createdAt = Number(raw?.createdAt || 0) > 0 ? Number(raw.createdAt) : now;
    const updatedAt = Number(raw?.updatedAt || 0) > 0 ? Number(raw.updatedAt) : now;
    const mulingRoles = ['none', 'main', 'mule'] as const;
    return {
      id,
      label: String(raw?.label || '').trim(),
      email: String(raw?.email || '').trim(),
      password: String(raw?.password || ''),
      serverName: String(raw?.serverName || 'USWest').trim() || 'USWest',
      notes: String(raw?.notes || ''),
      preferredScriptId: String(raw?.preferredScriptId || '').trim(),
      createdAt,
      updatedAt,
      mulingRole: mulingRoles.includes(raw?.mulingRole as typeof mulingRoles[number]) ? (raw.mulingRole as typeof mulingRoles[number]) : 'none',
      mulingStoreMode: raw?.mulingStoreMode === 'specific' ? 'specific' as const : 'any' as const,
      mulingItemsToStore: String(raw?.mulingItemsToStore || ''),
      mulingItemsFromMain: String(raw?.mulingItemsFromMain || ''),
      mulingItemsToMuleOff: String(raw?.mulingItemsToMuleOff || ''),
      proxy: String(raw?.proxy || ''),
      proxyUsername: String(raw?.proxyUsername || ''),
      proxyPassword: String(raw?.proxyPassword || ''),
      isSteam: !!raw?.isSteam,
      steamId: String(raw?.steamId || '').trim(),
    };
  }

  readDashboardAccounts(): DashboardAccountRecord[] {
    try {
      const dir = join(this.accountsFilePath, '..');
      this.ensureDir(dir);
      debugLog(`readDashboardAccounts: file="${this.accountsFilePath}" exists=${existsSync(this.accountsFilePath)}`);
      if (!existsSync(this.accountsFilePath)) {
        debugLog(`readDashboardAccounts: file not found, returning []`);
        return [];
      }
      const raw = readFileSync(this.accountsFilePath, 'utf8');
      debugLog(`readDashboardAccounts: raw content (first 200 chars): ${raw.slice(0, 200)}`);
      const parsed = JSON.parse(raw) as { accounts?: unknown[] };
      const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts : [];
      debugLog(`readDashboardAccounts: parsed ${accounts.length} account(s)`);
      return accounts.map((account, index) => this.normalizeDashboardAccountRecord(account, index));
    } catch (err) {
      debugLog(`readDashboardAccounts: ERROR: ${(err as Error).message}`);
      Logger.warn('AccountService', `accounts read failed: ${(err as Error).message}`);
      return [];
    }
  }

  writeDashboardAccounts(accounts: DashboardAccountRecord[]): void {
    this.ensureDir(join(this.accountsFilePath, '..'));
    writeFileSync(this.accountsFilePath, JSON.stringify({ accounts }, null, 2), 'utf8');
  }

  // ── Overview cache ────────────────────────────────────────────────────────

  readDashboardAccountOverviewCache(accountId: string): DashboardAccountOverviewCacheRecord | null {
    try {
      const id = String(accountId || '').trim();
      if (!id) return null;
      this.ensureDir(this.cacheDir);
      const filePath = this.getDashboardAccountOverviewCacheFile(id);
      if (!existsSync(filePath)) return null;
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<DashboardAccountOverviewCacheRecord>;
      if (!parsed || typeof parsed !== 'object' || !parsed.overview || typeof parsed.overview !== 'object') return null;
      if (!this.isDashboardOverviewCacheComplete(parsed.overview as DashboardAccountOverview)) return null;
      return {
        accountId: id,
        email: String(parsed.email || '').trim(),
        updatedAt: Number(parsed.updatedAt || 0) > 0 ? Number(parsed.updatedAt) : Date.now(),
        overview: parsed.overview as DashboardAccountOverview,
      };
    } catch (err) {
      Logger.warn('AccountService', `accounts overview cache read failed for ${accountId}: ${(err as Error).message}`);
      return null;
    }
  }

  private isDashboardOverviewCacheComplete(overview: DashboardAccountOverview): boolean {
    const characters = Array.isArray(overview?.characters) ? overview.characters : [];
    const storageSections = ['vault', 'gifts', 'temporaryGifts', 'materialStorage', 'potions'];
    return characters.every((character) => {
      const equipment = Array.isArray(character?.equipment) ? character.equipment : [];
      const inventory = Array.isArray(character?.inventory) ? character.inventory : [];
      const backpacks = Array.isArray(character?.backpacks) ? character.backpacks : [];
      return [equipment, inventory, backpacks].every((items) => items.every((item) => !!item && Array.isArray(item.enchantIds) && Object.prototype.hasOwnProperty.call(item, 'uniqueId')));
    }) && storageSections.every((key) => {
      const section = ((overview as unknown) as Record<string, unknown>)[key] as DashboardAccountOverviewStorageSection | undefined;
      return !!section && Array.isArray(section.items);
    });
  }

  readAllDashboardAccountOverviewCaches(): Record<string, DashboardAccountOverviewCacheRecord> {
    const result: Record<string, DashboardAccountOverviewCacheRecord> = {};
    try {
      this.ensureDir(this.cacheDir);
      const files = readdirSync(this.cacheDir).filter((file) => extname(file).toLowerCase() === '.json');
      for (const file of files) {
        const accountId = file.slice(0, -5);
        const cached = this.readDashboardAccountOverviewCache(accountId);
        if (cached) result[accountId] = cached;
      }
    } catch (err) {
      Logger.warn('AccountService', `accounts overview cache list failed: ${(err as Error).message}`);
    }
    return result;
  }

  writeDashboardAccountOverviewCache(accountId: string, email: string, overview: DashboardAccountOverview): DashboardAccountOverviewCacheRecord {
    const record: DashboardAccountOverviewCacheRecord = {
      accountId: String(accountId || '').trim(),
      email: String(email || '').trim(),
      updatedAt: Date.now(),
      overview,
    };
    this.ensureDir(this.cacheDir);
    writeFileSync(this.getDashboardAccountOverviewCacheFile(record.accountId), JSON.stringify(record, null, 2), 'utf8');
    return record;
  }

  deleteDashboardAccountOverviewCache(accountId: string): void {
    try {
      const id = String(accountId || '').trim();
      if (!id) return;
      const filePath = this.getDashboardAccountOverviewCacheFile(id);
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch (err) {
      Logger.warn('AccountService', `accounts overview cache delete failed for ${accountId}: ${(err as Error).message}`);
    }
  }

  pruneDashboardAccountOverviewCaches(accounts: DashboardAccountRecord[]): void {
    try {
      const validIds = new Set(accounts.map((account) => String(account.id || '').trim()).filter(Boolean));
      this.ensureDir(this.cacheDir);
      const files = readdirSync(this.cacheDir).filter((file) => extname(file).toLowerCase() === '.json');
      for (const file of files) {
        const accountId = file.slice(0, -5);
        if (!validIds.has(accountId)) this.deleteDashboardAccountOverviewCache(accountId);
      }
    } catch (err) {
      Logger.warn('AccountService', `accounts overview cache prune failed: ${(err as Error).message}`);
    }
  }

  // ── Overview building ─────────────────────────────────────────────────────

  private buildDashboardOverviewItem(
    token: DashboardAccountEquipmentToken,
    uniqueLookup?: Map<string, string[]>,
  ): DashboardAccountOverviewItem {
    const objectType = Number.isFinite(token.objectType) ? Math.trunc(token.objectType) : -1;
    let enchantIds: number[] = [];
    if (objectType >= 0 && uniqueLookup instanceof Map) {
      const exactKey = `${objectType}#${String(token.uniqueId || '').trim()}`;
      const fallbackKey = `${objectType}#`;
      const exactBucket = uniqueLookup.get(exactKey);
      const fallbackBucket = uniqueLookup.get(fallbackKey);
      const encoded = exactBucket?.length
        ? String(exactBucket.shift() || '').trim()
        : (fallbackBucket?.length ? String(fallbackBucket.shift() || '').trim() : '');
      enchantIds = decodeDashboardEnchantIds(encoded);
    }
    return {
      objectType,
      objectTypeHex: formatObjectTypeHex(objectType),
      name: this.getObjectDisplayName(objectType),
      uniqueId: token.uniqueId,
      enchantIds,
    };
  }

  buildDashboardOverviewItems(
    tokens: DashboardAccountEquipmentToken[],
    uniqueLookup: Map<string, string[]>,
    keepEmpty = true,
  ): DashboardAccountOverviewItem[] {
    const items = tokens.map((token) => this.buildDashboardOverviewItem(token, uniqueLookup));
    return keepEmpty ? items : items.filter((item) => Number(item.objectType) >= 0);
  }

  buildDashboardStorageSection(
    tokenGroups: DashboardAccountEquipmentToken[][],
    uniqueLookup: Map<string, string[]>,
  ): DashboardAccountOverviewStorageSection {
    const items: DashboardAccountOverviewItem[] = [];
    tokenGroups.forEach((tokens) => {
      items.push(...this.buildDashboardOverviewItems(tokens, uniqueLookup, false));
    });
    const uniqueTypes = new Set(items.map((item) => Number(item.objectType)).filter((objectType) => Number.isFinite(objectType) && objectType >= 0));
    return {
      items,
      totalCount: items.length,
      uniqueCount: uniqueTypes.size,
    };
  }

  // ── Deca API ──────────────────────────────────────────────────────────────

  async fetchCharListXml(accessToken: string): Promise<{ xml: string } | { error: string }> {
    const body = new URLSearchParams({
      do_login: 'false',
      accessToken,
      game_net: 'Unity',
      play_platform: 'Unity',
      game_net_user_id: '',
      muleDump: 'true',
      __source: 'ExaltAccountManager',
    }).toString();

    return new Promise((resolve) => {
      const req = https.request(
        'https://www.realmofthemadgod.com/char/list',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body, 'utf8'),
            'X-Unity-Version': '2019.3.14f1',
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            const error = parseCharListError(data);
            if (error) {
              resolve({ error });
              return;
            }
            if (!data.includes('<Chars')) {
              resolve({ error: `Unexpected char list response${res.statusCode ? ` (${res.statusCode})` : ''}.` });
              return;
            }
            resolve({ xml: data });
          });
        },
      );
      req.on('error', (err) => {
        Logger.error('AccountService', `char/list request failed: ${err.message}`);
        resolve({ error: 'Failed to load character list.' });
      });
      req.setTimeout(15000, () => {
        req.destroy();
        resolve({ error: 'Character list request timed out.' });
      });
      req.write(body, 'utf8');
      req.end();
    });
  }

  async fetchDashboardAccountOverviewRemote(
    accountId: string,
    email: string,
    password: string,
    steam?: { steamId: string },
  ): Promise<{ cache: DashboardAccountOverviewCacheRecord } | { error: string }> {
    const clientToken = getClientToken();
    if (!clientToken) return { error: 'Client token unavailable.' };

    const verifyResult = await this.verifyDecaAccount(email, password, clientToken, steam);
    if ('error' in verifyResult) return { error: verifyResult.error };

    const charListResult = await this.fetchCharListXml(verifyResult.token);
    if ('error' in charListResult) return { error: charListResult.error };

    const overview = this.parseDashboardAccountOverview(email, charListResult.xml);
    if ('error' in overview) return { error: overview.error };

    return {
      cache: this.writeDashboardAccountOverviewCache(accountId, email, overview),
    };
  }

  parseDashboardAccountOverview(
    email: string,
    xml: string,
  ): DashboardAccountOverview | { error: string } {
    try {
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        isArray: (name) => name === 'Char' || name === 'ItemData',
      });
      const parsed = parser.parse(xml) as {
        Chars?: {
          Account?: Record<string, unknown>;
          Char?: Array<Record<string, unknown>> | Record<string, unknown>;
        };
      };
      const charsNode = parsed?.Chars;
      if (!charsNode) return { error: 'Character list payload was missing <Chars>.' };

      const accountNode = (charsNode.Account ?? {}) as Record<string, unknown>;
      const accountStats = (accountNode.Stats ?? {}) as Record<string, unknown>;
      const accountUniqueLookup = buildDashboardUniqueItemLookup(accountNode.UniqueItemInfo);
      const giftUniqueLookup = buildDashboardUniqueItemLookup((charsNode as Record<string, unknown>).UniqueGiftItemInfo ?? accountNode.UniqueGiftItemInfo);
      const temporaryGiftUniqueLookup = buildDashboardUniqueItemLookup((charsNode as Record<string, unknown>).UniqueTemporaryGiftItemInfo ?? accountNode.UniqueTemporaryGiftItemInfo);
      const vaultChestNodes = Array.isArray((accountNode.Vault as Record<string, unknown> | undefined)?.Chest)
        ? ((accountNode.Vault as Record<string, unknown>).Chest as unknown[])
        : ((accountNode.Vault as Record<string, unknown> | undefined)?.Chest ? [(accountNode.Vault as Record<string, unknown>).Chest] : []);
      const materialChestNodes = Array.isArray((accountNode.MaterialStorage as Record<string, unknown> | undefined)?.Chest)
        ? ((accountNode.MaterialStorage as Record<string, unknown>).Chest as unknown[])
        : ((accountNode.MaterialStorage as Record<string, unknown> | undefined)?.Chest ? [(accountNode.MaterialStorage as Record<string, unknown>).Chest] : []);
      const rawCharacters = Array.isArray(charsNode.Char)
        ? charsNode.Char
        : (charsNode.Char ? [charsNode.Char] : []);
      const characters = rawCharacters.map((rawChar) => {
        const classType = parseCharListNumber(rawChar.ObjectType);
        const uniqueLookup = buildDashboardUniqueItemLookup(rawChar.UniqueItemInfo);
        const backpackSlots = Math.max(0, parseCharListNumber(rawChar.BackpackSlots));
        const backpackCount = Math.max(0, Math.min(8, Math.floor(backpackSlots / 8)));
        const allTokens = parseDashboardEquipmentTokens(rawChar.Equipment, 12 + (backpackCount * 8));
        const equipmentTokens = allTokens.slice(0, 4);
        const inventoryTokens = allTokens.slice(4, 12);
        const backpackTokens = allTokens.slice(12);
        return {
          charId: parseCharListNumber(rawChar['@_id']),
          classType,
          classTypeHex: formatObjectTypeHex(classType),
          className: this.getObjectDisplayName(classType),
          level: parseCharListNumber(rawChar.Level),
          exp: parseCharListNumber(rawChar.Exp),
          fame: parseCharListNumber(rawChar.CurrentFame),
          seasonal: parseCharListBoolean(rawChar.Seasonal),
          dead: parseCharListBoolean(rawChar.Dead),
          hp: parseCharListNumber(rawChar.HitPoints),
          maxHp: parseCharListNumber(rawChar.MaxHitPoints),
          mp: parseCharListNumber(rawChar.MagicPoints),
          maxMp: parseCharListNumber(rawChar.MaxMagicPoints),
          attack: parseCharListNumber(rawChar.Attack),
          defense: parseCharListNumber(rawChar.Defense),
          speed: parseCharListNumber(rawChar.Speed),
          dexterity: parseCharListNumber(rawChar.Dexterity),
          vitality: parseCharListNumber(rawChar.HpRegen),
          wisdom: parseCharListNumber(rawChar.MpRegen),
          equipment: this.buildDashboardOverviewItems(equipmentTokens, uniqueLookup, true),
          inventory: this.buildDashboardOverviewItems(inventoryTokens, uniqueLookup, true),
          backpacks: this.buildDashboardOverviewItems(backpackTokens, uniqueLookup, true),
        } satisfies DashboardAccountOverviewCharacter;
      });
      characters.sort(
        (a, b) => b.level - a.level || b.fame - a.fame || a.className.localeCompare(b.className) || a.charId - b.charId,
      );

      return {
        accountName: String(accountNode.Name || '').trim() || email,
        totalFame: parseCharListNumber(accountStats.TotalFame),
        aliveFame: parseCharListNumber(accountStats.Fame),
        bestCharFame: parseCharListNumber(accountStats.BestCharFame ?? accountStats.BestFame),
        maxNumChars: parseCharListNumber(accountNode.MaxNumChars),
        characters,
        vault: this.buildDashboardStorageSection(vaultChestNodes.map((value) => parseDashboardEquipmentTokens(value, 0)), accountUniqueLookup),
        gifts: this.buildDashboardStorageSection([parseDashboardEquipmentTokens(accountNode.Gifts, 0)], giftUniqueLookup),
        temporaryGifts: this.buildDashboardStorageSection([parseDashboardEquipmentTokens(accountNode.TemporaryGifts, 0)], temporaryGiftUniqueLookup),
        materialStorage: this.buildDashboardStorageSection(materialChestNodes.map((value) => parseDashboardEquipmentTokens(value, 0)), accountUniqueLookup),
        potions: this.buildDashboardStorageSection([parseDashboardEquipmentTokens(accountNode.Potions, 0)], accountUniqueLookup),
      };
    } catch (err) {
      Logger.warn('AccountService', `char/list parse failed: ${(err as Error).message}`);
      return { error: 'Failed to parse character list.' };
    }
  }

  // ── Deca account verification ─────────────────────────────────────────────

  /**
   * Call Deca account/verify to get session tokens.
   *
   * On a machine-binding rejection, retries ONCE with a freshly computed HWID
   * (bypassing hwid.txt); if that works, the cached file was stale and we drop
   * it so future launches use the value that just worked.
   */
  async verifyDecaAccount(
    email: string,
    password: string,
    clientToken: string,
    steam?: { steamId: string },
  ): Promise<
    | { token: string; tokenTimestamp: string; tokenExpiration: string }
    | { error: string }
  > {
    const first = await this.verifyDecaAccountOnce(email, password, clientToken, steam);
    if (!('error' in first)) return first;

    if (first.transport || !isHwidBindingError(first.rawError)) {
      return { error: first.error };
    }

    const freshToken = getClientToken({ skipFile: true });
    if (!freshToken || freshToken === clientToken) {
      return { error: first.error };
    }

    Logger.log('AccountService', 'account/verify rejected HWID; retrying once with fresh WMI HWID (bypassing hwid.txt).');
    const retry = await this.verifyDecaAccountOnce(email, password, freshToken, steam);
    if (!('error' in retry)) {
      const removed = clearCachedHwid();
      Logger.log('AccountService', `Fresh-HWID verify succeeded${removed ? '; removed stale hwid.txt' : ''}.`);
      return retry;
    }
    return { error: retry.error };
  }

  /**
   * One account/verify round-trip.
   */
  private async verifyDecaAccountOnce(
    email: string,
    password: string,
    clientToken: string,
    steam?: { steamId: string },
  ): Promise<
    | { token: string; tokenTimestamp: string; tokenExpiration: string }
    | { error: string; rawError: string; transport?: boolean }
  > {
    const steamId = String(steam?.steamId || '').trim();
    const useSteam = !!steam && steamId !== '';
    const body = new URLSearchParams(
      useSteam
        ? {
            guid: email,
            secret: password,
            steamid: steamId,
            clientToken,
            game_net: 'Unity_steam',
            play_platform: 'Unity_steam',
            game_net_user_id: steamId,
          }
        : {
            guid: email,
            password,
            clientToken,
            game_net: 'Unity',
            play_platform: 'Unity',
            game_net_user_id: '',
          },
    ).toString();

    return new Promise((resolve) => {
      const req = https.request(
        'https://www.realmofthemadgod.com/account/verify',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body, 'utf8'),
            'X-Unity-Version': '2019.3.14f1',
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            const token = parseVerifySuccess(data);
            if (token) {
              resolve(token);
              return;
            }
            const rawError = (data.match(/<Error>([^<]*)<\/Error>/i)?.[1] ?? '').trim();
            if (!rawError) {
              const status = res.statusCode ?? 0;
              const snippet = data.replace(/\s+/g, ' ').trim().slice(0, 200);
              Logger.warn(
                'AccountService',
                `account/verify unrecognized response (HTTP ${status})${useSteam ? ' [steam]' : ''}: ${snippet || '<empty body>'}`,
              );
              resolve({
                error: `Login failed — unexpected server response (HTTP ${status}). ${snippet ? `Response: ${snippet}` : 'Empty response body.'}`,
                rawError: '',
              });
              return;
            }
            resolve({ error: parseVerifyError(data), rawError });
          });
        },
      );
      req.on('error', (err) => {
        Logger.error('AccountService', `account/verify request failed: ${err.message}`);
        resolve({ error: 'Network error. Try again.', rawError: '', transport: true });
      });
      req.setTimeout(15000, () => {
        req.destroy();
        resolve({ error: 'Request timed out.', rawError: '', transport: true });
      });
      req.write(body, 'utf8');
      req.end();
    });
  }
}
