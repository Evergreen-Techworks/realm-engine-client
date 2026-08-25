# 62 — Diagnostics Cleanup + Guardrail

## Goal
After this plan, the temporary `DBG_FILE_LOG` diagnostics added during the
UDodge debugging/upgrade work are removed from `udodge/`, leaving only permanent,
low-rate logging. The uncommitted CameraTAB log-spam fix is preserved untouched. A
grep guardrail is documented so the debug spam cannot creep back. This is the
final plan of the workstream and runs only after Stages A-D are proven in-game.

## Dependencies
Plan 61 merged (and Stages A-D confirmed working in-game — do NOT strip the
diagnostics until the feature is proven). Touches
`internal/src/features/movement/udodge/UDodge.cpp` and `UDodgeSensors.cpp` only.
Parallel-safe with nothing else in the chain (it is the tail).

## Current state

Temporary diagnostics added during debugging (all throttled `% 120`/`% 240`):
- `UDodge.cpp` — the `MOVE`/`NO-MOVE` blocks (`UDodge.cpp:274-289`) and the worker
  heartbeat added in plan 59.
- `UDodgeSensors.cpp` — `[UDodge] BuildMap rawProjs=...` (`:293-297`) and
  `[UDodge] BuildMap DONE lanes=...` (`:327-332`).

Also present, and to be LEFT ALONE:
- The UNCOMMITTED CameraTAB log-spam fix — CameraTAB is owned by the cleanup wave
  (`internal/src/gui/tabs/CameraTAB.cpp`, forbidden to edit here). Do not stage,
  revert, edit, or commit it; leave it exactly as found.
- The UNCOMMITTED `client/build-tools/dev-build.bat` — leave as found.
- Permanent install/gate logs in `ProjectileTracking.cpp` (keep — they diagnose
  game patches).

## Target design

Remove ONLY the temporary UDodge debugging lines listed above. Keep:
- The `projectileSourceUnavailable` early-return path (behavior, not a log).
- Any permanent one-shot resolve/install logs.
Replace the removed `MOVE`/`NO-MOVE`/`BuildMap` spam with nothing (the overlay +
`DiagView` already expose lanes/zones/threats/decision to the Test tab and client
diag view, `UDodge.cpp:380-407`). If a single low-rate health line is still
wanted, keep at most ONE `% 600` heartbeat gated behind an existing debug flag —
but default to removing all of them.

## Steps

1. **Remove the `DBG_FILE_LOG` diagnostics** from `UDodge.cpp` (the `MOVE`/
   `NO-MOVE` blocks at `:274-289` and the plan-59 worker heartbeat) and from
   `UDodgeSensors.cpp` (`:293-297`, `:327-332`). Leave the surrounding control flow
   (the `if (g_out.overrideActive || autoWalk)` move dispatch) intact — only the
   logging statements go. If the `DbgFileLog.h` include is now unused in a file,
   remove it. Build:
   `bash internal/tools/wsl-build.sh Debug && bash internal/tools/check-raw-access.sh`

2. **Confirm the CameraTAB and dev-build.bat changes are untouched.**
   `git status` must still show them modified exactly as before this plan (this
   plan does not touch them). No code change.

3. **In-game smoke test**: UDodge + Autopilot still work end-to-end (dodge, path,
   orbit) with the diagnostics gone; the dll-trace is quiet during normal play.

## Verification

```bash
bash internal/tools/wsl-build.sh Debug          # 0 errors
bash internal/tools/check-raw-access.sh         # exit 0
```

Completion greps (must return NOTHING):
```bash
command grep -rn "BuildMap rawProjs\|BuildMap DONE\|NO-MOVE\|\\[UDodge\\] MOVE dec" \
  internal/src/features/movement/udodge/
```
`git status` still lists `internal/src/gui/tabs/CameraTAB.cpp` (if it was modified
before) and `client/build-tools/dev-build.bat` as modified — this plan changed
neither.

## Out of scope
- Do NOT touch `CameraTAB.cpp`, `client/build-tools/dev-build.bat`, or any
  cleanup-wave file.
- Do NOT remove permanent `ProjectileTracking` install/gate logging.
- Do NOT change any UDodge behavior — logging removal only.
