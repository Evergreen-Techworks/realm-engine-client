// Shared Electron IPC channel names — used by BOTH electron/main.cjs and
// electron/preload.cjs. Edit here only: the two ends require this module and
// reference IPC.* so a rename/add is a one-place change and a main↔preload
// mismatch becomes a missing-property error instead of a silent dead channel.
module.exports.IPC = Object.freeze({
  // Frameless-window controls (renderer → main: send/invoke).
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_IS_MAXIMIZED: 'window:isMaximized',
  // Maximize-state notifications (main → renderer).
  WINDOW_MAXIMIZED: 'window:maximized',
  WINDOW_UNMAXIMIZED: 'window:unmaximized',

  // Steam OpenID "Connect with Steam" account flow.
  STEAM_CONNECT: 'steam:connect',

  // RotMG credential readers (launcher registry + injected-DLL capture log).
  ROTMG_READ_LAUNCHER_CREDS: 'rotmg:readLauncherCreds',
  ROTMG_READ_CAPTURE_LOG: 'rotmg:readCaptureLog',

  // Multi-instance host bridge (13 channels).
  INSTANCE_HOST_IS_SUPPORTED: 'instanceHost:isSupported',
  INSTANCE_HOST_LIST_INSTANCES: 'instanceHost:listInstances',
  INSTANCE_HOST_LIST_WINDOWS: 'instanceHost:listWindows',
  INSTANCE_HOST_LIST_ATTACHMENTS: 'instanceHost:listAttachments',
  INSTANCE_HOST_LAUNCH: 'instanceHost:launch',
  INSTANCE_HOST_TRACK_BY_PID: 'instanceHost:trackByPid',
  INSTANCE_HOST_STOP: 'instanceHost:stop',
  INSTANCE_HOST_DISCOVER_WINDOW: 'instanceHost:discoverWindow',
  INSTANCE_HOST_FOCUS: 'instanceHost:focus',
  INSTANCE_HOST_ATTACH: 'instanceHost:attach',
  INSTANCE_HOST_DETACH: 'instanceHost:detach',
  INSTANCE_HOST_RESIZE_SLOT: 'instanceHost:resizeSlot',
  // Instance-state push (main → renderer).
  INSTANCE_HOST_UPDATE: 'instanceHost:update',
});
