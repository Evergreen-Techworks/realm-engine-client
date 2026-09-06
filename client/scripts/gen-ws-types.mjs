// Generates the browser companion for the dashboard WebSocket message-type
// names from the single TS source of truth.
//
//   source : src/dashboard/wsMessageTypes.ts   (exported `WS_MSG` object)
//   output : src/dashboard/public/ws-message-types.js  (`window.WS_MSG`)
//
// The browser `app.js` is served as-is (no bundler), so it can't import the TS
// directly; index.html loads the generated companion as a classic <script>
// before app.js, exposing the identical map on window.WS_MSG. Run this whenever
// wsMessageTypes.ts changes:  node scripts/gen-ws-types.mjs
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src', 'dashboard', 'wsMessageTypes.ts');
const OUT = join(here, '..', 'src', 'dashboard', 'public', 'ws-message-types.js');

const ts = readFileSync(SRC, 'utf8');
const body = ts.slice(ts.indexOf('Object.freeze({'));
const pairs = [];
const re = /([A-Z0-9_]+):\s*'([^']*)'/g;
let m;
while ((m = re.exec(body)) !== null) pairs.push([m[1], m[2]]);
if (pairs.length === 0) {
  throw new Error('gen-ws-types: no WS_MSG entries parsed from ' + SRC);
}

const lines = pairs.map(([k, v]) => `  ${k}: ${JSON.stringify(v)},`).join('\n');
const out = `// AUTO-GENERATED from src/dashboard/wsMessageTypes.ts by scripts/gen-ws-types.mjs.
// Do NOT edit by hand — edit wsMessageTypes.ts and re-run the generator.
// Loaded as a classic <script> before app.js so app.js can read window.WS_MSG.
window.WS_MSG = Object.freeze({
${lines}
});
`;
writeFileSync(OUT, out);
console.log('gen-ws-types: wrote ' + pairs.length + ' entries to ' + OUT);
