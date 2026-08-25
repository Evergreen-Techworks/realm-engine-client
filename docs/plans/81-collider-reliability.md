# 81 — Collider Reliability: Fail-Closed Writes, Self-Witnessing, Liveness

## Goal
After this plan, `features/movement/collider/PlayerCollider` (1) **refuses to write or
capture** the collision multiplier unless the offset was resolved from live metadata
(fail-closed against the silent float-corruption failure mode), (2) **logs on
transitions only** so "the collider is applying" is provable from the log — offset
path, ARMED/disarmed edges, and `targets found=0` — and (3) carries a **liveness
stamp** (`LastTickMs()`) surfaced in the Test panel so a deleted driver call is
visible instead of silent. Behavior is unchanged on the happy path (offset trusted,
feature armed, targets present): it writes exactly as before.

## Dependencies
- **Plan 80 must be merged first** — this plan calls
  `RuntimeOffsets::IsFieldWriteTrusted(&RuntimeOffsets::OP_CollRadiusMult)` and relies
  on the corrected `OP_CollRadiusMult = 0x788` fallback.
- Files touched: `features/movement/collider/PlayerCollider.{h,cpp}` and
  `gui/tabs/TestTAB.cpp` (one small read-only diagnostic row). No other plan in this
  series touches these files, so it runs in parallel with plan 82.

## Current state

`features/movement/collider/PlayerCollider.cpp`:
- Read/write helpers (`:72-80`) go straight through the offset with no trust check:
  ```cpp
  bool WriteCollisionMultiplier(void* properties, float value) {
      return Mem::TryWrite(properties, RuntimeOffsets::OP_CollRadiusMult, value);
  }
  ```
- `Tick(void* player)` (`:197`):
  - Early-outs when disabled (`:201`) and when `player == nullptr` (`:207`) with **no
    liveness stamp** — the top of the function does no work-independent timestamping.
  - When `propertyCount == 0` it `return`s silently (`:233-234`) — no witness that the
    feature resolved nothing to write to.
  - Captures the original only if the read is finite and non-zero (`:255`) — good — and
    then unconditionally `WriteCollisionMultiplier(propertiesPtr, g_multiplier)`
    (`:261`) with no offset-trust gate.
- `SetEnabled(bool)` (`:272`) flips `g_enabled` with **no ARMED/disarmed log** — this
  is the toggle-reached-the-DLL edge that currently proves nothing.
- The `logFn` plumbing exists (`PlayerCollider.h:9`, `ApplyMultiplier` calls it) but
  `Tick` never installs one, so nothing is logged.

`gui/tabs/TestTAB.cpp:1357-1369` has a "GAME HITBOX DEBUG" section that reads the live
multiplier; it is the natural home for the liveness/offset-path row. Note TestTAB's
own collision reads (`:244`, `:259`) already route through `RuntimeOffsets::OP_CollRadiusMult`
— do NOT change those.

## Target design

All new logging is **transition-only**: a `static` last-value is compared with an
integer/enum compare every frame; a `DBG_FILE_LOG` fires only when the value changes.
No per-frame disk writes. Grep-able tag: `[PlayerCollider]`.

### `PlayerCollider.h`
Add to the public API:
```cpp
// Liveness: GetTickCount64() stamped at the TOP of Tick(), before any early-out,
// so it measures "the driver still calls me", not "I did work". 0 until first tick.
uint64_t LastTickMs();

// True when the collision-multiplier offset is registry-trusted (resolved from live
// metadata) AND the feature is currently applying. For the Test diag row.
bool OffsetTrusted();
```

### `PlayerCollider.cpp`
- Add `#include "core/logging/DbgFileLog.h"` and `#include <cstdint>`.
- Add file-scope state in the anon namespace:
  ```cpp
  uint64_t g_lastTickMs = 0;
  int      g_lastArmedLog = -1;     // -1 unknown, 0 disarmed, 1 armed
  int      g_lastPathLog  = -1;     // -1 unknown, 0 fallback/untrusted, 1 trusted
  int      g_lastTargetsZero = -1;  // -1 unknown, 0 had-targets, 1 zero-targets
  ```
- New helper for the fail-closed gate:
  ```cpp
  bool CollisionOffsetTrusted() {
      return RuntimeOffsets::IsFieldWriteTrusted(&RuntimeOffsets::OP_CollRadiusMult);
  }
  ```
- A transition-log helper for the offset path, called once per Tick while armed:
  ```cpp
  void LogOffsetPathTransition(bool trusted) {
      const int now = trusted ? 1 : 0;
      if (now == g_lastPathLog) return;
      g_lastPathLog = now;
      if (trusted)
          DBG_FILE_LOG("[PlayerCollider] offset path: via FieldInfo (0x"
              << std::hex << RuntimeOffsets::OP_CollRadiusMult << std::dec << ") — writes ARMED");
      else
          DBG_FILE_LOG("[PlayerCollider] offset path: FALLBACK/STALE (state not metadata-resolved) "
              "— REFUSING writes to collisionRadiusMultiplier");
  }
  ```

### Wiring in `Tick`
1. First line of `Tick` (before the `!g_enabled` early-out):
   `g_lastTickMs = GetTickCount64();`
2. ARMED-edge log in `SetEnabled` (see below), OR at the top of the armed branch —
   put it in `SetEnabled` so it fires exactly on the toggle:
3. In the armed body, before the capture/write loop, evaluate
   `const bool trusted = CollisionOffsetTrusted();` and call
   `LogOffsetPathTransition(trusted);`.
4. **Fail-closed gate:** if `!trusted`, skip the entire capture-and-write loop
   (`PlayerCollider.cpp:239-267`) — do not read, do not capture, do not write, do not
   rebuild the tracking set. Leave `g_tracked` as-is (so a later trusted frame still
   restores anything captured while trusted). `g_lastPlayer = player; return;`.
5. `targets found=0` witness: at the current `if (propertyCount == 0) return;`
   (`:233`), before returning, transition-log:
   ```cpp
   if (propertyCount == 0) {
       if (g_lastTargetsZero != 1) { g_lastTargetsZero = 1;
           DBG_FILE_LOG("[PlayerCollider] targets found=0 (nothing to write to)"); }
       g_lastPlayer = player; return;
   }
   ```
   and set `g_lastTargetsZero = 0` on the path where `propertyCount > 0` (once, on
   transition).

### `SetEnabled` ARMED edge (`PlayerCollider.cpp:272`)
```cpp
void SetEnabled(bool enabled) {
    if (g_lastArmedLog != (enabled ? 1 : 0)) {
        g_lastArmedLog = enabled ? 1 : 0;
        DBG_FILE_LOG("[PlayerCollider] " << (enabled ? "ARMED (toggle reached DLL)"
                                                     : "DISARMED"));
    }
    g_enabled = enabled;
}
```

### Accessors
```cpp
uint64_t LastTickMs()   { return g_lastTickMs; }
bool     OffsetTrusted(){ return CollisionOffsetTrusted(); }
```
Reset `g_lastTickMs`/log-state sensibly in `ResetStateForTest()` (set the three
`g_last*Log` back to -1; leave `g_lastTickMs` as-is or 0).

### Test panel surface (`gui/tabs/TestTAB.cpp`, GAME HITBOX DEBUG block ~1357-1369)
Add two read-only lines after the existing "Current game multiplier" text:
```cpp
const uint64_t colTick = PlayerCollider::LastTickMs();
const uint64_t sinceMs  = colTick ? (GetTickCount64() - colTick) : 0;
ImGui::TextColored(colTick && sinceMs < 500 ? ImVec4(0.4f,1.f,0.4f,1.f)
                                            : ImVec4(1.f,0.5f,0.3f,1.f),
    "Collider Tick: %s (%llu ms ago)  offset=%s",
    colTick ? "live" : "NEVER TICKED",
    (unsigned long long)sinceMs,
    PlayerCollider::OffsetTrusted() ? "metadata-trusted" : "FALLBACK/untrusted");
```
Include `features/movement/collider/PlayerCollider.h` in TestTAB if not already.

## Steps

1. **Add liveness + accessors, no gating yet.** Add `LastTickMs()`/`OffsetTrusted()`
   to `PlayerCollider.h`; add `g_lastTickMs` + the accessors + the `GetTickCount64()`
   stamp as the first statement of `Tick` in `PlayerCollider.cpp`; add the required
   includes. Build:
   ```bash
   bash internal/tools/wsl-build.sh Debug
   ```
   No behavior change (stamp + getters only).

2. **Add ARMED/disarmed transition log.** Implement the `SetEnabled` edge log and
   `g_lastArmedLog`. Build (as above). Behavior unchanged; log now proves the toggle.

3. **Add offset-path transition log + fail-closed write gate.** Add
   `CollisionOffsetTrusted()`, `LogOffsetPathTransition`, and the `if (!trusted)` skip
   of the capture/write loop. Build (as above). Happy path (offset trusted) is
   byte-identical; only an untrusted offset now refuses the write.

4. **Add `targets found=0` witness.** Wire `g_lastTargetsZero` at the `propertyCount`
   branch. Build (as above).

5. **Surface liveness/offset in the Test panel.** Add the two ImGui lines in the GAME
   HITBOX DEBUG block of `TestTAB.cpp`. Build + guardrail:
   ```bash
   bash internal/tools/wsl-build.sh Debug
   bash internal/tools/check-raw-access.sh
   ```
   Expect 0 errors, guardrail exit 0.

## Verification
```bash
bash internal/tools/wsl-build.sh Debug        # 0 errors after every step
bash internal/tools/check-raw-access.sh       # exit 0 (no new raw access)
```
Grep — the gate and logs exist and the write path is guarded:
```bash
command grep -n 'IsFieldWriteTrusted\|\[PlayerCollider\]\|LastTickMs' internal/src/features/movement/collider/PlayerCollider.cpp
```
In-game (user Release deploy): toggling the Collider plugin writes exactly one
`[PlayerCollider] ARMED (toggle reached DLL)` line; the hitbox still shrinks
identically; Test → GAME HITBOX DEBUG shows "Collider Tick: live (<500 ms ago)
offset=metadata-trusted". Standing at char-select with it armed logs
`targets found=0` once (not per frame).

## Out of scope
- Do NOT change the multiplier math, the capture-original/restore logic
  (`TrackedProperty`, `RestoreTrackedColliders`, `ForgetTrackedColliders`), or the
  three ObjectProperties target offsets — pattern 5 is already correct; only gate it.
- Do NOT change TestTAB's existing `ReadCollisionMult`/`ReadCollisionMultAlt`
  (`:236`,`:251`) or its offset reads — they already route through the table.
- Do NOT touch `RuntimeOffsets.*` (plan 80 owns it) or `ProjectileTracking.*`
  (plan 82 owns it).
- Do NOT add per-frame logging; every new log must be transition-gated by a static
  last-value.
