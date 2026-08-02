const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { spawn, fork, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { WindowHostBridge } = require('./services/window-host-bridge.cjs');
const { InstanceManager } = require('./services/instance-manager.cjs');

const APP_NAME = 'Realm Engine';
const APP_USER_MODEL_ID = 'com.realmengine.app';
const DASHBOARD_PORT = 4440;
const DASHBOARD_URL = 'http://localhost:' + DASHBOARD_PORT;
const PROXY_STARTUP_TIMEOUT = 60000;
const POLL_INTERVAL = 500;

app.setName(APP_NAME);
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}


let mainWindow = null;
let proxyProcess = null;
let proxyExitReason = null;
let proxyStderrTail = '';
const windowHostBridge = new WindowHostBridge();
const instanceManager = new InstanceManager(windowHostBridge);

function getMainWindowHwndDecimal() {
  if (!mainWindow || mainWindow.isDestroyed()) return '0';
  const buf = mainWindow.getNativeWindowHandle();
  if (!buf || buf.length === 0) return '0';
  try {
    if (buf.length >= 8) return buf.readBigUInt64LE(0).toString();
    if (buf.length >= 4) return String(buf.readUInt32LE(0));
  } catch {}
  return '0';
}

function resolveAppIcon() {
  if (app.isPackaged) {
    const p = path.join(process.resourcesPath, 'assets', 'app-icon.png');
    if (fs.existsSync(p)) return p;
    return undefined;
  }
  const root = path.join(__dirname, '..');
  for (const name of ['assets/app-icon.png', 'assets/LogoWNoBackground.png']) {
    const p = path.join(root, name);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function resolveLogoFileUrl() {
  const candidates = [
    app.isPackaged && path.join(process.resourcesPath, 'assets', 'app-icon.png'),
    path.join(__dirname, '..', 'assets', 'app-icon.png'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return 'file:///' + p.replace(/\\/g, '/');
  }
  return '';
}

// ── Loading screen (inline HTML — no file deps) ──────────────────────────────

function getListeningPidsForPort(port) {
  if (process.platform !== 'win32') return [];
  try {
    const out = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 1500,
    });
    const pids = new Set();
    const portPattern = new RegExp('(^|:)' + String(port) + '$');
    String(out || '').split(/\r?\n/).forEach((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5 || parts[0].toUpperCase() !== 'TCP') return;
      const local = parts[1] || '';
      const foreign = parts[2] || '';
      const pid = Number(parts[4]);
      // A listening TCP socket has a wildcard foreign endpoint (0.0.0.0:0 / [::]:0).
      // Key off that instead of the State column ("LISTENING"), which Windows
      // localizes by UI language (German "ABHÖREN", French "À L'ÉCOUTE", …) and
      // would otherwise make this return nothing — leaving stale dev proxies
      // un-cleaned — on non-English PCs.
      const isListening = /:0$/.test(foreign);
      if (!Number.isFinite(pid) || !isListening) return;
      if (portPattern.test(local)) pids.add(pid);
    });
    return Array.from(pids);
  } catch (err) {
    console.warn('[Electron] Could not inspect dashboard port:', err.message);
    return [];
  }
}

function cleanupStaleDevProxyProcesses(projectRoot, candidatePids = []) {
  if (process.platform !== 'win32') return;
  const pids = Array.isArray(candidatePids)
    ? candidatePids.filter((pid) => Number.isFinite(Number(pid)) && Number(pid) > 0)
    : [];
  if (!pids.length) return;

  let rows = [];
  try {
    const pidFilter = pids.length === 1
      ? 'ProcessId = ' + Number(pids[0])
      : pids.map((pid) => 'ProcessId = ' + Number(pid)).join(' OR ');
    const out = execFileSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"" + pidFilter + "\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ], { encoding: 'utf8', windowsHide: true, timeout: 2500 });
    const parsed = JSON.parse(String(out || '[]').trim() || '[]');
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    console.warn('[Electron] Could not inspect stale dev proxy processes:', err.message);
    return;
  }

  const rootA = String(projectRoot || '').toLowerCase();
  const rootB = rootA.replace(/\\/g, '/');
  for (const row of rows) {
    const pid = Number(row && row.ProcessId);
    if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) continue;
    const cmd = String((row && row.CommandLine) || '').toLowerCase();
    const cmdSlash = cmd.replace(/\\/g, '/');
    const sameWorkspace = (rootA && cmd.includes(rootA)) || (rootB && cmdSlash.includes(rootB));
    const isRealmDevProxy =
      sameWorkspace &&
      cmd.includes('--dev') &&
      (cmd.includes('src\\index.ts') || cmdSlash.includes('src/index.ts'));
    if (!isRealmDevProxy) continue;
    try {
      console.log('[Electron] Removing stale Realm Engine dev proxy PID', pid);
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      });
    } catch (err) {
      console.warn('[Electron] Failed to remove stale dev proxy PID ' + pid + ':', err.message);
    }
  }
}

// Logo base64-embedded so it renders from a data: URL with no file dep.
// This is THE one loading screen for the whole startup (security check →
// "Starting proxy…" → "Loading dashboard…"); setLoadingStatus only swaps
// the status text, so the logo stays put the entire time.
function loadingLogoDataUri() {
  try {
    const p = resolveAppIcon();
    if (p && fs.existsSync(p))
      return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
  } catch {}
  return '';
}

function buildLoadingHtml() {
  const _logo = loadingLogoDataUri();
  const _logoTag = _logo
    ? `<img src="${_logo}" alt="Realm Engine" style="width:108px;height:108px;object-fit:contain;margin-bottom:18px;-webkit-app-region:drag" />`
    : '';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Realm Engine</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}html,body{height:100%;overflow:hidden}
body{background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;-webkit-app-region:drag;user-select:none}
#wc{position:fixed;top:0;right:0;display:flex;-webkit-app-region:no-drag}
.wb{width:46px;height:32px;border:none;background:transparent;color:#8b949e;cursor:pointer;display:flex;align-items:center;justify-content:center}
.wb:hover{background:#21262d;color:#e6edf3}.wc:hover{background:#da3633;color:#fff}
.e{color:#f85149}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head><body>
${_logoTag}
<div style="font-size:22px;font-weight:600;margin-bottom:8px">Realm Engine</div>
<div id="s" style="font-size:13px;color:#8b949e;margin-bottom:32px">Starting...</div>
<div id="sp" style="width:28px;height:28px;border:3px solid #21262d;border-top-color:#2dd4bf;border-radius:50%;animation:spin .8s linear infinite"></div>
<div id="wc">
<button class="wb" onclick="window.electronAPI&&window.electronAPI.minimize()"><svg viewBox="0 0 12 12" width="12" height="12"><rect y="5" width="12" height="1.5" fill="currentColor"/></svg></button>
<button class="wb" onclick="window.electronAPI&&window.electronAPI.maximize()"><svg viewBox="0 0 12 12" width="12" height="12"><rect x="1" y="1" width="10" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button>
<button class="wb wc" onclick="window.electronAPI&&window.electronAPI.close()"><svg viewBox="0 0 12 12" width="12" height="12"><path d="M1 1L11 11M11 1L1 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
</div>
</body></html>`;
}

function setLoadingStatus(text, isError) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const escaped = JSON.stringify(String(text));
  mainWindow.webContents.executeJavaScript(`(function(){
    var s=document.getElementById('s');
    var sp=document.getElementById('sp');
    if(s){s.textContent=${escaped};s.className=${isError?'"e"':'""'};}
    if(sp&&${!!isError})sp.style.display='none';
  })();`).catch(() => {});
}

// ── Window creation ──────────────────────────────────────────────────────────

function createWindow() {
  const icon = resolveAppIcon();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    frame: false,
    backgroundColor: '#0d1117',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  mainWindow.on('maximize', () => mainWindow.webContents.send('window:maximized'));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:unmaximized'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Show window as soon as first paint is ready
  mainWindow.once('ready-to-show', () => mainWindow.show());
  instanceManager.on('update', (state) => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('instanceHost:update', state);
      }
    } catch {}
  });

  // Load the loading screen (inline data URL — no file deps), then act
  const loadingUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(buildLoadingHtml());
  mainWindow.loadURL(loadingUrl).catch(() => {}).then(() => {
    // Start polling for dashboard
    waitForDashboardAndLoad();
  });
}

// ── Dashboard polling ────────────────────────────────────────────────────────

async function waitForDashboardAndLoad() {
  const start = Date.now();
  let lastStatus = '';

  while (Date.now() - start < PROXY_STARTUP_TIMEOUT) {
    if (proxyProcess === null) {
      // Give exit handler a moment to set reason
      await new Promise(r => setTimeout(r, 300));
      setLoadingStatus(proxyExitReason || 'Proxy process exited unexpectedly.', true);
      return;
    }

    try {
      const resp = await fetch(DASHBOARD_URL);
      if (resp.ok) {
        setLoadingStatus('Loading dashboard...');
        // Small delay so user sees the status change
        await new Promise(r => setTimeout(r, 200));
        mainWindow.loadURL(DASHBOARD_URL);
        return;
      }
      const s = 'Waiting for dashboard... (HTTP ' + resp.status + ')';
      if (s !== lastStatus) { setLoadingStatus(s); lastStatus = s; }
    } catch {
      const elapsed = Math.round((Date.now() - start) / 1000);
      const s = 'Starting proxy... (' + elapsed + 's)';
      if (s !== lastStatus) { setLoadingStatus(s); lastStatus = s; }
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  setLoadingStatus('Dashboard failed to start within 60s.', true);
}

// ── Proxy process ────────────────────────────────────────────────────────────

function startProxy() {
  const projectRoot = path.join(__dirname, '..');
  const distApp = path.join(projectRoot, 'dist', 'app.cjs');
  const isProd = app.isPackaged && fs.existsSync(distApp);

  if (isProd) {
    console.log('[Electron] Starting proxy (production mode)');
    const realRoot = process.resourcesPath;
    const userCfgDir = path.join(app.getPath('userData'), 'realm-engine');
    try {
      fs.mkdirSync(userCfgDir, { recursive: true });
    } catch {
      /* ignore */
    }
    const userCfgPath = path.join(userCfgDir, 'config.json');

    proxyProcess = fork(distApp, ['--dev'], {
      cwd: realRoot,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        REALM_ENGINE_PROD: '1',
        REALM_ENGINE_ROOT: realRoot,
        REALM_ENGINE_APP_ROOT: projectRoot,
        REALM_ENGINE_USER_CONFIG_PATH: userCfgPath,
        REALM_ENGINE_VERSION: app.getVersion(),
      },
    });

    if (proxyProcess.stdout) {
      proxyProcess.stdout.on('data', (d) => process.stdout.write(d));
    }
    if (proxyProcess.stderr) {
      proxyProcess.stderr.on('data', (d) => {
        process.stderr.write(d);
        proxyStderrTail = (proxyStderrTail + d.toString()).slice(-500);
      });
    }
  } else {
    console.log('[Electron] Starting proxy (dev mode)');
    cleanupStaleDevProxyProcesses(projectRoot, getListeningPidsForPort(DASHBOARD_PORT));
    const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const nodeExe = process.env.npm_node_execpath || process.env.NODE || 'node';
    proxyProcess = spawn(nodeExe, [tsxCli, path.join(projectRoot, 'src', 'index.ts'), '--dev'], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        REALM_ENGINE_VERSION: app.getVersion(),
      },
    });
    if (proxyProcess.stdout) {
      proxyProcess.stdout.on('data', (d) => {
        try { process.stdout.write(d); } catch {}
      });
    }
    if (proxyProcess.stderr) {
      proxyProcess.stderr.on('data', (d) => {
        try { process.stderr.write(d); } catch {}
        proxyStderrTail = (proxyStderrTail + d.toString()).slice(-500);
      });
    }
  }

  proxyProcess.on('error', (err) => {
    console.error('[Electron] Failed to start proxy:', err.message);
    proxyExitReason = 'Proxy error: ' + err.message;
    proxyProcess = null;
  });

  proxyProcess.on('exit', (code, signal) => {
    console.log('[Electron] Proxy exited with code', code, signal ? 'signal ' + signal : '');
    if (code !== 0 && code !== null) {
      const detail = proxyStderrTail.trim();
      proxyExitReason = detail
        ? 'Proxy crashed (code ' + code + '): ' + detail.split('\n').pop()
        : 'Proxy crashed (exit code ' + code + ')';
    }
    proxyProcess = null;
  });
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());
ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false);
ipcMain.handle('instanceHost:isSupported', () => windowHostBridge.isSupported());
ipcMain.handle('instanceHost:listInstances', () => instanceManager.list());
ipcMain.handle('instanceHost:listWindows', async () => windowHostBridge.listTopLevelWindows());
ipcMain.handle('instanceHost:listAttachments', () => windowHostBridge.listAttachments());
ipcMain.handle('instanceHost:launch', async (_event, payload) => instanceManager.launch(payload || {}));
ipcMain.handle('instanceHost:trackByPid', async (_event, payload) => instanceManager.trackByPid(payload || {}));
ipcMain.handle('instanceHost:stop', async (_event, payload) => instanceManager.stop(payload?.instanceId));
ipcMain.handle('instanceHost:discoverWindow', async (_event, payload) => instanceManager.discoverWindow(payload?.instanceId));
ipcMain.handle('instanceHost:focus', async (_event, payload) => instanceManager.focus(payload?.instanceId));
ipcMain.handle('instanceHost:attach', async (_event, payload) => {
  const hostHwnd = payload?.hostHwnd || getMainWindowHwndDecimal();
  return instanceManager.attach({
    instanceId: payload?.instanceId,
    slotId: payload?.slotId,
    hostHwnd,
  });
});
ipcMain.handle('instanceHost:detach', async (_event, payload) => instanceManager.detach(payload?.slotId));
ipcMain.handle('instanceHost:resizeSlot', async (_event, payload) => {
  return instanceManager.resizeSlot(payload?.slotId, payload?.bounds || {});
});

// ── Steam OpenID — "Connect with Steam" account flow ─────────────────────────
// Opens a child BrowserWindow at Steam's OpenID endpoint. Steam authenticates
// the user (their normal Steam login), then redirects back to return_to. We
// intercept the redirect, parse the Steam ID from openid.claimed_id, close the
// window, and return the ID to the renderer.
//
// NOTE: Returns ONLY the Steam ID — the Deca-issued secret still has to be
// entered manually. Steam OpenID doesn't expose game-specific session tickets.
const STEAM_OPENID_RETURN = 'http://localhost:9876/__re_steam_openid_callback__';
const STEAM_OPENID_URL =
  'https://steamcommunity.com/openid/login' +
  '?openid.ns=' + encodeURIComponent('http://specs.openid.net/auth/2.0') +
  '&openid.mode=checkid_setup' +
  '&openid.return_to=' + encodeURIComponent(STEAM_OPENID_RETURN) +
  '&openid.realm=' + encodeURIComponent('http://localhost:9876') +
  '&openid.identity=' + encodeURIComponent('http://specs.openid.net/auth/2.0/identifier_select') +
  '&openid.claimed_id=' + encodeURIComponent('http://specs.openid.net/auth/2.0/identifier_select');

function parseSteamIdFromOpenIdUrl(url) {
  try {
    const u = new URL(url);
    const claimed = u.searchParams.get('openid.claimed_id') || '';
    // claimed_id looks like https://steamcommunity.com/openid/id/76561198XXXXXXXXX
    const m = claimed.match(/\/openid\/id\/(\d+)\s*$/);
    return m ? m[1] : null;
  } catch { return null; }
}

// ── RotMG Exalt Launcher credential reader ────────────────────────────────────
// Reads Unity PlayerPrefs from HKCU\Software\DECA Live Operations GmbH\RotMG
// Exalt Launcher. Unity stores PlayerPrefs as registry values with
//   - key   = base64(originalName) + "_h<hash>"
//   - value = REG_BINARY of UTF-8 bytes, often base64-encoded, null-terminated.
// The launcher persists the user's GUID (email) and PS (password/secret) under
// the keys "Productionguid" and "Productionps" — plus the current access token.
//
// This handler returns whatever is currently stored. If the user is logged in
// via the official launcher, those creds are what got sent to /account/verify.
const REG_PATH = 'HKCU\\Software\\DECA Live Operations GmbH\\RotMG Exalt Launcher';

function decodeRegBinaryToString(hex) {
  // hex is contiguous like '6A65737365...00' — pairs of nibbles + trailing null
  if (!hex) return '';
  const bytes = Buffer.from(hex.replace(/[^0-9a-fA-F]/g, ''), 'hex');
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;  // strip trailing null(s)
  return bytes.slice(0, end).toString('utf8');
}

function tryBase64Decode(s) {
  if (!s || /[^A-Za-z0-9+/=]/.test(s)) return s;
  try {
    const decoded = Buffer.from(s, 'base64').toString('utf8');
    // Heuristic: only return the decoded form if it's printable-ish and the
    // re-encoding round-trips. Otherwise the input wasn't really base64.
    if (Buffer.from(decoded, 'utf8').toString('base64').replace(/=+$/, '') === s.replace(/=+$/, '')) {
      return decoded;
    }
  } catch {}
  return s;
}

// ── Capture-log reader (multi-account import) ────────────────────────────────
// Reads %LocalAppData%\RealmOfTheMadGod\re-captured-creds.jsonl written by the
// internal DLL's AppEngineManager.Connect hook. Returns one record per unique
// GUID (keeps the newest secret per GUID — handles password rotations and
// post-Steam-relink updates correctly).
ipcMain.handle('rotmg:readCaptureLog', async () => {
  try {
    const fs = require('fs');
    const os = require('os');
    const logPath = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'RealmOfTheMadGod',
      're-captured-creds.jsonl',
    );
    if (!fs.existsSync(logPath)) {
      return { error: 'No capture log yet. Log in via the launcher (or our app) at least once with the injected DLL active.' };
    }
    const raw = fs.readFileSync(logPath, 'utf8');
    const byGuid = new Map();
    let parsed = 0, skipped = 0;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed);
        if (!rec || typeof rec.guid !== 'string' || !rec.guid) { skipped++; continue; }
        const prev = byGuid.get(rec.guid);
        // Keep the latest record per GUID (by timestamp; defaults to "this line newer than nothing").
        if (!prev || (rec.timestamp || 0) > (prev.timestamp || 0)) byGuid.set(rec.guid, rec);
        parsed++;
      } catch { skipped++; }
    }
    return {
      total: parsed,
      skipped,
      uniqueAccounts: Array.from(byGuid.values()).map((r) => ({
        guid:        r.guid,
        secret:      r.secret || '',
        clientToken: r.clientToken || '',
        steamId:     r.steamId || '',
        capturedAt:  r.timestamp || null,
        isSteam:     !!(r.steamId && r.steamId.length > 0),
      })),
      logPath,
    };
  } catch (err) {
    return { error: 'Read failed: ' + (err && err.message ? err.message : String(err)) };
  }
});

ipcMain.handle('rotmg:readLauncherCreds', async () => {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const proc = spawn('reg.exe', ['query', REG_PATH], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    proc.on('error', (err) => resolve({ error: 'reg.exe failed: ' + err.message }));
    proc.on('close', () => {
      if (!stdout.trim()) {
        resolve({ error: stderr.trim() || 'No registry data — has the RotMG Exalt Launcher been run on this PC?' });
        return;
      }
      const out = { found: true };
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(/^\s+([A-Za-z0-9+/=]+)_h\d+\s+REG_(?:BINARY|SZ|DWORD)\s+(.+)$/);
        if (!m) continue;
        const encodedKey = m[1];
        const rawValueHex = m[2].trim();
        const keyName = tryBase64Decode(encodedKey);  // e.g. 'Productionguid'

        const decodedValue = decodeRegBinaryToString(rawValueHex);
        switch (keyName) {
          case 'Productionguid':         out.guid   = decodedValue; break;
          case 'Productionps':           out.secret = tryBase64Decode(decodedValue); break;
          case 'token':                  out.token  = decodedValue; break;
          case 'tokenTimestamp':         out.tokenTimestamp  = Number(decodedValue) || null; break;
          case 'tokenExpiration':        out.tokenExpiration = Number(decodedValue) || null; break;
          case 'ProductionpreferredServer': out.preferredServer = decodedValue; break;
          default: break;
        }
      }
      if (!out.guid && !out.secret) {
        resolve({ error: 'Launcher registry exists but no Production credentials found. Log into the launcher once first.' });
        return;
      }
      resolve(out);
    });
  });
});

ipcMain.handle('steam:connect', () => new Promise((resolve) => {
  let resolved = false;
  const done = (result) => { if (!resolved) { resolved = true; resolve(result); } };
  const authWin = new BrowserWindow({
    width: 480,
    height: 720,
    parent: mainWindow || undefined,
    modal: false,
    title: 'Connect with Steam',
    backgroundColor: '#171a21',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  const watch = (navUrl) => {
    if (!navUrl || !navUrl.startsWith(STEAM_OPENID_RETURN)) return;
    const steamId = parseSteamIdFromOpenIdUrl(navUrl);
    done(steamId ? { steamId } : { error: 'Could not parse Steam ID from callback' });
    if (!authWin.isDestroyed()) authWin.close();
  };
  authWin.webContents.on('will-redirect', (_e, url) => watch(url));
  authWin.webContents.on('will-navigate', (_e, url) => watch(url));
  authWin.webContents.on('did-redirect-navigation', (_e, url) => watch(url));

  authWin.on('closed', () => done({ cancelled: true }));

  authWin.loadURL(STEAM_OPENID_URL).catch((err) => {
    done({ error: 'Failed to open Steam: ' + (err?.message || String(err)) });
    if (!authWin.isDestroyed()) authWin.close();
  });
}));

// ── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Force-update gate: block the main window from opening until we've either
  // confirmed we're on the latest version, installed an update, or the check
  // timed out / errored (we lean lenient — server-side min-version check is
  // the actual lock; this is just the UX layer).
  let updaterApi = null;
  try {
    updaterApi = require('./services/updater.cjs');
    const { updating } = await updaterApi.enforceUpdateOnLaunch({ app, BrowserWindow, dialog });
    if (updating) return; // quitAndInstall in progress — do not open main window
  } catch (err) {
    console.error('[updater] launch gate failed (allowing startup):', err && (err.message || err));
  }

  startProxy();
  createWindow();

  // In-session soft-prompt for updates published while the app is running.
  // The next launch will hard-gate, so we don't kick users mid-session.
  try {
    if (updaterApi) {
      updaterApi.scheduleBackgroundUpdateChecks({
        app,
        dialog,
        getWindow: () => mainWindow,
      });
    }
  } catch (err) {
    console.error('[updater] background checks failed (ignored):', err && (err.message || err));
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (proxyProcess) { proxyProcess.kill(); proxyProcess = null; }
  app.quit();
});

app.on('before-quit', () => {
  if (proxyProcess) { proxyProcess.kill(); proxyProcess = null; }
});
