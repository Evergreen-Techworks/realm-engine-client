// Run with:  node --test tests/
// (node:test, not vitest — this covers main-process .cjs services, which the
// vitest include pattern under src/**/__tests__ deliberately does not collect.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function service(name, globals) {
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(new URL(`../electron/services/${name}.cjs`, import.meta.url), 'utf8'),
    { module, console, ...globals }, { filename: name });
  return module.exports;
}

test('packaged Windows paths use the launcher directory before Electron services start', () => {
  const writes = [], paths = {};
  const api = service('portable-paths', {
    process: { platform: 'win32', env: {} },
    require: name => name === 'path' ? path.win32 : { mkdirSync: dir => writes.push(dir) },
  });
  const app = { isPackaged: true, setPath: (key, value) => { paths[key] = value; } };
  // No PORTABLE_EXECUTABLE_DIR = NSIS-installed build: keep default paths, no throw.
  assert.equal(api.configurePortablePaths(app, {}), null);
  assert.equal(writes.length, 0);
  assert.throws(() => api.configurePortablePaths(app, { PORTABLE_EXECUTABLE_DIR: 'relative' }), /directory is unavailable/);
  assert.equal(writes.length, 0);
  const env = { PORTABLE_EXECUTABLE_DIR: 'D:\\Apps\\Realm Engine' };
  assert.equal(api.configurePortablePaths(app, env), 'D:\\Apps\\Realm Engine\\RE_ASSETS');
  assert.equal(env.RE_ASSETS, paths.userData);
  assert.equal(paths.sessionData, path.win32.join(env.RE_ASSETS, 'session'));
  assert.equal(paths.logs, path.win32.join(env.RE_ASSETS, 'logs'));
});

test('dev and non-Windows paths remain untouched', () => {
  const api = service('portable-paths', {
    process: { platform: 'linux', env: {} }, require: name => name === 'path' ? path : {
      mkdirSync: () => assert.fail('Linux path must not be changed'),
    },
  });
  assert.equal(api.configurePortablePaths({ isPackaged: true }), null);
  assert.equal(api.configurePortablePaths({ isPackaged: false }, { PORTABLE_EXECUTABLE_DIR: 'D:\\x' }), null);
});
