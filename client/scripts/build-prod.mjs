/**
 * Production build script for Realm Engine v1.
 *
 * Pipeline:
 *   1. Clean dist/
 *   2. Build C++ DLL via MSBuild (Release|x64)
 *   3. Copy the built DLL → assets/realm-engine.dll (plain — open source, no encryption)
 *   4. Bundle core app with esbuild
 *   5. Bundle each plugin individually (plugins/*.ts -> dist/plugins/*.js)
 *   6. Stage dist/public + inject __ADMIN_BUILD__ flag
 */

import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, copyFileSync, existsSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';

const ADMIN_BUILD = process.argv.includes('--admin');

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const PLUGINS_SRC = join(ROOT, 'plugins');
const PLUGINS_DIST = join(DIST, 'plugins');
const DATA_DIR = join(ROOT, 'data');

// Locate the internal DLL repo as a sibling of this one. Supports both the
// canonical RealmEngineRotmg/internal clone name and the legacy DebugInternal
// layout. INTERNAL_DIR env var wins if set.
function findInternalDir() {
  const override = process.env.INTERNAL_DIR;
  if (override) return resolve(override);
  for (const name of ['internal', 'DebugInternal']) {
    const p = resolve(ROOT, '..', name);
    if (existsSync(join(p, 'il2cpp-dll-injection.sln'))) return p;
  }
  return resolve(ROOT, '..', 'internal');
}
const INTERNAL_DIR = findInternalDir();
const DLL_SLN = join(INTERNAL_DIR, 'il2cpp-dll-injection.sln');
const DLL_DEST = join(ROOT, 'assets', 'realm-engine.dll');
// The .vcxproj OutDir (TargetName=realm-engine) writes realm-engine.dll straight
// into client/assets/ (= DLL_DEST). Older project configs emitted it under
// internal/x64/Release/ instead, so accept either — assets first (that's where a
// current build lands), legacy path as a fallback. Only copy when the build
// didn't already land it.
const DLL_BUILD_CANDIDATES = [
  DLL_DEST,
  join(INTERNAL_DIR, 'x64', 'Release', 'realm-engine.dll'),
];
const PACKET_DEFINITIONS_JSON = readFileSync(join(DATA_DIR, 'packet-definitions.json'), 'utf8');
const STAT_TYPES_JSON = readFileSync(join(DATA_DIR, 'stat-types.json'), 'utf8');
const SERVERS_JSON = readFileSync(join(DATA_DIR, 'servers.json'), 'utf8');

const EXCLUDED_PLUGINS = new Set([
  'auto-drink',    // directory plugin (plugins/auto-drink/), excluded from prod for now
]);
const ADMIN_ONLY_PLUGINS = new Set([
  'auto-ability.ts',
  'packet-logger.ts',
]);

function log(msg) {
  console.log(`[build-prod] ${msg}`);
}

function fileSize(path) {
  try { return (statSync(path).size / 1024).toFixed(1) + ' KB'; }
  catch { return '?'; }
}

// ── Step 1: Clean ────────────────────────────────────────────────────────────

log(`Build mode: ${ADMIN_BUILD ? 'ADMIN (dev features included)' : 'USER (admin features stripped)'}`);
log('Cleaning dist/...');
rmSync(DIST, { recursive: true, force: true });
mkdirSync(PLUGINS_DIST, { recursive: true });

// ── Step 2: Build C++ DLL ────────────────────────────────────────────────────

log('Building C++ DLL (Release|x64)...');
if (!existsSync(DLL_SLN)) {
  console.error(`[build-prod] ERROR: Solution not found: ${DLL_SLN}`);
  process.exit(1);
}

// Locate MSBuild: prefer PATH, then vswhere, then common hard-coded paths.
function findMSBuild() {
  // 1. Already on PATH (Developer Command Prompt)?
  try { execSync('msbuild /version /nologo', { stdio: 'pipe' }); return 'msbuild'; } catch {}

  // 2. vswhere (ships with VS 2017+ installer, always at this fixed location).
  // -prerelease lets it discover VS2026 previews; we drop -requires because
  // some VS2026 installs report different component IDs.
  const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
  if (existsSync(vswhere)) {
    for (const args of [
      '-latest -prerelease -find MSBuild\\**\\Bin\\MSBuild.exe',
      '-latest -prerelease -requires Microsoft.Component.MSBuild -find MSBuild\\**\\Bin\\MSBuild.exe',
      '-latest -requires Microsoft.Component.MSBuild -find MSBuild\\**\\Bin\\MSBuild.exe',
    ]) {
      try {
        const found = execSync(`"${vswhere}" ${args}`, { stdio: 'pipe' })
          .toString().trim().split('\n')[0].trim();
        if (found && existsSync(found)) return `"${found}"`;
      } catch {}
    }
  }

  // 3. Hard-coded fallbacks. VS2026 internal version is 18 — the installer puts
  // BuildTools at \18\BuildTools rather than \2026\BuildTools.
  const candidates = [
    // VS2026 (internal version 18)
    'C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise\\MSBuild\\Current\\Bin\\MSBuild.exe',
    'C:\\Program Files\\Microsoft Visual Studio\\18\\Professional\\MSBuild\\Current\\Bin\\MSBuild.exe',
    'C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe',
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\18\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe',
    // VS2022
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\MSBuild\\Current\\Bin\\MSBuild.exe',
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\MSBuild\\Current\\Bin\\MSBuild.exe',
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe',
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe',
  ];
  for (const c of candidates) if (existsSync(c)) return `"${c}"`;

  return null;
}

const msbuild = findMSBuild();
if (!msbuild) {
  console.error('[build-prod] ERROR: MSBuild not found. Install Visual Studio 2022 or 2026 (any edition) or Build Tools.');
  console.error('[build-prod] Alternatively, run this script from a Developer Command Prompt.');
  process.exit(1);
}
log(`Using MSBuild: ${msbuild}`);

try {
  // /t:Rebuild (not incremental): guarantees the shipped DLL matches this exact
  // source tree rather than a stale incremental object. 10 min: a clean full
  // compile of the DLL (~7000+ functions) can exceed the old 2-minute cap,
  // especially on CI or after node-gyp wipes caches.
  execSync(
    `${msbuild} "${DLL_SLN}" /t:Rebuild /p:Configuration=Release /p:Platform=x64 /m /v:minimal`,
    { stdio: 'inherit', timeout: 600000 }
  );
} catch (err) {
  console.error('[build-prod] ERROR: MSBuild failed.');
  process.exit(1);
}

const dllBuilt = DLL_BUILD_CANDIDATES.find((p) => existsSync(p));
if (!dllBuilt) {
  console.error(
    `[build-prod] ERROR: DLL not found after build. Looked in:\n  ${DLL_BUILD_CANDIDATES.join('\n  ')}`
  );
  process.exit(1);
}

log(`DLL built: ${fileSize(dllBuilt)}`);

// ── Step 4: Ship DLL (plain — open source) ───────────────────────────────────

// Open source: the DLL is shipped unencrypted as assets/realm-engine.dll. The
// runtime deploy path (index.ts) resolves assets/realm-engine.dll, so no
// decryption step or embedded key is needed. When the .vcxproj already emits
// into assets/ the "copy" is a no-op (self-copy would throw), so skip it.
mkdirSync(join(ROOT, 'assets'), { recursive: true });
if (resolve(dllBuilt) !== resolve(DLL_DEST)) {
  copyFileSync(dllBuilt, DLL_DEST);
  log(`DLL copied → assets/realm-engine.dll (${fileSize(DLL_DEST)})`);
} else {
  log(`DLL already in assets/realm-engine.dll (${fileSize(DLL_DEST)})`);
}

// ── Step 5: Bundle core ──────────────────────────────────────────────────────

log('Bundling core application...');
await esbuild.build({
  entryPoints: [join(ROOT, 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: join(DIST, 'app.cjs'),
  minify: true,
  sourcemap: false,
  treeShaking: true,
  // 'electron' MUST be external — bundling it pulls in node_modules/electron/
  // index.js (the launcher stub for *spawning* electron from outside) and
  // throws "Electron failed to install correctly" at runtime inside the
  // packaged app. Marked external so `import { shell } from 'electron'`
  // resolves to electron's built-in module loader at runtime.
  external: ['koffi', 'sharp', 'electron'],
  // esbuild CJS output replaces import.meta with {}, making import.meta.url = undefined.
  // Inject a shim at the top of the bundle and point define at it so
  // dirname(fileURLToPath(import.meta.url)) resolves to the bundle's own directory.
  banner: {
    js: 'var __importMetaUrl=require("url").pathToFileURL(__filename).href;',
  },
  define: {
    PRODUCTION: '"true"',
    __ADMIN_BUILD__: String(ADMIN_BUILD),
    __PACKET_DEFINITIONS_JSON__: JSON.stringify(PACKET_DEFINITIONS_JSON),
    __STAT_TYPES_JSON__: JSON.stringify(STAT_TYPES_JSON),
    __SERVERS_JSON__: JSON.stringify(SERVERS_JSON),
    'import.meta.url': '__importMetaUrl',
  },
  logLevel: 'warning',
});
log(`Core bundled: ${fileSize(join(DIST, 'app.cjs'))}`);

// ── Step 6: Bundle plugins ───────────────────────────────────────────────────

log('Bundling plugins...');
const excludedPluginFiles = new Set(EXCLUDED_PLUGINS);
if (!ADMIN_BUILD) {
  for (const file of ADMIN_ONLY_PLUGINS)
    excludedPluginFiles.add(file);
}
// Discover plugins: top-level `*.ts` files, plus directory plugins
// (`<name>/index.ts`, bundled to `<name>.js`). Exclusion is keyed by the file
// name for files and by the folder name for directory plugins.
const pluginEntries = [];
for (const name of readdirSync(PLUGINS_SRC)) {
  const full = join(PLUGINS_SRC, name);
  const st = statSync(full);
  if (st.isFile()) {
    if (name.endsWith('.ts') && !excludedPluginFiles.has(name)) {
      pluginEntries.push({ entry: full, outName: name.replace(/\.ts$/, '.js') });
    }
  } else if (st.isDirectory() && !excludedPluginFiles.has(name)) {
    const indexEntry = join(full, 'index.ts');
    if (existsSync(indexEntry)) {
      pluginEntries.push({ entry: indexEntry, outName: `${name}.js` });
    }
  }
}

for (const { entry, outName } of pluginEntries) {
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile: join(PLUGINS_DIST, outName),
    minify: true,
    sourcemap: false,
    treeShaking: true,
    // 'electron' MUST be external — bundling it pulls in node_modules/electron/
    // index.js (the launcher stub for *spawning* electron from outside) and
    // throws "Electron failed to install correctly" at runtime inside the
    // packaged app. Marked external so `import { shell } from 'electron'`
    // resolves to electron's built-in module loader at runtime.
    external: ['koffi', 'sharp', 'electron'],
    define: {
      __ADMIN_BUILD__: String(ADMIN_BUILD),
      __PACKET_DEFINITIONS_JSON__: JSON.stringify(PACKET_DEFINITIONS_JSON),
      __STAT_TYPES_JSON__: JSON.stringify(STAT_TYPES_JSON),
      __SERVERS_JSON__: JSON.stringify(SERVERS_JSON),
    },
    logLevel: 'warning',
  });
}
log(`${pluginEntries.length} plugins bundled`);

// ── Step 7: Strip admin features from dashboard (user builds only) ───────────

// Copy src/dashboard/public → dist/public (staging copy — never modify source)
const PUBLIC_SRC = join(ROOT, 'src', 'dashboard', 'public');
const PUBLIC_DIST = join(DIST, 'public');
mkdirSync(PUBLIC_DIST, { recursive: true });
for (const f of readdirSync(PUBLIC_SRC)) {
  const src = join(PUBLIC_SRC, f);
  if (statSync(src).isFile()) copyFileSync(src, join(PUBLIC_DIST, f));
}
// Copy subdirectories (e.g. enchantments/)
for (const f of readdirSync(PUBLIC_SRC)) {
  const src = join(PUBLIC_SRC, f);
  if (statSync(src).isDirectory()) {
    const destDir = join(PUBLIC_DIST, f);
    mkdirSync(destDir, { recursive: true });
    for (const sub of readdirSync(src)) {
      const subSrc = join(src, sub);
      if (statSync(subSrc).isFile()) copyFileSync(subSrc, join(destDir, sub));
    }
  }
}

// Inject __ADMIN_BUILD__ flag into app.js (CSS hides admin-only elements;
// JS uses the flag to lock out admin mode entirely in user builds).
// HTML is NOT stripped — removing elements breaks JS event listeners.
{
  const appJsPath = join(PUBLIC_DIST, 'app.js');
  if (existsSync(appJsPath)) {
    let js = readFileSync(appJsPath, 'utf-8');
    js = `var __ADMIN_BUILD__=${ADMIN_BUILD};\n` + js;
    writeFileSync(appJsPath, js);
  }
  log(ADMIN_BUILD ? 'Admin build — all features enabled' : 'User build — admin features locked');
}

// ── Done ─────────────────────────────────────────────────────────────────────

log('');
log('Production build complete!');
log('');
log('Output:');
log(`  Core:      dist/app.cjs (${fileSize(join(DIST, 'app.cjs'))})`);
log(`  Plugins:   dist/plugins/ (${pluginEntries.length} files)`);
log(`  DLL:       assets/realm-engine.dll (${fileSize(DLL_DEST)})`);
log('');
log('Run "npm run dist" to package with electron-builder.');
