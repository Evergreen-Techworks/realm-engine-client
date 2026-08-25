# 88 — Autofire hold (DLL)

## Goal

After this plan, holding a bindable key makes the player fire continuously by
driving the game's **own** shoot entry points — so the game's rate limit, MP /
silence / cooldown checks, packet emission, and bullet spawning all happen
exactly as they do for a real mouse hold. Nothing about *where* the shot goes
changes here; killaura (plans 85–87) and AutoAim (`AimHooks`) already own aim.

Delivered as: `ShootRuntime` (a sanctioned native shoot-call wrapper, the shoot
analogue of the existing `DodgeRuntime` movement wrapper), an `AutoFire` feature
with a hold-key state machine, a `BootGate` entry so it cannot arm against stale
metadata, and a Combat-tab section.

## Dependencies

**Plan 85 must be merged first.** Not for an API dependency — `AutoFire` does not
call `KillAura` — but because both plans edit
`internal/src/gui/tabs/CombatTab/CombatTAB.cpp`,
`internal/src/features/control/FeatureCommandRegistry.cpp` and
`internal/il2cpp-dll-injection.vcxproj`. Serialize to avoid conflicts.

Plan 87 may be merged before or after this one (disjoint files), but the
recommended order is 85 → 87 → 88 → 89.

Files this plan touches that other plans also touch:

| File | Also touched by |
|---|---|
| `internal/il2cpp-dll-injection.vcxproj` (+ `.filters`) | 85, 87, 89 |
| `internal/src/gui/tabs/CombatTab/CombatTAB.cpp` | 85, 87, 89 |
| `internal/src/features/control/FeatureCommandRegistry.cpp` | 85, 89 |
| `internal/src/core/runtime/BootGate.cpp` | nobody else |

**BUILD HAZARD:** `internal/tools/wsl-build.sh` writes to a shared
`C:\rebuild\Debug`. Do not run it while another agent is building.

## Current state

### 1. There is no input synthesis anywhere in the DLL

`grep -rn "SendInput\|keybd_event\|mouse_event\|PostMessage" internal/src/` returns
nothing. Every key path in the tree only *reads* keys via `GetAsyncKeyState`:
`internal/src/features/movement/dodge/SteerInput.cpp:28-35`,
`internal/src/features/movement/dodge/XDodge.cpp:349`,
`internal/src/features/runtime/FeatureRuntime.cpp:97`,
`internal/src/features/runtime/FeatureRuntime.cpp:170`,
`internal/src/gui/tabs/TestTAB.cpp:790,820,928`.

So autofire cannot be faked as input; it must call the game.

### 2. The two shoot entry points are already bound (for hooking) in AimHooks

`internal/src/features/combat/autoaim/AimHooks.cpp:20-24`:

```cpp
static const char* kPlayerClass   = "LKHPPBEGNOM";
static const char* kShootClass    = "FKALGHJIADI";
static const char* kCSAMethod     = "ELCBJAFBLJG"; // ComputeShootAngle
static const char* kSWAMethod     = "EHGHCACPAGH"; // ShootWithAngle
static const char* kSSPMethod     = "PMIANFBMMNN"; // SendShotPacket
```

`:39-41`:

```cpp
using ComputeShootAngleFn = void(__fastcall*)(void*, uint8_t, float*, bool*, bool, void*);
using ShootWithAngleFn    = void(__fastcall*)(void*, float, void*);
```

`:143-145` resolves them with `loose = false`:

```cpp
g_csaTarget = Il2CppHook::ResolveMethod(kPlayerClass, kCSAMethod, 4, /*loose*/false);
g_swaTarget = Il2CppHook::ResolveMethod(kShootClass,  kSWAMethod, 1, /*loose*/false);
```

The `bool* outCanShoot` out-parameter of `ComputeShootAngle` **is the game's own
"may I fire this frame?" gate** — cooldown, MP, silence, weapon present. Calling
`ComputeShootAngle` and only firing when it says yes is exactly what the game's
input loop does, and is why this design cannot outrun the attack rate.

(Informational, from the local gitignored Il2CppInspector dump — verify at
runtime, do not hardcode:
`internal/src/game/generated/il2cpp-functions.h:114535`
`LKHPPBEGNOM_ELCBJAFBLJG(LKHPPBEGNOM*, uint8_t, float*, bool*, bool, MethodInfo*)`;
`:116894` `FKALGHJIADI_EHGHCACPAGH(FKALGHJIADI*, float, MethodInfo*)`.)

### 3. The sanctioned pattern for *calling* (not hooking) a game method

`internal/src/features/movement/dodge/MovementRuntime.cpp` is the template:
* resolve once and cache — `:29-37` via
  `Il2CppHook::ResolveMethodCached("FKALGHJIADI", "DGLCONCOIBO", 2)`;
* re-dispatch through the live object's vtable for virtual methods, cached per
  class — `:44-67`;
* SEH-guard every call and return a failure value — `:139-151`:
  ```cpp
  bool CallMoveTo(void* player, float x, float y) {
      if (!s_fnMoveTo || !player) return false;
      MoveToFn fn = ResolveMoveToForObject(player);
      if (!fn) return false;
      bool ok = false;
      __try { ok = fn(player, x, y, nullptr); }
      __except (EXCEPTION_EXECUTE_HANDLER) { ok = false; }
      return ok;
  }
  ```

### 4. Hotkeys, feature gating and per-frame ticking

* VK-name parsing already exists:
  `internal/src/features/control/FeatureCommandRegistry.cpp:47-71`
  (`ResolveHotkeyVkInternal` — `"F5"`, `"NUMPAD3"`, `"SPACE"`, `"NONE"`, …).
* Foreground + key-down helper:
  `internal/src/features/runtime/FeatureRuntime.cpp:88-98`.
* Fail-closed install gate: `internal/src/core/runtime/BootGate.h:29` +
  the `kFeatures` ledger at `internal/src/core/runtime/BootGate.cpp:39-45`.
* Per-frame entry: `internal/src/gui/tabs/CombatTab/CombatTAB.cpp:19-33`, called
  from `internal/src/platform/hooks/DirectX.cpp:236` regardless of menu state.

## Target design

### 8.1 `ShootRuntime` — the sanctioned shoot-call wrapper

New file pair `internal/src/features/combat/autoaim/ShootRuntime.h` / `.cpp`.
(That folder **is** on the include path —
`internal/il2cpp-dll-injection.vcxproj:356,383` — so `#include "ShootRuntime.h"`
works from anywhere.)

```cpp
#pragma once
#include <cstdint>

// ShootRuntime — the ONE place that CALLS the game's shoot methods (as opposed to
// AimHooks, which HOOKS them). Shoot analogue of DodgeRuntime in
// features/movement/dodge/MovementRuntime.h. Resolve-once + cache; every call is
// SEH-guarded and returns false on any failure. Game/render thread only.
namespace ShootRuntime {

// Resolve ComputeShootAngle + ShootWithAngle. Safe to call every tick until it
// succeeds; caches on first success. Returns true once both are bound.
bool EnsureResolved();
bool IsResolved();

// LKHPPBEGNOM::ELCBJAFBLJG(slot, &outAngle, &outCanShoot, false)
// outCanShoot is the GAME'S OWN rate-limit / MP / silence gate. Returns false if
// the method is unbound or the call faulted (outputs then untouched).
bool TryComputeShootAngle(void* player, uint8_t slot, float& outAngle, bool& outCanShoot);

// FKALGHJIADI::EHGHCACPAGH(angle). Virtual — re-dispatched through the live
// object's vtable, cached per class, exactly like DodgeRuntime::CallMoveTo.
bool CallShootWithAngle(void* player, float angle);

void Reset();   // realm transition / teardown

} // namespace ShootRuntime
```

Resolution constants (copy from `AimHooks.cpp:20-24`, keep them in **one** place —
`ShootRuntime.cpp` — and add a comment cross-referencing `AimHooks.cpp`):

```cpp
Il2CppHook::ResolveMethodCached("LKHPPBEGNOM", "ELCBJAFBLJG", 4, /*loose*/false);
Il2CppHook::ResolveMethodCached("FKALGHJIADI", "EHGHCACPAGH", 1, /*loose*/false);
```

**Interaction with AimHooks — intentional and required.** `AimHooks` MinHooks
both of these addresses (`AimHooks.cpp:155-158`). `mi->methodPointer` still points
at the patched entry, so a `ShootRuntime` call *goes through the detour* and
inherits the AutoAim/killaura angle redirect. That is the desired behaviour: the
autofire trigger and the aim redirect stay independent. There is no recursion —
the detour calls the MinHook trampoline, not `ShootRuntime`.

**Unknowns to verify at runtime, fail-closed until then:**
* `slot` (`uint8_t`) is the weapon slot. Start at `0`. Make it a diagnostic
  spinner in the UI (`0..3`) so it can be corrected without a rebuild.
* the 5th `bool` parameter (`CPINCMGNBOO` in the dump) is unidentified. Pass
  `false`. If `outCanShoot` is never `true` in-game with a weapon equipped and no
  cooldown, try `true` — record the finding in a comment.

### 8.2 `AutoFire` feature

New file pair `internal/src/features/combat/autofire/AutoFire.h` / `.cpp`
(not on the include path — include by full subpath
`#include "features/combat/autofire/AutoFire.h"`).

```cpp
#pragma once
#include <cstdint>

// AutoFire — hold-to-continuously-fire. Drives the game's own shoot entry so the
// game's rate limit applies. Owns NO hook (that is why it publishes a liveness
// stamp). Ticked from CombatTAB::Tick on the render thread.
namespace AutoFire {

void Tick(bool menuOpen);

void SetEnabled(bool on);      bool IsEnabled();     // master switch, default OFF
void SetHotkeyVk(int vk);      int  GetHotkeyVk();   // 0 = unbound (never fires)
void SetSlot(int slot);        int  GetSlot();       // diagnostic, clamp [0,3], default 0

// Programmatic engage, independent of the hotkey. Used by auto-break-walls
// (plan 89). Reference-free boolean: last writer wins, cleared on disable.
void SetAutoEngage(bool on);   bool IsAutoEngaged();

struct Diag {
    bool     resolved   = false;  // ShootRuntime bound
    bool     gated      = false;  // BootGate refused
    bool     engaged    = false;  // hotkey down OR auto-engage
    bool     lastCanShoot = false;
    uint32_t shotsSent  = 0;
    uint32_t framesEngaged = 0;
};
Diag GetDiag();

void RenderSettings();   // render thread

} // namespace AutoFire
```

`Tick(menuOpen)` behaviour spec — every guard is mandatory:

```
if (!enabled)                                   -> disengage, return
if (!BootGate::FeatureAllowed("AutoFire"))      -> gated = true, rate-limited log, return
if (!ShootRuntime::EnsureResolved())            -> rate-limited log, return
engaged = IsAutoEngaged()
          || (hotkeyVk != 0
              && FeatureRuntime-style foreground check
              && (GetAsyncKeyState(hotkeyVk) & 0x8000))
if (menuOpen && !IsAutoEngaged())               -> disengage (never fire while typing in the menu)
if (!engaged)                                   -> log the disengage EDGE, return
player = GameState::GetLocalPtr(); if (!player) -> disengage, return
if (LocalPlayer::GetHP() <= 0)                  -> disengage, return
throttle: at most ONE attempt per Present frame (a monotonic frame counter, not a
          wall-clock timer — the game's own gate handles cadence)
if (!ShootRuntime::TryComputeShootAngle(player, slot, angle, canShoot)) -> return
if (!canShoot)                                  -> return   (the game said no; do NOT force)
if (!ShootRuntime::CallShootWithAngle(player, angle))                   -> return
++shotsSent
```

**Foreground check.** `FeatureRuntime::IsCurrentProcessForeground` is `static` in
an anonymous namespace (`internal/src/features/runtime/FeatureRuntime.cpp:88-94`).
Do **not** export it — re-implement the same three lines locally in
`AutoFire.cpp` and add a comment pointing at the original. Duplicating three lines
of Win32 is preferable to widening `FeatureRuntime`'s public surface for this.

### 8.3 BootGate ledger entry

`internal/src/core/runtime/BootGate.cpp:39-45`, add to `kFeatures`:

```cpp
{ "AutoFire", "Auto-fire / hold-to-shoot", { "FKALGHJIADI", "LKHPPBEGNOM" }, 2 },
```

Both anchors already exist in `kAnchors` (`BootGate.cpp:25-35`).

### 8.4 IPC key + UI

`internal/src/features/control/FeatureCommandRegistry.cpp`, in the
`ApplyCoreFeature` table:

```cpp
FH_BOOL("autoFireEnabled", AutoFire::SetEnabled),
FH("autoFireHotkey",       AutoFire::SetHotkeyVk(ResolveHotkeyVkInternal(f.value))),
```

Do **not** add these to `client/src/bridge/contract.ts` in this plan — no client
plugin drives autofire in v1, and keeping the TS side untouched preserves plan
86's parallel-safety.

`AutoFire::RenderSettings()`: Enable checkbox, hotkey picker (reuse
`KeyBinds::GetValidKeys()` / `KeyBinds::ToString()` from
`internal/src/core/config/keybinds.h:12-13`), a diagnostic slot spinner, and a
live status line:
`resolved=<0/1> gated=<0/1> engaged=<0/1> canShoot=<0/1> shots=<n>`.

## Steps

1. **Create `ShootRuntime` (resolve only).**
   Create `internal/src/features/combat/autoaim/ShootRuntime.h` / `.cpp` with
   `EnsureResolved` / `IsResolved` / `Reset` and the two cached `MethodInfo*`
   lookups from §8.1. `TryComputeShootAngle` and `CallShootWithAngle` return
   `false` unconditionally for now. Register both files in
   `internal/il2cpp-dll-injection.vcxproj` next to the other
   `src\features\combat\autoaim\*` entries (around lines 92 and 215) and mirror in
   `.vcxproj.filters`. Nothing calls it.
   → `bash internal/tools/wsl-build.sh Debug`

2. **Implement the two calls.**
   Fill in `TryComputeShootAngle` and `CallShootWithAngle`, each SEH-guarded, and
   give `CallShootWithAngle` the per-class vtable re-dispatch copied from
   `internal/src/features/movement/dodge/MovementRuntime.cpp:44-67`
   (`il2cpp_object_get_virtual_method`, cached on the object's klass pointer).
   Add a one-time `DBG_FILE_LOG` recording the resolved method pointers.
   → `bash internal/tools/wsl-build.sh Debug`

3. **BootGate entry.**
   Edit `internal/src/core/runtime/BootGate.cpp`: add the `AutoFire` row to
   `kFeatures`. Behaviour-neutral (nothing queries it yet).
   → `bash internal/tools/wsl-build.sh Debug`

4. **Create `AutoFire` (state machine, no firing).**
   Create `internal/src/features/combat/autofire/AutoFire.{h,cpp}` with all
   setters/getters, `Diag`, and a `Tick` that evaluates every guard and updates
   `Diag` **but stops short of calling `CallShootWithAngle`** (leave a
   `// STEP 6:` marker). Register in the `.vcxproj` + `.filters`.
   → `bash internal/tools/wsl-build.sh Debug`

5. **Wire tick + UI.**
   Edit `internal/src/gui/tabs/CombatTab/CombatTAB.cpp`: include
   `features/combat/autofire/AutoFire.h`, call `AutoFire::Tick(menuVisible);` in
   `CombatTAB::Tick`, and add a separator + `AutoFire::RenderSettings();` to
   `CombatTAB::Render()`. Implement `RenderSettings` per §8.4.
   *Still fires nothing — verify in-game that the status line shows
   `resolved=1 gated=0` and that `canShoot` flips to 1 while a weapon is equipped
   and the hold key is down. If it never flips, flip the 5th bool argument in
   `TryComputeShootAngle` and re-check (see §8.1).*
   → `bash internal/tools/wsl-build.sh Debug`

6. **Enable firing.**
   Replace the `// STEP 6:` marker with the `CallShootWithAngle` call and the
   `shotsSent` counter. Add the transition-only ENGAGED/disengaged edge log and
   the 30-second liveness stamp
   (`[AutoFire] alive engaged=<0/1> resolved=<0/1> shots=<n>`) — AutoFire owns no
   hook, so this stamp is the only proof it is running.
   → `bash internal/tools/wsl-build.sh Debug`

7. **IPC key.**
   Edit `internal/src/features/control/FeatureCommandRegistry.cpp` per §8.4.
   → `bash internal/tools/wsl-build.sh Debug` and
     `bash internal/tools/check-raw-access.sh`

## Verification

```bash
bash internal/tools/wsl-build.sh Debug        # "0 Error(s)"
bash internal/tools/check-raw-access.sh       # exit 0, no output
```

Must return **zero** results — the shoot method tokens must live in exactly two
sanctioned files (`AimHooks.cpp` hooks them, `ShootRuntime.cpp` calls them):

```bash
grep -rn 'ELCBJAFBLJG\|EHGHCACPAGH\|PMIANFBMMNN' internal/src/ \
  | grep -v 'internal/src/features/combat/autoaim/AimHooks.cpp' \
  | grep -v 'internal/src/features/combat/autoaim/ShootRuntime.cpp' \
  | grep -v 'internal/src/game/'
```

Must return **zero** results (AutoFire owns no hook and resolves nothing
privately):

```bash
grep -rnE 'MH_CreateHook|il2cpp_class_get_method_from_name|il2cpp_field_get_offset' \
  internal/src/features/combat/autofire/
```

In-game acceptance:
1. Combat tab → AUTOFIRE → Enable, bind a key, hold it. The character fires
   continuously at the vanilla attack rate.
2. Release the key: firing stops within one frame.
3. Open the menu with the key held: firing stops (menu guard).
4. The trace log contains exactly **one** `ENGAGED` line per press, not one per
   frame, plus a `[AutoFire] alive` line every ~30 s.
5. Compare shots-per-second against a manual mouse hold — they must match. If
   autofire is faster, the `canShoot` gate is being bypassed: stop and fix
   before shipping.

## Out of scope

* **Do not** synthesize OS input (`SendInput` / `keybd_event` / `PostMessage`).
  There is no such code in the tree and adding it would be a new, unsanctioned
  primitive.
* **Do not** bypass or short-circuit `outCanShoot`. Firing faster than the game's
  own rate limit desyncs the server and is trivially detectable.
* **Do not** add a hook. `AutoFire` calls; `AimHooks` hooks. Keep them separate.
* **Do not** modify `internal/src/features/combat/autoaim/AimHooks.cpp` — its
  detours, its `Shot_Angle = 0x1C` manual offset, and its install/uninstall order
  in `internal/src/platform/hooks/InitHooks.cpp` all stay as-is.
* **Do not** touch `KillAura` (plan 85) or `ShotOrigin` (plan 87).
* **Do not** add `autoFire*` keys to `client/src/bridge/contract.ts` — that would
  break plan 86's parallel-safety for no v1 benefit.
* **Do not** edit `internal/src/features/movement/udodge/UDodgeSolver.cpp` or
  `UDodgeTypes.h` (Phase-3 conflict zone).
