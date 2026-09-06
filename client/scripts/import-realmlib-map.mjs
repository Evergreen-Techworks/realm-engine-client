#!/usr/bin/env node
// Reports what an upstream realmlib checkout knows that the canonical packet
// data does not. READ-ONLY — this script never writes a file.
//
// CANONICAL SOURCE: client/data/packet-definitions.json. This script only tells
// you what to put in it; `npm run gen:packets` is what produces every derived
// artifact (see client/data/README.md and
// docs/plans/107-packet-source-of-truth.md).
//
// It replaces the old scripts/sync-packet-map.mjs, which *wrote*
// packages/protocol/src/generated/packet-map.ts. Two generators writing one
// file is the failure mode plan 107 removes: packet-map.ts now has exactly one
// producer, gen-packet-artifacts.mjs, fed from the canonical JSON.
//
// Usage:
//   node scripts/import-realmlib-map.mjs <path-to-realmlib/src>
//   node scripts/import-realmlib-map.mjs ../../HiveManager/HeadlessClient/realmlib/src
//
// Exit 0 when there is nothing to report, 1 when there is.

import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const upstream = process.argv[2];
if (!upstream) {
  console.error('Usage: node scripts/import-realmlib-map.mjs <path-to-realmlib/src>');
  console.error('Example: node scripts/import-realmlib-map.mjs ../../HiveManager/HeadlessClient/realmlib/src');
  process.exit(2);
}
const MAP_PATH = resolve(upstream, 'packet-map.ts');
const TYPE_PATH = resolve(upstream, 'packet-type.ts');

function loadUpstreamMap(path) {
  const m = new Map();
  const re = /^\s*(\d+):\s*PacketType\.([A-Z0-9_]+),?\s*(?:\/\/\s*(.*))?$/;
  for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    const mo = re.exec(line);
    if (mo) m.set(Number(mo[1]), { name: mo[2], comment: (mo[3] ?? '').trim() });
  }
  return m;
}

function loadUpstreamEnum(path) {
  const s = new Set();
  const re = /^\s*([A-Z0-9_]+)\s*=\s*['"]([A-Z0-9_]+)['"]/;
  for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    const mo = re.exec(line);
    if (mo) s.add(mo[1]);
  }
  return s;
}

const upstreamMap = loadUpstreamMap(MAP_PATH);
const upstreamEnum = loadUpstreamEnum(TYPE_PATH);

const defs = JSON.parse(readFileSync(join(CLIENT_ROOT, 'data/packet-definitions.json'), 'utf-8'));

// Canonical id -> Layer B name, across both sections.
const canonicalById = new Map();
for (const [id, packet] of Object.entries(defs.packets)) {
  if (packet.protocolName in defs.protocolOrphanNames) continue; // orphans carry no id
  canonicalById.set(Number(id), packet.protocolName);
}
for (const [id, packet] of Object.entries(defs.protocolOnlyPackets)) canonicalById.set(Number(id), packet.name);

const canonicalNames = new Set([...canonicalById.values(), ...Object.keys(defs.protocolOrphanNames)]);

// --- 1. ids upstream has that canonical does not --------------------------
const missingIds = [...upstreamMap.keys()].filter((id) => !canonicalById.has(id)).sort((a, b) => a - b);

// --- 2. ids whose upstream name differs from canonical protocolName --------
const renamed = [];
for (const [id, { name }] of upstreamMap) {
  const canonical = canonicalById.get(id);
  if (canonical && canonical !== name) renamed.push({ id, upstream: name, canonical });
}
renamed.sort((a, b) => a.id - b.id);

// --- 3. PacketType members upstream that canonical does not know -----------
const missingNames = [...upstreamEnum].filter((n) => !canonicalNames.has(n)).sort();

// --- report ----------------------------------------------------------------
const total = missingIds.length + renamed.length + missingNames.length;

if (missingIds.length) {
  console.log(`\n${missingIds.length} id(s) upstream that the canonical file does not have.`);
  console.log('Add each to `packets` (with Layer A `name`/`direction`/`fields`) if the proxy');
  console.log('should decode it, otherwise to `protocolOnlyPackets`. Ready to paste:\n');
  for (const id of missingIds) {
    const { name } = upstreamMap.get(id);
    console.log(`    "${id}": { "name": "${name}", "direction": "Incoming" },`);
  }
  console.log('\n  (direction is a guess — verify against the upstream packets/incoming|outgoing/ folder)');
}

if (renamed.length) {
  console.log(`\n${renamed.length} id(s) whose upstream name differs from canonical \`protocolName\`:\n`);
  for (const r of renamed) console.log(`    ${String(r.id).padStart(4)}  canonical: ${r.canonical}    upstream: ${r.upstream}`);
  console.log('\n  Update `protocolName` on that packet if upstream is right.');
}

if (missingNames.length) {
  console.log(`\n${missingNames.length} upstream PacketType member(s) absent from the canonical file:\n`);
  for (const n of missingNames) console.log(`    ${n}`);
  console.log('\n  If one has an id, it belongs in `packets`/`protocolOnlyPackets`; if it has none,');
  console.log('  add it to `protocolOrphanNames` with its direction.');
}

if (total === 0) {
  console.log(`[import-realmlib-map] OK — canonical file already covers all ${upstreamMap.size} upstream ids and ${upstreamEnum.size} PacketType members.`);
  process.exit(0);
}

console.log(`\n[import-realmlib-map] ${total} item(s) to reconcile into client/data/packet-definitions.json,`);
console.log('then run: npm run gen:packets && npm run check:packets');
console.log('(this script wrote nothing)');
process.exit(1);
