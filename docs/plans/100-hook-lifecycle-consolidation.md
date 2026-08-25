# 100 — Hook lifecycle consolidation (`Il2CppHook::EnsureRuntime` / `UninstallMinHook`)

## Goal

After this plan, `platform/hooks/Il2CppHook` owns the **whole** MinHook
lifecycle, not just the install half. Two new helpers —
`Il2CppHook::EnsureRuntime(label)` and `Il2CppHook::UninstallMinHook(target, label)` —
replace six hand-rolled copies of the `MH_Initialize` idempotency dance and
fourteen hand-rolled `MH_DisableHook` + `MH_RemoveHook` pairs across `features/`.
`features/` stops naming `MH_*` symbols entirely, and a new guardrail check makes
that one-way.

The install half already lives in `Il2CppHook::InstallMinHook`
(`Il2CppHook.cpp:29-51`) and `check-raw-access.sh` check 4 already forbids bare
`MH_CreateHook` in `features/` + `gui/`. This plan closes the other two thirds
of the same concern.

**This is a C++ plan.** It builds the DLL and must not run concurrently with any
other C++ plan (shared `C:\rebuild`).

## Dependencies

None — content-independent. But per `96-overview.md` it is scheduled **before**
plans 101, 103 and 104 because it edits files those plans also edit.

Files this plan touches that other plans also touch:
- `internal/src/features/movement/dodge/ProjectileTracking.cpp` — plans 101, 103
  and 104 also edit it. **Land 100 first.**
- `internal/src/features/movement/dodge/AoeTracking.cpp` — plan 103 also edits it.
- `internal/src/features/combat/autoaim/AimHooks.cpp` — plan 105 also edits it
  (different function).
- `internal/tools/check-raw-access.sh` — plan 104 also edits it (retiring the
  `.ps1` mirror). Different sections; trivial merge.

## Current state

### Six copies of the MinHook-init dance

All six do the same thing: call `MH_Initialize()` once, treat
`MH_ERROR_ALREADY_INITIALIZED` as success, and latch a `static bool`. They differ
only in logging and return type — which is exactly the shape that hides a bug.

| File:line | Latch | On failure |
|---|---|---|
| `features/movement/dodge/DangerPlanner.cpp:839-847` | `static bool s_mhInit` (function-local) | `DBG_FILE_LOG("[DangerPlanner] TryInstall: MH_Initialize failed st=" ...)` then `return;` |
| `features/movement/dodge/ProjectileTracking.cpp:412-417` | `static bool s_mhInit` (function-local) | **silent** `return;` |
| `features/movement/dodge/AoeTracking.cpp:736-751` | file-scope `s_mhInit` | 4-shot rate-limited `AgentLogAoe("H2", ..., "mh_init_fail", ...)` then `return;` |
| `features/movement/noclip/NoclipHook.cpp:104-116` | `static bool mhInitialized` inside `EnsureMinHook()` | **silent** `return false;` |
| `features/combat/autoaim/AimHooks.cpp:146-152` | `static bool s_mhInit` (function-local) | **silent** `return false;` |
| `features/combat/autoaim/ProjNoclip.cpp:138-144` | `static bool s_mhInit` (function-local) | **silent** `return;` |

Representative (`ProjectileTracking.cpp:412-417`):

```cpp
    static bool s_mhInit = false;
    if (!s_mhInit) {
        MH_STATUS st = MH_Initialize();
        if (st != MH_OK && st != MH_ERROR_ALREADY_INITIALIZED) return;
        s_mhInit = true;
    }
```

**Latent problem the duplication hides:** each latch is *per call site*, so if
`MH_Initialize` genuinely fails once, five other modules will still call it
again — six retries of a global one-shot. And
`features/account/CredentialCapture.cpp` tears hooks down
(`:217-218`, `:222-223`) but **never initializes MinHook at all**
(`grep -n 'MH_' internal/src/features/account/CredentialCapture.cpp` shows only
the four teardown calls). It relies on another module having run
`MH_Initialize` first — an unenforced init-order contract.

### Fourteen copies of the teardown pair

Every one is `MH_DisableHook(t); MH_RemoveHook(t);` with the return value
ignored, followed by nulling the target and trampoline.

| File:line |
|---|
| `features/movement/dodge/DangerPlanner.cpp:877-878` |
| `features/movement/dodge/ProjectileTracking.cpp:438-439` |
| `features/movement/dodge/AoeTracking.cpp:904-905` (Gjj) |
| `features/movement/dodge/AoeTracking.cpp:910-911` (Fhoh) |
| `features/movement/dodge/AoeTracking.cpp:916-917` (Expl) |
| `features/movement/dodge/AoeTracking.cpp:922-923` (Sfx) |
| `features/movement/noclip/NoclipHook.cpp:161-162` (in a loop over `kCount`) |
| `features/combat/autoaim/AimHooks.cpp:170` (csa) |
| `features/combat/autoaim/AimHooks.cpp:171` (swa) |
| `features/combat/autoaim/AimHooks.cpp:172` (ssp) |
| `features/combat/autoaim/ProjNoclip.cpp:155-156` (rollback path on install failure) |
| `features/combat/autoaim/ProjNoclip.cpp:170-171` (iacod) |
| `features/combat/autoaim/ProjNoclip.cpp:175-176` (gjfk) |
| `features/account/CredentialCapture.cpp:217-218`, `:222-223` |

Representative (`AoeTracking.cpp:902-907`):

```cpp
    if (g_GjjTarget) {
        MH_DisableHook(g_GjjTarget);
        MH_RemoveHook(g_GjjTarget);
        g_GjjTarget   = nullptr;
        g_OrigGjjKob  = nullptr;
    }
```

### The sanctioned home already exists

`internal/src/platform/hooks/Il2CppHook.h` declares `ResolveMethod`,
`InstallMinHook`, `ResolveMethodCached`, `EnsureThreadAttached`.
`internal/src/platform/hooks/InitHooks.cpp:108-109` owns the process-wide
teardown (`MH_DisableHook(MH_ALL_HOOKS)` + `MH_Uninitialize()`); that stays
exactly where it is.

`Il2CppHook.h:22-24` currently says of `InstallMinHook`:
"Assumes MH_Initialize already ran (DirectX.cpp / first hook installs it — keep
that behavior)." That comment is what pushed `MH_Initialize` out into six
feature files. This plan makes the assumption enforceable instead of documented.

## Target design

Extend `internal/src/platform/hooks/Il2CppHook.h`:

```cpp
    // Idempotent, process-wide MinHook bring-up. Safe to call from any hook
    // installer; the FIRST successful call latches and every later call is a
    // relaxed atomic load. MH_ERROR_ALREADY_INITIALIZED counts as success (a
    // second MH_Initialize is not an error — it means someone beat us to it).
    //
    // Returns false only when MinHook genuinely cannot come up, in which case
    // the caller MUST NOT proceed to InstallMinHook. A failure is logged ONCE
    // (with `label`) rather than once per caller — six modules retrying a
    // failed global one-shot is what the old per-file `static bool s_mhInit`
    // latches produced.
    //
    // Thread-safety: safe to call from any thread. Uses a std::once_flag; the
    // fast path after initialisation is a relaxed atomic load, so it is cheap
    // enough for a per-frame TryInstall retry loop.
    bool EnsureRuntime(const char* label);

    // MH_DisableHook(target) + MH_RemoveHook(target) with the standard
    // DBG_FILE_LOG on failure, then `target = nullptr`. No-op (returns true)
    // when `target` is already null, so callers can drop their `if (t)` guards.
    //
    // `target` is taken BY REFERENCE and nulled on the way out precisely
    // because every existing copy of this pattern nulls it immediately after
    // — folding that in removes the "removed but not nulled" failure mode.
    //
    // Trampoline pointers stay the caller's business: they are typed and this
    // helper is not. Null them yourself, right after this returns.
    //
    // Thread-safety: same as MinHook's own — call from the teardown path only.
    bool UninstallMinHook(void*& target, const char* label);
```

Implementation in `internal/src/platform/hooks/Il2CppHook.cpp`:

```cpp
// ─── MinHook runtime bring-up ────────────────────────────────────────────────
static std::once_flag        s_mhOnce;
static std::atomic<bool>     s_mhReady{ false };

bool EnsureRuntime(const char* label)
{
    if (s_mhReady.load(std::memory_order_relaxed)) return true;
    std::call_once(s_mhOnce, [label]() {
        const MH_STATUS st = MH_Initialize();
        if (st == MH_OK || st == MH_ERROR_ALREADY_INITIALIZED) {
            s_mhReady.store(true, std::memory_order_relaxed);
            return;
        }
        DBG_FILE_LOG("[il2cpphook] MH_Initialize(" << (label ? label : "?")
                     << ") failed: " << st << " — NO hooks will install this session");
    });
    return s_mhReady.load(std::memory_order_relaxed);
}

bool UninstallMinHook(void*& target, const char* label)
{
    if (!target) return true;
    const char* tag = label ? label : "?";
    const MH_STATUS disabled = MH_DisableHook(target);
    if (disabled != MH_OK)
        DBG_FILE_LOG("[il2cpphook] MH_DisableHook(" << tag << ") failed: " << disabled);
    const MH_STATUS removed = MH_RemoveHook(target);
    if (removed != MH_OK)
        DBG_FILE_LOG("[il2cpphook] MH_RemoveHook(" << tag << ") failed: " << removed);
    target = nullptr;
    return disabled == MH_OK && removed == MH_OK;
}
```

`Il2CppHook.cpp` already includes `minhook/MinHook.h` (line 6), `<mutex>`
(line 8) and `DbgFileLog.h` (line 4). Add `#include <atomic>`.

### Divergence warnings — which behavior is correct

1. **Failure logging.** Today four of six sites fail *silently*. The unified
   helper always logs once. This is a strict improvement in observability with
   no behavioral change on the success path (the only path that has ever been
   taken in practice — `MH_Initialize` failing means the process is already
   badly broken). **Correct behavior: log once, in `Il2CppHook`.**
2. **Retry-after-failure.** Today each site retries because each has its own
   latch. The unified helper latches globally via `std::once_flag`, so a genuine
   failure is permanent for the session. **This is the intended behavior** —
   `MH_Initialize` is not transient; retrying it from a per-frame `TryInstall`
   loop just burns cycles. Note it explicitly in the PR description.
3. **`AoeTracking`'s `AgentLogAoe` rate-limited failure log**
   (`AoeTracking.cpp:739-746`) is richer than the others. Delete it along with
   the block — the unified log carries the same `MH_STATUS`. Do **not** try to
   preserve the `AgentLogAoe` channel for this one case.
4. **`UninstallMinHook` nulls `target`; `MH_DisableHook`/`MH_RemoveHook` return
   values were previously ignored everywhere.** Keeping them ignored (log only,
   never change control flow) preserves behavior exactly. Do **not** make any
   caller branch on the new return value in this plan.

### Hot path

Neither helper is on the per-frame hot path. `EnsureRuntime` is called from
`TryInstall` loops that already run once per frame until they succeed; its fast
path is one relaxed atomic load, strictly cheaper than the current
`static bool` + guard-variable check (which is a thread-safe-statics acquire
load on MSVC).

## Steps

1. **Add the two declarations** to `internal/src/platform/hooks/Il2CppHook.h`
   with the doc comments above. Also fix the now-stale sentence at
   `Il2CppHook.h:22-24` — replace "Assumes MH_Initialize already ran ..." with
   "Call `EnsureRuntime()` first; this helper does not initialise MinHook."
   Verify:
   ```bash
   bash internal/tools/wsl-build.sh Debug && bash internal/tools/check-raw-access.sh
   ```

2. **Implement both in `internal/src/platform/hooks/Il2CppHook.cpp`** exactly as
   given, plus `#include <atomic>`. Nothing calls them yet.
   Verify: same commands. Expect 0 errors, 0 warnings.

3. **Migrate `ProjectileTracking.cpp`** (simplest site, do it first to validate
   the pattern).

   Before (`:412-417`):
   ```cpp
       static bool s_mhInit = false;
       if (!s_mhInit) {
           MH_STATUS st = MH_Initialize();
           if (st != MH_OK && st != MH_ERROR_ALREADY_INITIALIZED) return;
           s_mhInit = true;
       }
   ```
   After:
   ```cpp
       if (!Il2CppHook::EnsureRuntime("ProjectileTracking")) return;
   ```

   Before (`:437-440`):
   ```cpp
           if (g_spawnTarget) {
               MH_DisableHook(g_spawnTarget);
               MH_RemoveHook(g_spawnTarget);
           }
           g_OriginalSpawn = nullptr;
           g_spawnTarget = nullptr;
   ```
   After:
   ```cpp
           Il2CppHook::UninstallMinHook(g_spawnTarget, "ProjectileTracking");
           g_OriginalSpawn = nullptr;
   ```
   (`UninstallMinHook` nulls `g_spawnTarget` itself.)

   Verify: build + guardrail, then
   `grep -n 'MH_' internal/src/features/movement/dodge/ProjectileTracking.cpp`
   → empty. Remove `#include "minhook/MinHook.h"` from that file once it is.

4. **Migrate `AimHooks.cpp` and `ProjNoclip.cpp`.** Same two mechanical
   replacements. `ProjNoclip.cpp:155-156` is a rollback-on-install-failure path;
   it becomes
   `Il2CppHook::UninstallMinHook(s_gjfkTarget, "ProjNoclip.GJFK");` — note this
   now also nulls `s_gjfkTarget` on that path, which the old code did **not**
   do. That is a fix (the old code left a dangling removed-hook pointer that
   `Uninstall()` would then try to remove a second time); call it out in the PR.
   Verify: build + guardrail + `grep -n 'MH_'` on both files → empty; drop their
   `minhook/MinHook.h` includes.

5. **Migrate `DangerPlanner.cpp`.** Replace `:839-847` with
   `if (!Il2CppHook::EnsureRuntime("DangerPlanner")) return;` and `:877-878`
   with `Il2CppHook::UninstallMinHook(s_hookTarget, "DangerPlanner");` (keep the
   surrounding `if (s_hookInstalled && s_hookTarget)` guard and the
   `s_origUpdate = nullptr; s_hookInstalled = false;` lines; delete only the
   now-redundant `s_hookTarget = nullptr;`).
   Verify: build + guardrail + `grep -n 'MH_'` → empty; drop the include.

6. **Migrate `NoclipHook.cpp`.** Delete `EnsureMinHook()` entirely
   (`:104-116`) and replace its call site with
   `Il2CppHook::EnsureRuntime("NoclipHook")`. Replace the in-loop teardown
   (`:161-162`) with
   `Il2CppHook::UninstallMinHook(s_target[i], "NoclipHook");` and delete the
   now-redundant `s_target[i] = nullptr;`.
   Verify: build + guardrail + `grep -n 'MH_'` → empty; drop the include.

7. **Migrate `AoeTracking.cpp`.** Replace `:736-751` with
   `if (!Il2CppHook::EnsureRuntime("AoeTracking")) return;` (deleting the
   `AgentLogAoe` failure block per divergence note 3) and each of the four
   teardown blocks (`:902-924`) with
   `Il2CppHook::UninstallMinHook(g_GjjTarget, "AoeTracking.Gjj");` etc., keeping
   each trampoline null-out line.
   Verify: build + guardrail + `grep -n 'MH_'` → empty; drop the include.

8. **Migrate `CredentialCapture.cpp`.** Replace `:217-218` and `:222-223` with
   `Il2CppHook::UninstallMinHook(s_connectTarget, "CredentialCapture.Connect");`
   and
   `Il2CppHook::UninstallMinHook(s_setSteamIdTarget, "CredentialCapture.SetSteamId");`.
   **Also add** `if (!Il2CppHook::EnsureRuntime("CredentialCapture")) return;`
   immediately before the first `Il2CppHook::InstallMinHook` call
   (currently `:177`) — this file installs hooks today without ever
   initialising MinHook, relying on another module having done so first. Adding
   the call makes it correct on its own and is a no-op whenever the old implicit
   ordering held.
   Verify: build + guardrail + `grep -n 'MH_'` → empty; drop the include.

9. **Add guardrail check 15.** In `internal/tools/check-raw-access.sh`, after
   check 14, append:

   ```bash
   # 15. Bare MinHook lifecycle calls in features/ + gui/. Check 4 already bans
   #     MH_CreateHook; this closes the other two thirds of the same concern.
   #     Use Il2CppHook::EnsureRuntime / InstallMinHook / UninstallMinHook. The
   #     process-wide teardown (MH_DisableHook(MH_ALL_HOOKS) + MH_Uninitialize)
   #     lives in platform/hooks/InitHooks.cpp and is out of scope by
   #     construction. A same-line raw-access-ok marker exempts a justified case.
   hits15="$(grep -rnE '\bMH_(Initialize|Uninitialize|EnableHook|DisableHook|RemoveHook|ApplyQueued|QueueEnableHook|QueueDisableHook)\b' "${scope_feat[@]}" 2>/dev/null | grep -v 'raw-access-ok')"
   if [ -n "$hits15" ]; then
     echo "FORBIDDEN [bare MinHook lifecycle]:"; echo "$hits15"; fail=1
   fi
   ```

   Also update the script's header comment (lines 3–14) to mention check 15.
   Verify: `bash internal/tools/check-raw-access.sh` → exit 0, no output. Then
   temporarily paste `MH_Initialize();` into any file under `internal/src/features/`,
   re-run, confirm it reports check 15, and remove it.

10. **Final sweep.** Confirm the concern is fully homed:
    ```bash
    grep -rn 'MH_' internal/src/features internal/src/gui        # empty
    grep -rn 'minhook/MinHook.h' internal/src/features internal/src/gui  # empty
    ```
    Verify: full build + guardrail.

## Verification

```bash
bash internal/tools/wsl-build.sh Debug     # expect: 0 Error(s), 0 Warning(s)
bash internal/tools/check-raw-access.sh    # expect: exit 0, no output
```

Greps that must return **zero** results when this plan is complete:

```bash
grep -rn 'MH_' /home/jesse/realm-engine-client/internal/src/features /home/jesse/realm-engine-client/internal/src/gui
grep -rn 'minhook/MinHook.h' /home/jesse/realm-engine-client/internal/src/features /home/jesse/realm-engine-client/internal/src/gui
grep -rn 'static bool s_mhInit\|static bool mhInitialized' /home/jesse/realm-engine-client/internal/src
```

Runtime smoke check (if you can run the game): inject and confirm
`%LOCALAPPDATA%\RotMG Exalt DLL Trace.log` still shows every
`[il2cpphook] ...` install line it showed before, in the same order, and that
`[ProjectileTracking] Install: spawn hook INSTALLED` / `[DangerPlanner] TryInstall: ... INSTALLED`
still appear. Then unload via the overlay and confirm no crash on teardown —
teardown ordering is the one thing this plan touches that logs can't fully prove.

## Out of scope

- **Do NOT touch `platform/hooks/InitHooks.cpp:108-109`.** The process-wide
  `MH_DisableHook(MH_ALL_HOOKS)` + `MH_Uninitialize()` is the sanctioned
  shutdown and must stay exactly where it is, in exactly its current position in
  `DetourUninitialization()`'s deliberate teardown order.
- **Do NOT touch the MS Detours path** (`IDXGISwapChain::Present`). Different
  hooking library, different lifecycle, out of scope.
- **Do NOT change any detour body, any `ResolveMethod`/`ResolveMethodCached`
  call, or any hook target.** This plan moves lifecycle plumbing only.
- **Do NOT make any caller branch on `UninstallMinHook`'s return value.** Every
  existing site ignores the `MH_STATUS`; preserving that is what makes this
  behavior-preserving.
- **Do NOT retire `check-raw-access.ps1` here** — plan 104 owns that decision.
  Just add check 15 to the `.sh`.
- **Do NOT touch `Il2CppHook::EnsureThreadAttached`** or the method cache.
