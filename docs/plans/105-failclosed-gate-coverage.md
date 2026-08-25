# 105 — Fail-closed gate coverage audit (**BEHAVIOR-CHANGING — decisions required**)

## Goal

Two fail-closed safety gates were built in earlier phases and then applied at
almost none of the sites they were built for:

- `RuntimeOffsets::IsFieldWriteTrusted` (plan 80/81) exists because a wrong
  float offset **writes successfully** onto some other valid, writable float —
  silent memory corruption with no fault to catch. It gates exactly **one**
  write in the tree.
- `BootGate::FeatureAllowed` (the boot gate that keeps features off until their
  IL2CPP anchors are confirmed healthy) is called by **3** of ~15 features, and
  its dependency table carries **2 rows nobody reads**.

After this plan, every float write in `features/` + `gui/` either goes through
the trust gate or carries a written, reviewed reason why it does not; the
`BootGate` table has no dead rows; and a guardrail check keeps new ungated float
writes out.

**This plan CHANGES BEHAVIOR.** Gating a write means that on a build where the
offset did not resolve from live metadata, the write now **does not happen**.
That is the entire point of the gate — but it is a product decision per site,
not a refactor. Each step below states the decision it requires. **Do not merge
this plan with any other**, and do not start it until a human has signed off on
the decision table.

**This is a C++ plan.** Dispatch it LAST in the C++ queue.

## Dependencies

- **Plans 100, 101, 103 and 104 MUST be merged first.** This plan edits
  `AimHooks.cpp` (100), `TestTAB.cpp` (which plan 103's check 18 deliberately
  excludes, pending this plan), `BootGate.cpp`, and
  `internal/tools/check-raw-access.sh` (100–104 all append to it).

Files this plan touches that other plans also touch:
- `internal/src/features/combat/autoaim/AimHooks.cpp` — plan 100 (different
  function: `TryInstall`/`Uninstall`, not `SendShotPacketDetour`).
- `internal/src/gui/tabs/TestTAB.cpp` — no other plan; plan 103 explicitly left
  it alone for this plan.
- `internal/src/core/runtime/BootGate.cpp` — no other plan.
- `internal/tools/check-raw-access.sh` — append after checks 15–18.

## Current state

### Gate A — `RuntimeOffsets::IsFieldWriteTrusted`

Declared at `internal/src/core/runtime/RuntimeOffsets.h:69-76`:

```cpp
    // Fail-closed gate for FLOAT WRITES that fail OPEN (a wrong float offset writes
    // successfully onto another valid, writable float — silent corruption). Returns
    // true ONLY when the offset was resolved from live IL2CPP metadata this session
    // (ResolvedMatch or ResolvedShifted). Fallback / Suspect / Pending -> false ->
    // the caller MUST refuse the write. Reads may still use the fallback; this gate
    // is specifically for writes.
    bool IsFieldWriteTrusted(const uint32_t* offsetVar);
```

Every call site in the tree:

```bash
$ grep -rn 'IsFieldWriteTrusted' internal/src | grep -v 'RuntimeOffsets.'
internal/src/features/movement/dodge/ProjectileTracking.cpp:610
internal/src/features/movement/collider/PlayerCollider.cpp:93
```

**Only ONE of those two actually gates a write.**

`PlayerCollider.cpp:91-94` → `:279-284` is the reference implementation:

```cpp
bool CollisionOffsetTrusted()
{
    return RuntimeOffsets::IsFieldWriteTrusted(&RuntimeOffsets::OP_CollRadiusMult);
}
...
    const bool trusted = CollisionOffsetTrusted();
    LogOffsetPathTransition(trusted);
    if (!trusted) {
        g_lastPlayer = player;
        return;                       // <-- refuses the write
    }
```

`ProjectileTracking.cpp:605-616` uses it for **observability on a read path**
only — its own comment says so:

```cpp
        // Transition-only witness: reports whether projRadius resolved from live
        // metadata (read-only state query — not a write gate). Observability only;
        // the read path and its range gate below are unchanged.
```

### The ungated float writes

`grep -rn 'Mem::TryWrite' internal/src/features internal/src/gui`:

| # | Site | Field | Type | Gated? |
|---|---|---|---|---|
| 1 | `features/movement/collider/PlayerCollider.cpp:86` | `OP_CollRadiusMult` | float | **yes** (via `:279-284`) |
| 2 | `features/combat/autoaim/AimHooks.cpp:126` | `Shot_Angle` | float | **no** |
| 3 | `features/combat/autoaim/AimHooks.cpp:127` | `Player_FacingAngle` | float | **no** |
| 4 | `gui/tabs/TestTAB.cpp:802` | `PosX` | float | **no** |
| 5 | `gui/tabs/TestTAB.cpp:803` | `PosY` | float | **no** |
| 6 | `gui/tabs/TestTAB.cpp:804` | `KJ_Float3Pos` | float | **no** |
| 7 | `gui/tabs/TestTAB.cpp:805` | `KJ_Float3Pos + 4u` | float | **no** |
| 8 | `gui/tabs/TestTAB.cpp:93` | `HP` | int32 | n/a — see below |

Sites 2–3, in `SendShotPacketDetour` (`AimHooks.cpp:110-131`), fire on **every
outbound shot** when auto-aim is redirecting:

```cpp
        if (ok) {
            const float newAngle = ApplyWeaponTweaks(atan2f(
                s_targetY.load(std::memory_order_relaxed) - py,
                s_targetX.load(std::memory_order_relaxed) - px));
            Mem::TryWrite<float>(shotData, RuntimeOffsets::Shot_Angle, newAngle);
            Mem::TryWrite<float>(player, RuntimeOffsets::Player_FacingAngle, newAngle);
        }
```

Sites 4–7, in the Ctrl+click teleport (`TestTAB.cpp:795-807`), write four floats
into the local player on a user gesture.

There are also **int32** writes outside the gate's stated scope:
`TestTAB.cpp:93` (`HP`), and `VisualsTAB.cpp`'s `WriteInt32At` calls at `:98`
(`MaxHP`) and `:100` (`ObjType`) via its own private helper. The gate's docblock
scopes it to float writes because an integer written to a wrong offset is far
more likely to produce a visible symptom. **Leave the int32 writes alone** — see
"Out of scope".

### Gate B — `BootGate::FeatureAllowed`

Table at `internal/src/core/runtime/BootGate.cpp:39-47`:

```cpp
struct FeatureNeeds { const char* feature; const char* label; const char* needs[4]; int count; };
constexpr FeatureNeeds kFeatures[] = {
    { "ProjectileTracking", "Bullet dodging",        { "HBEAKBIHANL", "KJMONHENJEN" },               2 },
    { "AoeTracking",        "AoE / ground dodging",  { "GJJCEFJMNMK", "FHOHCELBPDO" },               2 },
    { "AutoNexus",          "Auto-nexus (survival)", { "LKHPPBEGNOM", "HBEAKBIHANL" },               2 },
    { "SafeWalk",           "Safe-walk (hazards)",   { "CMFPKCJHKKB", "BGAIOPJMHLO", "KJMONHENJEN" }, 3 },
    { "AutoFire",           "Auto-fire / hold-to-shoot", { "FKALGHJIADI", "LKHPPBEGNOM" },           2 },
};
```

Callers:

```bash
$ grep -rn 'FeatureAllowed(' internal/src | grep -v 'BootGate.h'
internal/src/core/runtime/BootGate.cpp:164:bool FeatureAllowed(const char* feature) {
internal/src/features/movement/dodge/ProjectileTracking.cpp:367
internal/src/features/movement/dodge/AoeTracking.cpp:859
internal/src/features/combat/autofire/AutoFire.cpp:101
```

`"AutoNexus"` and `"SafeWalk"` have **no caller**. And the fallthrough at
`BootGate.cpp:171` is:

```cpp
bool FeatureAllowed(const char* feature) {
    if (s_state != State::Ready) return false;
    for (int i = 0; i < kFeatureCount; ++i) {
        if (std::strcmp(kFeatures[i].feature, feature) != 0) continue;
        ...
        return true;
    }
    return true;          // <-- unregistered name -> ALLOWED
}
```

So a typo in a feature name silently disables the gate for that caller. The two
dead rows also feed `GetFeatureReport` (`:204-208`), which drives the Test tab's
per-feature "blocked" display — so the UI currently claims to gate Auto-nexus and
Safe-walk when it does not.

## Decisions required before implementing

**DECIDED 2026-08-24 by the user. The implementer MUST follow these and must not
re-litigate them:**

- **D1 = GATE BOTH.** Refuse the `Shot_Angle` write as well as
  `Player_FacingAngle` when the offset is untrusted. The user chose the safer
  option over "keep aim working". CONSEQUENCE, and it must be made loud: on a
  build where either offset falls back, auto-aim redirection SILENTLY STOPS
  WORKING and shots fire at the player's real angle. Emit a transition-only
  `DBG_FILE_LOG` naming the untrusted offset when the gate first refuses, so the
  cause is discoverable instead of looking like "auto-aim is broken".
- **D2 = GATE.** (as proposed)
- **D3 = DELETE THE ROW.** Do NOT add a `FeatureAllowed` call to AutoNexus — it
  is a survival feature and must keep running on a degraded build.
- **D4 = DELETE THE ROW.** Do NOT add an enforcement point for SafeWalk.
- **D5 = KEEP `return true` + one-shot log.** (as proposed)

Original table retained below for rationale.

| # | Site | Proposed | Consequence when the offset is untrusted |
|---|---|---|---|
| D1 | `AimHooks.cpp:126-127` (`Shot_Angle`, `Player_FacingAngle`) | **GATE** | Auto-aim redirection stops working on a build where either offset fell back. The shot fires at the player's real angle — degraded, not broken. Alternative: gate only `Player_FacingAngle` (cosmetic facing) and leave `Shot_Angle` ungated so aim still functions. |
| D2 | `TestTAB.cpp:802-805` (teleport) | **GATE** | Ctrl+click teleport does nothing on a build where `PosX`/`PosY`/`KJ_Float3Pos` fell back. Since a wrong `KJ_Float3Pos` write scribbles a float3 into an unknown struct on the local player, gating this is the strongest case in the table. |
| D3 | `BootGate` `AutoNexus` row | **ADD THE CALL** to `AutoNexus`, or **DELETE THE ROW** | Adding it means auto-nexus refuses to run until `LKHPPBEGNOM` + `HBEAKBIHANL` are confirmed healthy — for a survival feature, refusing is arguably worse than running degraded. Deleting the row makes the Test tab stop claiming a gate that does not exist. |
| D4 | `BootGate` `SafeWalk` row | **ADD THE CALL** to the safe-walk path, or **DELETE THE ROW** | Same shape as D3. Note "SafeWalk" is not a module — it is a setting on four dodge modes (`UDodge::SetSafeWalk`, `PJDodge::SetSafeWalk`, …), so "adding the call" means picking one enforcement point, probably `WorldTAB::IsTileDamagingLive`. |
| D5 | `FeatureAllowed`'s unregistered-name fallthrough (`BootGate.cpp:171`) | **KEEP `return true`** and add a one-shot `DBG_FILE_LOG` naming the unregistered feature | Changing it to `return false` would gate every feature that does not have a row — a large, unreviewed behavior change. Logging makes typos visible without changing behavior. |

**Recommended defaults if no decision is forthcoming:** D1 = gate
`Player_FacingAngle` only; D2 = gate; D3 = delete the row; D4 = delete the row;
D5 = keep + log. These are the choices that maximise safety where corruption is
possible and minimise "safety feature silently disables the thing you needed".

## Target design

### Per-site gate helper, modelled on `PlayerCollider`

Do **not** invent a new abstraction. Copy the shape that already works
(`PlayerCollider.cpp:91-107`): a small file-local `…OffsetTrusted()` predicate
plus a transition-only witness log, called once per armed path.

For `AimHooks.cpp`, add above `SendShotPacketDetour`:

```cpp
// Fail-closed gate for the two float writes below. A wrong float offset writes
// SUCCESSFULLY onto some other valid float (RuntimeOffsets.h:69-76) — the write
// cannot fault, so refusing is the only defence. Mirrors
// PlayerCollider::CollisionOffsetTrusted.
static int s_aimWriteTrustLogged = -1;   // -1 unknown, 0 refused, 1 armed

static bool AimWriteOffsetsTrusted()
{
    const bool trusted =
        RuntimeOffsets::IsFieldWriteTrusted(&RuntimeOffsets::Player_FacingAngle);
    const int now = trusted ? 1 : 0;
    if (now != s_aimWriteTrustLogged) {
        s_aimWriteTrustLogged = now;
        DBG_FILE_LOG(trusted
            ? "[AimHooks] facing-angle offset metadata-resolved — writes ARMED"
            : "[AimHooks] facing-angle offset FALLBACK/STALE — REFUSING facing-angle write");
    }
    return trusted;
}
```

(Adjust which offsets it checks to match decision D1.)

For `TestTAB.cpp`, add next to the teleport block:

```cpp
// All four teleport writes are floats and fail OPEN on a stale offset —
// KJ_Float3Pos in particular would scribble a float3 into an unknown struct on
// the local player. Gate all four together: a partial teleport (position moved,
// float3 not, or vice versa) is worse than no teleport.
static bool TeleportOffsetsTrusted()
{
    return RuntimeOffsets::IsFieldWriteTrusted(&RuntimeOffsets::PosX)
        && RuntimeOffsets::IsFieldWriteTrusted(&RuntimeOffsets::PosY)
        && RuntimeOffsets::IsFieldWriteTrusted(&RuntimeOffsets::KJ_Float3Pos);
}
```

Note `KJ_Float3Pos + 4u` is covered by the `KJ_Float3Pos` entry — the gate keys
on the offset **variable's address**, not the computed value
(`RuntimeOffsets.h:65-67`: "Health state for a specific offset variable (reverse
lookup by address)").

### Thread-safety

`IsFieldWriteTrusted` does a reverse lookup over the offset table.
`AimHooks::SendShotPacketDetour` runs on the **game thread** (it is an IL2CPP
detour), not the render thread. Confirm `IsFieldWriteTrusted` is safe to call
from there before wiring it in: read `RuntimeOffsets.cpp`'s implementation and
check it only reads `s_entries`/`s_entryState` (written by `EnsureAll` on the
render thread, and only until settled). If it does more than read, **stop and
report** — the gate would need a snapshot rather than a live query, and that is
a design change outside this plan.

The transition-log statics (`s_aimWriteTrustLogged`) are single-writer per
thread and follow the exact pattern already in
`ProjectileTracking.cpp:600` and `PlayerCollider.cpp:98-107`.

### Hot path

`SendShotPacketDetour` fires once per outbound shot — a few times per second,
not per frame per entity. One extra table lookup there is fine. Do **not** hoist
it into a per-frame cache in this plan; if profiling later shows it matters, the
`PlayerCollider` pattern of computing `trusted` once per Tick is the answer.

## Steps

1. **Get the decisions.** Reproduce the D1–D5 table in the PR description with a
   decision recorded for each. **Do not proceed without them.**
   Verify: the PR description contains five decisions.

2. **Confirm `IsFieldWriteTrusted` is game-thread-safe.** Read its implementation
   in `internal/src/core/runtime/RuntimeOffsets.cpp` and record in the PR what
   state it touches. If it mutates anything, stop.
   Verify: written finding in the PR.

3. **Implement D1 in `AimHooks.cpp`.** Add `AimWriteOffsetsTrusted()` and wrap
   the write(s) the decision covers. Include `RuntimeOffsets.h` and
   `DbgFileLog.h` if not already present.

   Before (`:126-127`):
   ```cpp
               Mem::TryWrite<float>(shotData, RuntimeOffsets::Shot_Angle, newAngle);
               Mem::TryWrite<float>(player, RuntimeOffsets::Player_FacingAngle, newAngle);
   ```
   After (recommended default — gate the facing write only):
   ```cpp
               Mem::TryWrite<float>(shotData, RuntimeOffsets::Shot_Angle, newAngle);
               if (AimWriteOffsetsTrusted())
                   Mem::TryWrite<float>(player, RuntimeOffsets::Player_FacingAngle, newAngle);
   ```
   Verify:
   ```bash
   bash internal/tools/wsl-build.sh Debug && bash internal/tools/check-raw-access.sh
   ```

4. **Implement D2 in `TestTAB.cpp`.** Add `TeleportOffsetsTrusted()` and wrap the
   four writes:
   ```cpp
                   if (okLand && TeleportOffsetsTrusted()) {
                       Mem::TryWrite<float>(localPlayer, RuntimeOffsets::PosX, tpX);
                       Mem::TryWrite<float>(localPlayer, RuntimeOffsets::PosY, tpY);
                       Mem::TryWrite<float>(localPlayer, RuntimeOffsets::KJ_Float3Pos, tpX);
                       Mem::TryWrite<float>(localPlayer, RuntimeOffsets::KJ_Float3Pos + 4u, -tpY);
                   }
   ```
   Add a transition-only `DBG_FILE_LOG` on the refused path so a user who presses
   Ctrl+click and sees nothing has a trace line explaining why.
   Verify: build + guardrail.

5. **Implement D3 and D4 in `BootGate.cpp`.** Either add the `FeatureAllowed`
   calls at the chosen enforcement points, or delete the corresponding rows from
   `kFeatures` (`:42`, `:43`). If deleting, also check
   `GetFeatureReport`'s consumers in `TestTAB.cpp` / `DiagBridge.cpp` still
   render sensibly with fewer rows (they iterate the returned count, so they
   should).
   Verify: build + guardrail. If rows were deleted, confirm the Test tab's
   feature panel still renders (runtime check below).

6. **Implement D5.** In `BootGate.cpp:164-172`, keep `return true` for an
   unregistered name and add a one-shot log:
   ```cpp
       // Unregistered feature name -> not gated. This is deliberate (a feature
       // with no anchor dependencies should not be blocked) but it also means a
       // TYPO silently disables the gate, so name it once.
       static const char* s_warnedUnknown = nullptr;
       if (s_warnedUnknown != feature) {
           s_warnedUnknown = feature;
           DBG_FILE_LOG("[BootGate] FeatureAllowed('" << (feature ? feature : "?")
                        << "') — no kFeatures row, NOT gated");
       }
       return true;
   ```
   (Pointer comparison is intentional: every caller passes a string literal, so
   this logs once per distinct call site without a string compare on a hot path.)
   Verify: build + guardrail.

7. **Add guardrail check 19.** In `internal/tools/check-raw-access.sh`, append
   after the last check added by plans 100–104:

   ```bash
   # 19. Ungated float writes in features/ + gui/. A wrong FLOAT offset writes
   #     SUCCESSFULLY onto another valid float — the write cannot fault, so
   #     Mem::TryWrite's SEH does not protect you. Every float write must sit
   #     behind RuntimeOffsets::IsFieldWriteTrusted (see PlayerCollider.cpp for
   #     the reference shape). Integer writes are out of scope: a wrong int
   #     offset produces a visible symptom.
   #     This check is deliberately COARSE — it flags the write, not the gate —
   #     so a genuinely-reviewed ungated float write needs a same-line
   #     raw-access-ok marker naming the decision.
   hits19="$(grep -rnE 'Mem::TryWrite<float>|Mem::TryWrite\([^,]+, *RuntimeOffsets::[A-Za-z0-9_]+, *[a-zA-Z_][a-zA-Z0-9_]*\)' "${scope_feat[@]}" 2>/dev/null \
     | grep -v 'raw-access-ok')"
   if [ -n "$hits19" ]; then
     echo "REVIEW REQUIRED [ungated float write]:"; echo "$hits19"; fail=1
   fi
   ```

   Then add same-line `raw-access-ok` markers naming the decision to any float
   write the decisions left ungated, e.g.:
   ```cpp
   Mem::TryWrite<float>(shotData, RuntimeOffsets::Shot_Angle, newAngle);  // raw-access-ok: plan 105 D1 — Shot_Angle left ungated so auto-aim still functions on a fallback offset; a wrong write here misses, it does not corrupt player state
   ```
   Also update the script header comment to mention check 19.
   Verify: `bash internal/tools/check-raw-access.sh` → exit 0, no output.

8. **Remove plan 103's temporary TestTAB exclusion from check 18** (added
   because this plan owned the TestTAB writes). In `check-raw-access.sh`, drop
   the `| grep -v 'TestTAB.cpp'` from check 18 and instead put same-line
   `raw-access-ok` markers on `TestTAB.cpp:802-805` explaining they are gated
   writes, not reads.
   Verify: `bash internal/tools/check-raw-access.sh` → exit 0, no output.

## Verification

```bash
bash internal/tools/wsl-build.sh Debug     # expect: 0 Error(s), 0 Warning(s)
bash internal/tools/check-raw-access.sh    # expect: exit 0, no output
```

Greps that must return **zero** results when this plan is complete:

```bash
# Every float write is gated or explicitly marked:
grep -rnE 'Mem::TryWrite<float>' \
  /home/jesse/realm-engine-client/internal/src/features \
  /home/jesse/realm-engine-client/internal/src/gui \
  | grep -v 'raw-access-ok' | grep -v 'PlayerCollider.cpp'

# No BootGate row without a caller (run after implementing D3/D4):
for f in $(grep -oE '\{ "[A-Za-z]+",' /home/jesse/realm-engine-client/internal/src/core/runtime/BootGate.cpp \
           | grep -oE '"[A-Za-z]+"' | tr -d '"' | sort -u); do
  grep -rq "FeatureAllowed(\"$f\")" /home/jesse/realm-engine-client/internal/src || echo "ungated row: $f"
done
```

**Runtime checks — these are what actually validate this plan.**

1. Inject on a healthy build. Confirm the trace log shows
   `[AimHooks] facing-angle offset metadata-resolved — writes ARMED` and that
   auto-aim still redirects shots (fire at an enemy while not facing it).
2. Ctrl+click teleport still works, and the trace log shows no refusal line.
3. Open Test → OFFSET HEALTH. Every offset the gates key on should read
   `ResolvedMatch` or `ResolvedShifted`. If any reads `FallbackFieldName` /
   `FallbackGaveUp` / `Suspect` on a build you consider healthy, the gate will
   refuse and you have found a real offset problem — report it rather than
   loosening the gate.
4. Open Test → the per-feature BootGate panel. Confirm it lists the same rows
   after your D3/D4 change and does not render a blank/garbage row.

## Out of scope

- **Do NOT gate integer writes.** `TestTAB.cpp:93` (`HP`) and
  `VisualsTAB.cpp:98,100` (`MaxHP`, `ObjType`) are int32. The gate's docblock
  scopes it to floats deliberately (`RuntimeOffsets.h:69-71`) — an int written
  to a wrong offset produces a visible symptom. Extending the gate to ints is a
  separate decision.
- **Do NOT change `ProjectileTracking.cpp:605-616`.** It uses
  `IsFieldWriteTrusted` as a read-path *witness* and says so in its own comment.
  Converting it into a gate would disable hitbox-radius reads on a fallback
  offset, which is strictly worse than reading a possibly-stale radius.
- **Do NOT change `FeatureAllowed`'s `return true` fallthrough to `return false`**
  (decision D5 default). That would gate every feature without a row — a large
  behavior change nobody has reviewed.
- **Do NOT change `RuntimeOffsets::IsFieldWriteTrusted` itself**, or the set of
  `OffsetState` values it accepts as trusted. If it is too strict in practice
  (e.g. `ResolvedShifted` should not count), that is its own plan.
- **Do NOT add new BootGate rows** for KillAura / AutoBreakWalls / PlayerCollider
  / the dodge modes. Deciding whether each of those should refuse to run on a
  stale anchor is a per-feature product call and would balloon this plan; D3/D4
  are limited to the two rows that already exist and lie.
- **Do NOT touch the udodge solver, its sensors, or any Phase-3 constant.**
