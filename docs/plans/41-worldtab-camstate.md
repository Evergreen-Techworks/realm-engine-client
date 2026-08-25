# 41 — WorldTAB + CamState Hygiene

## Goal
`gui/tabs/WorldTAB.cpp` and `gui/CamState.cpp` stop carrying private field
offsets, a private field-resolution mini-framework, a private class-lookup
helper that duplicates `Resolver::FindClassLoose`, a private IL2CPP string
reader that duplicates `Il2CppC::ReadString`, and raw hex pointer-cast reads
that evade every guardrail check. Everything routes through the
`RuntimeOffsets` entries added by plan 37, `Il2CppC::ReadString`, `Mem::`, and
`Resolver::FindClassLoose`. Behavior is preserved (divergences noted below).

## Dependencies
- **Plan 37 must be merged first** (uses `RuntimeOffsets::KJ_DictObjectId`,
  `Sq_DamageCached`, `Sq_Cover`, `Player_GuildName`, `WM_DiagE0/F4/F8/FC/100`,
  plus the pre-existing `WM_TickId`/`WM_TickId2`/`PosX`/`PosY`).
- **Plan 38 must be merged first** (this plan does NOT need
  `Il2CppC::ReadStringUtf8` — see Divergence warnings for why WorldTAB stays
  on ASCII `Il2CppC::ReadString` — but per the overview's dependency graph 41
  depends on both 37 and 38; merge 38 first regardless so the dependency
  order matches plan 42's).
- Parallel-safe with plans 39, 40, 42 (disjoint files).

Files touched (no other plan in this wave touches them):
- `internal/src/gui/tabs/WorldTAB.cpp`
- `internal/src/gui/CamState.cpp`

Do NOT touch `internal/src/features/movement/{repp,pjdodge,dodge,zdodge,udodge}/`.
Do NOT touch `internal/src/core/runtime/RuntimeOffsets.{h,cpp}` (plan 37's
file — already merged and closed by the time this plan runs).
Do NOT touch `internal/src/gui/tabs/TestTAB.cpp` (plan 40's file) or
`internal/src/gui/tabs/PlayerTAB.cpp` / `CameraTAB.cpp` (plan 42's files),
even though some of the patterns below also appear there.

## Current state

### 1. `OFF_PLAYER_GUILD` — dead duplicate of a plan-37 manual constant
`WorldTAB.cpp:58-62`:
```cpp
// Guild name (NFJGJKLPLBA @ FKALGHJIADI dump 0x468) is at runtime 0x468 — dump offsets for FKALGHJIADI
// own fields ARE the runtime offsets (the dump was generated from the already-patched binary).
static constexpr uint32_t OFF_PLAYER_GUILD  = 0x468;  // string NFJGJKLPLBA — guild name (empty if no guild)
```
This constant has **zero call sites** in the file today (verified:
`grep -n OFF_PLAYER_GUILD gui/tabs/WorldTAB.cpp` matches only the declaration
line). Plan 37 already added the same value as
`RuntimeOffsets::Player_GuildName` (a manual constant, not a table row —
see plan 37's "Divergence warnings" and the overview's `NFJGJKLPLBA`
identity-conflict note). This step is pure dead-code deletion; it does
**not** introduce a new call site and does **not** resolve the
`NFJGJKLPLBA`/`PlayerName` identity question — that stays open per the
overview.

### 2. `OFF_KJM_OBJECT_ID` — duplicate of a plan-37 table entry
`WorldTAB.cpp:63-64`:
```cpp
// KJMONHENJEN.FDNHINDAEHK — dict key / object id when pointer match fails vs GameState::GetLocalPtr()
static constexpr uint32_t OFF_KJM_OBJECT_ID = 0xC0;
```
One call site, already through `Mem::TryRead`, at `WorldTAB.cpp:675`:
```cpp
if (Mem::TryRead(localPtr, OFF_KJM_OBJECT_ID, oidFromField) && oidFromField != 0)
```
Plan 37 added the same field as `RuntimeOffsets::KJ_DictObjectId`.

### 3. `OFF_WM_*` — seven WorldManager diagnostic offsets, two already in the registry
`WorldTAB.cpp:75-82`:
```cpp
static constexpr uint32_t OFF_WM_UINT_D8    = 0xD8;
static constexpr uint32_t OFF_WM_UINT_DC    = 0xDC;
static constexpr uint32_t OFF_WM_UINT_E0    = 0xE0;
static constexpr uint32_t OFF_WM_FLOAT_F4   = 0xF4;
static constexpr uint32_t OFF_WM_FLOAT_F8   = 0xF8;
static constexpr uint32_t OFF_WM_INT_FC     = 0xFC;
static constexpr uint32_t OFF_WM_INT_100    = 0x100;
```
Seven call sites, all in `DoRefresh()` at `WorldTAB.cpp:567-573`:
```cpp
Mem::TryRead(worldMgr, OFF_WM_UINT_D8,  g_wm_d8);
Mem::TryRead(worldMgr, OFF_WM_UINT_DC,  g_wm_dc);
Mem::TryRead(worldMgr, OFF_WM_UINT_E0,  g_wm_e0);
Mem::TryRead(worldMgr, OFF_WM_FLOAT_F4, g_wm_f4);
Mem::TryRead(worldMgr, OFF_WM_FLOAT_F8, g_wm_f8);
Mem::TryRead(worldMgr, OFF_WM_INT_FC,   g_wm_fc);
Mem::TryRead(worldMgr, OFF_WM_INT_100,  g_wm_100);
```
`OFF_WM_UINT_D8`/`OFF_WM_UINT_DC` duplicate the EXISTING table-resolved
`RuntimeOffsets::WM_TickId`/`WM_TickId2` (self-healing today, already used
elsewhere in the codebase — this file just never adopted them). The other
five duplicate the plan-37 manual constants `WM_DiagE0`/`WM_DiagF4`/
`WM_DiagF8`/`WM_DiagFC`/`WM_Diag100`.

### 4. `FindClassByName` — verbatim duplicate of `Resolver::FindClassLoose`
`WorldTAB.cpp:265-276`:
```cpp
static Il2CppClass* FindClassByName(const char* name)
{
    struct Ctx { const char* name; Il2CppClass* result; };
    Ctx ctx{ name, nullptr };
    il2cpp_class_for_each([](Il2CppClass* klass, void* ud) {
        auto* c = static_cast<Ctx*>(ud);
        if (c->result) return;
        if (strcmp(il2cpp_class_get_name(klass), c->name) == 0)
            c->result = klass;
    }, &ctx);
    return ctx.result;
}
```
This is byte-for-byte the same algorithm as `Resolver::FindClassLoose`
(`core/runtime/Il2CppResolver.cpp:340-352`). One call site,
`WorldTAB.cpp:294`:
```cpp
s_hbeakKlass = FindClassByName("HBEAKBIHANL");
```
`Il2CppResolver.h` is already included (`WorldTAB.cpp:10`).

### 5. `ReadIl2CppString` — local copy of `Il2CppC::ReadString` with a stricter length gate
`WorldTAB.cpp:464-481`:
```cpp
static bool ReadIl2CppString(void* strPtr, char* buf, int bufLen)
{
    if (!Mem::AddrOk(strPtr) || bufLen <= 0) return false;
    int32_t len = 0;
    Mem::TryRead(strPtr, Il2CppC::kStrLen, len);
    if (len <= 0 || len > 256) return false;
    if (len > bufLen - 1) len = bufLen - 1;
    const uint8_t* chars = reinterpret_cast<const uint8_t*>(strPtr) + Il2CppC::kStrChars;
    for (int i = 0; i < len; ++i) {
        uint16_t ch = 0;
        Mem::TryRead(chars + (size_t)i * 2u, 0u, ch);
        buf[i] = (char)(ch & 0x7F);
    }
    buf[len] = '\0';
    return buf[0] != '\0';
}
```
Seven call sites: `WorldTAB.cpp:516, 525, 537, 626, 636, 734, 2383`, e.g.
```cpp
if (ReadIl2CppString(minStr, buf, sizeof(buf)))
    t.minDmg = (int32_t)std::strtol(buf, nullptr, 10);
```
and (return value discarded):
```cpp
ReadIl2CppString(nameStr, ent.playerName, sizeof(ent.playerName));
```
The canonical `Il2CppC::ReadString(strPtr, out, outCap)`
(`core/il2cpp/Il2CppContainers.cpp:35-48`) does the same ASCII-masked copy
(`ch & 0x7F`) but returns `int` (chars written, 0 on failure) instead of
`bool`, and its length handling differs — see Divergence warnings.

### 6. Square live-hazard block — private field-resolution mini-framework duplicating a plan-37 table entry
`WorldTAB.cpp:2290-2365` (inside the `QuerySquareHazard`/`IsTileDamagingLive`
disabled-by-default live-lookup feature — `s_liveHazOk` starts `false` and is
only ever set to `false` again; there is no code path that sets it `true`, so
this feature is permanently inert today, per the comment at
`WorldTAB.cpp:2279-2286`):
```cpp
static constexpr uint32_t  kSquareDamageOffFallback = 0x10;  // EAPMKCKMNDI, i32
static constexpr uint32_t  kSquareCoverOffFallback  = 0x48;  // JGMBPFJEGAH, ref
static uint32_t s_squareDamageOff = kSquareDamageOffFallback;
static uint32_t s_squareCoverOff  = kSquareCoverOffFallback;
...
static uint32_t FieldOffsetOr(Il2CppClass* klass, const char* name, uint32_t fallback)
{
    if (!klass) return fallback;
    FieldInfo* f = il2cpp_class_get_field_from_name(klass, name);
    if (!f) return fallback;
    const size_t off = il2cpp_field_get_offset(f);
    return (off > 0 && off < 0x1000) ? static_cast<uint32_t>(off) : fallback;
}
...
s_squareDamageOff = FieldOffsetOr(sq, "EAPMKCKMNDI", kSquareDamageOffFallback);
s_squareCoverOff  = FieldOffsetOr(sq, "JGMBPFJEGAH", kSquareCoverOffFallback);
```
`FieldOffsetOr` has exactly these two call sites (verified —
`grep -n FieldOffsetOr gui/tabs/WorldTAB.cpp` returns only the definition
and these two lines). Its only two consumers, `ProbeSquare`
(`WorldTAB.cpp:2400-2411`), already carry `raw-access-ok` markers because
they read through a raw `reinterpret_cast` in a shared `__try` sweep:
```cpp
out->dmgCached = *reinterpret_cast<const int*>(p + s_squareDamageOff);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
out->covered   = *reinterpret_cast<const uint64_t*>(p + s_squareCoverOff) != 0;  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
```
Plan 37 added these exact two fields to the registry as
`RuntimeOffsets::Sq_DamageCached` (fallback 0x10) and `RuntimeOffsets::Sq_Cover`
(fallback 0x48) specifically because of this duplication (see plan 37
"Current state" table, `WorldTAB.cpp:2294-2295` rows).

`FindGetSquareMethod` (`WorldTAB.cpp:2299-2317`, resolves
`HJMBOMEHGDJ.MPIIFPBDACN(int,int)` by iterating `il2cpp_class_get_methods`
and rejecting the `(float,float)` overload) and the method-pointer plumbing
around it are a legitimate live-instance overload disambiguation — the same
pattern the guardrail already leaves alone in `features/` (it only forbids
the simple `il2cpp_class_get_method_from_name` convenience call, not a
manual `il2cpp_class_get_methods` iteration). **Do not touch
`FindGetSquareMethod` or the method-resolution half of
`EnsureSquareLookupResolved`** — only the two field-offset lines above.

### 7. Two more call sites of the SAME two fields, read via inline magic numbers, outside the mini-framework
`WorldTAB.cpp:722-725` (inside the primary tile-scan loop in `DoRefresh()`,
already through `Mem::TryRead`, but with inline hex instead of a name):
```cpp
// Read Discord method cached values from the Square object directly
Mem::TryRead(tp, 0x10, t.damageCached);
void* coverPtr = nullptr;
if (Mem::TryRead(tp, 0x48, coverPtr) && coverPtr != nullptr) {
    t.hasCover = true;
}
```
These are the SAME `BGAIOPJMHLO.EAPMKCKMNDI` / `BGAIOPJMHLO.JGMBPFJEGAH`
fields as item 6, read a second, independent way. They also migrate to
`RuntimeOffsets::Sq_DamageCached` / `RuntimeOffsets::Sq_Cover`.

### 8. `ReadLivePlayerXY` in CamState.cpp — raw hex pointer-cast reads
`CamState.cpp:24-37`:
```cpp
static bool ReadLivePlayerXY(float& outX, float& outY)
{
    void* p = WorldTAB::GetLocalPtr();
    if (p) {
        __try {
            outX = *(float*)((uint8_t*)p + 0x3C);
            outY = *(float*)((uint8_t*)p + 0x40);
            return true;
        } __except (EXCEPTION_EXECUTE_HANDLER) {}
    }
    outX = WorldTAB::GetLocalX();
    outY = WorldTAB::GetLocalY();
    return true;
}
```
`0x3C`/`0x40` are `RuntimeOffsets::PosX`/`PosY` (already used with those
names throughout `WorldTAB.cpp`, e.g. `WorldTAB.cpp:326-327`). This is a
**C-style cast**, so it evades guardrail check 2 (which only matches
`reinterpret_cast<...>`). One call site of `ReadLivePlayerXY`, inside
`CamState::Tick()` at `CamState.cpp:57`. Only caller in the file; only
definition in the file — no other consumer.

## Target design

No new abstractions — every replacement below uses an API that already
exists (post plan-37/38 merge):

- `RuntimeOffsets::KJ_DictObjectId`, `Sq_DamageCached`, `Sq_Cover`,
  `Player_GuildName`, `WM_DiagE0`, `WM_DiagF4`, `WM_DiagF8`, `WM_DiagFC`,
  `WM_Diag100`, `WM_TickId`, `WM_TickId2` — `core/runtime/RuntimeOffsets.h`.
- `Resolver::FindClassLoose(const char*)` — `core/runtime/Il2CppResolver.h`.
- `Il2CppC::ReadString(void* strPtr, char* out, int outCap) -> int` —
  `core/il2cpp/Il2CppContainers.h`.
- `Mem::TryRead<T>(base, off, out&) -> bool` — `core/runtime/MemRead.h`.

### Divergence warnings
- **String reader length handling.** WorldTAB's local `ReadIl2CppString`
  *rejects* (returns `false`, buffer untouched) any string longer than 256
  chars, and leaves `buf` untouched when `len <= 0`. The canonical
  `Il2CppC::ReadString` *truncates* to `outCap - 1` (no 256 ceiling) and
  writes `out[0] = '\0'` when `len <= 0`. Every call site in this file uses
  either a stack buffer pre-zeroed with `= {}` (`buf[32] = {}` at
  `WorldTAB.cpp:515, 524, 536, 2382`) or a struct field whose value is only
  read/displayed when the surrounding `Mem::TryRead`/`Mem::AddrOk` guard
  already succeeded, so the empty-string edge case is not observable in
  practice. The truncate-vs-reject difference only matters for
  implausible (>256-char) strings, which none of these fields (tile IDs,
  player names, guild names, numeric damage/speed strings) produce in
  normal play. **Chosen behavior: adopt the canonical truncate semantics**
  (matches plan 38's stated intent that `ReadString`/`ReadStringUtf8` are
  the one home for this) — this is a truncate-instead-of-reject change for
  a case that cannot occur with real game data, not a functional change to
  this feature.
- **Square live-hazard field resolution.** The deleted `FieldOffsetOr` path
  re-resolved `EAPMKCKMNDI`/`JGMBPFJEGAH` off the SPECIFIC class returned by
  `HJMBOMEHGDJ.MPIIFPBDACN`'s return type (falling back to
  `Resolver::FindClassLoose("BGAIOPJMHLO")` only if that failed). The
  registry resolves the same two fields off `Resolver::FindClassLoose(
  "BGAIOPJMHLO")` directly. Both target the same field names on the same
  class in every case observed; per the plan 40 precedent (PlayerCollider),
  the registry value wins as the single source of truth. Because this
  entire code path is inert today (`s_liveHazOk` is never set `true` — see
  item 6), there is no observable runtime behavior change either way.
- **`OFF_PLAYER_GUILD` / `NFJGJKLPLBA` identity conflict** — unresolved, see
  the overview `docs/plans/36-adoption-overview.md` "Decisions deliberately
  NOT made" item 1. This plan moves the constant's VALUE (0x468) to its
  already-existing plan-37 home (`RuntimeOffsets::Player_GuildName`) without
  adding a new call site and without touching `RuntimeOffsets::PlayerName`.
  Do not attempt to resolve the conflict here.

## Steps

### Step 1 — Delete `OFF_PLAYER_GUILD` (dead code)
File: `internal/src/gui/tabs/WorldTAB.cpp`

Delete lines 58-62 (the three-line comment block and the constant). Nothing
else changes — there are no call sites.

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 2 — `OFF_KJM_OBJECT_ID` → `RuntimeOffsets::KJ_DictObjectId`
File: `internal/src/gui/tabs/WorldTAB.cpp`

Delete the constant at lines 63-64. Replace the one call site (line 675):
```cpp
// Before
if (Mem::TryRead(localPtr, OFF_KJM_OBJECT_ID, oidFromField) && oidFromField != 0)
// After
if (Mem::TryRead(localPtr, RuntimeOffsets::KJ_DictObjectId, oidFromField) && oidFromField != 0)
```

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 3 — `OFF_WM_*` → `RuntimeOffsets::WM_TickId`/`WM_TickId2`/`WM_Diag*`
File: `internal/src/gui/tabs/WorldTAB.cpp`

Delete the seven constants at lines 75-82. Replace the seven call sites at
lines 567-573:
```cpp
// Before
Mem::TryRead(worldMgr, OFF_WM_UINT_D8,  g_wm_d8);
Mem::TryRead(worldMgr, OFF_WM_UINT_DC,  g_wm_dc);
Mem::TryRead(worldMgr, OFF_WM_UINT_E0,  g_wm_e0);
Mem::TryRead(worldMgr, OFF_WM_FLOAT_F4, g_wm_f4);
Mem::TryRead(worldMgr, OFF_WM_FLOAT_F8, g_wm_f8);
Mem::TryRead(worldMgr, OFF_WM_INT_FC,   g_wm_fc);
Mem::TryRead(worldMgr, OFF_WM_INT_100,  g_wm_100);
// After
Mem::TryRead(worldMgr, RuntimeOffsets::WM_TickId,  g_wm_d8);
Mem::TryRead(worldMgr, RuntimeOffsets::WM_TickId2, g_wm_dc);
Mem::TryRead(worldMgr, RuntimeOffsets::WM_DiagE0,  g_wm_e0);
Mem::TryRead(worldMgr, RuntimeOffsets::WM_DiagF4,  g_wm_f4);
Mem::TryRead(worldMgr, RuntimeOffsets::WM_DiagF8,  g_wm_f8);
Mem::TryRead(worldMgr, RuntimeOffsets::WM_DiagFC,  g_wm_fc);
Mem::TryRead(worldMgr, RuntimeOffsets::WM_Diag100, g_wm_100);
```
(The `g_wm_*` variable names stay as-is — they're display state, not the
thing being migrated.)

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 4 — `FindClassByName` → `Resolver::FindClassLoose`
File: `internal/src/gui/tabs/WorldTAB.cpp`

Delete the function at lines 265-276. Replace the one call site (line 294):
```cpp
// Before
s_hbeakKlass = FindClassByName("HBEAKBIHANL");
// After
s_hbeakKlass = Resolver::FindClassLoose("HBEAKBIHANL");
```

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 5 — `ReadIl2CppString` → `Il2CppC::ReadString`
File: `internal/src/gui/tabs/WorldTAB.cpp`

Delete the function and its header comment at lines 464-481. Replace all
seven call sites, changing the truthiness check from `bool` to `> 0`:
```cpp
// Before (WorldTAB.cpp:516, 525, 537, 2383 — pattern repeats 4x)
if (ReadIl2CppString(minStr, buf, sizeof(buf)))
    t.minDmg = (int32_t)std::strtol(buf, nullptr, 10);
// After
if (Il2CppC::ReadString(minStr, buf, sizeof(buf)) > 0)
    t.minDmg = (int32_t)std::strtol(buf, nullptr, 10);
```
```cpp
// Before (WorldTAB.cpp:626, 636, 734 — return value discarded, pattern repeats 3x)
ReadIl2CppString(nameStr, ent.playerName, sizeof(ent.playerName));
// After
Il2CppC::ReadString(nameStr, ent.playerName, sizeof(ent.playerName));
```
`core/il2cpp/Il2CppContainers.h` is already included (`WorldTAB.cpp:13`).

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 6 — Square live-hazard fields → `RuntimeOffsets::Sq_DamageCached`/`Sq_Cover`
File: `internal/src/gui/tabs/WorldTAB.cpp`

- Delete `kSquareDamageOffFallback`, `kSquareCoverOffFallback`,
  `s_squareDamageOff`, `s_squareCoverOff` (lines 2294-2297).
- Delete the `FieldOffsetOr` function (lines 2319-2326).
- In `EnsureSquareLookupResolved`, delete the two assignment lines
  (2347-2348):
  ```cpp
  s_squareDamageOff = FieldOffsetOr(sq, "EAPMKCKMNDI", kSquareDamageOffFallback);
  s_squareCoverOff  = FieldOffsetOr(sq, "JGMBPFJEGAH", kSquareCoverOffFallback);
  ```
  (the surrounding `sq` resolution and the `DBG_FILE_LOG` lines that follow
  stay — only delete these two assignment lines; if `sq` becomes unused as a
  result, keep the variable since it is still read by the `DBG_FILE_LOG`
  call and/or the `getSquare` resolution block above it — check before
  deleting anything else in this function).
- In `ProbeSquare` (lines 2400-2411), change the two field reads, KEEPING
  the existing `raw-access-ok` markers (this is still a shared-`__try`
  hot-loop sweep, now just naming the registry directly):
  ```cpp
  // Before
  out->dmgCached = *reinterpret_cast<const int*>(p + s_squareDamageOff);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
  out->covered   = *reinterpret_cast<const uint64_t*>(p + s_squareCoverOff) != 0;  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
  // After
  out->dmgCached = *reinterpret_cast<const int*>(p + RuntimeOffsets::Sq_DamageCached);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
  out->covered   = *reinterpret_cast<const uint64_t*>(p + RuntimeOffsets::Sq_Cover) != 0;  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
  ```
- Do NOT touch `FindGetSquareMethod` or the `getSquare`/`s_squareLookup`
  method-resolution logic.

**Verify:** `bash internal/tools/wsl-build.sh Debug` and
`bash internal/tools/check-raw-access.sh`

### Step 7 — Inline `0x10`/`0x48` tile reads → `RuntimeOffsets::Sq_DamageCached`/`Sq_Cover`
File: `internal/src/gui/tabs/WorldTAB.cpp`

At lines 722-725:
```cpp
// Before
Mem::TryRead(tp, 0x10, t.damageCached);
void* coverPtr = nullptr;
if (Mem::TryRead(tp, 0x48, coverPtr) && coverPtr != nullptr) {
    t.hasCover = true;
}
// After
Mem::TryRead(tp, RuntimeOffsets::Sq_DamageCached, t.damageCached);
void* coverPtr = nullptr;
if (Mem::TryRead(tp, RuntimeOffsets::Sq_Cover, coverPtr) && coverPtr != nullptr) {
    t.hasCover = true;
}
```

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 8 — `CamState::ReadLivePlayerXY` → `Mem::TryRead`
File: `internal/src/gui/CamState.cpp`

Add includes (this file currently has none of these):
```cpp
#include "core/runtime/MemRead.h"
#include "core/runtime/RuntimeOffsets.h"
```
Replace the function body (lines 24-37):
```cpp
// Before
static bool ReadLivePlayerXY(float& outX, float& outY)
{
    void* p = WorldTAB::GetLocalPtr();
    if (p) {
        __try {
            outX = *(float*)((uint8_t*)p + 0x3C);
            outY = *(float*)((uint8_t*)p + 0x40);
            return true;
        } __except (EXCEPTION_EXECUTE_HANDLER) {}
    }
    outX = WorldTAB::GetLocalX();
    outY = WorldTAB::GetLocalY();
    return true;
}
// After
static bool ReadLivePlayerXY(float& outX, float& outY)
{
    void* p = WorldTAB::GetLocalPtr();
    if (Mem::TryRead(p, RuntimeOffsets::PosX, outX) &&
        Mem::TryRead(p, RuntimeOffsets::PosY, outY))
        return true;
    outX = WorldTAB::GetLocalX();
    outY = WorldTAB::GetLocalY();
    return true;
}
```
`Mem::TryRead` already AddrOk-checks `base` internally (`p == nullptr` and
garbage pointers both fail safely, matching the old `if (p)` +
SEH-catch behavior); if either read fails, `outX`/`outY` are left
untouched by `Mem::TryRead` and are then overwritten by the fallback
branch exactly as before — same net behavior as the original single shared
`__try` (both offsets were always read together and the fallback always
supplied both on any failure).

**Verify:** `bash internal/tools/wsl-build.sh Debug` and
`bash internal/tools/check-raw-access.sh`

## Verification
```bash
bash internal/tools/wsl-build.sh Debug            # 0 warnings / 0 errors
bash internal/tools/check-raw-access.sh            # exit 0

# Dead/duplicate constants gone (expect ZERO hits):
grep -n 'OFF_PLAYER_GUILD\|OFF_KJM_OBJECT_ID\|OFF_WM_UINT\|OFF_WM_FLOAT\|OFF_WM_INT' internal/src/gui/tabs/WorldTAB.cpp

# Private helpers gone (expect ZERO hits):
grep -n 'static Il2CppClass\* FindClassByName\|static bool ReadIl2CppString\|FieldOffsetOr\|kSquareDamageOffFallback\|kSquareCoverOffFallback' internal/src/gui/tabs/WorldTAB.cpp

# Raw hex pointer cast gone from CamState.cpp (expect ZERO hits):
grep -nE '\*\(float\*\)\(\(uint8_t\*\)' internal/src/gui/CamState.cpp

# WorldTAB now calls the canonical string reader (expect >= 7 hits):
grep -c 'Il2CppC::ReadString(' internal/src/gui/tabs/WorldTAB.cpp
```

## Out of scope
- The `HFDNHJFNEKA` (`objectType`) raw offset `0x30` at `WorldTAB.cpp:615`
  (`Mem::TryRead(value, 0x30u, ent.objType);`) — this field was NOT added to
  the registry by plan 37, so this plan has no sanctioned home to point it
  at. Adding a new `RuntimeOffsets` row is plan 37's territory (already
  merged/closed); leave this magic offset as-is. Flag it for a future
  registry-additions plan.
- Resolving the `NFJGJKLPLBA` / `PlayerName` identity conflict (overview
  item 1) — value-preserving move only.
- `FindGetSquareMethod` / the live-hazard method-resolution path — inert
  feature, out of scope for this offset-hygiene pass (see item 6 above).
- `TestTAB.cpp`, `PlayerTAB.cpp`, `CameraTAB.cpp` — other plans' files.
- `features/movement/{repp,pjdodge,dodge,zdodge,udodge}/`.
- Any change to `WorldTAB`'s or `CamState`'s observable behavior, timing, or
  UI layout.
