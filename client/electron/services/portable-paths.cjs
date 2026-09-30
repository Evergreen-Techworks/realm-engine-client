'use strict';
const path = require('path');
const fs = require('fs');

// Repoint Electron's writable state at an RE_ASSETS folder next to the
// portable EXE, so a portable install is fully self-contained (configs,
// session storage, logs and the proxy log all live beside the executable).
//
// The env var is only set by electron-builder's *portable* launcher. The NSIS
// build is packaged too but has no launcher dir — for that one this is the
// normal installed case, so it quietly keeps the default %APPDATA% paths
// instead of treating the missing variable as an error.
function configurePortablePaths(app, env = process.env) {
  if (!app.isPackaged || process.platform !== 'win32') return null;
  const exeDir = env.PORTABLE_EXECUTABLE_DIR;
  if (!exeDir) return null;
  if (!path.isAbsolute(exeDir)) throw new Error('Portable launcher directory is unavailable.');
  const data = path.join(exeDir, 'RE_ASSETS');
  fs.mkdirSync(data, { recursive: true });
  app.setPath('userData', data);
  app.setPath('sessionData', path.join(data, 'session'));
  app.setPath('logs', path.join(data, 'logs'));
  env.RE_ASSETS = data;
  return data;
}
module.exports = { configurePortablePaths };
