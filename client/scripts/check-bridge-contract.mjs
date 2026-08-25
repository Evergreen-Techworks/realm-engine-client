/**
 * check-bridge-contract.mjs — fails when the DLL's feature-key registry and the
 * client's typed feature-key lists drift apart.
 *
 * The DLL swallows unknown feature keys by design
 * (internal/src/features/control/FeatureCommandRegistry.cpp:9-10 — "Unknown keys
 * are intentionally treated as applied"), so a client→DLL key with no handler
 * produces no log and no warning: the feature simply never runs. This script is
 * the only thing that makes that class of mistake visible.
 *
 * It reads both files as TEXT — it never compiles the DLL, and it needs no
 * node_modules. Run it from `client/`:
 *
 *   node scripts/check-bridge-contract.mjs
 *
 * Exit 0 = the two sides agree (or the C++ tree is absent — a client-only
 * checkout prints SKIPPED and passes). Exit 1 = drift, with a report naming each
 * key and the direction it drifted.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const CPP_PATH = resolve(
  REPO_ROOT, 'internal', 'src', 'features', 'control', 'FeatureCommandRegistry.cpp',
);
const TS_PATH = resolve(__dirname, '..', 'src', 'bridge', 'contract.ts');

/** Below this, assume the FH macro shape changed rather than that keys vanished. */
const MIN_EXPECTED_CPP_KEYS = 100;

/** Keys declared through the FH/FH_BOOL/FH_INT/... handler-table macros. */
const FH_MACRO_KEY = /FH(?:_BOOL|_INT|_INT_BOOL|_FLOAT|_TEXT)?\s*\(\s*"([A-Za-z0-9_]+)"/g;
/** Keys matched by hand with `f.Is("...")` inside an FH body. */
const F_IS_KEY = /f\.Is\("([A-Za-z0-9_]+)"\)/g;

function collect(text, re) {
  const out = new Set();
  for (const m of text.matchAll(re)) out.add(m[1]);
  return out;
}

/** Pull one `export const NAME = [ ... ] as const;` array out of contract.ts. */
function tsArray(text, name) {
  const block = new RegExp(name + '\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const').exec(text);
  if (!block) {
    console.error(`FAIL: could not find \`${name} = [...] as const\` in ${TS_PATH}`);
    process.exit(1);
  }
  return [...block[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
}

const minus = (a, b, c) => [...a].filter((k) => !b.has(k) && !(c && c.has(k))).sort();
const intersect = (a, b) => [...a].filter((k) => b.has(k)).sort();

if (!existsSync(CPP_PATH)) {
  console.log('SKIPPED: bridge contract check — no DLL source tree at');
  console.log(`  ${CPP_PATH}`);
  console.log('SKIPPED: this is expected in a client-only checkout; not a failure.');
  process.exit(0);
}

const cppText = readFileSync(CPP_PATH, 'utf8');
const cppKeys = new Set([
  ...collect(cppText, FH_MACRO_KEY),
  ...collect(cppText, F_IS_KEY),
]);

if (cppKeys.size < MIN_EXPECTED_CPP_KEYS) {
  console.error(
    `FAIL: registry parse produced only ${cppKeys.size} keys — the FH macro shape ` +
    'changed, fix the parser (scripts/check-bridge-contract.mjs).',
  );
  process.exit(1);
}

const tsText = readFileSync(TS_PATH, 'utf8');
const sendable = tsArray(tsText, 'DLL_FEATURE_KEYS');
const dllOnly = tsArray(tsText, 'DLL_ONLY_FEATURE_KEYS');
const knownUnhandled = tsArray(tsText, 'KNOWN_UNHANDLED_FEATURE_KEYS');
const sendableSet = new Set(sendable);
const dllOnlySet = new Set(dllOnly);
const knownUnhandledSet = new Set(knownUnhandled);

const failures = [];
const report = (header, keys, hint) => {
  if (!keys.length) return;
  failures.push([header, ...keys.map((k) => `  - ${hint(k)}`)].join('\n'));
};

// 1. Client can send it, the DLL has no handler → silent no-op.
report(
  `FAIL: ${minus(sendableSet, cppKeys, knownUnhandledSet).length} key(s) in DLL_FEATURE_KEYS have no DLL handler:`,
  minus(sendableSet, cppKeys, knownUnhandledSet),
  (k) => `client can send \`${k}\` but the DLL has no handler — it will be silently ` +
    `swallowed. Add the handler, or add \`${k}\` to KNOWN_UNHANDLED_FEATURE_KEYS with an owner.`,
);

// 2. The DLL handles it, no TS list mentions it → undocumented gap.
report(
  `FAIL: ${minus(cppKeys, sendableSet, dllOnlySet).length} DLL key(s) missing from every TS list:`,
  minus(cppKeys, sendableSet, dllOnlySet),
  (k) => `the DLL handles \`${k}\` but no TS list mentions it. Add it to ` +
    'DLL_FEATURE_KEYS (if a plugin should send it) or DLL_ONLY_FEATURE_KEYS (if the ' +
    'in-game UI owns it).',
);

// 3. A key cannot be both client-sendable and DLL-only.
report(
  'FAIL: key(s) listed in both DLL_FEATURE_KEYS and DLL_ONLY_FEATURE_KEYS:',
  intersect(dllOnlySet, sendableSet),
  (k) => `\`${k}\` is in both lists — pick one.`,
);

// 4. DLL-only list has gone stale.
report(
  'FAIL: DLL_ONLY_FEATURE_KEYS entries the DLL no longer handles:',
  minus(dllOnlySet, cppKeys),
  (k) => `\`${k}\` is listed DLL-only but the DLL no longer handles it — delete it.`,
);

// 5. The ratchet: the moment someone implements a known-broken key, this list
//    must shrink, so the "known broken" note can never outlive the bug.
report(
  'FAIL: KNOWN_UNHANDLED_FEATURE_KEYS entries the DLL now handles:',
  intersect(knownUnhandledSet, cppKeys),
  (k) => `\`${k}\` is listed as unhandled but the DLL now handles it — remove it ` +
    'from KNOWN_UNHANDLED_FEATURE_KEYS.',
);

// 6. DLL_FEATURE_KEYS hygiene — sorted and duplicate-free, so diffs stay readable.
{
  const dupes = sendable.filter((k, i) => sendable.indexOf(k) !== i);
  const unsorted = [...sendable].sort().join('\0') !== sendable.join('\0');
  if (dupes.length) {
    report('FAIL: DLL_FEATURE_KEYS has duplicates:', [...new Set(dupes)].sort(),
      (k) => `list has duplicate \`${k}\`.`);
  }
  if (unsorted) failures.push('FAIL: DLL_FEATURE_KEYS list is not sorted.');
}

if (failures.length) {
  console.error('bridge contract DRIFT — DLL registry and contract.ts disagree.');
  console.error(`  C++ : ${CPP_PATH}`);
  console.error(`  TS  : ${TS_PATH}`);
  console.error('');
  console.error(failures.join('\n\n'));
  process.exit(1);
}

console.log(
  `bridge contract OK — ${cppKeys.size} DLL keys, ${sendable.length} client-sendable, ` +
  `${dllOnly.length} DLL-only, ${knownUnhandled.length} known-unhandled`,
);
