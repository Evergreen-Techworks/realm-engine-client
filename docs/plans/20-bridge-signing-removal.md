# 20 — Bridge signing removal (overview + shared wire contract)

## Goal
After this workstream, the DLL↔client named-pipe bridge is **plaintext
length-prefixed JSON messages dispatched purely by `type`**. There is no
per-message `seq`/`mac`, no mutual-auth handshake (`hello` challenge → `auth`
challenge-response → `authResult`), no derived session key, and no
`BuildSecrets.h` dependency. The pipe still connects, exchanges player / threat
/ hotkey / feature / tile data with identical *semantics*, heartbeats for
liveness (without a MAC), and reconnects. Removing the Release `#error` in
`Handshake.cpp` unblocks `internal/tools/wsl-build.sh Release`.

This is a **decision already made** (client is open source; the DLL↔client
pairing lock is moot). Do not re-litigate; execute the removal.

## Why this is split into 20a + 20b
Removing the whole auth layer from both sides honestly exceeds one
agent-session, so it is split:

- **20a — internal (C++)**: `internal/src/core/ipc/*` + the `.vcxproj`.
- **20b — client (TypeScript + build scripts)**: `client/src/bridge/*` +
  `client/scripts/build-prod.mjs` + `client/build-tools/dev-build.bat`.

Each sub-plan is fully self-contained and repeats the final wire contract
below. Read only your assigned sub-plan; you do not need the other.

## Ordering and coordination (read carefully)

1. **This is a flag-day protocol change.** The DLL (`version.dll`) is built
   from this same tree and ships together with the client (see
   `client/scripts/build-prod.mjs`, which builds the Release DLL into
   `client/assets/version.dll`). There is **no supported mixed configuration**
   (new client vs. old DLL, or vice versa). The pipe protocol flips atomically
   when both sides are rebuilt. Merge 20a and 20b together (or back-to-back)
   and rebuild+redeploy both. Do not run a new one side against an unrebuilt
   other side — the old side will drop every message (MAC verify fails) or
   stall the handshake, which looks like a hang, not a crash.

2. **20a lands first, then 20b.** 20b removes the `BuildSecrets.h` generation
   from `build-prod.mjs`. If that generation is removed *before* 20a deletes
   the Release `#error` in `Handshake.cpp`, a Release DLL build via
   `build-prod.mjs` would fail. So: **20b depends on 20a.**

3. **Plan 20 lands before plan 19** (`19-threat-channel-compact-versioned.md`).
   Plans 20a and 19 both edit `IpcBridge.cpp WriteThreats`; plans 20b and 19
   both edit `InternalBridge.ts handleThreats`. **Plan 20 must NOT change the
   threat payload string format** — it only strips the `seq`/`mac` envelope
   around `{"type":"threats","threats":"<payload>"}`. The `<payload>` contents
   are owned by plan 19. Do these in order, never concurrently.

## Final plaintext wire contract (both sub-plans must produce exactly this)

Framing is unchanged: every message is a little-endian `uint32` byte-length
prefix followed by that many bytes of UTF-8 JSON
(`IpcFraming.{cpp,h}` on the DLL side, `writeMessage`/`processMessages` in
`InternalBridge.ts`). Only the JSON bodies change (no `seq`, no `mac`).

**DLL → client:**
```
{"type":"hello","version":3,"protocol":"bridge-v3","features":["autoDodge","autoAim","tileMap"]}
{"type":"player","alive":true,"hp":H,"maxHp":M,"def":D,"posX":X.XXX,"posY":Y.YYY}
{"type":"player","alive":false}
{"type":"hotkeyEvent","pluginId":"..","action":"..","value":true|false}
{"type":"threats","threats":"<payload — unchanged, owned by plan 19>"}
{"type":"unresolvedClasses","classes":"a,b,c"}
{"type":"heartbeat"}
{"type":"heartbeatResp"}
```
`authResult` is **removed** (no longer sent).

**client → DLL:**
```
{"type":"setFeature","key":"..","valueType":"b|n|s","value":<bool|number|string>}
{"type":"clearTiles"}
{"type":"noWalkInit","types":".."}
{"type":"tileUpdate","tiles":".."}
{"type":"heartbeat"}
{"type":"heartbeatResp"}
```
`auth` is **removed** (no longer sent).

## Connection lifecycle without auth

1. Client (Node/Electron) is the pipe **server**; it `listen()`s and calls
   `signalHelloEvent()` so the DLL's load gate opens.
2. DLL (pipe **client**) connects, immediately sends `hello` (no challenge),
   then enters its main loop and begins pushing `player`/`threats`/`hotkeyEvent`
   /`unresolvedClasses` and heartbeats. It does **not** wait for any auth reply.
3. Client, on receiving `hello`: validate `version`/`protocol`, mark the
   connection live, emit the existing `'authenticated'` event (kept by name for
   downstream `DevServer` compatibility — it now means "connected"), replay all
   remembered feature state, and start its heartbeat timer.
4. Heartbeats stay **bidirectional** for liveness: each side sends
   `{"type":"heartbeat"}` every 5 s; the peer replies `{"type":"heartbeatResp"}`;
   3 consecutive unanswered heartbeats → disconnect. No nonce, no MAC — receipt
   of any `heartbeatResp` proves liveness.
5. On disconnect the DLL loops and reconnects; the client cleans up, emits
   `'disconnected'`, and keeps listening.

## Plans in this workstream

| Plan | Scope | Depends on |
|------|-------|-----------|
| 20a  | Internal C++ IPC: delete handshake/session, plaintext builders + bridge loop, drop `BuildSecrets.h` | none (parallel-safe vs. other internal plans; but **must precede** 19 and 20b) |
| 20b  | Client TS bridge + build scripts: remove crypto/handshake/sign/verify, drop `BuildSecrets.h` generation | **20a** |

## Global verification

Run all of these; each sub-plan repeats the subset relevant to it.

```
bash internal/tools/wsl-build.sh Debug      # expect 0 warnings / 0 errors
bash internal/tools/wsl-build.sh Release     # NOW must build too (no BuildSecrets.h)
bash internal/tools/check-raw-access.sh      # expect exit 0
cd client && npm run build                   # clean except the 2 known pre-existing `sharp` errors
```

Completion greps (must return zero results in the touched trees):
```
command grep -rn 'seq\|mac\|Handshake\|IpcSession\|sessionKey\|ComputeSessionMac' internal/src/core/ipc/
command grep -rn 'computeSessionMac\|verifyIncomingSignedMessage\|signOutgoingMessage\|deriveSessionKey\|__HANDSHAKE_KEY__' client/src/bridge/
```
