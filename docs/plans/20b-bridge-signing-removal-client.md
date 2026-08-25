# 20b — Bridge signing removal (client / TypeScript)

## Goal
The client's named-pipe **server** (`client/src/bridge/InternalBridge.ts`) speaks
**plaintext length-prefixed JSON dispatched purely by `type`**. All HMAC crypto,
the mutual-auth handshake (`hello`→`auth`→`authResult`), the derived session key,
per-message `seq`/`mac` signing and verification, and the `BuildSecrets.h` /
`__HANDSHAKE_KEY__` / `__PIPE_NAME__` build plumbing are removed. The pipe still
accepts the DLL, processes player/threat/hotkey data with identical semantics,
heartbeats for liveness (no MAC), replays feature state on connect, and
reconnects. Downstream events (`'authenticated'`, `'disconnected'`, `'message'`,
`'unresolvedClasses'`) and the `isConnected` getter keep working unchanged for
`DevServer`.

## Dependencies
- **Depends on plan 20a (internal) — land 20a first.** 20b removes the
  `BuildSecrets.h` generation from `client/scripts/build-prod.mjs`; if that is
  removed before 20a deletes the Release `#error` in `Handshake.cpp`, a Release
  DLL build via `build-prod.mjs` would fail.
- **Precedes plan 19** (`19-threat-channel-compact-versioned.md`), which also
  edits `InternalBridge.ts handleThreats`. Do them in order. **Do not change the
  threat payload string** here — only remove the `seq`/`mac` verification around
  it. Plan 19 owns the payload.
- Files touched: `client/src/bridge/InternalBridge.ts`,
  `client/src/bridge/contract.ts`, `client/scripts/build-prod.mjs`,
  `client/build-tools/dev-build.bat`.

## Current state (exact auth surface to remove)

### `client/src/bridge/InternalBridge.ts`
- `:18` `import { createHash, createHmac, randomBytes } from 'crypto';`
- `:25` `declare const __HANDSHAKE_KEY__`; `:26` `declare const __PIPE_NAME__`.
- `:30-37` `PIPE_PATH` derived from `__PIPE_NAME__` (falls back to
  `BRIDGE.DEV_PIPE_NAME`).
- `:44-47` `HEARTBEAT_INTERVAL`, `MAX_MISSES`, `IS_PROD`, `HEX64`.
- `:49-53` `getHandshakeKey()` / `HANDSHAKE_KEY`.
- `:55-64` `hmacResponse`; `:66-68` `randomNonce`; `:70-72` `isHexNonce`.
- `:74-96` `deriveSessionKey`, `computeSessionMac`.
- `:98-107` `parseSeq`.
- `:109-123` `playerPayloadFromMessage` (the canonical MAC payload builder).
- `:125-131` `hotkeyPayloadFromMessage`.
- `:133-136` `SignedFields` interface.
- `:147` `authenticated` field; `:153-157` `pendingChallenge`, `serverChallenge`,
  `missCount`, `sessionKey`, `nextClientSeq`, `lastDllSeq`.
- `:176` `isConnected` = `authenticated && pipeTransportReady()`.
- `:184-208` `bridgeAuthUserId()`.
- `:225-229` handshake-key gate in `listen()`.
- `:276-284` `send()` — `signOutgoingMessage` gate.
- `:299-303` `getNextSeq`; `:305-348` `getSignedFields`; `:350-364`
  `signOutgoingMessage`; `:366-375` `verifyIncomingSignedMessage`.
- `:472-510` `handleMessage` — the default-case sigPayload verify.
- `:512-547` `handleHello` — computes `hmacResponse`, sends the `auth` message
  with `response`+`challenge`.
- `:549-567` `handleAuthResult` — derives `sessionKey`, sets `authenticated`.
- `:570-580` `replayAllFeatureState` — signs each replayed feature.
- `:582-588` `handleHeartbeat` — replies signed `heartbeatResp`.
- `:590-594` `handleHeartbeatResp`.
- `:596-607` `handlePlayer`; `:614-621` `handleHotkeyEvent`; `:623-633`
  `handleThreats`; `:635-643` `handleUnresolvedClasses` — all call
  `verifyIncomingSignedMessage`.
- `:645-674` `startHeartbeat` — sends signed `heartbeat` with nonce.

### `client/src/bridge/contract.ts`
- `:19-23` `BRIDGE` (`DEV_PIPE_NAME`, `PROTOCOL_VERSION: 3`, `PROTOCOL_TAG:
  'bridge-v3'`) — **keep the constants** (`hello` still carries `version`/
  `protocol`). Update the surrounding doc comments that describe signed vs.
  unsigned messages (`:25-31`, `:1-16`) to reflect plaintext-by-`type`.
- `DllMessageType` map (`:32-46`) — keep all entries **except** `AuthResult`,
  which the DLL no longer sends. Removing `AuthResult` is optional but tidy; if
  removed, delete the `case DllMessageType.AuthResult` in `handleMessage`.

### `client/scripts/build-prod.mjs`
- `:53` `BUILD_SECRETS_H` path; `:88-104` writes `BuildSecrets.h`; `:335-342`
  post-build removal of `BuildSecrets.h`.
- `:233-234` esbuild `define` for `__HANDSHAKE_KEY__` / `__PIPE_NAME__`.
- `handshakeKey` / `pipeName` consts (~`:98-99`).

### `client/build-tools/dev-build.bat`
- `:73-78` `/XF BuildSecrets.h` robocopy exclude.
- `:85-93` "Write dev BuildSecrets.h if missing" block.

## Target design

### Final wire contract (produce exactly this)
DLL → client (handled by `type`): `hello`, `player`, `hotkeyEvent`, `threats`,
`unresolvedClasses`, `heartbeat`, `heartbeatResp` — **no** `seq`/`mac`, no
`authResult`.
client → DLL: `setFeature`, `clearTiles`, `noWalkInit`, `tileUpdate`,
`heartbeat`, `heartbeatResp` — **no** `seq`/`mac`, no `auth`.

### Rewritten `InternalBridge.ts` shape
- Drop the `crypto` import entirely (no `createHash`/`createHmac`/`randomBytes`).
- Delete `getHandshakeKey`, `HANDSHAKE_KEY`, `hmacResponse`, `randomNonce`,
  `isHexNonce`, `HEX64`, `deriveSessionKey`, `computeSessionMac`, `parseSeq`,
  `playerPayloadFromMessage`, `hotkeyPayloadFromMessage`, `SignedFields`,
  `bridgeAuthUserId`, `getNextSeq`, `getSignedFields`, `signOutgoingMessage`,
  `verifyIncomingSignedMessage`.
- Replace the `authenticated` flag with a `private connected = false;`. Drop
  `pendingChallenge`, `serverChallenge`, `sessionKey`, `nextClientSeq`,
  `lastDllSeq`. Keep `missCount` and `heartbeatTimer` for liveness.
- `PIPE_PATH`: replace the `__PIPE_NAME__` machinery with
  `const PIPE_PATH = BRIDGE.DEV_PIPE_NAME;`. Delete both `declare const`s.
- `isConnected` getter → `return this.connected && this.pipeTransportReady();`.
- `listen()`: drop the `if (!HANDSHAKE_KEY)` early return (the `HANDSHAKE_KEY`
  no longer exists); keep the `isWindowsNamedPipeHost()` guard and
  `signalHelloEvent()`.
- `send(msg)`: gate on `this.pipeTransportReady() && this.connected`; write
  `JSON.stringify(msg)` directly (no signing):
  ```ts
  send(msg: DllMessage): void {
    if (!this.pipeTransportReady() || !this.connected) return;
    this.writeMessage(JSON.stringify(msg));
  }
  ```
- `handleHello(msg)`: validate `version`/`protocol` (unchanged check against
  `BRIDGE.PROTOCOL_VERSION`/`BRIDGE.PROTOCOL_TAG`), then **treat hello as
  "connected"** — no challenge, no `auth` reply:
  ```ts
  private handleHello(msg: DllMessage): void {
    const version = Number(msg.version ?? 0);
    const protocol = String(msg.protocol ?? '');
    if (version !== BRIDGE.PROTOCOL_VERSION || protocol !== BRIDGE.PROTOCOL_TAG) {
      Logger.error('InternalBridge', 'Hello wrong protocol/version');
      this.disconnect();
      return;
    }
    this.connected = true;
    this.missCount = 0;
    Logger.log('InternalBridge', 'DLL connected (plaintext bridge).');
    this.emit('authenticated');            // event name kept for DevServer compat
    this.replayAllFeatureState();
    this.startHeartbeat();
  }
  ```
- Delete `handleAuthResult` and its `case DllMessageType.AuthResult` branch.
- `replayAllFeatureState()`: gate on `this.connected`; write each remembered
  feature message directly: `this.writeMessage(JSON.stringify(msg));`.
- `handleHeartbeat()`: reply plaintext, no nonce/mac:
  ```ts
  private handleHeartbeat(): void {
    this.writeMessage(JSON.stringify({ type: DllMessageType.HeartbeatResp }));
  }
  ```
- `handleHeartbeatResp()`: `this.missCount = 0;`.
- `handlePlayer(msg)`: drop the verify; keep the `def` caching + `emit('message')`:
  ```ts
  private handlePlayer(msg: DllMessage): void {
    const def = typeof msg.def === 'number' && Number.isFinite(msg.def) ? Math.trunc(msg.def) : null;
    this.lastDllDefense = msg.alive === true ? def : null;
    this.emit('message', msg);
  }
  ```
- `handleHotkeyEvent(msg)` / `handleUnresolvedClasses(msg)` / `handleThreats(msg)`:
  drop `verifyIncomingSignedMessage`; keep the existing payload parsing/emit.
  `handleThreats` stays: `const payload = typeof msg.threats === 'string' ?
  msg.threats : ''; const parsed = parseThreatPayload(payload);
  publishDllThreats(parsed.threats, parsed.ground);` — **do not touch
  `parseThreatPayload` / the payload format** (plan 19 owns it).
- `handleMessage` default case: drop the `authenticated`/`sigPayload` verify;
  just `this.emit('message', msg);`.
- `cleanup()`: set `connected = false`; drop `sessionKey`/`nextClientSeq`/
  `lastDllSeq`/`pendingChallenge`/`serverChallenge` resets (fields removed).
  Keep `emit('disconnected')` when it was connected.
- `startHeartbeat()`: send plaintext heartbeat; keep the miss/disconnect logic
  driven by whether a `heartbeatResp` cleared `missCount`:
  ```ts
  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    let awaiting = false;
    this.heartbeatTimer = setInterval(() => {
      if (!this.connected || !this.socket) return;
      if (awaiting) {                       // previous beat unanswered
        this.missCount++;
        if (this.missCount >= MAX_MISSES) {
          Logger.error('InternalBridge', `${this.missCount} heartbeat misses — disconnecting`);
          this.disconnect();
          return;
        }
      }
      awaiting = true;
      this.writeMessage(JSON.stringify({ type: DllMessageType.Heartbeat }));
    }, HEARTBEAT_INTERVAL);
    // heartbeatResp handler resets missCount; clear `awaiting` there via a field
    // if you prefer — simplest is to reset missCount in handleHeartbeatResp and
    // track `awaiting` on the instance instead of the closure.
  }
  ```
  (Implementation detail: track "awaiting" as a private field so
  `handleHeartbeatResp` can clear it. Behavior target: 3 consecutive unanswered
  → disconnect, same as today.)

Keep `userId`/`currentUserId`/`setUserId` (external API surface) — they no
longer influence the wire but `setUserId`'s disconnect-on-change is harmless.

### `import { EventEmitter }`, `signalHelloEvent`, `parseThreatPayload`,
`publishDllThreats`, `Logger`, `BRIDGE`, `DllMessageType` imports all stay.

## Steps

### Step 1 — Rewrite `InternalBridge.ts`
Apply every bullet under "Rewritten `InternalBridge.ts` shape". Verify:
```
cd client && npm run build
```
Expect clean except the 2 known pre-existing `sharp` errors.

### Step 2 — Update `contract.ts` doc comments
Reword the file header (`:1-16`) and the `DllMessageType` doc block (`:25-31`)
to say messages are plaintext, dispatched by `type`, with no `seq`/`mac`/auth.
Keep `BRIDGE` and all `DllMessageType` values (optionally remove `AuthResult` if
you also removed its `case` in Step 1). Build again: `cd client && npm run build`.

### Step 3 — Remove `BuildSecrets.h` generation + secret defines from `build-prod.mjs`
- Delete the `handshakeKey`/`pipeName` consts, the `secretsHeader` string, the
  `writeFileSync(BUILD_SECRETS_H, ...)` + its log (`~:88-104`), the
  `BUILD_SECRETS_H` path const (`:53`), and the post-build `rmSync`/`unlink` of
  `BuildSecrets.h` (`~:335-342`).
- In the esbuild `define` block, delete the `__HANDSHAKE_KEY__` and
  `__PIPE_NAME__` lines (`:233-234`). Leave `PRODUCTION`, `__ADMIN_BUILD__`, the
  JSON blobs, and `import.meta.url` untouched.
- Sanity: `command grep -n 'BuildSecrets\|__HANDSHAKE_KEY__\|__PIPE_NAME__'
  client/scripts/build-prod.mjs` → empty.

### Step 4 — Remove `BuildSecrets.h` writing from `dev-build.bat`
- Delete the `/XF BuildSecrets.h` line from the robocopy call (`:73-78` area;
  keep the rest of the `robocopy`).
- Delete the whole "Write dev BuildSecrets.h if missing" block (`:85-93`).
- Sanity: `command grep -n 'BuildSecrets' client/build-tools/dev-build.bat` →
  empty.

## Verification
```
cd client && npm run build     # clean except the 2 known pre-existing `sharp` errors
```
Completion greps — all must be empty:
```
command grep -rn 'computeSessionMac\|verifyIncomingSignedMessage\|signOutgoingMessage\|deriveSessionKey\|hmacResponse\|sessionKey\|__HANDSHAKE_KEY__\|__PIPE_NAME__' client/src/bridge/
command grep -rn 'createHmac\|createHash\|randomNonce' client/src/bridge/InternalBridge.ts
command grep -rn 'BuildSecrets\|__HANDSHAKE_KEY__\|__PIPE_NAME__' client/scripts/build-prod.mjs
command grep -rn 'BuildSecrets' client/build-tools/dev-build.bat
```
Functional check (on a Windows host with the DLL from 20a): inject → pipe
connects → dashboard shows connected → feature toggles reach the DLL → threats
render → kill+reinject reconnects. No `Dropped unsigned/invalid ...` warnings.

## Out of scope
- **The threat payload string** and `parseThreatPayload`/`DllThreatBus.ts` — plan
  19 owns the payload shape; here only the `seq`/`mac` verify wrapper is removed.
- `client/src/dashboard/server/DevServer.ts` and dashboard UI — they consume the
  unchanged `'authenticated'`/`'disconnected'`/`'message'` events and
  `isConnected`; do not touch them.
- Any `internal/` (C++) file — that is plan 20a.
- The `BRIDGE` protocol constants and feature-key list in `contract.ts` — keep
  their values (the `hello` message still carries `version`/`protocol`).
