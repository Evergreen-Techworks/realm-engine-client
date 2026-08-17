import type { PluginContext } from '../src/plugins/PluginContext.js';
import type { ClientConnection } from '../src/proxy/ClientConnection.js';

/** `/pattern/flags`; backslash escapes the next byte in the regex source. */
function tryParseSlashRegex(line: string): RegExp | null {
  if (!line.startsWith('/') || line.length < 3) return null;

  let delim = -1;
  for (let i = 1; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 0x5c && i + 1 < line.length) {
      i++;
      continue;
    }
    if (c === 0x2f) {
      delim = i;
      break;
    }
  }
  if (delim <= 0) return null;

  let body = '';
  let j = 1;
  while (j < delim) {
    if (line.charCodeAt(j) === 0x5c && j + 1 < delim) {
      body += line[j]!;
      body += line[j + 1]!;
      j += 2;
      continue;
    }
    body += line[j]!;
    j++;
  }

  let flags = '';
  for (let k = delim + 1; k < line.length; k++) {
    const ch = line[k]!;
    if (/[dgimsuy]/.test(ch)) flags += ch;
  }
  try {
    return new RegExp(body, flags);
  } catch {
    return null;
  }
}

function parseNameLines(raw: string): string[] {
  const out: string[] = [];
  for (let line of raw.split(/[\r\n]+/)) {
    line = line.replace(/\s+#.*$/, '').trim();
    if (line && !line.startsWith('#')) out.push(line);
  }
  return out;
}

function senderMatches(senderLc: string, pattern: string): boolean {
  const t = pattern.trim();
  if (!t) return false;
  if (t.startsWith('/') && t.length >= 4) {
    const rx = tryParseSlashRegex(t);
    return rx?.test(senderLc) ?? false;
  }
  return senderLc.includes(t.toLowerCase());
}

function localName(client: ClientConnection): string {
  return (client.playerData?.name ?? '').trim();
}

function senderIsSelf(sender: string, self: string): boolean {
  if (!self || !sender) return false;
  return sender.trim().toLowerCase() === self.toLowerCase();
}

function isSystemSender(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === '' || n === '*' || n === '#' || n === '[server]';
}

function senderLooksNegativeFameNpc(stars: number | null): boolean {
  return stars !== null && stars < 0;
}

const INVISIBLE_CHARS = /[\u200B-\u200F\uFEFF\u2060\u00AD\u034F\u180E\u2061-\u2064]/g;

function foldHomoglyphs(s: string): string {
  let o = s;
  const pairs: [RegExp, string][] = [
    [/[\u0430\u0410]/g, 'a'],
    [/[\u0435\u0415]/g, 'e'],
    [/[\u043E\u041E]/g, 'o'],
    [/[\u0440\u0420]/g, 'p'],
    [/[\u0441\u0421]/g, 'c'],
    [/[\u0443\u0423]/g, 'y'],
    [/[\u0445\u0425]/g, 'x'],
    [/[\u0456\u0406]/g, 'i'],
  ];
  for (const [re, ch] of pairs) o = o.replace(re, ch);
  return o;
}

type ScanSlices = { lc: string; compact: string };

function prepareScan(raw: string): ScanSlices {
  let s = raw.replace(INVISIBLE_CHARS, '');
  try {
    s = s.normalize('NFKC');
  } catch {}
  s = foldHomoglyphs(s);
  const lc = s.toLowerCase();
  const compact = lc.replace(/[^a-z0-9]/g, '');
  return { lc, compact };
}

function normalizeFakePipes(t: string): string {
  return t.replace(/[｜┃│¦\u2502]/g, '|');
}

function looksLikeCharSpam(text: string): boolean {
  if (text.length < 48) return false;
  let run = 1;
  for (let i = 1; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const p = text.charCodeAt(i - 1);
    const same = c === p && !(c <= 32);
    run = same ? run + 1 : 1;
    if (run >= 28) return true;
  }
  return false;
}

/** Masked http / shorteners / TG. No discord.gg / discord.com keyword blocks. */
function looksLikeMaskedHttpOrShortener(lc: string): boolean {
  const s = lc.replace(/\s+/g, ' ');
  if (/hxxps?:/.test(s)) return true;
  if (
    /^\s*h[\s·•_*]{2,40}t[\s·•_*]{2,40}p|h[\s_*]{3,25}t[\s_*]{2,15}p|^\s*h[\s_xw]{1,14}w[\s_xw]{1,14}p|^\s*h(?:\s+[t_*·•]){4,14}p\b/i.test(
      s,
    )
  ) {
    return true;
  }
  if (
    /\btinyurl\b|bit\s*[._-]*ly\b|is\.gd\b|clck\.ru\b|tiny\.(?:cc|one)\b|lnk\.bio\b|\blinktr\b/i.test(s)
  ) {
    return true;
  }
  if (/\bt\.me\//i.test(s)) return true;
  if (/\btelegram\.(?:me|[a-z0-9-]{3,})\b/i.test(s)) return true;
  return false;
}

const COMPACT_SPAM_NEEDLES: readonly string[] = [
  'paypal',
  'cashapp',
  'venmo',
  'zellepay',
  'zelle',
  'multitool',
  'nexusmaxing',
  'fameservice',
  'famreservice',
  'instantdelivery',
  'autodelivery',
  'whitebagandfame',
  'giftcards24',
  'dailylottery',
  'freespins',
  'seasonalitems',
  'bulkkeys',
  'cheapfame',
  'ssndecas',
  'enchanteddeca',
  'r2wins',
  'r2realm',
  'telegram',
  'kickcom',
  'instantnexusmaxing',
  'coinsstocks',
];

function looksLikePipeShopSpam(normLc: string): boolean {
  const pipeCount = (normLc.match(/\|/g) ?? []).length;
  if (pipeCount < 3) return false;
  const lump = normLc.replace(/\s+/g, ' ');
  return (
    /(paypal|venmo|zelle|\bcrypto\b|\$|€|\u20ac|cash[\s]?app|gift\s*cards?|instant|delivery|24\s*[\/ ]\s*7)/i.test(
      normLc,
    )
    || /realm\s*[|]+\s*stocks?\s*[|]+\s*(coins)?/i.test(normLc)
    || /real\s*m\s*coins\s*[|]+\s*stocks?/i.test(lump)
    || /(coins?\s*&\s*stocks?\s*&\s*stocks?\s*&|coins?\s+[|]+\s+)/i.test(lump)
    || /\b(realm|gift)\s+cards?\s*\d/.test(lump)
    || /\brealm\s+[il|]\s+stock\s+[il|]\s+(com|coin)\b/i.test(lump)
  );
}

function looksLikeObfuscatedUrl(normLc: string, raw: string): boolean {
  if (/(?:[a-z]\.){6,}[a-z]?/i.test(raw)) return true;
  if (/[a-z]{3,}![a-z0-9]{1,4}\.[a-z]{2,}/i.test(raw)) return true;
  if (/\.c\s*\(\s*\)\s*m|\)\(\)\s*\.\s*c/i.test(raw)) return true;
  if (/\/\\|\\\\\s*\/|\/\\\s*[a-z]/i.test(raw) && /\b(realm|stock|coins?|shop)\b/i.test(normLc)) {
    return true;
  }
  const flat = normLc.replace(/\s+/g, ' ');
  if (/oryxsp[!1]/i.test(flat)) return true;
  if (/\brealm\s+[il|]\s+stock\s+[il|]\s+(com|coin)\b/.test(flat)) return true;
  const soft = flat.replace(/[·•∙‧]/g, ' ');
  if (
    /d\s*[o0.]+\s*t\s+c\s*[o0.]+\s*m|\b\[\s*dot\s*\]\s*com\b/i.test(soft)
    && /\b(buy|sell|usd|\$|keys|deca|cheap|stock|coin|realm|shop|coins?)\b/i.test(soft)
  ) {
    return true;
  }
  return false;
}

function looksLikeAsciiBannerSpam(text: string): boolean {
  return /[=]{10,}|[-_=|]{14,}|(?:\*\s*){14,}/.test(text);
}

function looksLikeBotThreeDigitSuffix(
  lc: string,
  raw: string,
  normLc: string,
  obfus: boolean,
  banner: boolean,
): boolean {
  if (!/\s+\d{3}$/.test(raw)) return false;
  if (raw.length < 50) return false;
  const spamHint =
    /(fame|deca|key|vault|shop|stock|coin|lottery|season|nexus|multitool|oryx|realm|white\s*bag|enchant|bulk|service|client|cheap|lean|ssn\b|gift\s+card|coins?\s*&)/i.test(
      lc,
    );
  const heavy =
    ((normLc.match(/\|/g) ?? []).length >= 2
      || (raw.match(/=/g) ?? []).length >= 8
      || obfus
      || banner);
  return spamHint || heavy;
}

function matchesHardcodedSpam(rawText: string): boolean {
  const { lc, compact } = prepareScan(rawText);
  const normPipes = normalizeFakePipes(lc);
  const normOne = normPipes.replace(/\s+/g, ' ');

  if (looksLikeMaskedHttpOrShortener(lc)) return true;

  for (const w of COMPACT_SPAM_NEEDLES) {
    if (compact.includes(w)) return true;
  }

  const loosely = ` ${lc.replace(/[^a-zA-Z0-9]+/g, ' ').replace(/\s+/g, ' ')} `.toLowerCase();
  if (
    loosely.includes(' wtb ')
    || loosely.includes(' wts ')
    || loosely.includes(' wtt ')
    || loosely.includes(' wta ')
  )
    return true;

  const subs = [
    'cheap fame',
    'gift cards 24',
    'nexus maxing',
    'bulk keys',
    'daily lottery',
    'free spins',
    'ssn decas',
    'enchanted deca',
    'lean crown',
    'seasonal items',
    'telegram',
    'kick.com',
    'fame service',
  ];
  for (const s of subs) {
    if (lc.includes(s)) return true;
  }

  const res: RegExp[] = [
    /auto[\s_-]*delivery/i,
    /gift[\s_-]*cards?/i,
    /instant[\s_-]*delivery/i,
    /(paypal|venmo|zelle|cash[\s_-]*app|\bcrypto\b)/i,
    /\bkick\s*[.,]\s*com\b/i,
    /\br2wins\b|\br2realm\b/i,
    /realms?\s*\|\s*stocks?\s*\|\s*coins?\b/i,
    /\bshipping\s+(to\s+)?your\s+vault\b/i,
    /\b(win|get)\s+season'?s\s+items?\b/i,
    /(white\s+bag\s+and\s+fame|fame\s+service)/i,
    /(instant\s+nexus\s+maxing|nexus\s+maxing)/i,
    /(free\s+)?multitool\s+client/i,
    /(bis\s+)?enchanted\s+rare/i,
    /(win\s+)?seasonal\s+items/i,
    /(free\s+spins|daily\s+lottery)/i,
    /telegram\.[a-z0-9-]{2,}/i,
  ];
  for (const re of res) {
    if (re.test(normPipes) || re.test(rawText)) return true;
  }

  const obfus = looksLikeObfuscatedUrl(normOne, rawText);
  const bannerSpam = looksLikeAsciiBannerSpam(rawText);
  const pipeSpam = looksLikePipeShopSpam(normOne);

  if (
    pipeSpam
    || obfus
    || bannerSpam
    || looksLikeBotThreeDigitSuffix(lc, rawText, normOne, obfus, bannerSpam)
    || looksLikeCharSpam(rawText)
  ) {
    return true;
  }

  return false;
}

export function register(ctx: PluginContext): void {
  ctx.name = 'Chat Filter';
  ctx.category = 'utility';

  ctx.registerSetting('enabled', {
    label: 'Chat filter',
    type: 'boolean',
    value: true,
  });

  ctx.registerSetting('whitelist', {
    label: 'Always allow senders — one substring or `/regex/` per line (matches display name)',
    type: 'text',
    value: '',
  });

  ctx.registerSetting('blacklist', {
    label: 'Always block senders — one substring or `/regex/` per line',
    type: 'text',
    value: '',
  });

  ctx.hookPacket(
    'TEXT',
    (client, packet) => {
      if (!ctx.getSetting<boolean>('enabled')) return;
      if (packet.name !== 'TEXT' || !packet.isDefined || !packet.data) return;

      const data = packet.data as Record<string, unknown>;
      const rawText = String(data.cleanText ?? data.text ?? '');
      const sender = String(data.name ?? '').trim();

      const self = localName(client);
      const senderLc = sender.toLowerCase();

      if (senderIsSelf(sender, self)) return;
      if (isSystemSender(sender)) return;

      const starsRaw =
        typeof data.numStars === 'number' && Number.isFinite(data.numStars)
          ? (data.numStars as number)
          : null;
      if (senderLooksNegativeFameNpc(starsRaw)) return;

      const blacklist = parseNameLines(ctx.getSetting<string>('blacklist') ?? '');
      for (const line of blacklist) {
        if (senderMatches(senderLc, line)) {
          packet.send = false;
          return;
        }
      }

      const whitelist = parseNameLines(ctx.getSetting<string>('whitelist') ?? '');
      for (const line of whitelist) {
        if (senderMatches(senderLc, line)) return;
      }

      if (matchesHardcodedSpam(rawText)) packet.send = false;
    },
    { prepend: true },
  );

  ctx.hookCommand('cf', (client) => {
    ctx.enabled = !ctx.enabled;
    ctx.sendNotification(client, ctx.name, `Chat Filter ${ctx.enabled ? 'ON' : 'OFF'}`);
  });
}
