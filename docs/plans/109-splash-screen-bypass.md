# 109 — Exalt splash screen bypass

**Status:** design approved, ready for implementation planning. **No code changed yet.**
**Date:** 2026-09-02
**Scope:** `client/winhttp-proxy/` only. No changes to `internal/` (`realm-engine.dll`).

**Short answer:** `winhttp.dll` already runs at `DLL_PROCESS_ATTACH`, before Unity
initialises. Add a self-contained module there that resolves `SplashScreenScript`
structurally (by its serialization-preserved field names, not the Beebyte literal),
hooks its **unobfuscated** `Update`, and zeroes the `timeForLogo` durations on the main
thread. Fail-open at every step.

> **This removes the splash's fixed idle time, not asset-load time.** `_Data` is ~1.1 GB
> and whatever Unity streams behind the logos still has to be read. Measure the baseline
> before building anything further on top of this.

---

## Goal

Remove the fixed idle time RotMG Exalt spends displaying its splash logos, so the
client reaches the next screen sooner. Motivation: raw single-client start speed and
fast restarts after a crash or patch.

## Non-goals

This does **not** speed up asset loading. The game's `_Data` directory is ~1.1 GB
(`resources.assets` 395 MB, `resources.resource` 214 MB, `resources.assets.resS` 95 MB),
and whatever Unity streams behind the splash still has to be read. Zeroing the logo
durations removes *idle* time only. If the splash is covering real loading work rather
than waiting on timers, the observable win will be small — that is an accepted,
known bound of this feature, not a defect.

Also out of scope: skipping the splash *scene* (risks a half-initialised game, since
the scene likely brings up singletons), repacking assets on disk, and changing when
`realm-engine.dll` is injected.

## Why `winhttp.dll` and not `realm-engine.dll`

`realm-engine.dll` is injected on the **first NewTick packet**
(`client/src/dashboard/server/DevServer.ts:638-650`), i.e. once the player is already
in a world — long after the splash. Re-timing that injection to process start would
put every existing feature at risk: `BootGate` and each feature's `Install()` assume a
loaded world.

`winhttp.dll` is a proxy DLL placed in the game folder (`client/src/hooker/GameHooker.ts:8`)
and already runs at `DLL_PROCESS_ATTACH` (`client/winhttp-proxy/src/dllmain.cpp`), before
Unity initialises. It today only installs a `connect()` hook. Adding a self-contained
splash module there gives us the early foothold with a blast radius of exactly one DLL.

## Components

All new files live in `client/winhttp-proxy/src/`.

### `il2cpp_min.h` / `il2cpp_min.cpp`

A minimal IL2CPP shim. Resolves the functions below with `GetProcAddress` against
`GameAssembly.dll`. It deliberately does **not** include the generated headers —
`internal/src/game/generated/il2cpp-types.h` is 1.49M lines and has no place in a proxy DLL.

Required exports:

```
il2cpp_domain_get                 il2cpp_thread_attach
il2cpp_domain_assembly_open       il2cpp_assembly_get_image
il2cpp_image_get_class_count      il2cpp_image_get_class
il2cpp_class_get_name             il2cpp_class_get_fields
il2cpp_class_get_field_from_name  il2cpp_field_get_name
il2cpp_field_get_offset           il2cpp_class_get_method_from_name
il2cpp_thread_detach
```

> **Correction (post-implementation review).** This list originally named
> `il2cpp_domain_get_assemblies`. It is **not exported** by the shipping
> `GameAssembly.dll` — the PE export table was dumped directly and checked:
> 371 exports, `il2cpp_domain_get_assemblies` absent, `il2cpp_domain_assembly_open`
> present, and all twelve other required symbols present. Because the shim's
> `LoadApi` is all-or-nothing, requiring the missing export made the feature fail
> *closed*: the bootstrap would poll for 30 s and exit, and the splash would always
> play. The design now opens the single assembly it needs by name
> (`il2cpp_domain_assembly_open(domain, "Assembly-CSharp")`) instead of enumerating
> the domain. That is also strictly cheaper: `SplashScreenScript` is game code, so
> scanning only `Assembly-CSharp` drops the walk from the whole type universe to a
> few thousand types and stops forcing `Class::Init` across `mscorlib` and
> `UnityEngine.*` during boot. If `domain_assembly_open` returns null for
> `Assembly-CSharp`, we fail open — there is no fallback to full enumeration.

Opaque pointer types only (`void*` / forward-declared structs). If any lookup returns
null, the module reports "unavailable" and the feature disables itself.

### `splash_bypass.h` / `splash_bypass.cpp`

The feature itself: class resolution, the `Update` hook, and the neutralise step.

## Class resolution — structural, not literal

Do **not** key on the Beebyte literal alone. Identify the class structurally: the
MonoBehaviour whose fields include all three of

```
timeForLogo   logosToDisplay   possibleSplashscreens
```

These names survive obfuscation because Unity requires them for serialization. That is
directly visible in the generated bindings, where `SplashScreenScript__Fields`
(`internal/src/game/generated/il2cpp-types.h:356783`) shows those fields readable while
siblings such as `EFOMIEKLCDH` and `HFCKLCHLCGF` are mangled. A Beebyte rename of the
class therefore cannot break this scan.

Fallback, in order, if the scan finds no match:

1. Class named `OPICLDMNKFI` (the value in `internal/src/game/symbols/BeebyteName.h:3291`)
2. Class named `PAFBKAOKKCJ` (the typedef in `il2cpp-types-ptr.h:3244`)

The two disagree because they were captured from different builds — precisely the
situation `GameClasses::Resolve` exists to absorb. We do not import `BeebyteName.h`
(168 KB) into `winhttp.dll`; the two literals are inlined as constants.

Cache the resolved class. Do **not** cache a failed lookup — classes load lazily.

## Hook point: `Update`

Beebyte preserves Unity's magic method names. `internal/src/game/generated/il2cpp-functions.h`
contains `SplashScreenScript_Update` and `SplashScreenScript__ctor` unobfuscated while
every other method on the class is mangled. So:

```c
il2cpp_class_get_method_from_name(klass, "Update", 0)
```

resolves without any name mapping, and MinHook (already linked by `build.bat`) hooks the
resulting `methodPointer`.

**`Update`, not `.ctor`.** At `.ctor` time Unity has not yet deserialized `timeForLogo`,
so there would be nothing to zero. `Update` runs afterwards, every frame, on the main
thread, and hands us `__this` directly.

**Not `FindObjectsByType`.** `Resolver::FindObjectsByType` exists in the main DLL but is a
full IL2CPP object walk — the codebase calls it "expensive" and rate-limits it
(`internal/src/core/runtime/GameState.cpp:54`), and every caller runs on the main thread.
Calling it from our bootstrap thread would depart from that pattern for no benefit, since
the `Update` hook gives us the instance for free.

## Neutralise step

Inside the detour (main thread, instance in hand):

1. Read `timeForLogo` from `__this` at the offset from `il2cpp_field_get_offset`.
2. From the `List<float>`, read `_items` and `_size`, resolving both offsets by name via
   `il2cpp_class_get_field_from_name` — BCL field names are never obfuscated. Hardcoded
   fallbacks from the verified layout
   (`internal/src/game/generated/il2cpp-types.h:47499`): `_items` at `+0x10`, `_size` at
   `+0x18` from the list object pointer.
3. Float data begins at `+0x20` in the array object, matching the `GET_ARRAY_ELEMENT`
   convention in `internal/src/core/runtime/Il2CppResolver.h:7`.
4. Write `0.0f` to each of the `_size` elements.
5. Call the original `Update`.
6. Latch the detour to a no-op after the first pass that successfully zeroes a
   non-empty list.

> **Deliberate divergence (post-implementation review).** This step originally read
> "unhook after the first successful pass". The implementation does **not** unhook:
> it sets a `g_done` flag so the detour becomes a straight pass-through to the
> original `Update`. `MH_DisableHook` suspends every other thread and `HeapAlloc`s
> while they are suspended, and calling it from inside the detour that is currently
> executing on the hooked target risks deadlock and stack corruption. The hook is
> instead removed on `DLL_PROCESS_DETACH` (and skipped entirely when the process is
> terminating). The residual cost is one predictable-branch call per frame on a
> scene that is about to end. Code and doc agree on this now; do not "fix" the code
> back to a self-unhook.

Zeroing durations is chosen over forcing the state machine to a terminal index: it is the
softest intervention that still collects the whole idle-time win, and if it mis-fires the
game simply plays its normal splash.

## Data flow

```
DLL_PROCESS_ATTACH (winhttp.dll)
  ├─ InitThread            → existing connect() hook, unchanged
  └─ SplashBypassThread    → new
       ├─ poll for GameAssembly.dll + il2cpp exports
       ├─ il2cpp_thread_attach(il2cpp_domain_get())
       ├─ resolve class  (field-signature scan → literal fallbacks)
       ├─ resolve Update (il2cpp_class_get_method_from_name)
       └─ MinHook::CreateHook(methodPointer)
              └─ detour  [MAIN THREAD, __this valid, fields deserialized]
                   ├─ zero every float in timeForLogo._items
                   ├─ call original Update
                   └─ latch to a no-op once a non-empty list has been zeroed
```

## Error handling

Fail-open at every step. Any of: `GameAssembly.dll` absent, an IL2CPP export missing,
class unresolved, `Update` unresolved, `timeForLogo` null, `_items` null, `_size` <= 0, or
`MH_CreateHook` failing — all mean *do nothing* and let the game show its normal splash.
The feature never blocks, never retries destructively, and never crashes the boot path.

Bounds:

- Bootstrap polling gives up after **30 seconds**, so a patched build cannot leave a
  thread scanning forever. This matches the give-up spirit of `ResolveWorldPosLayout`'s
  bounded retry in `internal/src/core/runtime/RuntimeOffsets.cpp:288-291`.
- The detour wraps its field reads in SEH (`__try/__except`), mirroring
  `Resolver::Protection::safe_call`, and disables itself permanently on a fault rather
  than faulting every frame.

## Testing

Honest constraint: the end-to-end behaviour is only observable by running the real game on
Windows, so the automated surface is thin. Split accordingly.

**Automated (host-testable, no game):**
- Field-signature matcher: given a synthetic class/field-name table, it selects the class
  carrying all three marker fields, ignores near-misses that carry only two, and falls
  back to the literals when none match.
- `List<float>` zeroing: against a synthetic buffer laid out as
  `_items@+0x10`, `_size@+0x18`, data`@+0x20`, assert all `_size` floats become `0.0f`, that
  bytes outside that range are untouched, and that `_size == 0`, null `_items`, and a
  negative `_size` are all no-ops.

**Manual (Windows, requires the game):**
- Baseline: time launch → first interactive screen, 3 runs, unmodified `winhttp.dll`.
- With the feature: same 3 runs. Record the delta.
- Regression: confirm the existing `connect()` hook still redirects to `127.0.0.1:2050`
  and the client still connects and plays.
- Fail-open: with a deliberately wrong class literal *and* the signature scan disabled,
  confirm the game boots normally with its splash intact.

## Build and deployment

`client/winhttp-proxy/build.bat` gains the two new `.cpp` files in `%SRC%`. MinHook is
already compiled in. No new libraries; `ws2_32.lib` remains the only link input. The built
`winhttp.dll` continues to be deployed by `GameHooker` exactly as today, including its
existing backup/restore of any pre-existing `winhttp.dll`.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Win is smaller than hoped because the splash covers real loading | Medium | Stated as an explicit non-goal; measure baseline before building further on this |
| Deca renames or restructures `SplashScreenScript` | Medium | Structural field-signature scan survives class renames; two literal fallbacks; fail-open |
| Unity drops/renames `Update` on this class | Low | Fail-open; feature silently disables |
| Hooking `Update` destabilises the splash scene | Low | We only write floats into an already-allocated array and always call the original |
| Two `winhttp.dll` hooks interacting | Low | Splash module is independent of `connect_hook`; neither shares state |
| Added anti-cheat surface | Low | No new module is loaded and no game file is modified; the DLL was already present |

## Open questions

None blocking. One to settle empirically during manual testing: whether zeroing
`timeForLogo` alone fully collapses the sequence, or whether the fade floats
(`BLDPKNNILGA`, `HNPPLJFDFLO` in `SplashScreenScript__Fields`) still impose a few frames.
If they do, zero them by offset in the same pass — the mechanism is identical and needs no
design change.
