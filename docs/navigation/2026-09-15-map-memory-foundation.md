# MapMemory foundation, 2026-09-15

Branch: `investigate/persistent-map-corners`, based on audit commit `5c69428`.
Binding design: navigation rebuild spec section 4.2 and the controller's unknown-terrain ruling.

## Implemented boundary

`internal/src/features/movement/nav/MapMemory.h` is a pure, header-only storage owner.
It retains all successfully received ground within map dimensions up to 2048x2048,
including terrain beyond the current 128-tile capture window and more than 65,536
received squares. Ground and mutable structural observations remain separate.
This foundation has no production caller yet and changes no navigation behavior.

| Interface | Contract |
|---|---|
| `Reset(epoch, width, height)` | Accepts a strictly newer, nonzero instance epoch and valid dimensions; clears ground, structural knowledge and queued changes. Invalid or reused resets leave the current map intact. |
| `ObserveGround(epoch, column, row, flags, speedClass)` | Requires received-ground `kTileKnown`, a current epoch and valid coordinates. Preserves structural observations. FullOccupy and unknown flag bits are rejected. |
| `ObserveStructure(epoch, column, row, observation)` | Accepts only `CurrentSquareOccupant` proof of `Present` or `ConfirmedEmpty`. Keeps identity and occupancy flags; rejects unknown/unverified observations and transient-entity sources. Ground remains intact. |
| `GetCell(column, row)` | Returns a value copy with explicit bounds, ground and structural state. Known ground does not imply known structural absence. |
| `TakeChangedCells(maxCells = 4096)` | Returns an epoch-stamped, detached batch of complete changed-cell values, dimensions and a reset marker. Coalesces repeated changes per cell and leaves excess dirty cells queued. |

Observation methods return true only when retained knowledge changes. False means
unchanged or rejected; it must not be interpreted as permission to clear a cell.
An unknown/failed observation preserves prior knowledge and cannot create known
ground. Absence, an open object and an unknown structural state are distinct.
An identical observation creates no duplicate delta; changed object identity does,
even when occupancy flags remain identical.

Ground uses exactly two bytes per square: existing `TileOccupancy` ground flags and
an opaque 8-bit speed class. The speed-class table is a future adapter/router
responsibility; this slice does not quantize speeds or change `Speed` semantics.
At maximum dimensions ground alone is 8 MiB. Structural-knowledge and dirty bitsets
add approximately 1 MiB combined. Present structural occupants use a sparse map;
confirmed-empty cells require only the knowledge bit. Dirty coordinates use a
deduplicated queue, at most one entry per map cell; this and structural records are
additional memory, not included in the 8 MiB ground figure.

All methods require one owning thread. No locking or shared live view is provided.
Only detached `ChangedCells` values may cross the eventual worker boundary; the
consumer must preserve order within an epoch and reject old-epoch batches. The
reset marker is emitted even when no newly received cells exist, and old queued
cells cannot leak into a new epoch. Corridor/request generations are still future
integration work.

## Capture prerequisites

The caller must assign a new epoch on every actual instance transition, including
same-name/same-size instances. The pure memory intentionally does not infer identity
from a name, dimensions or an IL2CPP pointer. HELLO/MAPINFO/OnEnter wiring is not
part of this slice.

`CurrentSquareOccupant` is a proof obligation on the future adapter. It may be used
only after a successful, fresh square-occupant read and structural classification.
A cached far-away square's null occupant, a failed read, absence from an entity
enumeration, or an UPDATE drop is insufficient. Moving enemies, bullets and AoEs
belong to a separate transient overlay; this slice neither implements that overlay
nor learns blockers from those entities. A damaging ground tile remains valid
persistent ground, whereas structural damage flags are refused.

The pinned game's `Sq_Cover` reference establishes where to read occupancy, but
does not yet establish observation freshness during stream-out. Consequently no
live adapter is enabled. Capture/revalidation, global D* Lite routing, stamped
corridors, navStatus and local collision guards remain required. Persisting terrain
alone cannot fix the current radius-72 planner's remote-door failures.

## Validation

2026-09-15: added the tests before the header. The focused command exited 1 with
`fatal error: features/movement/nav/MapMemory.h: No such file or directory`.

```
c++ -std=c++17 -Wall -Wextra -Werror -I internal/src internal/tests/nav_map_memory_tests.cpp -o /tmp/nav-map-memory-tests
/tmp/nav-map-memory-tests
```

After implementation: exit 0, `Map memory tests: 57 checks, 0 failures`. Coverage
includes distant retention, more than 65,536 known cells, unknown ground and
structure, failed reads, same-size instance reset, stale observations/reset,
closed/open/reclosed/destroyed/recreated/replaced doors, unverified absence,
transient entities, bounded/coalesced detached deltas, limits and invalid inputs.

Seven temporary include-overlay mutations compiled successfully and each failed
the focused test executable with exit 1. No mutation touched the working header:

| Mutation | Failing assertion |
|---|---|
| Erase older ground on every update | ground and speed survive observations beyond 128 tiles |
| Accept old-epoch observations | delayed old-instance observations cannot repopulate the new instance |
| Keep structural objects on reset | new instance clears both ground and structural memory |
| Ground updates erase structures | ground replacement does not erase a door |
| Accept unverified structural absence | stream-out or unverified null cannot clear a door |
| Ignore authoritative removal | removal preserves ground and explicit absence |
| Report identical ground as changed | identical ground produces no change |

`python3 internal/tests/run_udodge_zone_tests.py`: exit 0. This runner now includes
MapMemory. Relevant totals: pathing 41, collision 36, speed 18, MapMemory 57,
enemy tracker 69, AutoFire 79, input focus 29. Full scenario suite: legacy 43
asserted / 4 pre-existing known limitations; game 45 / 2. Other host suites pass.

UndefinedBehaviorSanitizer: 57 checks pass. AddressSanitizer plus UBSan with
`-no-pie` and `ASAN_OPTIONS=handle_segv=0:detect_leaks=0`: 57 checks pass. The initial
PIE sanitizer executable emitted repeated `AddressSanitizer:DEADLYSIGNAL`; it was
stopped. The same binary passed under gdb. No clean default-PIE sanitizer result
is claimed, and leak detection was not validated.

`git diff --check`: pass. No client TypeScript or runtime integration changed.
No Windows source edits, portable build, gameplay verification, push or deployment.

`python3 internal/tests/run_nav_global_route_reproducer.py`: exit 1, still
`FAIL: route must use the only known opening south of the wall`. This is the
expected unresolved global-router regression; the new storage owner is not wired
into navigation and does not turn that failure into a pass.
