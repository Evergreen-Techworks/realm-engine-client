# 19 — Threat channel: compact versioned payload + truncation

## Goal
The DLL→client threat/ground payload keeps its **compact delimited** wire form (for
per-frame cost) but becomes drift-safe and honest: a leading schema-version token so
version skew fails loud, and a trailing `truncated` flag so load-shedding under heavy
bullet load is visible to the nexus policy instead of silently dropped. The two
hand-maintained string codecs are consolidated to ONE encoder (C++) and ONE decoder
(TS) around the existing typed objects, and auto-nexus responds conservatively when it
knows it is seeing a partial picture.

## Object-oriented framing
Same as the rest of the refactor: the "threat" and "ground hazard" are typed domain
objects (`IpcThreat`/`IpcGround` in C++, `DllThreat`/`DllGround` in TS). This plan gives
each side a single-responsibility codec around those objects instead of the current
three-function smear:
- C++ encoder (single home): `IpcMessages::EncodeThreats(...)` — the ONLY place that
  serializes the threat objects to the wire string.
- TS decoder (single home): `decodeThreatPayload(str)` in `DllThreatBus.ts` — the ONLY
  place that maps the wire string back to the typed objects.
The wire layout is a documented projection of the object fields, gated by ONE version.

## Dependencies
- **Depends on plan 20 (bridge signing removal) — land plan 20 FIRST.** Plan 20 removes
  the `seq`/`mac` envelope and the handshake from all messages, including threats; this
  plan then only reshapes the threat *payload string*. If plan 20 is not yet merged, do
  NOT also strip signing here — that is plan 20's job. If for some reason this runs
  before plan 20, the threat message is still the (unsigned-or-signed) `{"type":"threats",
  "threats":"<payload>"}` envelope and this plan only touches the `<payload>` contents.
- **Cross-language — cannot be split internal/client.** Both sides must agree on the
  version token and field layout. Touches `internal/src/core/ipc/{IpcBridge.cpp,
  IpcMessages.cpp,IpcMessages.h}`, `client/src/bridge/DllThreatBus.ts`,
  `client/src/bridge/InternalBridge.ts` (the `handleThreats` parse call only), and a new
  client test. Shares `IpcBridge.cpp WriteThreats` / `handleThreats` with plan 20 — do
  them in order, not concurrently.

## Current state
- `internal/src/core/ipc/IpcBridge.cpp:~180 BuildThreatPayload` builds
  `"<gDmg>:<gT>[|<d>:<t>]*;<attacker:bullet:tHitMs:dmg:pierce>[,...]"`. Silent truncation
  when a record won't fit and when `n >= kIpcMaxThreats` / ground `count >
  kIpcMaxGroundEvents` (the drops originate in `AutoNexus.cpp PublishThreats` /
  `IpcBridge_PublishThreats`).
- `internal/src/core/ipc/IpcBridge.cpp:~238 WriteThreats` builds the payload and sends it
  (envelope handling — seq/mac — is plan 20's concern).
- `client/src/bridge/DllThreatBus.ts:~64 parseThreatPayload` splits the string by
  `;` / `,` / `:` / `|` into `DllThreat[]` + `DllGround`. `DllThreat`/`DllGround`/
  `DllGroundEvent` interfaces at lines 1-18.
- `client/src/bridge/InternalBridge.ts:~623 handleThreats` calls `parseThreatPayload`.
- Caps: `kIpcMaxThreats=32`, `kIpcMaxGroundEvents=12` (`IpcBridge.h:35,50`).

## Target design
### Compact versioned wire layout (version 1)
```
1;<ground>;<threats>;<T>
```
- Leading `1` = `THREAT_SCHEMA_VERSION`. Decoder rejects any other leading token (skew
  → return empty + one-line warn; auto-nexus then falls back to server-confirmed damage).
- `<ground>` = `<rawDamage>:<tHitMs>[|<rawDamage>:<tHitMs>]*` (unchanged).
- `<threats>` = `<attackerObjId>:<bulletId>:<tHitMs>:<fallbackDamage>:<fallbackArmorPiercing>`
  comma-separated (unchanged field order — documented in BOTH codecs).
- `<T>` = `0` | `1` truncated flag.
Overhead vs today: ~3 bytes total. Compact preserved. To add a field later, bump the
leading version to `2` and branch in both codecs — old/new never silently mix.

Define `THREAT_SCHEMA_VERSION` once per language (`IpcMessages.h`, `DllThreatBus.ts`),
each with the field-order comment and a pointer to the other file.

### C++ encoder (single home)
- Add `int IpcMessages::EncodeThreats(char* out,int outSize,const IpcThreat* threats,
  int count,const IpcGround& ground,bool truncated)` — emits the `1;...;<T>` string.
  Move the serialization logic out of `BuildThreatPayload` into it; delete
  `BuildThreatPayload`. `WriteThreats` calls `EncodeThreats`.
- Thread `truncated` from the publish path (`IpcBridge_PublishThreats` /
  `AutoNexus.cpp PublishThreats`): set it when `n >= kIpcMaxThreats` or ground overflow
  forced a drop; store alongside `s_threatsPending`; pass to `EncodeThreats`.

### TS decoder (single home)
- `DllThreatBus.ts`: add `export const THREAT_SCHEMA_VERSION = 1;` and
  `export function decodeThreatPayload(str): { threats: DllThreat[]; ground: DllGround;
  truncated: boolean }`. It splits off the leading version, returns empty (`{threats:[],
  ground:default, truncated:false}`) if the version != 1, else parses the segments with
  per-field `Number(...)`/finite guards and reads the trailing `<T>`. Replace
  `parseThreatPayload` with this (keep the old name as a thin alias only if other callers
  exist — grep first; if `handleThreats` is the sole caller, delete `parseThreatPayload`).
- `publishDllThreats` / bus slot / `getDllThreats`: carry `truncated`; add
  `getDllThreatsTruncated(): boolean`.

### Truncation policy (deliberate behavior change — FLAG IT)
In `auto-nexus.ts`, when `getDllThreatsTruncated()` is true, treat that tick's predicted
danger as "assume worst" — never *raise* the nexus bar when the picture is known-partial.
Keep it to ONE clearly-commented spot.

## Steps
1. `THREAT_SCHEMA_VERSION` + field-order comments in `IpcMessages.h` and `DllThreatBus.ts`.
   Build (`bash internal/tools/wsl-build.sh Debug`) + `cd client && npm run build`.
2. C++ `EncodeThreats` (compact `1;...;<T>`), delete `BuildThreatPayload`, `WriteThreats`
   calls it. Build Debug 0/0.
3. Thread `truncated` from publish path into `EncodeThreats`. Build Debug 0/0; guardrail
   (`bash internal/tools/check-raw-access.sh`) exit 0.
4. TS `decodeThreatPayload` + `THREAT_SCHEMA_VERSION` guard + `truncated`; wire through
   `publishDllThreats`/slot/`getDllThreatsTruncated`; retire `parseThreatPayload`. Build.
5. `handleThreats` uses `decodeThreatPayload`. Build.
6. Round-trip test `client/src/bridge/__tests__/threatPayload.roundtrip.test.ts` (vitest):
   `"1;10:200|5:250;7:9:180.0:40:1,8:9:190.0:35:0;0"` → decode → assert exact
   `DllThreat[]`/`DllGround`/`truncated=false`; a `"1;...;1"` fixture → `truncated=true`;
   a `"2;..."` fixture → empty + version rejected. `npx vitest run <file>`.
7. Truncation policy in `auto-nexus.ts` (flagged behavior change), one commented spot. Build.
8. Final gates: DLL Debug 0/0 + guardrail 0; client build clean except the 2 known `sharp`
   errors; vitest passes.

## Verification
```
bash internal/tools/wsl-build.sh Debug             # 0/0
bash internal/tools/check-raw-access.sh            # exit 0
cd client && npm run build:native && npm run build # only the 2 known sharp errors
npx vitest run client/src/bridge/__tests__/threatPayload.roundtrip.test.ts
```
Completion greps (must be EMPTY):
```
command grep -rn 'BuildThreatPayload' internal/src/core/ipc/
command grep -n 'parseThreatPayload' client/src/bridge/   # unless kept as an intentional alias
```

## Out of scope
- Signing/handshake removal — that is plan 20. This plan does NOT touch `seq`/`mac`/
  auth (assume plan 20 already removed them, or leave the envelope untouched).
- Threat COMPUTATION (AutoNexus prediction math) — unchanged; only serialization + the
  truncation signal.
- Cross-language codegen — not here; one hand-maintained encoder + decoder + version guard
  + round-trip test.
- The pre-existing client `sharp` tsc errors.
