# 16 — Guardrail hardening + hot-loop honesty

## Goal
After this plan, `internal/tools/check-raw-access.sh` can no longer be defeated by
the three evasion patterns that currently pass it silently — (a) aliasing a
`RuntimeOffsets::X` field into a local `kOff`/`OFF_` reference and then reading
`ptr + kOffX`, (b) an inline `AddrOk`-style numeric bounds check
(`addr < 0x10000 || addr > 0x7FFFFFFFFFFFULL`) copied into feature code, and
(c) splitting offset arithmetic off the cast specifically "so it no longer reads
as a raw RuntimeOffsets access." The legitimate hot-loop raw reads that these
patterns were hiding become **honest**: they read `RuntimeOffsets::` directly and
carry a same-line `raw-access-ok` marker exactly like the sanctioned exemplar
`ProjectileRuntimeReader.cpp`, so a human can see every kept raw read and the
ratchet catches any *new* one. Two genuine abstraction misses are also closed:
`WorldTAB`'s hand-rolled IL2CPP string reader routes through `Il2CppC::ReadString`,
and `TestTAB`'s inline pointer-bounds checks route through `Mem::AddrOk`. Memory
**writes** get a sanctioned home (`Mem::TryWrite`) so the "read-only Mem::" excuse
for raw writes disappears.

## Dependencies
- Requires (already merged on this branch): plan 01 (`Mem::`), plan 02
  (`Il2CppC::`), plan 11 (the guardrail script this plan hardens). All present.
- Parallel-safe against every other plan: no other open plan touches
  `internal/tools/check-raw-access.sh`, `EnemyTracker.cpp`, `AimHooks.cpp`,
  `WeaponProfile.cpp`, `WorldTAB.cpp`, `TestTAB.cpp`, `core/runtime/MemRead.h`.
- Files this plan touches (watch for conflicts if any future plan reopens them):
  `internal/tools/check-raw-access.sh`, `internal/src/core/runtime/MemRead.h`,
  `internal/src/features/combat/enemytracker/EnemyTracker.cpp`,
  `internal/src/features/combat/autoaim/AimHooks.cpp`,
  `internal/src/features/combat/autoaim/WeaponProfile.cpp`,
  `internal/src/gui/tabs/WorldTAB.cpp`,
  `internal/src/gui/tabs/TestTAB.cpp`.

## Current state
The guardrail (`internal/tools/check-raw-access.sh`) has four checks. Check 1
matches only a *function definition* `bool (AddrOk|AddrValid)\(`; check 2 matches
only `reinterpret_cast<…>( … RuntimeOffsets:: … )` with a literal `RuntimeOffsets::`
token inside the cast, minus any line carrying `raw-access-ok`; check 3 matches a
fixed list of container-layout token *names*; check 4 matches `MH_CreateHook`.
`bash internal/tools/check-raw-access.sh` currently exits 0 — but the following
raw reads pass only because they dodge those exact literal patterns.

### Pattern A — offset aliasing (hides the read from check 2; no `raw-access-ok`)
A field offset is aliased to a local reference, so the cast site names `kOffPosX`,
not `RuntimeOffsets::PosX`, and check 2 never sees it. These are legitimate
per-call/per-frame `__try` hot-loop reads — the correct fix is the honest
`ProjectileRuntimeReader` form (read `RuntimeOffsets::` inline + a `raw-access-ok`
marker), NOT a rewrite.

`EnemyTracker.cpp` — alias block and its raw reads (per-entity world scan, hot):
```
20: static const uint32_t& kOffPosX          = RuntimeOffsets::PosX;
21: static const uint32_t& kOffPosY          = RuntimeOffsets::PosY;
22: static const uint32_t& kOffHp            = RuntimeOffsets::HP;
23: static const uint32_t& kOffMaxHp         = RuntimeOffsets::MaxHP;
24: static const uint32_t& kOffObjProps      = RuntimeOffsets::ObjProps;
25: static const uint32_t& kOffOpIsEnemy     = RuntimeOffsets::OP_IsEnemy;
26: static const uint32_t& kOffOpNoHealthBar = RuntimeOffsets::OP_NoHealthBar;
27: static const uint32_t& kOffOpInvincElem  = RuntimeOffsets::OP_InvincibleElem;
28: static const uint32_t& kOffObjType       = RuntimeOffsets::ObjType;
29: static const uint32_t& kOffWmDict        = RuntimeOffsets::WM_AllDict;
```
Raw reads using those aliases (all inside a shared `__try`):
`EnemyTracker.cpp:127`, `:128`, `:152`, `:158`, `:162`, `:165`, `:171`, `:172`,
`:176`, `:190`, `:191`. (Line 129 `*reinterpret_cast<uint64_t*>(lp)` and line 149
read the klass at offset 0 — no offset alias, but they live in the same `__try`
sweep and should carry the same marker for consistency. `kOffWmDict` at line 239 is
consumed by `Mem::ReadPtr(wm, kOffWmDict)` — that one is already routed and only the
*alias definition* needs de-aliasing.)

`AimHooks.cpp` — alias block and raw reads (inside IL2CPP shoot detours, very hot):
```
26: static const uint32_t& kOffPosX       = RuntimeOffsets::PosX;
27: static const uint32_t& kOffPosY       = RuntimeOffsets::PosY;
29: static constexpr uint32_t kOffShotAngle = 0x1C;
```
Raw reads: `AimHooks.cpp:85`, `:86`, `:101`, `:102`, `:123`, `:124` (all
`*reinterpret_cast<float*>(lp + kOffPosX/Y)` inside per-call `__try`). Raw write:
`AimHooks.cpp:132` (`*reinterpret_cast<float*>(shotData + kOffShotAngle) = newAngle`).
`kOffShotAngle` is a genuine private struct offset (shotData layout, not in
`RuntimeOffsets`) — keep it local but mark the read/write.

`WorldTAB.cpp` — alias block and raw reads (pre-existing; plan 07 left these):
```
44: static const uint32_t& OFF_POS_X           = RuntimeOffsets::PosX;
45: static const uint32_t& OFF_POS_Y           = RuntimeOffsets::PosY;
64: static const uint32_t& OFF_TILE_TYPE       = RuntimeOffsets::TileType;
```
Raw reads: `WorldTAB.cpp:1526`, `:1527` (`pi + OFF_POS_X/Y`), `:2458`
(`p + OFF_TILE_TYPE`). Lines `:2456`/`:2457` read `s_squareDamageOff` /
`s_squareCoverOff` — those are runtime-resolved private offsets (via
`il2cpp_field_get_offset` at `:2373`), not aliases; mark them but leave the
resolution as-is.

### Pattern B — private hardcoded offset consts + raw reads (dodge check 2 entirely)
No `RuntimeOffsets::` token appears, so check 2 is blind. These are genuine
private struct offsets; they are fine to keep, but the reads must carry a marker so
the hardened guardrail (step 1) doesn't flag them and so they are visible.
`WeaponProfile.cpp:16`–`19` define `0x188/0x18C/0x6B8/0x15C`; raw reads at
`WeaponProfile.cpp:29`, `:30`, `:35`, `:117`.
`TestTAB.cpp:225`–`227` define `0x18/0x1C8/0x780`; raw reads at `TestTAB.cpp:244`,
`:248`, `:260`, `:264`.

### Pattern C — inline `AddrOk` copy (dodges check 1, which only matches a def)
`TestTAB.cpp:247` and `TestTAB.cpp:263`:
```
if (opa < 0x10000 || opa > 0x7FFFFFFFFFFFULL) return 1.0f;
```
This is `Mem::AddrOk` open-coded (bounds are identical to canonical, so replacing is
behavior-preserving).

### Pattern D — deliberate grep dodge on a write (no write home in `Mem::`)
`TestTAB.cpp:87`–`98`, `WriteLocalKjnhlademh`, with the comment
`// … split off the cast so it no longer reads as a raw RuntimeOffsets access`:
```
uint8_t* dst = reinterpret_cast<uint8_t*>(p);
dst += RuntimeOffsets::HP;
__try { *reinterpret_cast<int32_t*>(dst) = v; } __except (…) {}
```
`Mem::` (`core/runtime/MemRead.h`) exposes only `AddrOk/TryRead/ReadOr/ReadPtr` —
no write — so every raw write in `features/`/`gui/` has to open-code. Other raw
writes that share this gap: `AimHooks.cpp:132`, `PlayerCollider.cpp:170` and `:283`.

### Abstraction miss — `WorldTAB` re-implements `Il2CppC::ReadString`
`WorldTAB.cpp:2126`–`2145`, `SehReadStringField`, hand-reads the IL2CPP managed
string layout (`strPtr + 0x10` = length, `strPtr + 0x14` = UTF-16 chars) — the exact
constants that already live in the sanctioned home as `Il2CppC::kStrLen = 0x10` /
`kStrChars = 0x14`, with `Il2CppC::ReadString(void*, char*, int)` doing the walk.
Check 3 misses it because `0x10`/`0x14` are inline literals, not the named tokens.
**Divergence (do not silently swap):** the two readers disagree — see Target design.

## Target design

### 1. `Mem::TryWrite<T>` — the sanctioned write primitive
Add to `internal/src/core/runtime/MemRead.h`, alongside `TryRead`, same style
(SEH-guarded, `AddrOk` on the destination first):
```cpp
// SEH-safe typed write. Returns false (writes nothing) if base+off is not a
// plausible committed address. Mirror of TryRead — the ONE write primitive so
// feature/gui code never open-codes *reinterpret_cast<T*>(p+off) = v.
template <typename T>
inline bool TryWrite(void* base, uint32_t off, const T& val) {
    if (!AddrOk(base)) return false;
    __try { *reinterpret_cast<T*>(reinterpret_cast<uint8_t*>(base) + off) = val; return true; }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}
```
Ownership: `Mem::` (header-only, zero-cost). Thread-safety: same as `TryRead` — the
SEH guard only protects against a bad page, not against races; callers already run
on the render/hook thread. No caching (writes are point events).

### 2. Guardrail: two new checks in `internal/tools/check-raw-access.sh`
Add after check 4, same `check`/scope machinery (scope stays `features/` + `gui/`;
both honor a same-line `raw-access-ok` for the rare justified case):
- **Check 5 — offset aliasing.** Flag any *definition* that binds a local name to a
  `RuntimeOffsets::` member by reference (the aliasing trick):
  `-E '(&|\bconst[^=]*&)[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=[[:space:]]*RuntimeOffsets::'`.
  Rationale: reading `RuntimeOffsets::X` directly is fine and is what check 2 already
  governs; *aliasing it to hide the read site* is what we forbid. Legitimate uses
  (passing the offset straight into `Mem::TryRead(p, RuntimeOffsets::X, …)`) never
  need an alias.
- **Check 6 — inline AddrOk bounds.** Flag the numeric ceiling literal outside the
  sanctioned home: `-F '0x7FFFFFFFFFFF'` over `features/`+`gui/` (the only correct
  place for this constant is `core/runtime/MemRead.h`, which is out of scope). This
  catches Pattern C without false positives (no feature legitimately names this
  bound).
Keep exit-code semantics (any hit → exit 1). Update the script's header comment to
list checks 5 and 6 and the `raw-access-ok` escape hatch for kept hot-loop reads.

### 3. Honest hot-loop reads (Patterns A and B)
De-alias and mark. The transform is mechanical and **behavior-preserving** (the
alias was a reference to the same `RuntimeOffsets::` variable — the runtime value is
identical). Use the exact marker text the exemplar uses so intent is uniform:
`// raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)`.

### 4. `WorldTAB` string read — DIVERGENCE, decide before swapping
`SehReadStringField` and `Il2CppC::ReadString` are **not** identical:
| Behavior | `WorldTAB.cpp:2126` (current) | `Il2CppC::ReadString` |
|---|---|---|
| length cap | rejects `len <= 0 || len > 64` → returns false | clamps `len` to `outCap-1`, no reject |
| char decode | keeps `0x20..0x7E`, writes `'\0'` for others | `ch & 0x7F` (masks high bit, no printable filter) |
| offsets | `0x10` / `0x14` inline | `kStrLen 0x10` / `kStrChars 0x14` (same) |
The offsets agree; the *filtering* differs. For a map-name label the `Il2CppC`
form is a superset (it will render control bytes as low-ASCII rather than cutting the
string). **Intended behavior: adopt `Il2CppC::ReadString`** — it is the shared home
and the map name is display-only, so the visible change is negligible and only for
pathological non-ASCII names. This is a deliberate, called-out behavior change, not a
silent one; it belongs in its own step so it can be reverted independently if a QA
pass dislikes it.

## Steps
Run `bash internal/tools/wsl-build.sh Debug` after every step (must stay green), and
`bash internal/tools/check-raw-access.sh` where noted.

1. **Add `Mem::TryWrite`.** Edit `core/runtime/MemRead.h` per Target design §1.
   No call-site changes yet. Build: `bash internal/tools/wsl-build.sh Debug`.

2. **Make `EnemyTracker.cpp` honest.** Delete the alias block (lines 20–28; keep line
   29 `kOffWmDict` only if still referenced by `Mem::ReadPtr` at :239 — if so, inline
   `RuntimeOffsets::WM_AllDict` there and delete the alias too). Replace each aliased
   read with the direct field + marker, e.g.
   before: `*outX = *reinterpret_cast<float*>(lp + kOffPosX);`
   after:  `*outX = *reinterpret_cast<float*>(lp + RuntimeOffsets::PosX);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)`
   Apply to :127,:128,:129,:149,:152,:158,:162,:165,:171,:172,:176,:190,:191.
   Build. (Behavior identical — same offsets, same `__try`.)

3. **Make `AimHooks.cpp` honest.** Delete aliases at :26,:27. Rewrite reads at
   :85,:86,:101,:102,:123,:124 to `lp + RuntimeOffsets::PosX/PosY` + marker. Keep
   `kOffShotAngle` (private shotData offset) but add the marker to the write at :132.
   Convert the write at :132 to `Mem::TryWrite<float>(shotData, kOffShotAngle, newAngle)`
   (drops the local `__try`; `TryWrite` supplies it) — verify the surrounding logic
   still compiles (the `ok` guard stays). Build.

4. **Make `WorldTAB.cpp` positional reads honest.** Delete aliases at :44,:45,:64.
   Rewrite reads at :1526,:1527 (`pi + RuntimeOffsets::PosX/PosY`) and :2458
   (`p + RuntimeOffsets::TileType`) with markers. Add markers to :2456,:2457 (leave
   `s_squareDamageOff`/`s_squareCoverOff` resolution untouched). Build.

5. **Mark `WeaponProfile.cpp` and `TestTAB` private-offset reads (Pattern B).** Add the
   `raw-access-ok` marker to `WeaponProfile.cpp:29,:30,:35,:117` and to the
   `ReadCollisionMult`/`ReadCollisionMultAlt` reads at `TestTAB.cpp:244,:248,:260,:264`.
   No offset changes. Build.

6. **Replace inline AddrOk in `TestTAB` (Pattern C).** At `TestTAB.cpp:247` and `:263`
   replace `if (opa < 0x10000 || opa > 0x7FFFFFFFFFFFULL) return 1.0f;` with
   `if (!Mem::AddrOk(op)) return 1.0f;` (drop the now-unused `uintptr_t opa` locals).
   Bounds are identical → behavior-preserving. Build.

7. **Route `TestTAB` write through `Mem::TryWrite` (Pattern D).** Replace the body of
   `WriteLocalKjnhlademh` (`TestTAB.cpp:87`–`98`) with
   `Mem::TryWrite<int32_t>(p, RuntimeOffsets::HP, v);` and delete the dodge comment.
   Behavior-preserving. Build.

8. **Adopt `Il2CppC::ReadString` in `WorldTAB` (DIVERGENCE step — isolate).** Replace
   `SehReadStringField`'s manual length/char walk (`WorldTAB.cpp:2132`–`2145`) with a
   call to `Il2CppC::ReadString(strPtr, buf, bufLen)` (keep the `strPtr` deref at
   :2129 or fold it into the call; `ReadString` already `AddrOk`-checks). Add
   `#include "core/il2cpp/Il2CppContainers.h"` if not present. This changes the
   len>64 reject and non-printable handling as documented — commit it alone with a
   message noting the divergence so it can be reverted independently. Build.

9. **Harden the guardrail.** Add checks 5 and 6 to
   `internal/tools/check-raw-access.sh` per Target design §2 and update the header
   comment. Run `bash internal/tools/check-raw-access.sh` — it must exit 0 (steps
   2–8 removed every alias and inline bound; kept raw reads now carry markers). If it
   flags anything, that site was missed above — mark or de-alias it, do not weaken the
   check.

10. **Final gate.** `bash internal/tools/wsl-build.sh Debug` green AND
    `bash internal/tools/check-raw-access.sh` exit 0.

## Verification
- `bash internal/tools/wsl-build.sh Debug` → `version.dll` builds clean after every
  step (Debug is the sanctioned WSL compile; Release needs `BuildSecrets.h`).
- `bash internal/tools/check-raw-access.sh` → exit 0.
- Zero-result greps (real GNU grep — `command grep`, the shell `grep` here is a ugrep
  wrapper that mishandles multi-path args):
  - `command grep -rnE '&[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=[[:space:]]*RuntimeOffsets::' internal/src/features internal/src/gui` → empty (no offset aliasing).
  - `command grep -rn '0x7FFFFFFFFFFF' internal/src/features internal/src/gui` → empty (no inline AddrOk ceiling).
  - `command grep -rnE 'reinterpret_cast<[^>]*>\([^;]*RuntimeOffsets::' internal/src/features internal/src/gui | command grep -v 'raw-access-ok'` → empty (every direct-offset raw read is marked).
- Behavior spot-check (manual, optional): autoaim still redirects shots; enemy ESP
  list unchanged; Test-tab collision-mult HUD reads the same value; map-name label
  renders (may differ only for non-ASCII names — the intended divergence).

## Out of scope
- Do NOT migrate the marked hot-loop `__try` sweeps to `Mem::TryRead`/`Game::` views:
  the shared-SEH-abort semantics are the documented reason they stay raw (same
  rationale as `ProjectileRuntimeReader.cpp`); per-field fallbacks would change fault
  behavior. Marking, not rewriting, is the deliverable.
- Do NOT touch `PlayerCollider.cpp`'s writes/reads beyond leaving them buildable — its
  `g_collisionMultiplierOffset` path is a separate module with its own resolution;
  converting its writes to `Mem::TryWrite` is a follow-up, not this plan (keep scope
  to combat/gui + the primitive + the guardrail).
- Do NOT change any offset *value* or the `il2cpp_field_get_offset` resolution sites
  (`WeaponProfile`, `WorldTAB:2373`, `AutoNexus`, `AutoAbility`, `ProjNoclip`,
  `CameraTAB`, `PlayerTAB`) — one-time field-offset resolution is an accepted idiom
  and not part of this hardening.
- Do NOT add an ESLint/client-side rule; this plan is internal-only.
