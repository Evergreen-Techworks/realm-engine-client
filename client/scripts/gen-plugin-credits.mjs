// Generates the plugin credits companion for the dashboard from the public
// git history of this repository (Evergreen-Techworks/realm-engine-client,
// public since its creation on 2026-05-25 — the full history counts).
//
//   source : git history of `main` + the plugin-to-path map below
//   output : src/dashboard/public/plugin-credits.js  (`window.PLUGIN_CREDITS`)
//
// The dashboard `app.js` is served as-is (no bundler), so index.html loads the
// generated companion as a classic <script> before app.js, exposing the map on
// window.PLUGIN_CREDITS. Each plugin's ⓘ credits popover reads its entry.
//
// Attribution model (user decision 2026-09-20): a plugin is credited by its
// TypeScript files AND the native (C++) feature tree it drives. Auto Dodge is
// special: credit is distributed per dodge version, plus shared-core and
// client-integration lines, so the tooltip shows who built which engine.
// Authors are GitHub logins where resolvable (noreply emails give the login
// directly; others are resolved through the GitHub commits API); a git display
// name is the fallback. Ordering is by commit count, most active first.
//
// The popover exists to credit CONTRIBUTORS, not the project owner (user
// decision 2026-09-20): his name is on the product itself, so his identities
// are filtered out of the per-plugin lists and a plugin only shows a ⓘ when
// someone else has worked on it. This repo carries no `Co-authored-by:`
// trailers (owner policy) — contributors whose work was integrated under
// owner-authored commits are credited through MANUAL_PLUGIN_AUTHORS below.
//
// Run after history changes:      node scripts/gen-plugin-credits.mjs
// Private build tree variant (adds plugins that only exist in C:\realm-engine,
// with no author list — they are the owner's own; NEVER commit that variant to
// this public repo):
//   node scripts/gen-plugin-credits.mjs --extra testlab-interleaver,testlab-recorder,testlab-runner,spoofing
import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..');
const OUT = join(here, '..', 'src', 'dashboard', 'public', 'plugin-credits.js');
const REPO_SLUG = 'Evergreen-Techworks/realm-engine-client';
const BRANCH = 'main';

// Emails GitHub can't resolve get an explicit login here (git display name is
// the fallback for anything still unknown).
const MANUAL_EMAIL_LOGINS = {
  'zackwinn10@gmail.com': 'Zaclin-GIT',
};

// The project owner is credited at the product level, not per plugin: the ⓘ
// popover lists the OTHER people who worked on a plugin. All of the owner's
// git identities are filtered by email and by resolved login.
const OWNER_LOGIN = 'jessesulo';
const OWNER_EMAILS = new Set(['sulo.jesse@outlook.com', 'jessesulo14@gmail.com']);

// Contributors whose reviewed work was integrated under owner-authored
// commits (so git history cannot see them), credited to the plugins that work
// built — this map is the mechanism for such credit; the repo does not use
// Co-authored-by trailers. ProdMafia, 2026-09: predictive AutoNexus
// observation + health evidence, and the shoot/autofire readiness bindings
// under the autoaim tree (docs/prodmafia/integration-report.md).
const MANUAL_PLUGIN_AUTHORS = {
  'auto-nexus': ['ProdMafia'],
  'auto-aim': ['ProdMafia'],
  'killaura': ['ProdMafia'],
};

// TS side of each plugin, plus the native tree it drives. Auto Dodge is built
// separately below from per-version file buckets.
const PLUGIN_PATHS = {
  'admin-autododge': ['client/plugins/admin-autododge.ts'],
  'anti-debuffs': ['client/plugins/anti-debuffs.ts'],
  'anti-lag': ['client/plugins/anti-lag.ts'],
  api: ['client/plugins/api.ts'],
  'auto-ability': ['client/plugins/auto-ability.ts', 'internal/src/features/combat/autoability/'],
  'auto-aim': ['client/plugins/auto-aim.ts', 'internal/src/features/combat/autoaim/', 'internal/src/features/combat/enemytracker/', 'internal/src/features/projectiles/ShotOrigin.cpp', 'internal/src/features/projectiles/ShotOrigin.h'],
  'auto-drink': ['client/plugins/auto-drink/'],
  'auto-follow': ['client/plugins/auto-follow.ts'],
  'auto-loot': ['client/plugins/auto-loot/', 'internal/src/features/loot/'],
  'auto-nexus': ['client/plugins/auto-nexus.ts', 'client/plugins/auto-nexus/', 'internal/src/features/combat/autonexus/'],
  'camera-controls': ['client/plugins/camera-controls.ts'],
  'chat-filter': ['client/plugins/chat-filter.ts'],
  'collider-manipulation': ['client/plugins/collider-manipulation.ts', 'internal/src/features/movement/collider/'],
  'damage-sniffer': ['client/plugins/damage-sniffer.ts'],
  'fps-setter': ['client/plugins/fps-setter.ts', 'internal/src/features/misc/FpsSetter.cpp', 'internal/src/features/misc/FpsSetter.h'],
  glow: ['client/plugins/glow.ts'],
  'ip-connect': ['client/plugins/ip-connect.ts'],
  killaura: ['client/plugins/killaura.ts', 'internal/src/features/combat/autoaim/', 'internal/src/features/projectiles/ShotOrigin.cpp', 'internal/src/features/projectiles/ShotOrigin.h'],
  'o3-helper': ['client/plugins/o3-helper.ts'],
  'packet-logger': ['client/plugins/packet-logger.ts'],
  'player-noclip': ['client/plugins/player-noclip.ts', 'internal/src/features/movement/noclip/'],
  rollback: ['client/plugins/rollback.ts'],
  'safe-visuals': ['client/plugins/safe-visuals.ts'],
  'safe-walk': ['client/plugins/safe-walk.ts'],
  'server-switch': ['client/plugins/server-switch.ts'],
  socket: ['client/plugins/socket.ts'],
  'speed-hack': ['client/plugins/speed-hack.ts', 'internal/src/features/movement/speedhack/'],
  'spoof-push-tiles': ['client/plugins/spoof-push-tiles.ts'],
};

// Auto Dodge versions → native file buckets. Labels mirror the mode list in
// client/plugins/auto-dodge.ts; XDodge carries the only third-party note we
// have on record (ported from the XRebuild/XDriver decompile).
const DODGE_MOVEMENT = 'internal/src/features/movement';
const DODGE_VERSIONS = [
  { id: 'xdodge', label: 'XDodge', note: 'Ported from the XRebuild/XDriver decompile', files: ['dodge/XDodge.cpp', 'dodge/XDodge.h'] },
  { id: 'rollout-grid', label: 'RE-Sim (grid)', files: ['dodge/RolloutDodge.cpp', 'dodge/RolloutDodge.h', 'dodge/GridThreatIndex.cpp', 'dodge/GridThreatIndex.h'] },
  { id: 'rollout-quad', label: 'RE-Sim (quadtree)', files: ['dodge/RolloutDodge.cpp', 'dodge/RolloutDodge.h', 'dodge/QuadtreeThreatIndex.cpp', 'dodge/QuadtreeThreatIndex.h'] },
  { id: 'zdodge', label: 'zDodge', files: ['zdodge/'] },
  { id: 're-plus-plus', label: 'RePP (RE++)', files: ['repp/'] },
  { id: 'pj-dodge', label: 'PJDodge', files: ['pjdodge/'] },
  { id: 'unified', label: 'UDodge (unified)', files: ['udodge/'] },
];
const DODGE_SHARED_DIRS = ['dodge/', 'sensors/', 'spacetime/'];
const DODGE_SHARED_EXCLUDE = ['dodge/XDodge.', 'dodge/RolloutDodge.', 'dodge/GridThreatIndex.', 'dodge/QuadtreeThreatIndex.'];

function git(args) {
  return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });
}

function listTree(prefix) {
  return git(['ls-tree', '-r', '--name-only', BRANCH, prefix]).split('\n').filter(Boolean);
}

// Per-file author history (unique commits per author email), following renames
// so pre-rename contributors are not lost.
const fileAuthorCache = new Map();
function fileAuthors(file) {
  if (fileAuthorCache.has(file)) return fileAuthorCache.get(file);
  const out = new Map(); // email → { name, commits:Set }
  const log = git(['log', BRANCH, '--follow', '--format=%H|%ae|%an', '--', file]);
  for (const line of log.split('\n').filter(Boolean)) {
    const [hash, email, ...nameParts] = line.split('|');
    const name = nameParts.join('|');
    if (!out.has(email)) out.set(email, { name, commits: new Set() });
    out.get(email).commits.add(hash);
    out.get(email).name = name; // keep the most recent spelling
  }
  fileAuthorCache.set(file, out);
  return out;
}

function expand(paths) {
  const files = [];
  for (const p of paths) {
    if (p.endsWith('/')) files.push(...listTree(p));
    else files.push(p);
  }
  return [...new Set(files)];
}

// Aggregate a bucket: login → commit count across its files.
function bucketAuthors(files) {
  const agg = new Map(); // email → { name, count }
  for (const f of files) {
    for (const [email, { name, commits }] of fileAuthors(f)) {
      if (!agg.has(email)) agg.set(email, { name, count: 0 });
      agg.get(email).count += commits.size;
    }
  }
  return agg;
}

// Resolve author emails to GitHub logins: noreply emails embed the login;
// the rest go through the commits API (email → linked account login).
function githubEmailLogins() {
  const map = new Map(); // email → login
  try {
    for (let page = 1; page <= 10; page++) {
      const json = JSON.parse(execFileSync('gh', ['api', `repos/${REPO_SLUG}/commits?per_page=100&page=${page}`], { encoding: 'utf8' }));
      if (!Array.isArray(json) || json.length === 0) break;
      for (const c of json) {
        const email = c.commit?.author?.email?.toLowerCase();
        const login = c.author?.login;
        if (email && login && !map.has(email)) map.set(email, login);
      }
      if (json.length < 100) break;
    }
  } catch (err) {
    console.warn('gen-plugin-credits: gh api unavailable (' + err.message.split('\n')[0] + '); falling back to git display names');
  }
  return map;
}

function display(login, email, info, emailLogins) {
  if (login) return login;
  const e = email.toLowerCase();
  if (emailLogins.has(e)) return emailLogins.get(e);
  if (MANUAL_EMAIL_LOGINS[e]) return MANUAL_EMAIL_LOGINS[e];
  return info.get(email)?.name || email;
}

function sortedNames(agg, emailLogins, manual = []) {
  const noreply = /^(\d+\+)?([^+@]+)@users\.noreply\.github\.com$/i;
  const rows = [];
  for (const [email, info] of agg.entries()) {
    if (OWNER_EMAILS.has(email.toLowerCase())) continue; // the owner is not a per-plugin credit
    const m = noreply.exec(email);
    const key = display(m ? m[2] : null, email, agg, emailLogins);
    if (key === OWNER_LOGIN) continue;
    rows.push({ key, count: info.count });
  }
  // Merge author identities that resolved to the same login.
  const byKey = new Map();
  for (const r of rows) byKey.set(r.key, (byKey.get(r.key) || 0) + r.count);
  const names = [...byKey.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  // Manual credits go last: they have no commit counts to sort by.
  for (const name of manual) if (!names.includes(name)) names.push(name);
  return names;
}

function entry(files, emailLogins, extra = {}, manual = []) {
  return { ...extra, authors: sortedNames(bucketAuthors(files), emailLogins, manual) };
}

// ---- build the credits map -------------------------------------------------

const emailLogins = githubEmailLogins();
const credits = {};

for (const [id, paths] of Object.entries(PLUGIN_PATHS)) {
  credits[id] = entry(expand(paths), emailLogins, {}, MANUAL_PLUGIN_AUTHORS[id]);
}

// Auto Dodge: per-version buckets over the movement tree, a shared-core bucket
// for the common dodge/sensors/spacetime machinery (plus the projectile store
// that feeds threat sensing), and a client-integration bucket for the plugin
// wrapper itself.
const movementFiles = listTree(DODGE_MOVEMENT);
const rel = (f) => f.slice(DODGE_MOVEMENT.length + 1);
const lines = DODGE_VERSIONS.map((v) => {
  const files = expand(v.files.map((f) => (f.endsWith('/') ? `${DODGE_MOVEMENT}/${f}` : `${DODGE_MOVEMENT}/${f}`)));
  return entry(files, emailLogins, { label: v.label, ...(v.note ? { note: v.note } : {}) });
});
const sharedFiles = movementFiles.filter((f) => {
  const r = rel(f);
  if (!DODGE_SHARED_DIRS.some((d) => r.startsWith(d))) return false;
  return !DODGE_SHARED_EXCLUDE.some((x) => r.startsWith(x));
}).concat(listTree('internal/src/features/projectiles'));
lines.push(entry(sharedFiles, emailLogins, { label: 'Shared core' }));
lines.push(entry(['client/plugins/auto-dodge.ts'], emailLogins, { label: 'Client integration' }));
credits['auto-dodge'] = { lines };

// Private-build extras: plugins that only exist in the build source tree. They
// are the owner's own work, so they carry no per-plugin author list — the ⓘ
// stays hidden until someone else contributes to them.
const extraArg = process.argv.find((a) => a.startsWith('--extra='));
if (extraArg) {
  for (const id of extraArg.slice('--extra='.length).split(',').filter(Boolean)) {
    credits[id] = { authors: [] };
  }
  console.log('gen-plugin-credits: PRIVATE variant (do not commit): ' + extraArg.slice(8));
}

const body = JSON.stringify(credits, null, 2).replace(/\n/g, '\n  ');
const out = `// AUTO-GENERATED from the git history of ${BRANCH} by scripts/gen-plugin-credits.mjs.
// Do NOT edit by hand — re-run the generator instead:
//   node scripts/gen-plugin-credits.mjs
// Loaded as a classic <script> before app.js so app.js can read
// window.PLUGIN_CREDITS for each plugin's ⓘ credits popover.
window.PLUGIN_CREDITS = Object.freeze(${body});
`;
writeFileSync(OUT, out);
const nPlugins = Object.keys(credits).length;
console.log(`gen-plugin-credits: wrote ${nPlugins} plugins (${credits['auto-dodge'].lines.length} dodge lines) to ${OUT}`);
