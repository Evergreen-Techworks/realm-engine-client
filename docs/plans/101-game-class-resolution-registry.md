# 101 — One home for IL2CPP class resolution (`GameClasses::Resolve`)

## Goal

After this plan there is exactly **one** policy for "turn a game class name into
an `Il2CppClass*`", living in a new `internal/src/game/symbols/GameClasses.{h,cpp}`:
try the BeeByte alias map for the readable name, fall back to the obfuscated
literal, cache the result, log once. Four different private policies and eight
private `static Il2CppClass*` caches across `features/` and `gui/` collapse onto
it, and the divergence where `WorldTAB` resolves the projectile class with a
**weaker** policy than `ProjectileTracking` (so the projectile ESP dies on a
rename while dodging survives) is closed.

**This is a C++ plan.** It builds the DLL and must not run concurrently with any
other C++ plan.

## Dependencies

- **Plan 100 MUST be merged first.** Both plans edit
  `internal/src/features/movement/dodge/ProjectileTracking.cpp` and
  `internal/src/features/movement/dodge/AoeTracking.cpp`.

Files this plan touches that other plans also touch:
- `internal/src/features/movement/dodge/ProjectileTracking.cpp` — plans 100
  (before), 103 and 104 (after).
- `internal/src/gui/tabs/WorldTAB.cpp` — plan 103 also edits it. **Land 101
  first.**
- `internal/il2cpp-dll-injection.vcxproj` / `.filters` — this plan adds two
  entries; plan 99 removes two and plan 104 adds several. Land in the
  overview's stated order and each sees a clean file.

## Current state

### The primitive everything builds on

`Resolver::FindClassLoose` (`internal/src/core/runtime/Il2CppResolver.cpp:340-352`):

```cpp
	Il2CppClass* FindClassLoose(const char* className)
	{
		if (!className || !className[0]) return nullptr;
		struct Ctx { const char* name; Il2CppClass* result; };
		Ctx ctx{ className, nullptr };
		il2cpp_class_for_each([](Il2CppClass* klass, void* ud) {
			auto* c = static_cast<Ctx*>(ud);
			if (c->result) return;
			if (strcmp(il2cpp_class_get_name(klass), c->name) == 0)
				c->result = klass;
		}, &ctx);
		return ctx.result;
	}
```

It is a **plain `strcmp` over every loaded class**, with no alias handling and
**no caching**. `il2cpp_class_for_each` has no early exit — the callback returns
once a hit is latched but iteration continues to the end.

**Divergence bug #5 (see `96-overview.md`):** `internal/src/platform/hooks/Il2CppHook.h:14-15`
documents `FindClassLoose` as "(BeeByte-rename proof)". It is not, and that
comment is the most likely reason several call sites skipped the alias pass.

### Four incompatible policies

**Policy A — BeeByte alias first, obfuscated fallback, cached, logged once.**
`internal/src/features/movement/dodge/ProjectileTracking.cpp:47-77`:

```cpp
__declspec(noinline) static Il2CppClass* ResolveProjClass()
{
    static Il2CppClass* s_cached = nullptr;
    if (s_cached) return s_cached;

    const char* resolvedVia = nullptr;
    for (const auto& kv : Beebyte::GetMap()) {
        if (kv.second == "Projectile") {
            Il2CppClass* k = Resolver::GetClass("", kv.first.c_str());
            if (!k) k = Resolver::FindClassLoose(kv.first.c_str());
            if (k) { s_cached = k; resolvedVia = kv.first.c_str(); break; }
        }
    }
    if (!s_cached) {
        Il2CppClass* k = Resolver::GetClass("", kProjClassName);      // "HBEAKBIHANL"
        if (!k) k = Resolver::FindClassLoose(kProjClassName);
        if (k) { s_cached = k; resolvedVia = kProjClassName; }
    }
    // ... one-shot DBG_FILE_LOG with resolvedVia ...
    return s_cached;
}
```

**Policy A′ — same alias scan, no class cache, no diagnostic.**
`internal/src/features/projectiles/ProjectileTrajectory.cpp:41-51`:

```cpp
    Il2CppClass* klass = nullptr;
    for (const auto& kv : Beebyte::GetMap()) {
        if (kv.second == "Projectile") {
            klass = Resolver::GetClass("", kv.first.c_str());
            if (!klass) klass = Resolver::FindClassLoose(kv.first.c_str());
            if (klass) break;
        }
    }
    if (!klass) klass = Resolver::GetClass("", "HBEAKBIHANL");
    if (!klass) klass = Resolver::FindClassLoose("HBEAKBIHANL");
```

Same class, same fallback literal, duplicated body. (It caches the *method* it
then looks up, not the class.)

**Policy B — bare `FindClassLoose`, per-file `static` cache, no alias pass.**

| File:line | Class | Cache |
|---|---|---|
| `gui/tabs/WorldTAB.cpp:274-279` | `"HBEAKBIHANL"` | `static Il2CppClass* s_hbeakKlass` (`:272`) |
| `gui/tabs/WorldTAB.cpp:2338` | `kWorldMgrClassName` = `"HJMBOMEHGDJ"` (`:2305`) | `s_liveHazResolved` one-shot |
| `gui/tabs/WorldTAB.cpp:2346` | `kSquareClassName` = `"BGAIOPJMHLO"` (`:2307`) | same one-shot |
| `gui/MinimapNav.cpp:240` | `"MiniMapManager"` | `static ... s_mmClass` |
| `gui/tabs/CameraTAB.cpp:225` | `"CameraManager"` | `static ... s_camMgrClass` |
| `features/visuals/FloatingTextService.cpp:58` | `"MapObjectUIManager"` | **none — full class-table scan on every call** |

`WorldTAB.cpp:274-279` is the divergence:

```cpp
// HBEAKBIHANL (runtime projectile) — klass cached here; FOMOIBCKIFP offset via RuntimeOffsets.
static Il2CppClass* s_hbeakKlass = nullptr;

static Il2CppClass* GetHbeakProjectileClass()
{
    if (!s_hbeakKlass)
        s_hbeakKlass = Resolver::FindClassLoose("HBEAKBIHANL");
    return s_hbeakKlass;
}
```

Same class as policy A, **without** the alias pass. After the next BeeByte
rotation, `ProjectileTracking` (dodging) keeps working and the WorldTAB
projectile ESP goes silently blank.

**Policy C — triple fallback, no alias pass, no cache.**
`features/movement/speedhack/SpeedHack.cpp:202-213`:

```cpp
static Il2CppClass* FindClassAny(const char* namespaze, const char* name)
{
    Il2CppClass* klass = nullptr;
    Resolver::Protection::safe_call([&]() {
        klass = Resolver::FindClass(namespaze, name);
        if (!klass) klass = Resolver::FindClassLoose(name);
        if (!klass) klass = Resolver::GetClass(namespaze, name);
    });
    return klass;
}
```

(`Resolver::FindClass` is a one-line forward to `GetClass` —
`Il2CppResolver.cpp:335-338` — so the first and third branches are identical.)

**Policy D — obfuscated literal only, 5-second give-up, dedup by consecutive
name.** `core/runtime/RuntimeOffsets.cpp:685-693` and `:735-741`. This one is
**deliberately different** and stays as-is: it drives the self-healing offset
table with its own give-up/stale-marking semantics that the OFFSET HEALTH panel
depends on. See "Out of scope".

### Where the class names live

`internal/src/features/movement/dodge/Mangled.h` already exists as "single
source of truth for IL2CPP/Beebyte-mangled class and method name strings used by
the dodge subsystem" and defines `MANGLED_PROJECTILE_CLS "HBEAKBIHANL"`,
`MANGLED_MAPOBJECT_CLS "KJMONHENJEN"`, etc. — but `WorldTAB.cpp:277` and
`ProjectileTracking.cpp:41` both hardcode `"HBEAKBIHANL"` anyway.

`Beebyte::GetMap()` (`internal/src/game/symbols/BeebyteName.h:11`) returns
`const std::unordered_map<std::string,std::string>&` keyed **obfuscated →
readable**, so finding the current obfuscated name for a readable one is a
linear scan over ~3523 entries.

## Target design

New files `internal/src/game/symbols/GameClasses.h` / `.cpp`.

```cpp
// GameClasses.h
#pragma once

struct Il2CppClass;

// GameClasses — the ONE policy for resolving a game class by name.
//
// Why this exists: Resolver::FindClassLoose is a plain strcmp over the whole
// class table (core/runtime/Il2CppResolver.cpp:340-352). It is NOT BeeByte-
// rename proof and it does NOT cache. Before this header, four different call
// sites layered four different fallback chains on top of it and each kept its
// own `static Il2CppClass*`, so the same class resolved with different
// robustness depending on who asked.
//
// Policy (in order):
//   1. Scan Beebyte::GetMap() for entries whose READABLE name == readableName;
//      for each candidate obfuscated name, try Resolver::GetClass("", obf) then
//      Resolver::FindClassLoose(obf). First hit wins.
//   2. Fall back to obfuscatedFallback (the last-known-good literal) via the
//      same GetClass -> FindClassLoose pair.
//   3. Cache the result (hit only) and return it for every later call.
//
// A FAILED lookup is NOT cached: classes load lazily, so a call before the
// player is in-realm must be retryable. This matches the behavior of every
// existing site's `if (!s_cached)` guard.
//
// Thread-safety: guarded by an internal mutex. Resolution happens at init /
// first-use, never per-frame after the first hit; the post-hit path is a map
// lookup under that mutex, which is cheap but NOT free — hoist the pointer out
// of any per-frame loop exactly as the current static caches do.
namespace GameClasses {

    // `readableName` is the deobfuscated name as it appears in the VALUES of
    // Beebyte::GetMap() (e.g. "Projectile", "CameraManager"). `obfuscatedFallback`
    // is the last-known-good obfuscated literal for the current build, or
    // nullptr when the class is not obfuscated (e.g. "CameraManager" is already
    // readable — pass it as BOTH arguments in that case).
    Il2CppClass* Resolve(const char* readableName, const char* obfuscatedFallback);

    // Named accessors for the classes resolved from more than one call site.
    // Each is a one-line Resolve() with the correct pair baked in, so a caller
    // cannot accidentally pass a weaker fallback than its neighbours.
    Il2CppClass* Projectile();      // "Projectile"     / "HBEAKBIHANL"
    Il2CppClass* WorldManager();    // "WorldManager"   / "HJMBOMEHGDJ"
    Il2CppClass* Square();          // "Square"         / "BGAIOPJMHLO"

} // namespace GameClasses
```

`.cpp` sketch:

```cpp
#include "pch-il2cpp.h"
#include "game/symbols/GameClasses.h"
#include "game/symbols/BeebyteName.h"
#include "core/runtime/Il2CppResolver.h"
#include "core/logging/DbgFileLog.h"

#include <mutex>
#include <string>
#include <unordered_map>

namespace GameClasses {
namespace {
std::mutex s_mu;
std::unordered_map<std::string, Il2CppClass*> s_cache;   // keyed by readableName

Il2CppClass* TryName(const char* n)
{
    if (!n || !n[0]) return nullptr;
    Il2CppClass* k = Resolver::GetClass("", n);
    if (!k) k = Resolver::FindClassLoose(n);
    return k;
}
} // namespace

Il2CppClass* Resolve(const char* readableName, const char* obfuscatedFallback)
{
    if (!readableName || !readableName[0]) return nullptr;
    std::lock_guard<std::mutex> lk(s_mu);
    const std::string key(readableName);
    if (auto it = s_cache.find(key); it != s_cache.end()) return it->second;

    Il2CppClass* found = nullptr;
    const char* via = nullptr;
    for (const auto& kv : Beebyte::GetMap()) {
        if (kv.second != key) continue;
        if (Il2CppClass* k = TryName(kv.first.c_str())) { found = k; via = kv.first.c_str(); break; }
    }
    if (!found && obfuscatedFallback) {
        if (Il2CppClass* k = TryName(obfuscatedFallback)) { found = k; via = obfuscatedFallback; }
    }
    if (!found) return nullptr;                 // NOT cached — lazy class load, retry later

    s_cache.emplace(key, found);
    DBG_FILE_LOG("[GameClasses] '" << readableName << "' resolved via '"
                 << (via ? via : "?") << "' (fallback literal was '"
                 << (obfuscatedFallback ? obfuscatedFallback : "-") << "')");
    return found;
}

Il2CppClass* Projectile()   { return Resolve("Projectile",   "HBEAKBIHANL"); }
Il2CppClass* WorldManager() { return Resolve("WorldManager", "HJMBOMEHGDJ"); }
Il2CppClass* Square()       { return Resolve("Square",       "BGAIOPJMHLO"); }
} // namespace GameClasses
```

**Before implementing `WorldManager()` / `Square()`, verify the readable names.**
Run `grep -n '"WorldManager"\|"Square"' internal/src/game/symbols/BeebyteName.h`.
If `"HJMBOMEHGDJ"` does not map to `"WorldManager"` in the alias map, use the
value that IS there (search the map for the obfuscated key:
`grep -n 'HJMBOMEHGDJ' internal/src/game/symbols/BeebyteName.h`). If a class has
no alias-map entry at all, pass the obfuscated literal as **both** arguments —
the alias scan simply finds nothing and the fallback path handles it, exactly as
today.

### Divergence resolutions — which behavior is correct

1. **`WorldTAB.cpp:274-279` vs `ProjectileTracking.cpp:47-77`.** Policy A is
   correct: the alias pass is the whole point of shipping a 3523-entry rename
   map, and the obfuscated literal is a fallback for when the map itself is
   stale. Migrating WorldTAB onto `GameClasses::Projectile()` **strengthens**
   it. On a build where the literal still resolves (i.e. today), the alias pass
   finds the same class first, so the observable result is identical. Verify
   this at runtime (see Verification).
2. **`SpeedHack`'s `FindClassAny`** tries `FindClass(ns,name)` then
   `FindClassLoose(name)` then `GetClass(ns,name)`. Branches 1 and 3 are the
   same function (`Il2CppResolver.cpp:335-338`), so it is really
   "namespaced exact, then loose". `GameClasses::Resolve` does
   "`GetClass("", n)` then `FindClassLoose(n)`". For SpeedHack's callers the
   namespace argument is what differs. **Do not migrate SpeedHack in this plan**
   — see "Out of scope". Instead, delete the redundant third branch is *also*
   out of scope; leave it alone entirely.
3. **`FloatingTextService.cpp:58` has no cache** and does a full class-table
   walk per floating text. Migrating it onto `GameClasses::Resolve` adds the
   cache, which is a pure win and is *not* a behavior change (the resolved class
   pointer is stable for the process lifetime — `il2cpp_class_for_each` returns
   the same pointer every time).
4. **`Il2CppHook.h:14-15`'s "(BeeByte-rename proof)" claim is wrong.** Correct
   it in this plan.

### Hot path

`GameClasses::Resolve` takes a mutex and hashes a string. It is **not** safe to
call from inside a per-frame per-entity loop. Every migrated site today already
hoists the class pointer into a `static` or resolves once — preserve that shape.
`WorldTAB::TryAppendHbeakFromElem` receives `hbeakKlass` as a parameter
(`WorldTAB.cpp:281-286`) and must keep receiving it; only the one place that
*produces* that pointer changes.

## Steps

1. **Create `internal/src/game/symbols/GameClasses.h` and `.cpp`** as specified.
   Add both to `internal/il2cpp-dll-injection.vcxproj` (a `<ClCompile>` and a
   `<ClInclude>` entry, alphabetically near the other `src\game\symbols` /
   `src\game\` entries) and to `internal/il2cpp-dll-injection.vcxproj.filters`
   under the same filter the other `src\game\` files use.
   Before writing `WorldManager()`/`Square()`, run the readable-name checks
   described above and adjust the readable strings to whatever the alias map
   actually contains.
   Verify:
   ```bash
   bash internal/tools/wsl-build.sh Debug && bash internal/tools/check-raw-access.sh
   ```
   Nothing calls it yet; expect 0 errors.

2. **Migrate `ProjectileTracking.cpp`.** Delete `ResolveProjClass()`
   (`:47-77`) and the `kProjClassName` constant (`:41`) if it has no other use
   (`grep -n kProjClassName` first — it is referenced in the log strings inside
   the function being deleted). Replace every `ResolveProjClass()` call with
   `GameClasses::Projectile()`. Add `#include "game/symbols/GameClasses.h"`;
   remove `#include "BeebyteName.h"` if nothing else in the file uses it
   (`grep -n Beebyte`).
   Verify: build + guardrail. Then
   `grep -n 'Beebyte::GetMap' internal/src/features/movement/dodge/ProjectileTracking.cpp`
   → empty.

3. **Migrate `ProjectileTrajectory.cpp`.** Replace the resolution block
   (`:41-51`) with:
   ```cpp
   Il2CppClass* klass = GameClasses::Projectile();
   if (!klass) return s_posAt;
   ```
   Keep the `while (const MethodInfo* mi = il2cpp_class_get_methods(klass, &iter))`
   loop and everything after it **exactly as-is** — the method search is not this
   plan's concern. Add the include; drop `BeebyteName.h` if unused.
   Verify: build + guardrail + `grep -n 'Beebyte::GetMap'` on the file → empty.

4. **Migrate `WorldTAB.cpp`'s projectile class (the divergence fix).** Replace
   `:272-279`:
   ```cpp
   static Il2CppClass* s_hbeakKlass = nullptr;
   static Il2CppClass* GetHbeakProjectileClass()
   {
       if (!s_hbeakKlass)
           s_hbeakKlass = Resolver::FindClassLoose("HBEAKBIHANL");
       return s_hbeakKlass;
   }
   ```
   with:
   ```cpp
   // Projectile class — resolved through GameClasses so this matches
   // ProjectileTracking's policy exactly (BeeByte alias first, obfuscated
   // literal as fallback). Before plan 101 this site used a bare
   // FindClassLoose("HBEAKBIHANL") and would go blank on a rename while
   // dodging kept working.
   static Il2CppClass* GetHbeakProjectileClass() { return GameClasses::Projectile(); }
   ```
   Keep the function (its callers pass the result around) and delete the
   `s_hbeakKlass` static. Add `#include "game/symbols/GameClasses.h"`.
   Verify: build + guardrail.

5. **Migrate `WorldTAB.cpp`'s world-manager / square resolution** at `:2338` and
   `:2346` to `GameClasses::WorldManager()` and `GameClasses::Square()`. Leave
   the `il2cpp_method_get_return_type` → `il2cpp_class_from_il2cpp_type` path at
   `:2344-2345` untouched — it derives `sq` from the method signature and only
   falls back to a name lookup, which is *stronger* than a name lookup and must
   stay. Keep `kWorldMgrClassName`/`kSquareClassName` if the log lines at
   `:2351-2352` still use them.
   Verify: build + guardrail.

6. **Migrate `FloatingTextService.cpp:58`** from
   `Resolver::FindClassLoose("MapObjectUIManager")` to
   `GameClasses::Resolve("MapObjectUIManager", "MapObjectUIManager")` (readable
   name; pass it as both arguments — see the header doc). Add the include.
   Verify: build + guardrail.

7. **Migrate `MinimapNav.cpp:240` and `CameraTAB.cpp:225`** the same way
   (`GameClasses::Resolve("MiniMapManager", "MiniMapManager")` and
   `GameClasses::Resolve("CameraManager", "CameraManager")`), and delete their
   now-redundant `static Il2CppClass* s_mmClass` / `s_camMgrClass` caches —
   `GameClasses` caches for them. Keep every surrounding validity check
   (`InstanceValid()`, `ValidateCamMgr()`) exactly as-is: those guard the
   *instance*, not the class.
   Verify: build + guardrail.

8. **Fix the misleading comment.** In
   `internal/src/platform/hooks/Il2CppHook.h:14-15`, replace
   "the class is found via `Resolver::FindClassLoose` (BeeByte-rename proof)"
   with "the class is found via `Resolver::FindClassLoose`, a namespace-ignoring
   exact-name scan — it is NOT rename proof; for a class that may be renamed,
   resolve it through `GameClasses::` first and hook by `MethodInfo*`."
   Verify: build + guardrail.

9. **Add guardrail check 16.** In `internal/tools/check-raw-access.sh` after the
   last check:

   ```bash
   # 16. Private BeeByte alias-map scans in features/ + gui/. Resolving a class
   #     by scanning Beebyte::GetMap() is GameClasses::Resolve's job — a private
   #     copy is how WorldTAB and ProjectileTracking ended up resolving the SAME
   #     class with different robustness. Reading the map for DISPLAY
   #     (Beebyte::Deobf in the inspector UI) is fine and not matched here.
   hits16="$(grep -rnF 'Beebyte::GetMap' "${scope_feat[@]}" 2>/dev/null | grep -v 'raw-access-ok')"
   if [ -n "$hits16" ]; then
     echo "FORBIDDEN [private BeeByte alias scan]:"; echo "$hits16"; fail=1
   fi
   ```

   Update the script header comment to mention check 16.
   Verify: `bash internal/tools/check-raw-access.sh` → exit 0. Then paste
   `Beebyte::GetMap();` into a features/ file, confirm it fires, remove it.

10. **Final sweep + build.**
    ```bash
    grep -rn 'Beebyte::GetMap' internal/src/features internal/src/gui      # empty
    grep -rn 'FindClassLoose("HBEAKBIHANL")' internal/src                  # empty
    ```
    Verify: full build + guardrail.

## Verification

```bash
bash internal/tools/wsl-build.sh Debug     # expect: 0 Error(s), 0 Warning(s)
bash internal/tools/check-raw-access.sh    # expect: exit 0, no output
```

Greps that must return **zero** results when this plan is complete:

```bash
grep -rn 'Beebyte::GetMap' /home/jesse/realm-engine-client/internal/src/features /home/jesse/realm-engine-client/internal/src/gui
grep -rn 'FindClassLoose("HBEAKBIHANL")' /home/jesse/realm-engine-client/internal/src
grep -rn 'BeeByte-rename proof' /home/jesse/realm-engine-client/internal/src
```

**Runtime check — this one matters.** Inject and read
`%LOCALAPPDATA%\RotMG Exalt DLL Trace.log`. You should see one
`[GameClasses] '<name>' resolved via '<obf>'` line per distinct class. For
`Projectile`, the `resolved via` value must be the same obfuscated name the old
`[ProjectileTracking] ResolveProjClass: resolved 'Projectile' via '...'` line
reported before this plan. If it differs, **stop** — the alias map and the
literal disagree and that is a finding, not a refactor. Also confirm the WorldTAB
projectile ESP still draws bullets (that is the site whose policy changed).

## Out of scope

- **Do NOT touch `RuntimeOffsets.cpp`'s class resolution** (`:685-693`,
  `:735-741`). It is deliberately literal-only with a 5-second give-up and
  stale-marking that the Test → OFFSET HEALTH panel and `BootGate`'s audit both
  read. Routing it through `GameClasses` would change what "unresolved class"
  means and is a separate, higher-risk decision.
- **Do NOT touch `features/movement/speedhack/SpeedHack.cpp:202-213`.** Its
  `FindClassAny` takes a namespace and its callers pass real namespaces
  (`SpeedHack.cpp:200` passes `klass->namespaze`); `GameClasses::Resolve` is
  namespace-less by design. Migrating it needs a namespace-aware overload, which
  is scope creep.
- **Do NOT change `Resolver::FindClassLoose`, `GetClass`, or `FindClass`
  themselves.** In particular do not add an early-exit to
  `il2cpp_class_for_each` — that is a perf change in a shared primitive and
  belongs in its own plan.
- **Do NOT migrate method resolution.** `Il2CppHook::ResolveMethodCached` already
  owns that and checks 8/9 already enforce it.
- **Do NOT delete or edit `Mangled.h`.** Consolidating the literals there with
  the ones in `GameClasses.cpp` is a follow-up; doing it here would touch the
  whole dodge subsystem.
- **Do NOT touch `WorldTAB.cpp:1222` or `:2312`
  (`il2cpp_class_get_methods` loops).** Method enumeration is not this plan.
