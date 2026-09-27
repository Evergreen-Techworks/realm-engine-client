#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const PROVIDERS = Object.freeze({
  doordash: { name: 'DoorDash', home: 'https://www.doordash.com/', search: (q) => `https://www.doordash.com/search/store/${encodeURIComponent(q)}/` },
  ubereats: { name: 'Uber Eats', home: 'https://www.ubereats.com/', search: (q) => `https://www.ubereats.com/search?q=${encodeURIComponent(q)}` },
  instacart: { name: 'Instacart', home: 'https://www.instacart.com/', search: (q) => `https://www.instacart.com/store/s?k=${encodeURIComponent(q)}` },
  gopuff: { name: 'Gopuff', home: 'https://www.gopuff.com/search', search: null },
});

export function providerHandoff(provider, query = '') {
  const key = provider.toLowerCase().replace(/[-_ ]/g, '');
  const chosen = PROVIDERS[key];
  if (!chosen) throw new Error(`Unknown provider: ${provider}. Choose doordash, ubereats, instacart, or gopuff.`);
  const trimmed = query.trim();
  if (trimmed.length > 200) throw new Error('Search must be 200 characters or fewer.');
  return {
    name: chosen.name,
    query: trimmed,
    url: trimmed && chosen.search ? chosen.search(trimmed) : chosen.home,
    searchOnSite: Boolean(trimmed && !chosen.search),
  };
}

export function parseItems(values) {
  if (values.length === 0 || values.length > 50) throw new Error('Provide 1 to 50 item names.');
  return values.map((value) => {
    const name = value.trim();
    if (!name || name.length > 200) throw new Error('Each item name must contain 1 to 200 characters.');
    return { name };
  });
}

export async function createInstacartList(items, { apiKey, environment = 'production', fetchImpl = fetch } = {}) {
  if (!apiKey?.trim()) throw new Error('Set INSTACART_API_KEY to use Instacart shopping lists.');
  if (!['production', 'development'].includes(environment)) throw new Error('Environment must be production or development.');
  const host = environment === 'production' ? 'https://connect.instacart.com' : 'https://connect.dev.instacart.tools';
  const response = await fetchImpl(`${host}/idp/v1/products/products_link`, {
    method: 'POST',
    headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Realm Engine shopping list', link_type: 'shopping_list', line_items: parseItems(items) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Instacart request failed (HTTP ${response.status}). Check API key and access.`);
  const body = await response.json();
  const url = new URL(body.products_link_url);
  if (url.protocol !== 'https:' || !(url.hostname === 'instacart.com' || url.hostname.endsWith('.instacart.com')))
    throw new Error('Instacart returned an unexpected shopping-list URL.');
  return url.toString();
}

function openBrowser(url) {
  const [command, args] = process.platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => console.error(`Could not open browser: ${err.message}`));
    child.unref();
  } catch (err) {
    console.error(`Could not open browser: ${err.message}`);
  }
}

const HELP = `Realm Engine food ordering handoff

Usage:
  npm run food -- <doordash|ubereats|instacart|gopuff> [search terms] [--no-open]
  npm run food -- instacart-list <item> [<item> ...] [--dev] [--no-open]

Examples:
  npm run food -- doordash pizza
  npm run food -- ubereats "sushi near me"
  npm run food -- gopuff snacks
  npm run food -- instacart-list milk eggs bread

Browser checkout is required. Instacart lists need INSTACART_API_KEY.
No order is placed or charged by this CLI.`;

export async function run(args, { env = process.env, write = console.log, launch = openBrowser } = {}) {
  if (!args.length || args.includes('--help') || args.includes('-h')) { write(HELP); return; }
  const noOpen = args.includes('--no-open');
  const dev = args.includes('--dev');
  const unknownFlag = args.find((arg) => arg.startsWith('--') && arg !== '--no-open' && arg !== '--dev');
  if (unknownFlag) throw new Error(`Unknown option: ${unknownFlag}`);
  const positional = args.filter((arg) => arg !== '--no-open' && arg !== '--dev');
  const [command, ...terms] = positional;
  if (command !== 'instacart-list' && dev) throw new Error('--dev is only for instacart-list.');
  let url;
  if (command === 'instacart-list') {
    url = await createInstacartList(terms, { apiKey: env.INSTACART_API_KEY, environment: dev ? 'development' : 'production' });
    write(`Instacart shopping list: ${url}`);
  } else {
    const handoff = providerHandoff(command, terms.join(' '));
    url = handoff.url;
    write(`${handoff.name}: ${url}`);
    if (handoff.searchOnSite) write(`Search on site for: ${handoff.query}`);
  }
  write('Review availability, delivery address, total, and payment on the provider site before placing your order.');
  if (!noOpen) launch(url);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  run(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exitCode = 1; });
}
