import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { Logger } from './Logger.js';

/**
 * SDK deployment to Documents.
 *
 * The packaged SDK (resources/sdk/) contains the full user SDK:
 *   - sdk/dist/index.js      - bridge stub entrypoint
 *   - sdk/dist JS files      - compiled fallback/submodule implementations
 *   - sdk/dist/types/        - TypeScript autocomplete
 *   - sdk/package.json       - version info
 *
 * Scripts can accidentally shadow the managed SDK with
 * Documents/Realmengine/Scripts/node_modules/@realmengine/sdk. Since Node
 * resolves that before Documents/Realmengine/node_modules, keep known shadow
 * installs synchronized too.
 */

const VERSION_FILE = 'sdk-version.txt';

function repoRoot(): string {
  return process.env.REALM_ENGINE_APP_ROOT
    ? resolve(process.env.REALM_ENGINE_APP_ROOT)
    : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** Find the packaged SDK directory (resources/ or dev source). */
function findPackagedSdkDir(): string | null {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

  const candidates = [
    // Packaged mode: electron-builder extraResources copies packages/sdk/ to resources/sdk/.
    resourcesPath ? join(resourcesPath, 'sdk') : '',
    process.env.REALM_ENGINE_ROOT ? join(resolve(process.env.REALM_ENGINE_ROOT), 'sdk') : '',
    // Dev mode: packages/sdk/.
    join(repoRoot(), 'packages', 'sdk'),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (existsSync(join(dir, 'package.json'))) return dir;
  }

  return null;
}

function findPackagedScriptsDir(): string | null {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    resourcesPath ? join(resourcesPath, 'script-packages') : '',
    join(repoRoot(), 'script-packages'),
  ].filter(Boolean);
  return candidates.find((dir) => existsSync(dir)) ?? null;
}

function deployStarterScripts(realmengineDir: string): void {
  const sourceRoot = findPackagedScriptsDir();
  if (!sourceRoot) return;
  const targetRoot = join(realmengineDir, 'Scripts');
  mkdirSync(targetRoot, { recursive: true });
  // One-time migration from the quest-only prototype to the complete Farmer.
  const legacy = join(targetRoot, 'level-20-quest-farmer');
  if (existsSync(legacy)) {
    try {
      const manifest = JSON.parse(readFileSync(join(legacy, 'realmengine.script.json'), 'utf8'));
      if (String(manifest?.developer ?? '') === 'Realm Engine') {
        rmSync(legacy, { recursive: true, force: true });
      }
    } catch { /* preserve unknown/user-owned folders */ }
  }
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = join(sourceRoot, entry.name);
    const target = join(targetRoot, entry.name);
    // Update Realm Engine's managed starter package, but never replace a
    // third-party script that happens to use the same folder name.
    if (existsSync(target)) {
      try {
        const manifest = JSON.parse(readFileSync(join(target, 'realmengine.script.json'), 'utf8'));
        if (String(manifest?.developer ?? '') !== 'Realm Engine') continue;
        rmSync(target, { recursive: true, force: true });
      } catch {
        continue;
      }
    }
    cpSync(source, target, { recursive: true });
    Logger.log('SDK', `Installed/updated starter script: ${entry.name}`);
  }
}

/** Read version from an SDK package.json. */
function readSdkVersion(sdkDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8'));
    return String(pkg.version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function sdkMatchesPackaged(packagedSdkDir: string, targetDir: string, packagedVersion: string): boolean {
  if (!existsSync(join(targetDir, 'package.json'))) return false;
  if (!existsSync(join(targetDir, 'dist', 'index.js'))) return false;
  if (!existsSync(join(targetDir, 'dist', 'types', 'index.d.ts'))) return false;
  if (readSdkVersion(targetDir) !== packagedVersion) return false;

  const sentinelFiles = [
    join('dist', 'index.js'),
    join('dist', 'ui', 'Panel.js'),
    join('dist', 'types', 'ui', 'Panel.d.ts'),
    join('src', 'ui', 'Panel.ts'),
  ];

  return sentinelFiles.every((file) => {
    const packagedText = readText(join(packagedSdkDir, file));
    const installedText = readText(join(targetDir, file));
    return packagedText != null && packagedText === installedText;
  });
}

/** Copy the entire packaged SDK to the target. */
function copySdkToDocuments(sdkDir: string, targetDir: string): void {
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
  }

  mkdirSync(targetDir, { recursive: true });
  cpSync(sdkDir, targetDir, { recursive: true });
}

function findShadowSdkDirs(realmengineDir: string): string[] {
  const scriptsDir = join(realmengineDir, 'Scripts');
  const dirs = [
    join(scriptsDir, 'node_modules', '@realmengine', 'sdk'),
  ];

  if (!existsSync(scriptsDir)) return dirs;

  try {
    for (const entry of readdirSync(scriptsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue;
      }

      const localSdk = join(scriptsDir, entry.name, 'node_modules', '@realmengine', 'sdk');
      if (existsSync(localSdk)) dirs.push(localSdk);
    }
  } catch {
    // Shared SDK deployment still covers scripts without a local node_modules SDK.
  }

  return dirs;
}

/** List installed files in the Documents SDK directory (for logging). */
function listInstalledFiles(targetDir: string): string[] {
  try {
    return readdirSync(targetDir, { recursive: true })
      .filter((f) => typeof f === 'string')
      .map((f) => String(f));
  } catch {
    return [];
  }
}

export function ensureSdkDeployed(): void {
  const userDir = process.env.USERPROFILE || homedir();
  const realmengineDir = join(userDir, 'Documents', 'Realmengine');
  deployStarterScripts(realmengineDir);
  const sdkTargetDir = join(realmengineDir, 'node_modules', '@realmengine', 'sdk');
  const versionFilePath = join(realmengineDir, VERSION_FILE);

  const packagedSdkDir = findPackagedSdkDir();
  if (!packagedSdkDir) {
    Logger.warn('SDK', 'Packaged SDK not found; cannot deploy to Documents.');
    return;
  }

  const packagedVersion = readSdkVersion(packagedSdkDir);
  const installedVersion = existsSync(versionFilePath)
    ? readFileSync(versionFilePath, 'utf8').trim()
    : 'none';

  const targetDirs = Array.from(new Set([
    sdkTargetDir,
    ...findShadowSdkDirs(realmengineDir),
  ]));
  const staleDirs = targetDirs.filter((dir) => !sdkMatchesPackaged(packagedSdkDir, dir, packagedVersion));

  if (installedVersion === packagedVersion && staleDirs.length === 0) {
    Logger.log('SDK', `v${packagedVersion} already installed in Documents (skipping deploy).`);
    return;
  }

  Logger.log(
    'SDK',
    `Deploying SDK v${packagedVersion} to Documents (installed: ${installedVersion}; stale copies: ${staleDirs.length})...`,
  );

  try {
    for (const targetDir of staleDirs) {
      copySdkToDocuments(packagedSdkDir, targetDir);
    }
    mkdirSync(realmengineDir, { recursive: true });
    writeFileSync(versionFilePath, packagedVersion);

    const installedFiles = listInstalledFiles(sdkTargetDir);
    Logger.log(
      'SDK',
      `SDK v${packagedVersion} deployed. Updated ${staleDirs.length} location(s). Files: ${installedFiles.join(', ')}`,
    );
  } catch (err: any) {
    Logger.warn('SDK', `SDK deploy failed: ${err.message}`);
  }
}
