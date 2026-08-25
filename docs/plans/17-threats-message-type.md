# 17 — Centralize the DLL 'threats' bridge message type

## Goal
The DLL→client `'threats'` message type (added by PR #52's DllThreatBus) is routed
through the centralized `DllMessageType` contract like every other bridge message,
instead of a raw string literal. After this plan there is no bare `case 'threats'`
in the bridge dispatch — it reads `case DllMessageType.Threats`.

## Dependencies
none — parallel-safe. Touches `client/src/bridge/contract.ts` and
`client/src/bridge/InternalBridge.ts`. No other in-flight plan touches these files
(plan 16 is internal C++ only).

## Current state
PR #52 added a DLL→client threat/ground data channel but wired its message type as a
raw literal, bypassing the `DllMessageType` object that every other bridge message
uses:
- `client/src/bridge/InternalBridge.ts:495` — `case 'threats':` (the ONLY case in that
  switch not using `DllMessageType.X`; every sibling is `case DllMessageType.Hello:` etc.)
- `client/src/bridge/contract.ts:31-43` — the `DllMessageType` object has no `Threats`
  entry.
- The C++ emitter (`internal/src/core/ipc/IpcMessages.cpp:66`,
  `BuildSignedStringJson(..., "threats", "threats", ...)`) hardcodes the same string.
  That side stays a hand-matched literal — this contract module deliberately does NOT
  unify across the language boundary (see contract.ts header comment); it centralizes
  the TS mirror only.

## Target design
Add one entry to the existing `DllMessageType` const object in
`client/src/bridge/contract.ts`, placed with the other incoming (DLL→client) types:
```ts
UnresolvedClasses: 'unresolvedClasses',
Threats: 'threats',
SetFeature: 'setFeature',
```
The value MUST be exactly `'threats'` (byte-matches IpcMessages.cpp). Then in
`InternalBridge.ts`, replace the raw case with the constant. No behavior change — same
wire string, same handler (`this.handleThreats(msg)`).

## Steps
1. `client/src/bridge/contract.ts`: add `Threats: 'threats',` to the `DllMessageType`
   object immediately after `UnresolvedClasses`. (Update the doc comment above the
   object to list Threats among the incoming DLL→client types.)
2. `client/src/bridge/InternalBridge.ts`: change `case 'threats':` (~line 495) to
   `case DllMessageType.Threats:`. Confirm `DllMessageType` is already imported at the
   top of the file (it is — used by all sibling cases).
3. Verify (below).

## Verification
```
cd client && npm run build:native && npm run build
```
Success = tsc exits 0 EXCEPT for the two KNOWN pre-existing, unrelated `sharp` errors
(`src/dashboard/server/wikiSpriteService.ts` TS2503, `src/util/rotmgLocalExtractor.ts`
TS2349) — those predate this branch, do not touch them. No NEW errors.
Completion grep (must be empty):
```
command grep -rn "case 'threats'" client/src/bridge/
```
And `command grep -n "Threats: 'threats'" client/src/bridge/contract.ts` must match.

## Out of scope
Do NOT change the C++ side (`IpcMessages.cpp`) or attempt cross-language schema
codegen — that is a separate deferred design item. Do NOT touch the threat payload
PARSING (`DllThreatBus.ts` / `parseThreatPayload`) — only the message-type dispatch.
Do NOT fix the pre-existing `sharp` tsc errors.
