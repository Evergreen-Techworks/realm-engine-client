#!/usr/bin/env node
// Fails the build when a derived packet artifact stops matching the canonical
// data, or when the canonical data becomes internally inconsistent.
//
// CANONICAL SOURCE: client/data/packet-definitions.json
// Introduced by docs/plans/107-packet-source-of-truth.md.
//
// Invariants:
//   1. Regeneration is a no-op (delegates to gen-packet-artifacts.mjs --check).
//   2. Every `packets` entry has a non-empty string `protocolName`.
//   3. No id appears in both `packets` and `protocolOnlyPackets`.
//   4. `protocolName` values are unique and collide with no protocol-only name
//      or orphan name.
//   5. Layer A `name` values are unique (a duplicate would make
//      PacketFactory.nameToId silently drop one).
//   6. Every `protocolAliases` key is an orphan name; every value is in PACKET_MAP.
//
// Run: node scripts/check-packet-drift.mjs   (also `npm run check:packets`)

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defs = JSON.parse(fs.readFileSync(path.join(CLIENT_ROOT, 'data/packet-definitions.json'), 'utf8'));

const failures = [];
const fail = (invariant, detail) => failures.push({ invariant, detail });

// --- 1. regeneration is a no-op -------------------------------------------
const gen = spawnSync(process.execPath, [path.join(CLIENT_ROOT, 'scripts/gen-packet-artifacts.mjs'), '--check'], {
  encoding: 'utf8',
});
if (gen.status !== 0) {
  fail(
    '1 (regeneration is a no-op)',
    (gen.stderr || gen.stdout || '').trimEnd() + '\n  A derived artifact was hand-edited, or the canonical data changed without regenerating.',
  );
}

// --- 2. protocolName is total ---------------------------------------------
const missing = Object.entries(defs.packets)
  .filter(([, p]) => typeof p.protocolName !== 'string' || p.protocolName.length === 0)
  .map(([id, p]) => `${id} (${p.name})`);
if (missing.length) {
  fail('2 (every packet has a protocolName)', `ids without a protocolName: ${missing.join(', ')}`);
}

// --- 3. no id in both packets and protocolOnlyPackets ----------------------
const bothIds = Object.keys(defs.protocolOnlyPackets).filter((id) => id in defs.packets);
if (bothIds.length) {
  fail('3 (packets / protocolOnlyPackets are disjoint)', `ids in both: ${bothIds.join(', ')}`);
}

// --- 4. protocolName uniqueness across all three name spaces ---------------
{
  const seen = new Map();
  const dupes = [];
  for (const [id, p] of Object.entries(defs.packets)) {
    if (!p.protocolName) continue;
    if (seen.has(p.protocolName)) dupes.push(`${p.protocolName} (ids ${seen.get(p.protocolName)} and ${id})`);
    else seen.set(p.protocolName, id);
  }
  for (const [id, p] of Object.entries(defs.protocolOnlyPackets)) {
    if (seen.has(p.name)) dupes.push(`${p.name} (packets id ${seen.get(p.name)} and protocolOnlyPackets id ${id})`);
    else seen.set(p.name, id);
  }
  // An orphan name may legitimately be reused as a `protocolName` (that is how
  // divergence D2 is encoded for id 100), but it must not also be a mapped id.
  const mapped = new Set([
    ...Object.values(defs.packets)
      .filter((p) => !(p.protocolName in defs.protocolOrphanNames))
      .map((p) => p.protocolName),
    ...Object.values(defs.protocolOnlyPackets).map((p) => p.name),
  ]);
  for (const name of Object.keys(defs.protocolOrphanNames)) {
    if (mapped.has(name)) dupes.push(`${name} is both an orphan name and a mapped PACKET_MAP name`);
  }
  if (dupes.length) fail('4 (protocol names are unique)', dupes.join('; '));
}

// --- 5. Layer A names are unique ------------------------------------------
{
  const seen = new Map();
  const dupes = [];
  for (const [id, p] of Object.entries(defs.packets)) {
    if (seen.has(p.name)) dupes.push(`${p.name} (ids ${seen.get(p.name)} and ${id})`);
    else seen.set(p.name, id);
  }
  if (dupes.length) {
    fail('5 (Layer A names are unique)', `${dupes.join('; ')} — PacketFactory.nameToId would silently drop one`);
  }
}

// --- 6. aliases resolve ----------------------------------------------------
{
  const mappedNames = new Set([
    ...Object.values(defs.packets)
      .filter((p) => !(p.protocolName in defs.protocolOrphanNames))
      .map((p) => p.protocolName),
    ...Object.values(defs.protocolOnlyPackets).map((p) => p.name),
  ]);
  const problems = [];
  for (const [alias, target] of Object.entries(defs.protocolAliases)) {
    if (!(alias in defs.protocolOrphanNames)) problems.push(`alias key ${alias} is not in protocolOrphanNames`);
    if (!mappedNames.has(target)) problems.push(`alias ${alias} -> ${target}, which is not a PACKET_MAP name`);
  }
  if (problems.length) fail('6 (aliases resolve)', problems.join('; '));
}

// --- report ----------------------------------------------------------------
if (failures.length) {
  console.error('[check-packet-drift] FAILED\n');
  for (const f of failures) {
    console.error(`  invariant ${f.invariant}`);
    for (const line of String(f.detail).split('\n')) console.error(`    ${line}`);
    console.error('');
  }
  console.error('  Canonical source: client/data/packet-definitions.json');
  console.error('  Regenerate derived artifacts with: npm run gen:packets');
  process.exit(1);
}

const divergences = Object.entries(defs.packets)
  .filter(([, p]) => p.protocolDirection)
  .map(([id, p]) => `${id} ${p.name}=${p.direction}/${p.protocolName}=${p.protocolDirection}`);

console.log(
  `[check-packet-drift] OK — ${Object.keys(defs.packets).length} shared packets, ` +
    `${Object.keys(defs.protocolOnlyPackets).length} protocol-only, ` +
    `${Object.keys(defs.protocolOrphanNames).length} orphan names, ` +
    `${Object.keys(defs.protocolAliases).length} aliases, ` +
    `${divergences.length} direction divergences (see D1)`,
);
// Kept visible on every run so the register does not quietly rot.
for (const d of divergences) console.log(`  D1 direction divergence: ${d}`);
