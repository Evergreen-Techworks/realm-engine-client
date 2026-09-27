# Native encounter capture v1

Diagnostic instrumentation only. Enable with `encounter-capture.flag` beside the native trace. The existing IPC thread polls this flag every two seconds. Recorder plugin must also be enabled. Separate `encounter-present.flag` enables only renderer timestamp capture; the scene flag implies renderer capture as well. No automatic enable. For overhead tests compare renderer-only control with scene+renderer; this measures incremental scene capture overhead, not total overhead versus no instrumentation. Keep native diagnostic timing enabled identically in both. No movement behavior or calibration changes are included. This source is based on 57a2be4 and excludes e506590 and 8c613b48.

## Recorder and identity

Each JSONL record contains `k` equal to `kind`: `native_scene`, `native_decision`, or `native_present_interarrival`; `t` is client receipt UTC milliseconds. Payload is top-level, `type=encounterCapture`, `version=1`. `processId` and `processStartUtcMs` identify the native process. `decision.generation` is a local native OnEnter epoch, NOT a server map ID. It requires an independently verified map/run join. The recorder file and exact build/script manifest establish run and executed subject identity; neither is guessed by native code.

`anchorMs` is the midpoint of GetTickCount64 reads bracketing the IPC thread UTC sample `anchorUtcMs`. `anchorUncertaintyMs` includes half bracket width plus 16ms tick granularity. Recorder copies it into `clockUncertaintyMs`. `decision.ms` is the original game-thread observation; receipt time is not the event time. Delayed pre-event scenes retain original times/sequence. UTC system-clock adjustments may invalidate anchor joins and must be detected by the reader. Queue delivery order is not event chronology. Deduplicate scene sequence within process identity; overlapping captures may repeat historical records.

## Decision

`decision` contains `ms,sequence,generation,trigger,tick,hp,maxHp,lockId,mode,solve,x,y,goalX,goalY,targetX,targetY,speed,range,clearance,standClearance,lockX,lockY,rawGoalX,rawGoalY,move,fromLock,lockApproach,driveAccepted,dropped,suppressed`.

Mode 0 idle/steer, 1 point walk, 2 locked combat, 3 native lock approach. Solve is existing SolveKind enum. `targetX/Y` is the commanded motion endpoint, not an alternative optimum. `goalX/Y` is solver-local goal; `rawGoalX/Y` is cached global requested goal (only meaningful for point travel). Range is solver goal maxRange, zero can mean unavailable during approach. `lockId` acknowledges actual native map lock. This observes 12–24-tile lock recovery when distance from player to lock position is in that band and mode is 3; it cannot alone prove the candidate script branch ran. `driveAccepted` means native drive guards accepted command, not server acknowledgement.

Trigger bits: 1 HP decrease or recorded hit request, 2 death, 4 lock/mode change, 8 repeated direction reversal, 16 commanded movement without 0.5-tile progress for 2s, 32 map ending, 64 recorded escape request. Client records `capture_trigger` with sourcePacket,reason,delivered. Delivered means bridge send accepted, not game-thread acknowledgement. If game updates cease before consumption, native terminal capture can be missing; retain the client terminal record. NewMap metadata retains old generation. No packet damage amounts are inferred from these triggers.

## Scene arrays and coverage

- `enemies` <=64 rows `[id,type,hp,maxHp,x,y,vx,vy,flags]`; flag1 XML invulnerable,2 health bar,4 scenery,8 projectile definitions. Copied current-thread EnemyTracker snapshot, with no new traversal or raw pointer reads. Snapshot itself filters hidden helpers; runtime invulnerable/untargetable conditions and observation age remain unknown. `enemiesObserved` is snapshot size; `enemyEntriesVisited` describes inspected prefix. Omitted entries are not safe.
- `projectiles` <=128 rows `[owner,attacker,bullet,hitHalf,remainingLifeMs,damageEstimate,flags,totalPoints,points]`; points <=8 `[x,y,relativeMs]` rows copied from the beginning of the native trace. Flag1 provisional packet path,2 runtime verified linear,4 beam,8 trace ends at projectile lifetime. Additional trajectory points are truncated, not extrapolated. Negative life/damage means unavailable. Freshness is unknown.
- `zones` <=64 `[x,y,radius,flags]`; flag1 active,2 policy keepout. Activation/expiration time and source entity are unavailable. Policy zones must not be counted as observed damaging blasts.
- `candidates` <=8 `[x,y,clearance,timeToDangerMs,score,flags]`, copied from actual solver evaluation, stand first. Flag1 stand,2 endpoint admitted,4 path admitted,8 instantaneously safe,16 rejected by zone sweep in reflex phase,32 rejected by temporal dwell in reflex phase,64 score actually evaluated,128 stand TTC evaluated in fallback. Flags describe phase-specific observations, not final universal admission. Negative TTC means unevaluated; unscored score=0 must not be interpreted as measured zero. Early safe-route return has zero alternatives. `candidatesObserved` reports full evaluated set size; `candidateTick` is solver input tick and may differ from scene decision tick. No solver rerun.
- `cells`: 289 row-major occupancy bytes for 17x17 at `cellX,cellY,cellStep` (0.5 tiles). Copied existing worker raster, `terrainTick` identifies raster snapshot. Byte255 unknown; bit1 wall,2 ground hazard,4 sink,8 void,16 full-occupy rule. No additional managed/world queries. This is local knowledge, not full-room geometry or exits.
- `projectilesObserved,zonesObserved` and array lengths expose truncation. Scene `flags`:1 projectile source unavailable,2 native source limited,4 terrain unavailable. `calibrationProvenance`, `enemyRuntimeConditions`, and `sourceObservationAgeMs` remain null in recorder wrapper; unsupported fields are not assumed healthy.

## Renderer

`native_present_interarrival` uses the SAME process/UTC anchor envelope plus `qpcFrequency`, cumulative `dropped`, and <=128 `frames` rows `[sequence,enableEpoch,threadId,monotonicMs,qpcTicks]`. Every existing Present-hook entry is recorded while capture is enabled. Compute CPU inter-present intervals from consecutive QPC ticks within the same process/thread/enable epoch, with consecutive sequences and zero lost coverage. First interval per epoch is unknown. This is not GPU execution, display latency, or isolated rendering work; includes previous Present blocking, scheduling, game pacing and frame-cap waiting. Multiple producer threads are retained explicitly; contention drops diagnostics without waiting. Disabled intervals must not be spliced into an FPS series.

## Budgets and limits

10Hz scenes, <=3s pre-event history, 2s post-event tail (overlap extension capped at 5s after window start), at most six ordinary windows per minute. Fixed 31-scene history, 128-scene SPSC queue, 16 ordinary exact decisions plus separate 16 terminal decisions. IPC drains up to four decisions, two scenes, and 128 frame samples per pass. All queues fixed capacity; overflow increments drops instead of waiting. Native memory including queues and scene scratch is statically constrained below4MiB. Renderer queue holds2048 timestamps. Queue high-water counters (`sceneQueueHighWater`, `decisionQueueHighWater`, `terminalQueueHighWater`, `frameQueueHighWater`) expose bounded occupancy. Failed pipe writes increment diagnostic drops, reported if a later connection delivers records. `memoryBytes` reports that conservative fixed allocation, not total process memory or formatter heap. IPC JSON formatting allocates outside movement/render hooks. Recorder writer retains existing bounded-by-flush batching.

This does not yet fulfill Stage2 live/overhead acceptance: private build, real captured encounter reconstruction, off/on renderer/native measurements and loss checks remain required. It cannot prove unobserved alternatives, hidden entities, full-room context, or fresh weapon calibration provenance. No movement improvement claim.

### Proxy and script evidence (private producer extension)

The recorder now emits `capture_boundary` with its Node `process_id` and a
`proxy:<pid>:<connection ordinal>:<map ordinal>` map identity. This is distinct
from the native process and native world-generation identity. Bind them only
with actual matching session evidence; `packet_process_id` selects the Node
producer in prospective comparison bindings.

`capture_span` / `packet_damage` certifies only observed parsed server traffic:
self object identity must be ready, a parsed MAPINFO must have been seen, no
inter-packet gap exceeds 2000 ms, and all packet rows in the span must have been
successfully flushed before the span is queued. Disconnects, map changes,
unknown/unparsed packets, mapper errors and writer errors cut coverage. Timer
time does not extend the last observed packet time. This is not proof that the
network or server produced no additional packets, nor protocol-definition
correctness. Absence of qualifying spans is unknown, not zero damage.

`script_dispatch` witnesses the stable pre/post-import SHA256 of the entry
module immediately before the host dispatches onStart. It does not attest
transitive modules, choose an A/B arm, or assign an attempt. `script_observation`
is an allowlisted bounded copy of known structured script markers, explicitly
labelled as a script report requiring an independent join. Claims of native
branch handling are not copied as truth. Private sink failures cannot prevent
script execution or dashboard logging.

An accepted AutoNexus recovery request now emits `capture_trigger` with source
`auto_nexus_accepted_request`. `delivered` means the capture request reached the
native bridge callback; `acknowledged:false` forbids interpreting that as an
observed native terminal decision. The subsequent native terminal record is
still required.

### AutoNexus scan diagnostic (`native_autonexus_scan`, private, strippable)

Tagged `AUTONEXUS-SCAN-DIAG` in source. Gated on the same `encounter-capture.flag`
(`UDodgeCapture::capture.enabled`); with the flag absent the native AutoNexus scan
does no extra work. When the flag is present and the published threat set's
estimated damage (raw minus defense, floor raw/10, piercing ignores defense; no
conditions) is at least 50% of the HP the DLL reads, the game thread copies one
fixed-size `Scan` into a 32-entry SPSC ring (`AutoNexusScanCapture::channel`);
overflow increments `dropped`. The IPC thread drains up to four per pass.

- `scan`: `ms` (GetTickCount64, same clock as `decision.ms`), `sequence`, `hp`, `maxHp`,
  `defense`, `totalApplied`, `branch` (1 = UDodge committed move, 0 = observed /
  conservative velocity), track origin `x,y` and velocity `vx,vy` (tiles/s),
  `targetValid,targetX,targetY,targetDist` (UDodge solver target this tick; distance
  < 0 = holding), `horizonMs`, `hitPad`, `threatsObserved`, `threatCount`.
- `threats` (<= 16, earliest impact first): `[owner, bullet, raw, applied, flags(1 = piercing),
  bx, by, bvx, bvy (tiles/s), tHitMs, trackClosest, trackClosestMs, holdClosest, holdClosestMs]`.
  Closest approach is Chebyshev centre distance over the horizon (5 ms steps) along
  the projected track and along a stationary hold at the scan position; a hit needs
  distance < hitHalf + 0.2139 + hitPad (0.754 for the usual 0.5 half).
- Envelope adds `scanQueueHighWater`, `channelBytes`, `dropped`.
