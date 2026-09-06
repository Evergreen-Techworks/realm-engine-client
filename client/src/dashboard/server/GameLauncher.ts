import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { execFileSync, spawn } from 'child_process';
import { Logger } from '../../util/Logger.js';
import { getClientToken } from '../../util/Hwid.js';
import { registerCredentialLaunch } from '../process/credentialLaunchRegistry.js';
import { moveRotmgLaunchedWindowAfterSpawn } from '../process/rotmgWindowsClientTune.js';

/**
 * Count running processes matching an image name, locale-independently.
 *
 * `tasklist` prints a localized "no tasks are running" notice (English "INFO:",
 * German "INFORMATION:", Spanish "INFORMACIÓN:", Japanese "情報:", …) to stdout —
 * and exits 0 — when nothing matches the filter. We must NOT blacklist that prose
 * by its English "INFO:" prefix: on a non-English PC the prefix differs, the line
 * survives, and the count is a false 1. Instead count only genuine CSV process
 * rows, identified by their first quoted field ("RotMG Exalt.exe","1234",…); the
 * notice is unquoted prose, so this is correct on every UI language.
 */
function countRunningProcessesByImageName(imageName: string): number {
  try {
    const output = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const normalize = (s: string): string => s.replace(/\u00A0/g, ' ').trim().toLowerCase();
    const target = normalize(imageName);
    return String(output || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => {
        const m = line.match(/^"([^"]*)"/);
        return m !== null && normalize(m[1]) === target;
      }).length;
  } catch (err) {
    Logger.warn('GameLauncher', `Failed to inspect ${imageName} processes: ${(err as Error).message}`);
    return 0;
  }
}

/**
 * Encapsulates game launch logic: path detection, process counting, single-client
 * enforcement, Steam AppID management, plain and credential-based launch.
 * Extracted from DevServer to isolate game-launch responsibility.
 *
 * Constructor dependencies are getter callbacks so GameLauncher stays decoupled
 * from DevServer's config/state management.
 */
export class GameLauncher {
  constructor(
    private readonly getRotmgPath: () => string | null,
    private readonly isSingleClientOnly: () => boolean,
    private readonly verifyAccount: (
      email: string,
      password: string,
      clientToken: string,
      steam?: { steamId: string },
    ) => Promise<
      | { token: string; tokenTimestamp: string; tokenExpiration: string }
      | { error: string }
    >,
  ) {}

  getRunningProcessCount(imageName: string): number {
    return countRunningProcessesByImageName(imageName);
  }

  getRunningRotmgExaltProcessCount(): number {
    return this.getRunningProcessCount('RotMG Exalt.exe');
  }

  terminateProcessByImageName(imageName: string): boolean {
    try {
      execFileSync('taskkill', ['/IM', imageName, '/F'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      return true;
    } catch (err) {
      // taskkill exits non-zero when the image simply isn't running. Detect that
      // structurally — its "not found"/"no running instance" text is localized by
      // the Windows UI language, so matching English substrings mislabels the
      // benign no-op as a real failure on non-English PCs.
      if (countRunningProcessesByImageName(imageName) === 0) {
        return false;
      }
      Logger.warn('GameLauncher', `Failed to terminate ${imageName}: ${String((err as Error).message || '')}`);
      return false;
    }
  }

  getSingleClientLaunchBlockError(): string | null {
    if (!this.isSingleClientOnly()) return null;
    if (this.getRunningRotmgExaltProcessCount() < 1) return null;
    return 'Close the existing RotMG Exalt process and launch again. We only support 1 account at a time right now, but later multiple accounts with proxies will be supported.';
  }

  /**
   * When the configured install is the Steam build of RotMG Exalt, ensure a
   * `steam_appid.txt` sits next to the exe before we launch it directly.
   *
   * Without it, the Steam build's early `SteamAPI_RestartAppIfNecessary` call
   * quits the process we just spawned and relaunches a *fresh* one through
   * Steam — which orphans the winhttp.dll hook's launcher-PID correlation and
   * loses our credential-launch tracking. With the file present, a direct spawn
   * initializes Steamworks against the already-running Steam client and stays in
   * the same process, so our inject + PID tracking hold.
   *
   * The AppID is read from the install's own Steam appmanifest (never
   * hardcoded), so it stays correct even if Deca re-IDs the app. This is a
   * strict no-op for the standalone (Deca-launcher) install — that build must
   * NOT have this file, and it has no `steamapps` ancestor so we never write it.
   */
  ensureSteamAppIdFile(gamePath: string): void {
    try {
      // The game lives at <steamapps>/common/<installdir>. Walk up looking for
      // that exact "common under steamapps" shape; bail if it isn't one.
      let steamAppsDir: string | null = null;
      let dir = gamePath;
      for (let i = 0; i < 6; i++) {
        const parent = dirname(dir);
        if (!parent || parent === dir) break;
        if (basename(dir).toLowerCase() === 'common' && basename(parent).toLowerCase() === 'steamapps') {
          steamAppsDir = parent;
          break;
        }
        dir = parent;
      }
      if (!steamAppsDir) return; // Standalone/Deca install → leave it alone.

      const appIdPath = join(gamePath, 'steam_appid.txt');
      if (existsSync(appIdPath)) return; // Steam itself, or a prior run, already wrote it.

      const installDirName = basename(gamePath).toLowerCase();
      let appId: string | null = null;
      for (const entry of readdirSync(steamAppsDir)) {
        const m = /^appmanifest_(\d+)\.acf$/i.exec(entry);
        if (!m) continue;
        const acf = readFileSync(join(steamAppsDir, entry), 'utf8');
        const installDir = acf.match(/"installdir"\s+"([^"]+)"/i)?.[1]?.trim().toLowerCase();
        if (installDir && installDir === installDirName) {
          appId = m[1];
          break;
        }
      }
      if (!appId) {
        Logger.warn('GameLauncher', `Steam install detected but no appmanifest matched "${basename(gamePath)}"; skipping steam_appid.txt.`);
        return;
      }
      writeFileSync(appIdPath, appId, 'utf8');
      Logger.log('GameLauncher', `Wrote steam_appid.txt (AppID ${appId}) for Steam-build direct launch.`);
    } catch (err) {
      Logger.warn('GameLauncher', `ensureSteamAppIdFile failed: ${(err as Error).message}`);
    }
  }

  /**
   * Launch the RotMG Exalt executable.
   */
  launchGame(): { ok: boolean; error?: string } {
    const launchBlockError = this.getSingleClientLaunchBlockError();
    if (launchBlockError) {
      return { ok: false, error: launchBlockError };
    }
    const gamePath = this.getRotmgPath();
    if (!gamePath) {
      return { ok: false, error: 'RotMG path not configured and auto-detection failed.' };
    }

    const exePath = join(gamePath, 'RotMG Exalt.exe');
    if (!existsSync(exePath)) {
      return { ok: false, error: `RotMG Exalt.exe not found at: ${exePath}` };
    }

    this.ensureSteamAppIdFile(gamePath);

    try {
      const child = spawn(exePath, [], {
        cwd: gamePath,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      Logger.log('GameLauncher', `Launched RotMG from: ${exePath}`);
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      Logger.error('GameLauncher', `Failed to launch RotMG: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  private clampLaunchWindowSize(n: number, min: number, max: number): number {
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  /**
   * Windowed launch extras for Unity player (width/height always honored; x/y best-effort — not all builds respect them).
   */
  private buildCredentialLaunchWindowExtras(opts?: {
    compactWindow?: boolean;
    windowRect?: { x: number; y: number; width: number; height: number };
  }): string[] {
    const rect = opts?.windowRect;
    if (rect && Number.isFinite(rect.width) && Number.isFinite(rect.height)) {
      const w = this.clampLaunchWindowSize(rect.width, 320, 7680);
      const h = this.clampLaunchWindowSize(rect.height, 240, 4320);
      const x = this.clampLaunchWindowSize(rect.x, -32000, 32000);
      const y = this.clampLaunchWindowSize(rect.y, -32000, 32000);
      return [
        '-screen-fullscreen',
        '0',
        '-screen-width',
        String(w),
        '-screen-height',
        String(h),
        '-screen-x',
        String(x),
        '-screen-y',
        String(y),
        '-popupwindow',
        '-nolog',
      ];
    }
    if (opts?.compactWindow) {
      return ['-screen-fullscreen', '0', '-screen-width', '640', '-screen-height', '360', '-popupwindow', '-nolog'];
    }
    return [];
  }

  /**
   * Verify with Deca then launch RotMG Exalt with token-based args (LoginGUI-style: verify only, no bind).
   * @param compactWindow Unity window size below in-game minimum (MAC multibox launch sidebar).
   * @param windowRect Optional pixel placement + size (virtual desktop coords from dashboard layout editor).
   */
  async launchGameWithCredentials(
    email: string,
    password: string,
    serverName: string,
    opts?: {
      compactWindow?: boolean;
      windowRect?: { x: number; y: number; width: number; height: number };
      /** Dashboard saved-account id when the client sends it */
      accountId?: string | null;
      /** Dashboard display label when the client sends it */
      accountLabel?: string | null;
      /** When true, authenticate via Steam (requires steamId). */
      isSteam?: boolean;
      /** Steam ID 64 (decimal string) — required when isSteam is true. */
      steamId?: string;
    },
  ): Promise<{ ok: boolean; error?: string }> {
    const launchBlockError = this.getSingleClientLaunchBlockError();
    if (launchBlockError) {
      return { ok: false, error: launchBlockError };
    }
    const gamePath = this.getRotmgPath();
    if (!gamePath) {
      return { ok: false, error: 'RotMG path not configured and auto-detection failed.' };
    }

    const exePath = join(gamePath, 'RotMG Exalt.exe');
    if (!existsSync(exePath)) {
      return { ok: false, error: `RotMG Exalt.exe not found at: ${exePath}` };
    }

    const clientToken = getClientToken();
    if (!clientToken) {
      return { ok: false, error: 'Client token unavailable.' };
    }

    const steamId = String(opts?.steamId || '').trim();
    if (opts?.isSteam && !steamId) {
      return { ok: false, error: 'Steam ID is required for Steam accounts.' };
    }
    const steamConfig = opts?.isSteam ? { steamId } : undefined;

    const verifyResult = await this.verifyAccount(email, password, clientToken, steamConfig);
    if ('error' in verifyResult) {
      return { ok: false, error: verifyResult.error };
    }

    const { token, tokenTimestamp, tokenExpiration } = verifyResult;

    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
    // platform stays `Deca` even for Steam accounts: this is a token launch, so
    // the account is already authenticated and the access token Deca returned is
    // provider-agnostic (it works for char-list, servers, and game connect the
    // same way regardless of whether we verified via email or Steam secret).
    // `platform:Steam` would additionally make the client try to init the Steam
    // overlay/ticket path, which needs the Steam client running — the opposite
    // of what this bypass launch is for. Do not change without runtime-testing.
    const args = `data:{platform:Deca,guid:${b64(email)},token:${b64(token)},tokenTimestamp:${b64(tokenTimestamp)},tokenExpiration:${b64(tokenExpiration)},env:4,serverName:${serverName}}`;
    const windowExtras = this.buildCredentialLaunchWindowExtras(opts);
    const launchedAtIso = new Date().toISOString();

    this.ensureSteamAppIdFile(gamePath);

    try {
      const child = spawn(exePath, [args, ...windowExtras], {
        cwd: gamePath,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      const wr = opts?.windowRect;
      const launcherPid = typeof child.pid === 'number' ? child.pid : -1;
      if (launcherPid > 0) {
        registerCredentialLaunch({
          launcherPid,
          accountId: opts?.accountId ?? null,
          accountLabel: opts?.accountLabel ?? null,
          email,
        });
      }
      if (wr && process.platform === 'win32' && launcherPid > 0) {
        window.setTimeout(() => {
          void moveRotmgLaunchedWindowAfterSpawn(launcherPid, wr, { email, launchedAtIso }).then((pos) => {
            if (pos.ok) {
              Logger.log(
                'GameLauncher',
                `Positioned credential launch window via Win32 (launcher PID ${launcherPid}, ${wr.width}×${wr.height} @ ${wr.x},${wr.y})`,
              );
            } else {
              Logger.warn(
                'GameLauncher',
                `Post-launch window move failed (launcher PID ${launcherPid}). ${pos.debug ?? ''}`.slice(0, 2000),
              );
            }
          });
        }, 500);
      }
      const logSuffix = wr
        ? ` (${wr.width}×${wr.height} @ ${wr.x},${wr.y})`
        : opts?.compactWindow
          ? ' (640×360 compact)'
          : '';
      Logger.log('GameLauncher', `Launched RotMG with credentials${logSuffix} from: ${exePath}`);
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      Logger.error('GameLauncher', `Failed to launch RotMG: ${msg}`);
      return { ok: false, error: msg };
    }
  }
}
