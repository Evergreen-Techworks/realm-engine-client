# 20a — Bridge signing removal (internal / C++)

## Goal
The injected DLL's named-pipe bridge (`internal/src/core/ipc/`) speaks
**plaintext length-prefixed JSON dispatched purely by `type`**. All HMAC
signing, the mutual-auth handshake, the derived session key, the per-message
`seq`/`mac` envelope, and the `BuildSecrets.h` dependency are gone. The pipe
still connects, sends `hello`, pushes player/threat/hotkey/feature/tile data
with identical semantics, heartbeats for liveness (no MAC), and reconnects.
Deleting the Release `#error` in `Handshake.cpp` makes
`internal/tools/wsl-build.sh Release` compile with no secret file.

## Dependencies
- **None to start** (parallel-safe against other internal plans).
- **Must precede plan 19** (`19-threat-channel-compact-versioned.md`) — it edits
  the same `IpcBridge.cpp WriteThreats`. **Must precede plan 20b** (client),
  which removes `BuildSecrets.h` generation from `build-prod.mjs`.
- Shared-file warning: `IpcBridge.cpp WriteThreats` and `IpcMessages.{cpp,h}
  BuildThreats` are also touched by plan 19. **Do not change the threat payload
  string** here — only strip the `seq`/`mac` fields from the JSON envelope.
  Plan 19 owns the `<payload>` contents.

## Current state (exact auth surface to remove)

### Files that are 100% auth and get deleted
- `internal/src/core/ipc/Handshake.h` / `Handshake.cpp` — HMAC-SHA256 (BCrypt),
  challenge gen/verify, shared-key decode, `AuthState` struct, heartbeat crypto
  constants. `Handshake.cpp:7-18` is the `#if __has_include("BuildSecrets.h")`
  block whose Release branch is `#error "BuildSecrets.h is required for release
  builds."` (`Handshake.cpp:14`) — **this is the thing blocking Release.**
- `internal/src/core/ipc/IpcSession.h` / `IpcSession.cpp` — `DeriveSessionKey`,
  `ComputeSessionMacHex`, `VerifyClientSeqAndMac`, `ParseUint64Dec`,
  `ConstantTimeHexEq64`, `IsAsciiIdSafe`. All auth/seq/mac.

Confirm no other file uses these before deleting:
`command grep -rn 'Handshake::\|IpcSession' internal/src` must show only
`IpcBridge.cpp`, `IpcSession.*`, `Handshake.*` (verified at planning time — no
`features/`, `gui/`, or `bootstrap/` consumers). `IpcBridge_GetUserId` /
`IpcBridge_IsAuthenticated` (declared `IpcBridge.h:68-69`) have **no callers**
outside `IpcBridge.cpp`.

### `internal/src/core/ipc/IpcMessages.h` / `IpcMessages.cpp` — signed builders
- `IpcMessages.cpp:20-23` `BuildSignedStringJson` emits `"seq":"..","mac":".."`.
- `IpcMessages.cpp:25-28` `BuildHello` emits `"challenge":"%s"`.
- `IpcMessages.cpp:30-33` `BuildAuthResult` — the `authResult` message (delete).
- `IpcMessages.cpp:35-43` `BuildHeartbeat`/`BuildHeartbeatResp` carry
  `nonce`/`response` + seq/mac.
- `IpcMessages.cpp:45-48` `BuildUnresolvedClasses` — seq/mac.
- `IpcMessages.cpp:50-57` `BuildPlayer(seq, mac)` — appends `"seq"/"mac"`.
- `IpcMessages.cpp:59-62` `BuildHotkeyEvent(... seq, mac)`.
- `IpcMessages.cpp:64-67` `BuildThreats(threats, seq, mac)`.
- `IpcMessages.cpp:69-79` `BuildPlayerSigPayload` — the canonical MAC payload
  (delete; nothing signs anymore).

### `internal/src/core/ipc/IpcBridge.cpp` — the state machine + every signer
- `IpcBridge.cpp:19-25` `#if __has_include("BuildSecrets.h")` include + the
  `BUILD_PIPE_NAME` fallback.
- `IpcBridge.cpp:77` `static Handshake::AuthState s_auth = {};` — the shared
  auth/seq/heartbeat state.
- `IpcBridge.cpp:81-82` `IpcBridge_GetUserId` / `IpcBridge_IsAuthenticated`.
- `IpcBridge.cpp:236-245` `WriteThreats` — `s_auth.nextServerSeq++` +
  `ComputeSessionMacHex` + `BuildThreats(...,seq,mac)`.
- `IpcBridge.cpp:247-257` `WriteSignedHotkeyEvent` — seq/mac.
- `IpcBridge.cpp:261-264` `WriteAuthResult`.
- `IpcBridge.cpp:266-320` `DispatchAuthMessage` — the `auth` handler
  (`DeriveSessionKey`, `ComputeResponse`, sets `s_auth.authenticated`) and the
  signed `heartbeat`/`heartbeatResp` handlers.
- `IpcBridge.cpp:324-346` `ParseSetFeatureCommand` — builds a `key|type|value`
  payload and calls `VerifyClientSeqAndMac`.
- `IpcBridge.cpp:348-370` `DispatchTileCommand` — `VerifyClientSeqAndMac` for
  `clearTiles`/`noWalkInit`/`tileUpdate`.
- `IpcBridge.cpp:379-389` `DispatchCommand` — extracts `seq`/`mac` before dispatch.
- `IpcBridge.cpp:393-595` `IpcBridgeThread` — generates the hello challenge
  (`:423`), the 5 s auth-wait loop (`:441-462`), the signed heartbeat send
  (`:485-512`), the signed player push (`:514-529`), signed hotkey/event drains
  (`:531-570`), signed unresolvedClasses (`:572-583`), and
  `Handshake::ClearSharedKeyCache()` (`:593`).

### Project files
- `internal/il2cpp-dll-injection.vcxproj:52,54` (`IpcSession.cpp`,
  `Handshake.cpp`) and `:203,205` (`IpcSession.h`, `Handshake.h`).
- `internal/il2cpp-dll-injection.vcxproj.filters:17,19` and `:121,123` — same
  four files.

## Target design

### Final wire contract (produce exactly this)
DLL → client:
```
{"type":"hello","version":3,"protocol":"bridge-v3","features":["autoDodge","autoAim","tileMap"]}
{"type":"player","alive":true,"hp":H,"maxHp":M,"def":D,"posX":X.XXX,"posY":Y.YYY}
{"type":"player","alive":false}
{"type":"hotkeyEvent","pluginId":"..","action":"..","value":true|false}
{"type":"threats","threats":"<payload UNCHANGED — plan 19 owns it>"}
{"type":"unresolvedClasses","classes":"a,b,c"}
{"type":"heartbeat"}
{"type":"heartbeatResp"}
```
client → DLL (accepted): `setFeature`, `clearTiles`, `noWalkInit`,
`tileUpdate`, `heartbeat`, `heartbeatResp` — all with **no** `seq`/`mac`.
`auth`/`authResult` no longer exist.

### New connection state (replaces `Handshake::AuthState`)
Put a lean struct at file scope in `IpcBridge.cpp` (no separate header needed):
```cpp
struct BridgeConn {
    int       heartbeatMisses;    // consecutive unanswered heartbeats
    ULONGLONG lastHeartbeatSent;  // GetTickCount64() of last heartbeat we sent
    bool      heartbeatPending;   // we sent a heartbeat, awaiting heartbeatResp
    bool      connected;          // hello sent, loop live
};
static BridgeConn s_conn = {};
```
Constants that were in `Handshake.h` move to `IpcBridge.cpp` locals (values
unchanged): `HEARTBEAT_INTERVAL_MS = 5000`, `HEARTBEAT_MAX_MISSES = 3`.

### Public accessors (keep signatures — no external callers, but header exports them)
- `IpcBridge_GetUserId()` → `return "";` (static empty string).
- `IpcBridge_IsAuthenticated()` → `return s_conn.connected && s_conn.heartbeatMisses < HEARTBEAT_MAX_MISSES;`

### Pipe name / `BuildSecrets.h`
Delete the `#if __has_include("BuildSecrets.h") #include "BuildSecrets.h" #endif`
block from `IpcBridge.cpp`. Keep the fixed public fallback so the pipe name is
resolved with no secret:
```cpp
#ifndef BUILD_PIPE_NAME
#define BUILD_PIPE_NAME "\\\\.\\pipe\\lfg-dev-bridge"
#endif
```
This is the same public value `build-prod.mjs` already hardcodes, so Release and
Debug agree. **Divergence note:** `Handshake.cpp` and `IpcBridge.cpp` also
carried a dev-fallback *HMAC key* (`47eb2499...`). It disappears with the auth
layer — nothing needs it. There is no behavior to preserve there.

### Threading / hot path
State (`s_conn`) is only ever touched from the single `IpcBridgeThread`, exactly
as `s_auth` was — no new locking required. Removing HMAC per message is a small
per-message *win* on the push cadence (player every 200 ms, threats/heartbeat as
today). No new per-frame indirection is introduced.

## Steps

Each step ends with a build. Use `bash internal/tools/wsl-build.sh Debug`
(0/0 expected) unless noted.

### Step 1 — Rewrite `IpcMessages.{h,cpp}` to plaintext builders
New signatures in `IpcMessages.h`:
```cpp
int  BuildHello(char* buf, int bufSize);
int  BuildHeartbeat(char* buf, int bufSize);       // {"type":"heartbeat"}
int  BuildHeartbeatResp(char* buf, int bufSize);   // {"type":"heartbeatResp"}
int  BuildUnresolvedClasses(char* buf, int bufSize, const char* classes);
int  BuildPlayer(char* buf, int bufSize);
int  BuildHotkeyEvent(char* buf, int bufSize, const char* pluginId, const char* action, bool value);
int  BuildThreats(char* buf, int bufSize, const char* threats);
```
Delete `BuildAuthResult` and `BuildPlayerSigPayload` from both files. In
`IpcMessages.cpp` replace `BuildSignedStringJson` with a plain helper (or inline
`snprintf`s). Concrete bodies:
```cpp
int BuildHello(char* buf, int bufSize) {
    return snprintf(buf, bufSize,
        "{\"type\":\"hello\",\"version\":3,\"protocol\":\"bridge-v3\",\"features\":[\"autoDodge\",\"autoAim\",\"tileMap\"]}");
}
int BuildHeartbeat(char* buf, int bufSize)     { return snprintf(buf, bufSize, "{\"type\":\"heartbeat\"}"); }
int BuildHeartbeatResp(char* buf, int bufSize) { return snprintf(buf, bufSize, "{\"type\":\"heartbeatResp\"}"); }
int BuildUnresolvedClasses(char* buf, int bufSize, const char* classes) {
    return snprintf(buf, bufSize, "{\"type\":\"unresolvedClasses\",\"classes\":\"%s\"}", classes);
}
int BuildThreats(char* buf, int bufSize, const char* threats) {
    // NOTE: do NOT touch the payload string format — plan 19 owns it.
    return snprintf(buf, bufSize, "{\"type\":\"threats\",\"threats\":\"%s\"}", threats);
}
int BuildHotkeyEvent(char* buf, int bufSize, const char* pluginId, const char* action, bool value) {
    return snprintf(buf, bufSize,
        "{\"type\":\"hotkeyEvent\",\"pluginId\":\"%s\",\"action\":\"%s\",\"value\":%s}",
        pluginId, action, value ? "true" : "false");
}
```
`BuildPlayer` keeps its LocalPlayer reads (`LocalPlayer::GetX/GetY/GetHP/
GetMaxHP/GetDefense/GetPtr`) — just drop the `seq`/`mac` tail:
```cpp
int BuildPlayer(char* buf, int bufSize) {
    if (!LocalPlayer::GetPtr())
        return snprintf(buf, bufSize, "{\"type\":\"player\",\"alive\":false}");
    return snprintf(buf, bufSize,
        "{\"type\":\"player\",\"alive\":true,\"hp\":%d,\"maxHp\":%d,\"def\":%d,\"posX\":%.3f,\"posY\":%.3f}",
        LocalPlayer::GetHP(), LocalPlayer::GetMaxHP(), LocalPlayer::GetDefense(),
        (double)LocalPlayer::GetX(), (double)LocalPlayer::GetY());
}
```
Build. (`IpcMessages.cpp` won't be reachable from `IpcBridge.cpp` yet — that's
Step 3 — but it must still compile on its own.)

### Step 2 — Delete the auth/session files and de-register them
Delete `internal/src/core/ipc/Handshake.h`, `Handshake.cpp`, `IpcSession.h`,
`IpcSession.cpp`. Remove their four `<ClCompile>`/`<ClInclude>` entries from
`internal/il2cpp-dll-injection.vcxproj` (lines noted above) and the matching
four from `internal/il2cpp-dll-injection.vcxproj.filters`. Do **not** build yet
(IpcBridge.cpp still references them) — proceed straight to Step 3, then build.

### Step 3 — Rewrite `IpcBridge.cpp`
Do all of the following in one pass, then build:

1. Remove includes: `#include "Handshake.h"`, `#include "IpcSession.h"`, and the
   `#if __has_include("BuildSecrets.h")` block. Keep the `#ifndef BUILD_PIPE_NAME`
   fallback (shown in Target design).
2. Replace `static Handshake::AuthState s_auth = {};` with the `BridgeConn
   s_conn` struct + `HEARTBEAT_INTERVAL_MS`/`HEARTBEAT_MAX_MISSES` locals.
3. `IpcBridge_GetUserId`/`IpcBridge_IsAuthenticated` → the stubs in Target design.
4. `WriteThreats`: drop seq/mac. Before → after:
   ```cpp
   // before
   const uint64_t outSeq = s_auth.nextServerSeq++;
   char outMac[65] = {};
   if (!IpcSession::ComputeSessionMacHex(s_auth.sessionKey, outSeq, "threats", payload, outMac)) return false;
   const int len = IpcMessages::BuildThreats(msgBuf, msgBufSize, payload, outSeq, outMac);
   // after (payload string UNCHANGED)
   const int len = IpcMessages::BuildThreats(msgBuf, msgBufSize, payload);
   ```
5. `WriteSignedHotkeyEvent` → rename to `WriteHotkeyEvent`, drop the payload/seq/
   mac, call `IpcMessages::BuildHotkeyEvent(msgBuf, msgBufSize, pluginId, action,
   value)`. Update its 4 call sites in the thread loop (socket toggle, plugin
   toggles, player-noclip, drained ghostHit events).
6. Delete `WriteAuthResult` and the entire `auth`-message branch. Replace
   `DispatchAuthMessage` with a `HandleControlMessage(json, hPipe, msgBuf, size)`
   that handles only heartbeat liveness:
   ```cpp
   static bool HandleControlMessage(char* json, HANDLE hPipe, char* msgBuf, int msgBufSize) {
       char typeBuf[64] = {};
       if (!IpcJson::GetString(json, "type", typeBuf, sizeof(typeBuf))) return false;
       if (strcmp(typeBuf, "heartbeat") == 0) {
           IpcFraming::WriteMessage(hPipe, msgBuf, IpcMessages::BuildHeartbeatResp(msgBuf, msgBufSize));
           return true;
       }
       if (strcmp(typeBuf, "heartbeatResp") == 0) {
           s_conn.heartbeatPending = false;
           s_conn.heartbeatMisses = 0;
           return true;
       }
       return false;
   }
   ```
7. `ParseSetFeatureCommand`: drop the `seqStr`/`macHex` params and the
   `VerifyClientSeqAndMac` block; keep the `key`/`valueType`/`value` parse and
   the `DBG_FILE_LOG`. `DispatchTileCommand`: drop `seqStr`/`macHex` params and
   every `VerifyClientSeqAndMac` guard, keeping the `IpcTileState::*` calls.
   `DispatchSetFeature`/`DispatchCommand`: drop the `seq`/`mac` extraction:
   ```cpp
   static void DispatchCommand(char* json) {
       char typeBuf[64] = {};
       if (!IpcJson::GetString(json, "type", typeBuf, sizeof(typeBuf))) return;
       if (DispatchTileCommand(typeBuf, json)) return;
       if (strcmp(typeBuf, "setFeature") == 0) DispatchSetFeature(json);
   }
   ```
8. `IpcBridgeThread` — rewrite the connect/loop:
   - After `SetNamedPipeHandleState`, reset `s_conn = {}`, send hello with
     `IpcMessages::BuildHello(msgBuf, sizeof(msgBuf))` (no challenge). On write
     failure, close + retry as today.
   - **Delete the 5 s auth-wait loop** (`:441-462`). Go straight into the main
     loop; set `s_conn.connected = true`, `s_conn.lastHeartbeatSent =
     GetTickCount64()`.
   - In the read branch: `if (!HandleControlMessage(readBuf, hPipe, msgBuf,
     sizeof(msgBuf))) DispatchCommand(readBuf);` (no `IsHealthy` gate).
   - Heartbeat send block: every `HEARTBEAT_INTERVAL_MS`, if
     `s_conn.heartbeatPending` → `heartbeatMisses++` (disconnect at
     `HEARTBEAT_MAX_MISSES`); else send `IpcMessages::BuildHeartbeat(...)`, set
     `heartbeatPending = true`, `lastHeartbeatSent = now`.
   - Player push (every 200 ms), hotkey/event drains, threats, and
     unresolvedClasses: drop all `IsHealthy` gates and all seq/mac; call the
     plaintext builders. Player push becomes:
     ```cpp
     len = IpcMessages::BuildPlayer(msgBuf, sizeof(msgBuf));
     if (!IpcFraming::WriteMessage(hPipe, msgBuf, len)) { connected = false; break; }
     ```
   - unresolvedClasses: `IpcMessages::BuildUnresolvedClasses(msgBuf,
     sizeof(msgBuf), classes)`.
   - Remove the final `Handshake::ClearSharedKeyCache()` call.
   Build: `bash internal/tools/wsl-build.sh Debug` → expect 0/0.

### Step 4 — Verify Release now builds and raw-access ratchet passes
```
bash internal/tools/wsl-build.sh Release
bash internal/tools/check-raw-access.sh
```
Release must compile with **no** `BuildSecrets.h` present. If MSBuild reports a
missing `BuildSecrets.h` from anywhere, grep for a stray include you missed:
`command grep -rn 'BuildSecrets' internal/src`.

## Verification
```
bash internal/tools/wsl-build.sh Debug      # 0 warnings, 0 errors
bash internal/tools/wsl-build.sh Release     # builds (was blocked by the #error before)
bash internal/tools/check-raw-access.sh      # exit 0
```
Completion greps — all must be empty:
```
command grep -rn 'Handshake\|IpcSession' internal/src/core/ipc/
command grep -rn 'ComputeSessionMac\|sessionKey\|nextServerSeq\|lastClientSeq' internal/src/core/ipc/
command grep -rn '"seq"\|"mac"\|\\"seq\\"\|\\"mac\\"' internal/src/core/ipc/IpcMessages.cpp
command grep -rn 'BuildSecrets' internal/src
```

## Out of scope
- **The threat payload string** inside `{"type":"threats","threats":"..."}`.
  Strip only the envelope; plan 19 reshapes the payload.
- `IpcFraming.{cpp,h}` (length-prefix framing) and `IpcJson.{cpp,h}` — unchanged.
- `IpcTileState.*`, `FeatureState`, `FeatureRuntime`, `FeatureCommandRegistry`
  — their behavior is unchanged; only the seq/mac guards *in front of* their
  calls are removed.
- Any client-side (`client/`) file, including `build-prod.mjs` and
  `dev-build.bat` — that is plan 20b.
