#pragma once

#include <cstdint>

// DangerPlanner — replaces AStarDodge at the install boundary.
//
// Hook target: AppEngineManager::Update (same as AStarDodge).
// Each call runs four phases:
//   1. Validator  — if the current step target has become dangerous since the
//                   last plan, downgrade to safe-hold and trigger a rebuild.
//   2. Tick       — on WM_TickId change, hazard-spawn flag, or WASD-release
//                   edge, rebuild the DangerMap, pick a goal cell (external
//                   goal > global safest), run A*, publish waypoints.
//   3. WASD gate  — if the player is holding WASD, skip the frame phase so
//                   the game's native movement drives the character. The
//                   plan is still refreshed in the background so the very
//                   next frame after release already walks to safety.
//   4. Frame      — walk waypoints, consuming the per-frame movement budget
//                   (tilesPerSec × CalcMoveSpeed(player) × dt) via one
//                   FKALGHJIADI::DGLCONCOIBO call.
//
// Settings are mirrored over IpcBridge feature keys (see IpcBridge.cpp).
namespace DangerPlanner {

// Install the AppEngineManager::Update MinHook. No-op if already installed.
void TryInstall();
void Uninstall();

// Authoritative move entry point — routes through the game's native
// FKALGHJIADI::DGLCONCOIBO (speed-clamped, collision-checked, packet-
// emitting). USE THIS for every movement write in the project. Raw
// writes to +0x3C/+0x40/+0x68/+0x6C bypass ACTk's rigidbody sync and
// cause server snap-backs. Returns false if the native function isn't
// resolved yet (shouldn't happen after first dPresent).
bool NativeMoveTo(void* player, float worldX, float worldY);

// Master on/off switch — when false the planner still runs the validator but
// issues zero movement commands. Safer than uninstalling on every toggle.
void SetEnabled(bool enabled);
bool IsEnabled();

// External plugin goal (from IpcBridge walkTarget pipe). When `active` is
// true the planner prefers this goal over enemy-lock / idle selection.
void SetExternalGoal(float worldX, float worldY);
void ClearExternalGoal();
bool HasExternalGoal();
// Returns false when no goal is active.
bool GetExternalGoal(float& outX, float& outY);

// Walk-to-spot goal (Shift+Click on empty ground, TestTAB). A persistent world
// point UDodge pathfinds to while still micro-dodging on the way. Separate from
// the external-goal (IPC walkTarget) channel and the enemy lock — a dedicated
// UDodge-consumed slot so it coexists cleanly with both. Cleared on arrival,
// on WASD steer, or when a new walk/click is issued (see UDodge::Tick).
void SetWalkGoal(float worldX, float worldY);
void ClearWalkGoal();
// Returns false (outActive=false) when no walk goal is set.
bool GetWalkGoal(float& outX, float& outY, bool& outActive);

// Enemy lock — click-to-follow. While locked, the planner parks the player
// at ~followPaddingRatio × weaponRange from the enemy on whatever side is
// safest, so shots still land while keeping distance.
//   objectId = 0 clears the lock. Returns the current locked id.
void    SetEnemyLock(int32_t objectId);
void    ClearEnemyLock();
int32_t GetEnemyLock();
// Lock-follow → A* bridge: resolve the locked enemy each frame and publish
// a stand-off goal so XDodge's A* paths to it. Off ⇒ lock stores the id
// but drives no movement (today's behavior). Default on.
void    SetLockFollowEnabled(bool en);
bool    GetLockFollowEnabled();
// Auto enemy-lock mode (active only when no manual Shift+Click lock is
// set). 0 = Off, 1 = Closest enemy, 2 = Follow auto-aim target. Manual
// lock always wins. Driven by the dashboard `enemyAutoLock` select.
void    SetAutoLockMode(int mode);
int     GetAutoLockMode();

// Player-follow lock — Shift+click on a friendly player to walk
// toward them while still auto-dodging bullets. No weapon-range
// orbit, just "follow this player." Mutually exclusive with enemy
// lock; setting one clears the other.
void    SetFollowPlayer(int32_t objectId);
void    ClearFollowPlayer();
int32_t GetFollowPlayer();
void    SetFollowPaddingRatio(float r);   // 0.3..1.0 of weapon range, default 0.85
float   GetFollowPaddingRatio();
// Fallback weapon range used when AutoAim hasn't sampled a shot yet,
// or when SetUseWeaponRange(false) forces a fixed radius.
void    SetFallbackRangeTiles(float t);
float   GetFallbackRangeTiles();
// Toggle: true (default) derives follow range from the equipped
// weapon (AutoAim::GetProjRangeTiles); false uses FallbackRangeTiles
// directly regardless of gear.
void    SetUseWeaponRange(bool on);
bool    GetUseWeaponRange();
// Auto-lock: when true and no lock is held, the planner automatically
// locks onto the nearest enemy within weapon range at ~4 Hz.
void    SetAutoLockEnabled(bool enabled);
bool    GetAutoLockEnabled();
// Last-resolved follow target (for debug overlay). Returns false if unlocked
// or the locked entity has gone missing. Out params give the enemy's world
// position, the planner's *follow distance* (where the character parks ≈
// weapon range × followPaddingRatio), and the raw weapon range that the
// lock was computed from (what the player can actually hit at).
bool    GetLockTarget(float& outEnemyX, float& outEnemyY,
                      float& outFollowTiles, float& outWeaponRangeTiles);

// Debug accessors for overlay/tab.
// GetPlannedTarget returns the PATH ENDPOINT (first waypoint after
// smoothing — typically many tiles away when LOS is clear through the
// committed path). GetExecTarget returns the TICK-LOCKED walking target
// one server-tick of motion ahead — this is where the frame phase
// actually drives the character each frame. Use GetExecTarget when you
// want to visualize "where is the character going right now".
bool  GetPlannedTarget(float& outX, float& outY);
bool  GetExecTarget(float& outX, float& outY);
int   GetWaypoints(float* outXY, int maxPoints);
float GetLastTickMs();
float GetLastPlanMs();
const char* GetLastFallbackReason();
// True when the last plan had to park in place because no route exists at
// any expansion radius. Debug map uses this to draw a "TRAPPED" indicator
// so the player knows why the character isn't dodging.
bool IsNoPath();
// Tactical commit budget — how many tiles of the current path the frame
// phase actually walks before the next replan. Strategic tail beyond
// this is visible on the debug map as a dim preview.
float GetCommitTiles();
// Which expansion tier succeeded on the last plan (0 = normal, 1-3 = wider
// radius + higher damage budget retries, -1 = all exhausted → parked).
int  GetNoPathExpansionIdx();
// Which code path picked the current goal.
//   0=none  1=external(IPC)  2=lock-follow  3=idle-reactive
//   4=stayput(safe)  5=expansion-tier  6=eat-hits(bullet-wall)  7=hysteresis
int  GetGoalSource();
// World position of the goal the planner committed to (post-clip).
void GetGoalWorld(float& outX, float& outY);

// ── Tunables (also exposed via IpcBridge setFeature keys) ─────────────────
void  SetWasdLookahead(float tiles);     // 2..8, default 4
void  SetTightLeashRadius(float tiles);  // 1..5, default 2.5
void  SetIdleMinGain(float severity);    // default 0.4
void  SetStickiness(float severity);     // default 0.3
void  SetReplanOnHazardSpawn(bool on);   // default true
// 0 = rebuild on server tick only (~200 ms). Positive = force a rebuild
// every N ms in addition to tick/hazard/release triggers. Clamped to 50..1000.
void  SetRebuildIntervalMs(float ms);
// Upper bound on how far a single plan commits. Goal cells farther than
// this are clipped to the boundary — we make short-term decisions and
// re-plan each tick rather than committing to a long path. Default 3 t.
void  SetPathMaxTiles(float tiles);
// Emergency SPEED BOOST (replaces the old raw-write teleport). Fires
// on the same trigger — when every 1-step neighbor is as dangerous as
// the current cell and we're actively being hit — but instead of raw-
// writing the player's position (which caused server snap-backs),
// activates a short window where the frame phase uses a multiplied
// per-step budget. All moves still go through the native move function
// so the server authorizes every step. SetTeleportEnabled toggles the
// whole trigger; Boost tunables control the multiplier / duration.
void  SetTeleportEnabled(bool enabled);
void  SetTeleportMaxTiles(float tiles);   // legacy — used by TP destination search
void  SetTeleportCooldownMs(float ms);
void     SetBoostMultiplier(float mul);   // 1.0-2.5, default 1.3
float    GetBoostMultiplier();
void     SetBoostDurationMs(uint64_t ms); // 50-2000, default 300
uint64_t GetBoostDurationMs();
bool     IsBoostActive();                 // true while boost window is open

float GetWasdLookahead();
float GetTightLeashRadius();
float GetIdleMinGain();
float GetStickiness();
bool  GetReplanOnHazardSpawn();
float GetRebuildIntervalMs();
float GetPathMaxTiles();
bool  GetTeleportEnabled();
float GetTeleportMaxTiles();
float GetTeleportCooldownMs();

// ── BFSDodge-derived timing safety knobs ─────────────────────────────────
// Post-arrival safety window (ms): how long the target cell must stay
// unhit after we land there. Larger = more cautious dodges. When auto-
// tune is ON (default), this is overridden per-plan based on player
// tilesPerSec — faster char = shorter window, slower = longer.
void  SetPostArrivalSafetyMs(float ms);
float GetPostArrivalSafetyMs();
void  SetAutoTuneSafetyMs(bool on);
bool  GetAutoTuneSafetyMs();
// Perpendicular-move bonus weight: encourages sidestepping over radial
// retreat. 0 = disabled, ~0.8 = BFS default. When auto-tune is ON
// (default), this is scaled per-plan based on local areaDensity — dense
// bullet regions get higher perp bias, open regions get lower.
void  SetPerpPenaltyWeight(float w);
float GetPerpPenaltyWeight();
void  SetAutoTunePerpWeight(bool on);
bool  GetAutoTunePerpWeight();
// Greedy path smoothing toggle. OFF by default — keeps A*'s raw cell-
// by-cell route so the strategic path visualization shows exactly which
// cells the planner chose. Enable if you want any-angle movement with
// fewer direction changes at the cost of losing the granular route
// preview. Movement quality is unaffected either way because the exec
// target interpolates along whatever waypoints are published.
void  SetPathSmoothEnabled(bool on);
bool  GetPathSmoothEnabled();
// Weight on per-cell neighborhood-severity ("area density"). Higher =
// planner strongly avoids clustered bullet areas; 0 disables.
void  SetAreaDensityWeight(float w);
float GetAreaDensityWeight();
// Strict tick-lock: when true, exec target only refreshes on server-tick
// boundaries (plus first fire and WASD release). Mid-tick plan changes
// still happen but don't alter what the character walks toward until the
// next tick. Eliminates ghost hits caused by sub-tick direction pivots
// at the cost of up to ~200 ms reaction delay. Off by default (reactive).
void  SetExecStrictTickLock(bool on);
bool  GetExecStrictTickLock();
// Frame reflex: sub-cell imminent-hit sidestep layer beneath A*. Runs
// every frame (60+Hz), reads raw projectile trajectories, and overrides
// the exec target with a perpendicular sidestep when the interpolated
// path would be hit within ~120 ms. Addresses the "new shot lands on my
// current trajectory between replans" gap the grid-based planner can't
// catch. On by default.
void  SetReflexEnabled(bool on);
bool  GetReflexEnabled();

// Strategic bias controls. When the strategic bias is enabled, the
// reflex layer's sidestep picker adds a small reward for directions
// that align with the A* path — so micro-dodges still make progress
// toward the goal. When disabled, reflex is purely threat-local (no
// strategic pull), which is the right choice if the strategic path
// itself is being corner-biased and you don't want the reflex to
// amplify that drift.
void  SetStrategicBiasEnabled(bool on);
bool  GetStrategicBiasEnabled();
// When true, `strategicDir` is sampled from a NEAR waypoint (≈1 tile
// along the path) rather than the FAR end of the path. This matches
// the "closest safest path" semantic — reflex bias follows the
// committed next step instead of a possibly-far-off A* goal.
void  SetStrategicUseNearWaypoint(bool on);
bool  GetStrategicUseNearWaypoint();

// Hit aversion — how strongly the planner avoids paths that clip
// projectiles. 1.0 = historical default. Higher (1.5–3.0) tightens
// the per-plan damage budget and the lock-follow "ring is still
// acceptable" severity gate, so A* refuses routes with stamps and
// the lock drops to idle-reactive on chip damage. Lower (0.5–0.8)
// lets the planner brute through a pattern when staying put or
// detouring would cost more than the hit. Clamped [0.25, 4.0].
void  SetHitAversion(float v);
float GetHitAversion();

// Tightness multiplier on effective bullet half-size for the CCD-based
// modes (Radial / Precision). 1.0 (default) matches Realm's actual
// projectile collision (Chebyshev / AABB, FUN_18015be50). <1 tightens
// dodges (closer brushes through gaps, more aggressive feel); >1
// widens for a safety margin against laggy / mispredicted bullets.
// Has no effect on Hybrid which scores pre-computed DangerMap stamps.
// Clamped [0.5, 2.0].
void  SetDodgeHitScale(float scale);
float GetDodgeHitScale();

// Hybrid mode — when true, the per-frame phase replaces A*-waypoint
// following with a path-biased 8-neighbor greedy step. Goal selection
// and the A* reference path still run every tick; the difference is
// only in HOW the character walks along it. Scoring uses dynamic
// threat severity at t=0/t=1, distance-to-nearest-path-point bias,
// directional continuity, and a hard veto on cells that get hit
// within `hybridMinHitMs`.
void  SetHybridMode(bool on);
bool  GetHybridMode();

// Precision mode — builds on Hybrid but swaps projectile grid reads
// for per-candidate continuous collision detection (CCD) against the
// live projectile list. Grid still feeds walls / damage / AoE / enemy
// layers. Gives exact per-point earliest-hit times instead of
// cell-discretized severity stamps, so the planner can thread gaps
// the grid discretization would have over-stamped. Mutually exclusive
// with Hybrid.
void  SetPrecisionMode(bool on);
bool  GetPrecisionMode();
// CCD sampling cadence (ms). Smaller = more accurate, more compute.
void  SetPrecisionSampleStepMs(float ms);   // 10..120, default 30
float GetPrecisionSampleStepMs();
// CCD sampling horizon (ms). How far ahead to predict bullets.
void  SetPrecisionHorizonMs(float ms);      // 200..2000, default 800
float GetPrecisionHorizonMs();

// Radial mode — continuous radial scan + binary refinement out from the
// player position (no danger-grid neighbour cells), with perpendicular-
// to-shot bias. Triggers only when a bullet would hit at the current
// position within the horizon — otherwise we hand position back to the
// user so WASD drives walking. Mutually exclusive with Hybrid / Precision.
//
// Tunables mirror the old "PrecisionDodge" weights: kParallel = penalty
// for moving along the weighted incoming bullet direction; kIntent =
// discount for moving along the player's pre-dodge WASD or strategic
// heading. Search depth is capped at ~1.5 tiles to keep dodges local.
void  SetRadialMode(bool on);
bool  GetRadialMode();
void  SetRadialHorizonMs(float ms);         // 300..1500, default 600
float GetRadialHorizonMs();
void  SetRadialSampleStepMs(float ms);      // 8..40, default 15
float GetRadialSampleStepMs();
void  SetRadialPerpWeight(float w);         // 0..1.5, default 0.32
float GetRadialPerpWeight();
void  SetRadialIntentWeight(float w);       // 0..0.6, default 0.18
float GetRadialIntentWeight();
void  SetRadialMaxSearchDist(float tiles);  // 0.5..2.5, default 1.5
float GetRadialMaxSearchDist();
void  SetHybridPathWeight(float w);   // 0..3
float GetHybridPathWeight();
void  SetHybridGoalWeight(float w);   // 0..3 — pull toward A* goal cell
float GetHybridGoalWeight();
void  SetHybridDirWeight(float w);    // 0..2
float GetHybridDirWeight();
void  SetHybridMinHitMs(float ms);    // 40..400, default 120
float GetHybridMinHitMs();

// Debug readout of the stat-aware cost multiplier most recently used by
// the planner, plus the HP/MaxHP/Defense it was computed from. Useful for
// the Movement tab to show the user why the planner is more or less
// conservative than the baseline.
void  GetStatCostSnapshot(int32_t& outHp, int32_t& outMaxHp,
                          int32_t& outDef, float& outMultiplier);

} // namespace DangerPlanner
