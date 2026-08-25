# 13 — Client: centralize Electron IPC + dashboard WebSocket channel names

## Goal
The Electron main↔renderer IPC channel strings (duplicated between
`electron/main.cjs` handlers and `electron/preload.cjs` mirrors) and the
dashboard WebSocket `msg.type` strings (duplicated between the server
`DevServer.ts` and the browser `app.js`) come from single shared constants
modules. Renaming or adding a channel is a one-place edit, and a mismatch
between the two ends becomes discoverable instead of a silent dead channel.

## Dependencies
None. Parallel-safe against every other plan (touches `client/electron/**` and
`client/src/dashboard/**` only — no overlap with 12 or 14).

## Current state
### Electron IPC — 28 strings duplicated across a process boundary
- Handlers: `electron/main.cjs:371-383` (`ipcMain.handle`/`.on`).
- Renderer mirror: `electron/preload.cjs:4-52` (`contextBridge` → `ipcRenderer.invoke`).
- Namespaces: `window:*` (minimize/maximize/close/isMaximized/…),
  `steam:connect`, `rotmg:readLauncherCreds`, `rotmg:readCaptureLog`,
  `instanceHost:*` (13 channels). No shared module — each string is typed twice.
Enumerate:
```
grep -rhoE "'(window|steam|rotmg|instanceHost):[a-zA-Z]+'" client/electron/main.cjs client/electron/preload.cjs | sort -u
```

### Dashboard WS — ~22 `type` literals hand-synced
- Server emits: `src/dashboard/server/DevServer.ts` (`type: '<x>'` at ~:3532-3838;
  ~22 distinct — `clientList`, `playerData`, `plugins`, `packet`, `tilesData`,
  `internalState`, `muling`, …).
- Browser consumes the same literals in `src/dashboard/public/app.js`
  (~17k lines). Two hand-maintained copies.
Enumerate server side:
```
grep -roE "type: '[a-zA-Z]+'" client/src/dashboard/server/DevServer.ts | sort -u
```

## Target design
Because `.cjs` (CommonJS, no bundler) and browser `app.js` (plain script, no
imports) cannot share an ES module directly, use the lowest-common-denominator
that each side can load:

1. **Electron IPC:** `electron/ipc-channels.cjs` — a plain CommonJS module:
   ```js
   // Shared IPC channel names — required by BOTH electron/main.cjs and preload.cjs.
   module.exports.IPC = Object.freeze({
     WINDOW_MINIMIZE: 'window:minimize', WINDOW_MAXIMIZE: 'window:maximize',
     WINDOW_CLOSE: 'window:close', WINDOW_IS_MAXIMIZED: 'window:isMaximized',
     STEAM_CONNECT: 'steam:connect',
     ROTMG_READ_LAUNCHER_CREDS: 'rotmg:readLauncherCreds',
     ROTMG_READ_CAPTURE_LOG: 'rotmg:readCaptureLog',
     INSTANCE_HOST_LAUNCH: 'instanceHost:launch', /* … all 13 … */
   });
   ```
   `main.cjs` and `preload.cjs` both `require('./ipc-channels.cjs')` and use
   `IPC.*` in place of the literals.

2. **Dashboard WS:** `src/dashboard/wsMessageTypes.ts` exporting a frozen
   `WS_MSG` object AND a generated plain-JS companion the browser can load. The
   browser `app.js` is not bundled, so either (a) emit a
   `dashboard/public/ws-message-types.js` (`window.WS_MSG = {…}`) generated from
   the TS by a tiny `scripts/gen-ws-types.mjs` and `<script>`-included before
   `app.js`, or (b) if `app.js` IS bundled at build, import the TS directly.
   Inspect the build (`grep -rn "public/app.js" client/scripts client/*.json`)
   and pick the matching option. Prefer (a) if `app.js` ships as-is.

**Ownership:** each constants module is the single source for its boundary. Add a
comment on each: "used by BOTH ends — edit here only."
**No behavior change:** every string value stays identical.

## Steps
1. Create `electron/ipc-channels.cjs`; replace literals in `main.cjs:371-383`
   and `preload.cjs:4-52` with `IPC.*`. Manually confirm both ends reference the
   same constant per channel (the whole point). Build/run check: `npm run build`
   (tsc doesn't check `.cjs`, so also `node --check electron/main.cjs` and
   `node --check electron/preload.cjs`).
2. Create `src/dashboard/wsMessageTypes.ts` (frozen `WS_MSG`); replace server
   `type: '<x>'` literals in `DevServer.ts` with `WS_MSG.*`. `npm run build`.
3. Wire the browser side: generate/emit the companion JS (option a) or import
   (option b); replace the literals in `public/app.js` with `WS_MSG.*` /
   `window.WS_MSG.*`. Load in the app and confirm the dashboard still receives
   updates (manual smoke).
4. Full `cd client && npm run build`.

## Verification
- `cd client && npm run build` succeeds; `node --check electron/main.cjs` and
  `node --check electron/preload.cjs` pass.
- `grep -rnE "'(window|steam|rotmg|instanceHost):[a-zA-Z]+'" client/electron/main.cjs client/electron/preload.cjs`
  → empty (all via `IPC.*`).
- `grep -roE "type: '[a-zA-Z]+'" client/src/dashboard/server/DevServer.ts` → empty
  (all via `WS_MSG.*`).
- Manual: app window controls (min/max/close) work; dashboard live panels update.

## Out of scope
- The DLL-bridge contract (pipe/feature keys) — plan 12.
- Refactoring `DevServer.ts` / `app.js` structure beyond the string swap.
- Adding a type-checked message schema (payload shapes) — names only here.
