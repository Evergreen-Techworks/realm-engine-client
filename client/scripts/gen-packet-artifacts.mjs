#!/usr/bin/env node
// Regenerates every derived packet artifact from the canonical protocol data.
//
// CANONICAL SOURCE: client/data/packet-definitions.json
//   (plus data/stat-types.json, data/packet-status.json,
//    data/packet-lab-name-only.json for the three side tables)
//
// Introduced by docs/plans/107-packet-source-of-truth.md. Both protocol stacks
// derive from the canonical file: Layer A (`src/packets/`, data-driven) and
// Layer B (`packages/protocol/`, class-based). Never hand-edit the outputs
// listed below — edit the canonical JSON and run `npm run gen:packets`.
//
// Outputs:
//   src/packets/packetDefinitions.generated.ts   <- packet-definitions.json (protocol* keys stripped)
//   src/packets/statTypes.generated.ts           <- stat-types.json
//   src/packets/packetStatus.generated.ts        <- packet-status.json
//   src/packets/packetLabNameOnly.generated.ts   <- packet-lab-name-only.json
//   packages/protocol/src/generated/packet-map.ts <- packet-definitions.json (protocol sections)
//
// Usage:
//   node scripts/gen-packet-artifacts.mjs           write the artifacts
//   node scripts/gen-packet-artifacts.mjs --check   diff against disk, exit 1 on mismatch

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(CLIENT_ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));

/** The emit formula shared by the four `src/packets/*.generated.ts` artifacts. */
function emitModule(header, varName, type, value) {
  return `${header}const ${varName}: ${type} = ${JSON.stringify(value, null, 2)};\n\nexport default ${varName};\n`;
}

/** Deep clone that drops every `protocol*` key, so the Layer A artifact keeps its `DefsFile` shape. */
function stripProtocolKeys(defs) {
  const clone = JSON.parse(JSON.stringify(defs));
  for (const packet of Object.values(clone.packets)) {
    for (const key of Object.keys(packet)) {
      if (key.startsWith('protocol')) delete packet[key];
    }
  }
  // Key insertion order of `packets` / `dataObjects` is preserved by the clone.
  return { packets: clone.packets, dataObjects: clone.dataObjects };
}

// ---------------------------------------------------------------------------
// packet-map.ts (Layer B)
// ---------------------------------------------------------------------------

const PACKET_MAP_HEADER = `import type { PacketMap } from '../packet-map.js';
import { invertPacketMap } from '../packet-map.js';

// AUTO-GENERATED — do not edit by hand.
// Source of truth: client/data/packet-definitions.json (see
// docs/plans/107-packet-source-of-truth.md). Regenerate with:
//   cd client && npm run gen:packets
//
// Each packet carries both spellings on one line of the canonical file:
// \`name\` is Layer A's (\`src/packets/\`, what plugins string-compare) and
// \`protocolName\` is Layer B's. Ids Layer A does not decode live in
// \`protocolOnlyPackets\`; \`PacketType\` members with no id live in
// \`protocolOrphanNames\`.
//
// A handful of packet names differ between REC's historical naming and realmlib's.
// The map entry uses REC's name (so downstream string comparisons keep working);
// realmlib's name is exported as an alias below so imports from either world resolve.
`;

function buildPacketMap(defs) {
  const entries = [];
  for (const [id, packet] of Object.entries(defs.packets)) {
    // A `protocolName` that is an orphan `PacketType` member has no Layer B id —
    // Layer A's id must not invent one. This is divergence D2/D3: Layer A id 100
    // is SHOOTACK, but Layer B's SHOOTACK is the orphan aliased to SHOOT_ACK (121).
    if (packet.protocolName in defs.protocolOrphanNames) continue;
    entries.push({ id: Number(id), name: packet.protocolName, comment: packet.protocolMapComment });
  }
  for (const [id, packet] of Object.entries(defs.protocolOnlyPackets)) {
    entries.push({ id: Number(id), name: packet.name, comment: packet.protocolMapComment });
  }
  entries.sort((a, b) => a.id - b.id);

  // A name that some alias points at carries a `// realmlib: <alias>` marker.
  const aliasByTarget = new Map();
  for (const [alias, target] of Object.entries(defs.protocolAliases)) aliasByTarget.set(target, alias);

  const lines = entries.map((e) => {
    const alias = aliasByTarget.get(e.name);
    const comment = alias ? `  // realmlib: ${alias}` : e.comment ? `  // ${e.comment}` : '';
    return `  "${e.id}": "${e.name}",${comment}`;
  });
  return { entries, lines };
}

function directionOf(defs, name, byProtocolName, protocolOnlyByName) {
  const packet = byProtocolName.get(name);
  if (packet) {
    if (packet.protocolDirection) return packet.protocolDirection;
    return packet.direction === 'server' ? 'Incoming' : 'Outgoing';
  }
  const only = protocolOnlyByName.get(name);
  if (only) return only.direction;
  const orphan = defs.protocolOrphanNames[name];
  if (orphan) return orphan;
  throw new Error(`no direction for PacketType member ${name}`);
}

function generatePacketMap(defs) {
  const { entries, lines } = buildPacketMap(defs);

  const byProtocolName = new Map();
  for (const packet of Object.values(defs.packets)) byProtocolName.set(packet.protocolName, packet);
  const protocolOnlyByName = new Map();
  for (const packet of Object.values(defs.protocolOnlyPackets)) protocolOnlyByName.set(packet.name, packet);

  // PacketType: every mapped name plus every orphan, `Array.prototype.sort()` order.
  const typeNames = [...new Set([...entries.map((e) => e.name), ...Object.keys(defs.protocolOrphanNames)])].sort();

  let out = PACKET_MAP_HEADER;
  out += 'export const PACKET_MAP: PacketMap = {\n';
  out += lines.join('\n');
  out += '\n};\n\nexport const BIDIR_PACKET_MAP: PacketMap = invertPacketMap(PACKET_MAP);\n\n';

  out += 'export enum PacketType {\n';
  for (const name of typeNames) out += `  ${name} = "${name}",\n`;
  out += '}\n\n';

  out += `/**
 * Realmlib canonical names that differ from REC. Each alias resolves to the same
 * wire string as the REC name, so \`pkt.type === PacketAlias.VAULT_CONTENT\` and
 * \`pkt.type === PacketType.VAULT_UPDATE\` are both true (they are the same string).
 */
export const PacketAlias = {
`;
  for (const [alias, target] of Object.entries(defs.protocolAliases)) out += `  ${alias}: PacketType.${target},\n`;
  out += '} as const;\n\n';

  out += `// Direction is not encoded in the wire protocol. Existing values are preserved
// from the prior REC map; new entries from realmlib are annotated with the
// evidence source in a trailing comment ("verified against realmlib
// incoming/outgoing dir" — cross-checked by matching each name to the
// corresponding *-packet.ts file under \`packets/incoming/\` or
// \`packets/outgoing/\` in the upstream realmlib checkout).
export const PACKET_DIRECTION: Record<PacketType, "Incoming" | "Outgoing"> = {
`;
  for (const name of typeNames) {
    const dir = directionOf(defs, name, byProtocolName, protocolOnlyByName);
    const note = defs.protocolDirectionNotes[name];
    out += `  ${name}: "${dir}",${note ? `  // ${note}` : ''}\n`;
  }
  out += '};\n';
  return out;
}

// ---------------------------------------------------------------------------
// Artifact table
// ---------------------------------------------------------------------------

function buildArtifacts() {
  const defs = readJson('data/packet-definitions.json');

  return [
    {
      out: 'src/packets/packetDefinitions.generated.ts',
      content: emitModule(
        "// Auto-generated from data/packet-definitions.json.\n// Do not edit by hand.\nimport type { DefsFile } from './PacketFactory.js';\n\n",
        'packetDefinitions',
        'DefsFile',
        stripProtocolKeys(defs),
      ),
    },
    {
      out: 'src/packets/statTypes.generated.ts',
      content: emitModule(
        "// Auto-generated from data/stat-types.json.\n// Do not edit by hand.\nimport type { StatTypesFile } from './PacketFactory.js';\n\n",
        'statTypes',
        'StatTypesFile',
        readJson('data/stat-types.json'),
      ),
    },
    {
      out: 'src/packets/packetStatus.generated.ts',
      content: emitModule(
        '// Auto-generated from data/packet-status.json.\n// Do not edit by hand.\n\n',
        'packetStatus',
        'Record<string, string>',
        readJson('data/packet-status.json'),
      ),
    },
    {
      out: 'src/packets/packetLabNameOnly.generated.ts',
      content: emitModule(
        '// Auto-generated from data/packet-lab-name-only.json.\n// Do not edit by hand.\n\n',
        'packetLabNameOnly',
        '{ packets: Array<{ name: string; direction: string; id?: number }> }',
        readJson('data/packet-lab-name-only.json'),
      ),
    },
    {
      out: 'packages/protocol/src/generated/packet-map.ts',
      content: generatePacketMap(defs),
      // The header comment names the canonical source and legitimately differs
      // from whatever preceded it; only the body below this marker is contractual.
      compareFrom: 'export const PACKET_MAP: PacketMap = {',
    },
  ];
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function sliceForCompare(text, marker) {
  if (!marker) return text;
  const i = text.indexOf(marker);
  return i === -1 ? text : text.slice(i);
}

function firstDiff(expected, actual) {
  const a = expected.split('\n');
  const b = actual.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return `  line ${i + 1}:\n    on disk:   ${JSON.stringify(b[i])}\n    generated: ${JSON.stringify(a[i])}`;
    }
  }
  return `  line count differs: on disk ${b.length}, generated ${a.length}`;
}

const check = process.argv.includes('--check');
const artifacts = buildArtifacts();
let failed = 0;

for (const artifact of artifacts) {
  const abs = path.join(CLIENT_ROOT, artifact.out);
  if (check) {
    const disk = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    const want = sliceForCompare(artifact.content, artifact.compareFrom);
    const have = sliceForCompare(disk, artifact.compareFrom);
    if (want !== have) {
      failed++;
      console.error(`[gen-packet-artifacts] DRIFT: ${artifact.out}`);
      console.error(firstDiff(want, have));
    }
  } else {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, artifact.content);
  }
}

if (check) {
  if (failed) {
    console.error(`\n[gen-packet-artifacts] ${failed} artifact(s) out of date. Fix with: npm run gen:packets`);
    process.exit(1);
  }
  console.log(`[gen-packet-artifacts] OK — all ${artifacts.length} artifacts match the canonical data.`);
} else {
  console.log(`[gen-packet-artifacts] wrote ${artifacts.length} artifacts from data/packet-definitions.json`);
}
