const { contextBridge, ipcRenderer } = require('electron');

// Channel names come from main.cjs via `webPreferences.additionalArguments`,
// NOT `require('./ipc-channels.cjs')`: this preload runs sandboxed (Electron's
// default), and a sandboxed preload can only require `electron` and a couple of
// Node polyfills. Requiring a local file throws, the whole preload dies, and
// `window.electronAPI` silently never exists — which reads downstream as the
// titlebar window buttons vanishing and every Steam/RotMG/instance-host call
// going dead. ipc-channels.cjs stays the single source of truth; main.cjs is
// unsandboxed, so it requires the module and forwards the map here.
const IPC_ARG_PREFIX = '--ipc-channels=';
const ipcArg = (process.argv || []).find((a) => a.startsWith(IPC_ARG_PREFIX));
if (!ipcArg) {
  throw new Error(
    'preload: missing ' + IPC_ARG_PREFIX + ' argument — the BrowserWindow must pass ' +
    "additionalArguments: ['--ipc-channels=' + JSON.stringify(IPC)]"
  );
}
const IPC = Object.freeze(JSON.parse(ipcArg.slice(IPC_ARG_PREFIX.length)));

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send(IPC.WINDOW_MINIMIZE),
  maximize: () => ipcRenderer.send(IPC.WINDOW_MAXIMIZE),
  close: () => ipcRenderer.send(IPC.WINDOW_CLOSE),
  isMaximized: () => ipcRenderer.invoke(IPC.WINDOW_IS_MAXIMIZED),
  onMaximizeChange: (callback) => {
    ipcRenderer.on(IPC.WINDOW_MAXIMIZED, () => callback(true));
    ipcRenderer.on(IPC.WINDOW_UNMAXIMIZED, () => callback(false));
  },
  steam: {
    /** Open Steam OpenID; resolves to { steamId } | { error } | { cancelled }. */
    connect: () => ipcRenderer.invoke(IPC.STEAM_CONNECT),
  },
  rotmg: {
    /**
     * Read whatever credentials the official RotMG Exalt Launcher has persisted
     * in Unity PlayerPrefs (registry). Resolves to
     *   { guid, secret, token, tokenTimestamp, tokenExpiration, preferredServer }
     * or { error } if nothing is there.
     */
    readLauncherCreds: () => ipcRenderer.invoke(IPC.ROTMG_READ_LAUNCHER_CREDS),
    /**
     * Read the injected-DLL's per-login capture log (multi-account). Resolves to
     *   { total, skipped, uniqueAccounts: [{ guid, secret, clientToken, steamId,
     *                                        capturedAt, isSteam }], logPath }
     * or { error } if the log doesn't exist yet.
     */
    readCaptureLog: () => ipcRenderer.invoke(IPC.ROTMG_READ_CAPTURE_LOG),
  },
  instanceHost: {
    isSupported: () => ipcRenderer.invoke(IPC.INSTANCE_HOST_IS_SUPPORTED),
    listInstances: () => ipcRenderer.invoke(IPC.INSTANCE_HOST_LIST_INSTANCES),
    listWindows: () => ipcRenderer.invoke(IPC.INSTANCE_HOST_LIST_WINDOWS),
    listAttachments: () => ipcRenderer.invoke(IPC.INSTANCE_HOST_LIST_ATTACHMENTS),
    launch: (payload) => ipcRenderer.invoke(IPC.INSTANCE_HOST_LAUNCH, payload),
    trackByPid: (payload) => ipcRenderer.invoke(IPC.INSTANCE_HOST_TRACK_BY_PID, payload),
    stop: (payload) => ipcRenderer.invoke(IPC.INSTANCE_HOST_STOP, payload),
    discoverWindow: (payload) => ipcRenderer.invoke(IPC.INSTANCE_HOST_DISCOVER_WINDOW, payload),
    focus: (payload) => ipcRenderer.invoke(IPC.INSTANCE_HOST_FOCUS, payload),
    attach: (payload) => ipcRenderer.invoke(IPC.INSTANCE_HOST_ATTACH, payload),
    detach: (payload) => ipcRenderer.invoke(IPC.INSTANCE_HOST_DETACH, payload),
    resizeSlot: (payload) => ipcRenderer.invoke(IPC.INSTANCE_HOST_RESIZE_SLOT, payload),
    onUpdate: (callback) => {
      const handler = (_event, state) => callback(state);
      ipcRenderer.on(IPC.INSTANCE_HOST_UPDATE, handler);
      return () => ipcRenderer.removeListener(IPC.INSTANCE_HOST_UPDATE, handler);
    },
  },
});
