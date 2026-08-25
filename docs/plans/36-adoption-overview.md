# 36 — Abstraction Adoption Sweep: Overview

## What this wave is

Plans 21-29 built the sanctioned abstraction layers for `internal/src/`:

- `Mem::` (`core/runtime/MemRead.h`) — SEH-safe reads/writes by byte offset
- `RuntimeOffsets::` (`core/runtime/RuntimeOffsets.{h,cpp}`) — table-driven,
  self-healing field-offset registry with the in-game OFFSET HEALTH panel
- `Il2CppC::` (`core/il2cpp/Il2CppContainers.{h,cpp}`) — .NET container layouts,
  dict/list walking, string reading
- `Il2CppHook::` (`platform/hooks/Il2CppHook.{h,cpp}`) — method resolution
  (`ResolveMethodCached`) and MinHook installation
- `Game::` (`game/objects/GameObjects.h`) — typed entity/character/projectile views
- `Resolver::` (`core/runtime/Il2CppResolver.{h,cpp}`) — class lookup, safe invoke

An adoption audit (2026-08-18) found that a lot of feature/GUI code still
bypasses these layers in ways the current guardrail
(`internal/tools/check-raw-access.sh`) does not catch:

1. **~25 locally-defined magic field offsets** (`static constexpr uint32_t
   kOff… = 0x…`) across 8 files, several duplicating each other or duplicating
   existing `RuntimeOffsets::` entries with no self-healing.
2. **6 private field-offset resolution mini-frameworks** (local
   `il2cpp_class_get_field_from_name` + `il2cpp_field_get_offset` code)
   re-implementing what the `RuntimeOffsets` table already does — including one
   pair of files with near-identical copies resolving a field that is
   *already in the registry*.
3. **Raw hex pointer arithmetic** that evades every guardrail check (C-style
   casts with hex literals, e.g. `*(float*)((uint8_t*)p + 0x3C)` for PosX).
4. **Verbatim helper duplication**: `EnsureIl2CppThreadAttached` ×2,
   `FindFieldOnHierarchy` ×3, `ReadPointerRef` ≡ `Mem::ReadPtr`,
   `FindClassByName` ≡ `Resolver::FindClassLoose`, three different IL2CPP
   string readers, and two copies of the "use inventory item by hotkey"
   resolution + call sequence.
5. **11 direct `il2cpp_class_get_method_from_name` calls** left in
   `gui/tabs/CameraTAB.cpp` (guardrail check 8 only covers `features/`).

## Scope exclusions (hard)

Plans in this wave must NOT modify:
- `internal/src/features/movement/repp/`
- `internal/src/features/movement/pjdodge/`
- `internal/src/features/movement/dodge/`
- `internal/src/features/movement/zdodge/`
- `internal/src/features/movement/udodge/`

These belong to the concurrent unified-dodge program (plans 30-35), which is
being implemented right now.

## Plans in this wave

| Plan | Title | Files touched |
|---|---|---|
| 37 | RuntimeOffsets registry additions | `core/runtime/RuntimeOffsets.{h,cpp}` |
| 38 | Core helper consolidation (thread-attach, UTF-8 string read) | `platform/hooks/Il2CppHook.{h,cpp}`, `core/il2cpp/Il2CppContainers.{h,cpp}`, `features/movement/speedhack/SpeedHack.cpp`, `features/movement/noclip/NoclipHook.cpp` |
| 39 | Combat offset migration + shared ItemUse home | `game/actions/ItemUse.{h,cpp}` (new), `il2cpp-dll-injection.vcxproj` + `.filters`, `features/combat/autoability/AutoAbility.cpp`, `features/combat/autonexus/AutoNexus.cpp`, `features/combat/autoaim/WeaponProfile.cpp`, `features/combat/autoaim/AimHooks.cpp` |
| 40 | ProjNoclip / PlayerCollider / TestTAB offset migration | `features/combat/autoaim/ProjNoclip.cpp`, `features/movement/collider/PlayerCollider.cpp`, `gui/tabs/TestTAB.cpp` |
| 41 | WorldTAB + CamState hygiene | `gui/tabs/WorldTAB.cpp`, `gui/CamState.cpp` |
| 42 | PlayerTAB + CameraTAB migration | `gui/tabs/PlayerTAB.cpp`, `gui/tabs/CameraTAB.cpp` |
| 43 | Guardrail extension (checks 9-11) | `internal/tools/check-raw-access.sh` |

## Dependency graph

```
37 (RuntimeOffsets additions) ──┬──► 39 (combat)      ──┐
                                ├──► 40 (collider/…)  ──┤
38 (core helpers) ──────────────┼──► 41 (WorldTAB/…)  ──┼──► 43 (guardrails)
                                └──► 42 (PlayerTAB/…) ──┘
```

- **37 and 38 are parallel-safe with each other** (disjoint files). Both are
  foundations: merge them first.
- **39, 40, 41, 42 are parallel-safe with each other** (disjoint file sets).
  39 and 40 depend only on 37. 41 and 42 depend on 37 AND 38.
- **43 must run last** — its new checks fail until 39-42 are merged.

## Cross-wave conflicts with the dodge program (plans 30-35)

- `gui/tabs/TestTAB.cpp` — dodge plans 33 and 35 edit the dodge-mode enum and
  transition code (TestTAB.h:10-18, TestTAB.cpp:141-204, ~1414). Plan 40 in
  this wave edits DIFFERENT regions (offset constants ~219-267, teleport
  writes ~797-801). No semantic overlap, but expect line drift: **merge plan
  40 after dodge plans 33/35**, or rebase trivially.
- `internal/il2cpp-dll-injection.vcxproj` (+ `.filters`) — dodge plans 31/33/35
  add/remove source entries; plan 39 adds `game/actions/ItemUse.{h,cpp}`.
  Textual merge conflicts in the same ItemGroups are possible; **merge plan 39
  after the dodge vcxproj edits** or resolve the trivial conflict.
- `internal/tools/check-raw-access.sh` — dodge plans only RUN it; plan 43 is
  the only modifier in either wave. If udodge code introduces hits on plan
  43's new checks, coordinate with the dodge implementer rather than editing
  `udodge/` from this wave.

## Global verification

Every plan step must end green on:

```bash
# Build the DLL from WSL (Debug config; drives Windows MSBuild):
bash internal/tools/wsl-build.sh Debug
# Expected: "0 Warning(s) / 0 Error(s)" and realm-engine.dll produced.

# Guardrail ratchet (must stay exit 0 at every step):
bash internal/tools/check-raw-access.sh
```

Prereq: `internal/src/game/generated/` must contain the six Il2CppInspectorPro
headers (gitignored, ~94 MB). If missing, the build fails immediately on
includes — see `internal/CLAUDE.md` and repo `SETUP.md`.

## Decisions deliberately NOT made by these plans (flag to the user)

1. **`NFJGJKLPLBA` identity conflict** — `RuntimeOffsets::PlayerName`
   (`RuntimeOffsets.cpp:69`, fallback 0x4B8, resolved from live metadata) and
   `gui/tabs/WorldTAB.cpp:62` (`OFF_PLAYER_GUILD = 0x468`, commented as "guild
   name NFJGJKLPLBA") attribute the SAME BeeByte field name to two different
   fields. If live resolution succeeds, `PlayerName` self-heals to whatever
   offset metadata reports for NFJGJKLPLBA — which per WorldTAB's comment is
   the guild string at 0x468. One of the two labels is wrong. Plan 41 keeps
   the guild constant value-identical (moved, not changed); someone must
   verify in-game which field NFJGJKLPLBA actually is and fix the loser.
2. **Equipment-manager offset gating** — AutoAbility/AutoNexus currently
   refuse to act until the offset resolves from metadata (no fallback);
   PlayerTAB happily uses the 0x668 fallback. Plan 39 unifies on the registry
   fallback (registry design wins), which slightly loosens the gate for
   AutoAbility/AutoNexus. See plan 39 "Divergence warnings".
3. **Local-player pointer source** — three coexisting getters
   (`GameState::GetLocalPtr`, `WorldTAB::GetLocalPtr`, `LocalPlayer::GetPtr`)
   are all still in use. Unifying them is a lifecycle change, not an offset
   cleanup, and is out of scope for this wave.
