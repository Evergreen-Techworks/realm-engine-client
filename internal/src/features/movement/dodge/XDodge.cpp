#include "pch-il2cpp.h"
#include "XDodge.h"
#include "features/combat/autoaim/modes/AutoAim.h"
#include "DangerPlanner.h"
#include "ProjectileTracking.h"
#include "DodgeHit.h"
#include "LocalPlayer.h"
#include "RuntimeOffsets.h"
#include "gui/tabs/TestTAB.h"
#include "gui/tabs/WorldTAB.h"
#include "DbgFileLog.h"

#include <imgui/imgui.h>
#include "W2S.h"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>
#include <windows.h>

// ─────────────────────────────────────────────────────────────────────────────
// XDodge — spacetime BFS dodge, ported from XRebuild/XDriver decompile.
//
// ALGORITHM (matches FUN_18015bfc0 + FUN_18015d3d0 intent from XDriver):
//
//   Every kRebuildFrames game ticks (~50ms at 60fps):
//     1. Snapshot live projectiles.
//     2. Build danger grid: for each cell (gx, gy) and time step t,
//        check if any projectile hits the cell at (elapsedMs + t × stepMs).
//        Also mark non-walkable cells as permanently dangerous.
//     3. Run spacetime BFS from player cell outward through (x, y, t).
//        Each step advances one time slice; from a cell you can reach
//        any of the 8-connected neighbors or stay in place at t+1.
//        Skip cells that are dangerous at t.
//        — If external goal active: stop at goal cell, trace path back
//          to t=1 (the "next step" we should take this frame).
//        — If no goal but player is in danger: find nearest escape cell,
//          trace to t=1.
//        — If no goal and player is safe: do nothing.
//     4. Fallback: if BFS finds no path at all, quick-scan t=0 for any
//        safe reachable cell and NativeMoveTo it (game speed-clamps).
//
//   Every game tick (17ms @ 60fps):
//     NativeMoveTo the planned next-step target.
//     Server authorizes speed; no raw writes.
// ─────────────────────────────────────────────────────────────────────────────

namespace XDodge {

// ── Grid dimensions ───────────────────────────────────────────────────────
static constexpr float kCell  = 0.25f;   // tile width per cell
// P1: enlarged shared radius (was 12 / 3 t). 20 cells = 5-tile radius —
// more strategic range for U-detours / distant holes. All grids are
// constexpr-sized off this, so the bump resizes everything safely; the
// extra cost is bounded by the walkability cache + rebuild throttle.
// (True goal-biased independent wide map = the deferred coarse-global tier.)
static constexpr int   kRad   = 20;      // cells from center → 5 tile radius
static constexpr int   kSide  = 41;      // kRad*2+1

// ── Time dimension ────────────────────────────────────────────────────────
static constexpr int   kMaxT  = 12;      // 13 time slices (0..12)

// ── Total spacetime states: 25×25×13 = 8125 ──────────────────────────────

// Danger field: danger[t][gx][gy] = severity 0..255.
//   0                       → safe
//   1 .. kSevBlock-1        → graded "fringe" cost (A* only; BFS/Fallback
//                              treat it as safe — reflex unchanged)
//   >= kSevBlock            → impassable: a wall, or a cell the projectile
//                              AABB physically covers at time t (a hit)
// Jesse's weighted-DangerMap model, max-combined (a stamp only ever RAISES
// a cell). The lethal core is stamped exactly where the old binary grid set
// `=1`, so BFS/FallbackScan/playerInDanger (which test `>= kSevBlock`) see
// a byte-identical blocked set. The fringe is a sparse +kFringeCells
// dilation ring around that core — extra cells only, never fewer — that is
// invisible to BFS and only shapes A* path cost.
static constexpr uint8_t kSevBlock  = 200;  // >= this ⇒ impassable
static constexpr uint8_t kSevLethal = 255;  // wall / projectile-AABB core
static constexpr uint8_t kSevFringe = 90;   // near-miss ring (graded, < block)
static constexpr int     kFringeCells = 1;  // ring thickness in cells
static constexpr uint8_t kSevWallFringe = 150; // wall-adjacent (graded, < block,
                                               // > bullet fringe → keep clearance)

// Wall avoidance: (1) a graded fringe around wall cells so A* keeps
// clearance instead of hugging geometry, and (2) a diagonal corner-clip
// filter in BFS+A* so a diagonal step can't cut between two wall cells
// (the cell-center probe says both endpoints are clear, but the hitbox
// clips the corner). Uses only the cached wall map — no new game read.
// Off ⇒ walls stay a pure hard block (old behavior).
static std::atomic<bool> g_wallAvoidEnabled{ true };

static uint8_t g_danger[kMaxT + 1][kSide][kSide];   // 8 125 bytes

// BFS visited + parent (for path tracing back to t=1)
// prev[t][gx][gy] = {prev_gx, prev_gy} — sentinel {127,127} = unvisited
struct Prev2 { int8_t gx, gy; };
static uint8_t g_visited[kMaxT + 1][kSide][kSide];  // 8 125 bytes
static Prev2   g_prev[kMaxT + 1][kSide][kSide];     // 16 250 bytes

// BFS queue — pre-allocated, never heap
struct STState { uint8_t t, gx, gy; };
static STState g_queue[kSide * kSide * (kMaxT + 1)]; // 8125 × 3 = 24 375 bytes

// World origin of cell (0,0) — updated each rebuild
static float g_originX = 0.f, g_originY = 0.f;

// Last resolved plan
static float g_nextX = 0.f, g_nextY = 0.f;
// Debug path overlay: the full A* route (start→goal) in world coords.
static constexpr int   kMaxPathPts = 128;
static float           g_pathPts[kMaxPathPts * 2];
static int             g_pathLen = 0;
// Debug: BOTH plans captured each rebuild (only when draw enabled) so the
// overlay can show A* (strategy) and BFS (reflex) at the same time.
static float           g_vizApts[kMaxPathPts * 2];
static int             g_vizAlen = 0;
static float           g_vizBfsX = 0.f, g_vizBfsY = 0.f;
static bool            g_vizBfsValid = false;
static std::atomic<bool> g_drawPathEnabled{ false };  // off by default (debug)

// Admin-only: predicted bullet trajectories drawn on screen so we can
// visually verify that ComputePosAt is tracking real bullets correctly.
// Useful for diagnosing slow / speed-changing projectiles where stamp
// aliasing isn't obvious. Sample at finer spacing than the danger-grid
// stamping so any inter-slice drift is visible.
static constexpr int   kMaxVizProjs    = 64;
static constexpr int   kVizProjSamples = 24;   // ~25 ms steps over a 600 ms horizon
static float           g_vizProj[kMaxVizProjs * kVizProjSamples * 2];
static int             g_vizProjLen[kMaxVizProjs] = { 0 };
static int             g_vizProjCount = 0;
static std::atomic<bool> g_drawProjPredEnabled{ false };
static bool  g_havePlan = false;

// Frame counter
static int g_frameCount = 0;

// ── Tunables ──────────────────────────────────────────────────────────────
static bool  g_enabled      = false;
static float g_hitScale     = 1.0f;    // projectile AABB multiplier
static int   g_rebuildN     = 3;       // rebuild every N frames (default 3 ≈ 50ms)
static float g_planStepMs   = 50.0f;   // ms per spacetime time slice
static float g_searchRadius = 3.0f;    // tile radius for BFS (mirrored in kRad)

// Weighted danger field master toggle. When false, BuildGrid stamps ONLY
// the lethal core (no fringe ring) so the grid is bit-for-bit the old
// binary behavior — the guaranteed fallback. Default on.
static std::atomic<bool> g_weightingEnabled{ true };

// Set to true by the HazardSpawnCallback whenever a new enemy projectile
// is recorded. Checked in Tick() to force an immediate grid rebuild even
// if g_rebuildN frames haven't elapsed yet — projectiles can spawn on any
// game frame, not only on the N-frame rebuild cadence.
static std::atomic<bool> g_newProjSinceRebuild{false};

static void OnHazardSpawn(const WorldProjectile& /*proj*/, void* /*user*/)
{
    g_newProjSinceRebuild.store(true, std::memory_order_relaxed);
}

// 8-connectivity + stay-in-place = 9 directions
static constexpr int kNDirs = 9;
static constexpr int8_t kDx[kNDirs] = {-1, 0, 1, -1, 0, 1, -1, 0, 1};
static constexpr int8_t kDy[kNDirs] = {-1,-1,-1,  0, 0, 0,  1, 1, 1};
// Movement cost per direction: diagonal=1.414, cardinal=1.0. (2-D A*
// has no "stay" move; the BFS reflex handles holding position.)
static constexpr float kDirCost[kNDirs] = {
    1.41421356f, 1.0f, 1.41421356f,
    1.0f,        0.0f, 1.0f,
    1.41421356f, 1.0f, 1.41421356f
};

// ── A* goal tier (additive; BFS remains the untouched immediate reflex) ───
// Re-introduced from b0's proven RunAStar skeleton, retargeted onto Jesse's
// weighted severity grid. Runs ONLY when g_astarEnabled && a goal exists &&
// the player is NOT in danger (any danger → snappy BFS escape instead).
// Cost = move + own fringe
// severity + neighborhood density — Jesse's weighting, computed only over
// already-stamped cells. Toggle off ⇒ A* never called ⇒ byte-identical
// to the working BFS-only build.
static constexpr int kTotalStates = kSide * kSide * (kMaxT + 1); // A* buffer sizing

static std::atomic<bool> g_astarEnabled{ true };
// (P2 replaced the old per-cell severity/density/stay weights with the
// arrival-time term `sevAtArrival * g_a2dW` — those constants were dead.)

// ── 2-D strategic map for A* (time-decayed projection of the 3-D grid) ───
// A* paths against THIS, not the spacetime grid: ~13× smaller search,
// stable frame-to-frame (no per-slice churn → no path jitter), cheaper
// (helps the game-thread stall / lateness). Hard-block = walls + cells
// dangerous at t≈0 (impassable NOW). Soft cost = Σ severity[t]/(1+t):
// persistently-hot lanes cost more, but a cell only grazed at a far slice
// stays routable — the untouched 3-D BFS reflex catches that graze if it
// materializes. Rebuilt once per BuildGrid.
static float   g_a2dCost[kSide][kSide];
static uint8_t g_a2dBlocked[kSide][kSide];
static float   g_a2dW = 0.004f;             // weight on g_a2dCost per A* step
// Perpendicular-to-incoming-shot bias (Jesse's perp penalty). Aggregate
// bullet-flow direction near the player (damage/distance-weighted sum of
// projectile travel angles); A* pays extra to move ALONG that axis so it
// prefers lateral sidesteps. Derived from the projectile snapshot only.
static std::atomic<bool> g_perpEnabled{ true };
static float g_aStarPerpW   = 0.6f;
static float g_incX = 0.f, g_incY = 0.f;  // unit aggregate incoming dir
static float g_incMag = 0.f;              // 0..1 directional coherence
// Gating model:
//  • IMMINENT (player cell hit within kImminentT slices ≈ 150 ms) → snappy
//    BFS escape. This owns the fast reaction.
//  • NOT imminent + goal → A* travels toward it (A* over the spacetime
//    grid already routes around the FAR/horizon danger, so it's safe to
//    let it drive while the next ~150 ms at our cell is clear). Without
//    this split, "any danger in the 650 ms horizon → BFS" starved A* —
//    in a bullet-hell the cell is almost always threatened *somewhere*,
//    so A* never ran.
//  • Calm + parked at goal (or no goal) → stand still (no drift/jitter).
static constexpr int   kImminentT         = 3;     // ≈150 ms at 50 ms/slice
static constexpr float kGoalDeadzoneTiles = 0.6f;
// Safe-here stickiness: if the player's own cell a2d cost is ≤ this and
// nothing's imminent, stand still instead of repositioning for marginal
// gain (stops the "shots nearby but I'm fine → backpedal" fidgeting).
static constexpr float kStickSafeCost     = 5.0f;
// BFS escape: a cell only qualifies if it stays non-lethal for this many
// slices AFTER arrival (uses the 3-D future map fully — don't dodge into a
// tile the map shows the bullet sweeps a moment later). BFS explores
// nearest-first, so the first cell passing this = closest sustainably-safe.
static constexpr int   kEscapeHoldSlices  = 4;     // ≈200 ms sustained safety

// ── P3: ORBIT ↔ SURVIVE arbiter (mode-hysteresis) ────────────────────────
// When the place we want to be (ring/external goal) is itself hot and we're
// in danger, abandon it and flee to the safest reachable cell. The survive
// TARGET is re-picked every rebuild (tracks a moving pocket); hysteresis is
// on the MODE only, so it commits to fleeing for a dwell window instead of
// ping-ponging orbit↔flee. Off ⇒ pure orbit/external behavior.
static std::atomic<bool> g_arbiterEnabled{ true };
// P5: BFS strategic bias — visit neighbors in goal-ward order so the
// FIRST safe escape cell found (same BFS depth ⇒ same safety/snappiness)
// tends toward the committed goal. Pure tiebreak; off ⇒ natural order.
static std::atomic<bool> g_bfsBiasEnabled{ true };
// P6: CCD-exact tight reflex commit. After the plan picks g_next, sweep
// the committed step against each bullet's EXACT predicted trajectory
// (ComputePosAt + real Chebyshev hitbox) at a fine step — not the 50 ms
// grid — and if it would clip, refine to the nearest CCD-safe neighbor
// (≤8 candidates). Margin ≈ 0 (only g_ccdPad for command latency).
static std::atomic<bool> g_ccdEnabled{ true };
static float g_ccdPad = 0.03f;                       // tiles, command-latency hair
using DodgeHit::kPlayerHalf;                         // shared hit math (DodgeHit.h)

// Never-stand-on-enemies. Contact damage in RotMG triggers from touching
// any enemy/boss body, so stamping live enemies into the danger grid
// (lethal core + small fringe) makes the planner route around them like
// bullets. kEnemyContactHalf is a conservative fixed half-size; bosses
// are larger so this slightly under-covers them, but combined with the
// 1-cell fringe ring it gives the planner a clear "stay off" signal
// without freezing the grid with huge stamps. Toggle off only for
// testing or weird cases (e.g. friendly Nexus NPCs that AutoAim's
// enemy filter doesn't already exclude).
static std::atomic<bool> g_avoidEnemiesEnabled{ true };
static constexpr float kEnemyContactHalf = 0.5f;
static constexpr float kCcdHorizonMs  = 260.f;       // sweep this far ahead (~1.3 ticks)
static constexpr float kCcdStepMs     = 10.f;        // fine sample (vs 50 ms grid)
enum class Mode { Orbit, Survive };
static Mode     g_mode        = Mode::Orbit;
static uint64_t g_modeSinceMs = 0;
static constexpr float    kSurviveEnterCost = 120.f; // goal-cell a2d cost that means "where I want to be is hot"
static constexpr float    kSurviveExitCost  = 60.f;  // must drop below this to return to orbit (hysteresis band)
static constexpr uint64_t kSurviveDwellMs   = 500;   // min commit to fleeing before orbit can resume
// Enemy-lock = SOFT standoff, not a ring. The goal is the safest reachable
// cell that also keeps roughly weapon range — chosen from the whole local
// map each rebuild. Danger dominates (move wherever the bullets make safe,
// dynamic); the standoff/travel terms are gentle pulls so we don't drift
// out of shooting range or hop needlessly. No radial/tangential constraint.
static constexpr float kStandoffW       = 8.0f;   // cost per tile off weapon range
static constexpr float kStandoffTravelW = 0.4f;   // cost per cell from the player
static constexpr int   kParkCells       = 2;      // best cell within this ⇒ stand still

// Anti-flee + sidestep bias. The plain standoff scoring above doesn't know
// which side of the enemy you're on, so a goal that is "perfectly on the
// ring" can sit *behind* you (= further from the enemy than you are now),
// driving long backward retreats when a small lateral step would have been
// enough. These two terms re-introduce that tactical intent:
//   - kRetreatPenalty (per cell of distance ADDED between player and enemy)
//     directly punishes "running away" — comparable scale to kStandoffW so
//     it can outweigh a small ring-deviation bonus the retreat would buy.
//   - kLateralBonus (per cell perpendicular to the player→enemy vector)
//     gently rewards sideways relocation, so among equally-safe options
//     the sidestep wins. Doesn't dominate; just tie-breaks the right way.
// Both applied to SelectStandoffGoal AND SelectSafestCell (when a lock
// exists), so SURVIVE mode also stops sprinting backwards.
static std::atomic<bool> g_lateralPrefEnabled{ true };
static constexpr float kRetreatPenalty = 10.0f;  // bumped from 6 — still ran
                                                 // away when the danger gradient
                                                 // strongly favoured backward.
static constexpr float kLateralBonus   = 1.5f;

// Goal hysteresis. A* was visibly "flipping directions" — picking one path,
// then the opposite one on the next rebuild, then back — because the danger
// landscape shifts slightly each frame and tiny noise re-selects a different
// optimum among equally-good goals. Give the previously-selected goal a
// small score discount so it has to be MEANINGFULLY beaten before we
// switch. Shared by SelectStandoffGoal and SelectSafestCell (they're
// alternatives — only one runs per rebuild). TTL prevents the memory from
// outliving its relevance (e.g. after a long pause / map change).
static std::atomic<bool>     g_goalStickyEnabled{ true };
static std::atomic<int>      g_lastGoalGX{ -1 };
static std::atomic<int>      g_lastGoalGY{ -1 };
static std::atomic<uint64_t> g_lastGoalMs{ 0 };
// Tuned back to a *modest* bonus after testing showed 20 was too sticky
// (the standoff goal wouldn't update fast enough when the enemy moved).
// Path-level flipping (A* picking different first-step directions from
// the same goal) isn't a goal-selection problem — it's handled below by
// the commit-layer dwell. Goal sticky only needs to absorb tiny noise
// between near-equal goal CELLS.
static constexpr float    kGoalStickyBonus = 10.0f;
static constexpr uint64_t kGoalStickyTtlMs = 1500;

// Commit-layer direction dwell. Goal hysteresis (above) only stops
// flipping when SelectStandoffGoal/SelectSafestCell runs (lock / survive
// modes). It does NOT prevent path-level flipping — A* can pick a
// different first step from the same goal across rebuilds, and pure
// external-goal cases (auto-follow, follow-mouse, BagLooter) bypass goal
// hysteresis entirely. This guard sits at the COMMIT site: once we
// commit a step in a direction, hold that direction for at least
// kCommitDwellMs before accepting a sharp reversal (>90deg turn).
// Imminent danger always overrides — we never block a real dodge.
static std::atomic<bool> g_commitDwellEnabled{ true };
static constexpr uint64_t kCommitDwellMs = 250;
static int      g_lastStepDX = 0;
static int      g_lastStepDY = 0;
static uint64_t g_lastStepMs = 0;
// Line-of-sight to the locked enemy (Jesse's prefer-LOS). A SOFT penalty
// (not a hard exclude) so among safe in-range cells the goal prefers one
// that can actually shoot the enemy — but survival still wins (it won't
// stand in danger just to keep LOS). Uses the cached WALL map only
// (bullets/enemies don't block your shots).
static std::atomic<bool> g_losGoalEnabled{ true };
static constexpr float kLosBlockedW = 40.f;       // penalty if a wall blocks the shot

// Manual-WASD yield: while the player holds a move key, XDodge issues NO
// movement (the player drives) but keeps PLANNING, so it resumes the
// instant the key is released. Reading keys via GetAsyncKeyState is the
// same input pattern the Shift/Ctrl chords already use — it yields TO
// WASD, it does not block it. Default on.
static std::atomic<bool> g_wasdYieldEnabled{ true };
static bool ManualMoveHeld()
{
    if (!g_wasdYieldEnabled.load(std::memory_order_relaxed)) return false;
    auto down = [](int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; };
    return down('W') || down('A') || down('S') || down('D')
        || down(VK_LEFT) || down(VK_RIGHT) || down(VK_UP) || down(VK_DOWN);
}

// ── Speed match (anti rubber-band) ───────────────────────────────────────
// The spacetime grid models motion as one cell (kCell) per time slice. If
// the player's REAL speed differs from that, slice-indexed bullet/cell
// timing doesn't line up with where the character actually ends up and the
// planner thrashes (visible rubber-banding). We observe realized speed from
// the (px,py,dt) the Tick already receives — no game call, the true server-
// granted speed incl. slows/status — and (a) scale the effective slice ms so
// "one cell per slice" is physically accurate, (b) clamp the per-frame
// commanded step to obsSpeed*dt so we never order a move past reach.
// Off ⇒ fixed g_planStepMs + no clamp = current behavior.
static std::atomic<bool> g_speedMatchEnabled{ true };
static float g_obsSpeed   = 5.0f;   // tiles/sec, EMA of realized motion
static bool  g_havePrevPos = false;
static float g_prevPx = 0.f, g_prevPy = 0.f;
static float g_effStepMs  = 50.0f;  // slice ms actually used by BuildGrid

static float   g_gScore[kTotalStates];
static float   g_fScore[kTotalStates];
static float   g_aDist[kTotalStates];   // P2: accumulated path distance (tiles) → arrival time
static uint8_t g_aClosed[kTotalStates];
struct AParent { int8_t gx, gy; uint8_t t; };
static AParent g_aParent[kTotalStates];
static int     g_heap[kTotalStates];
static int     g_heapSize = 0;

enum class PlanTier { None, AStar, BFS, Fallback };
static PlanTier g_planTier = PlanTier::None;

// Smart goal (Jesse's SelectGoalNearTarget): instead of pathing to the raw
// clipped external-goal cell, pick the lowest-weighted-severity cell in a
// small window around it, tie-broken toward the intended goal. Feeds A*
// ONLY — BFS keeps the raw clipped goal so its behavior is unchanged.
// Off ⇒ A* targets the raw clipped cell (the step-2 behavior).
static std::atomic<bool> g_smartGoalEnabled{ true };
static constexpr int kGoalSearch    = 4;   // window half-extent (cells) around raw goal
static constexpr int kGoalHorizonT  = 6;   // severity summed over t=0..this slice

// Per-projectile Chebyshev half-extent (finite + 0.5 fallback) now lives in
// DodgeHit.h so XDodge and RolloutDodge share one hit model. Bring it into
// scope so the existing call sites below are unchanged.
using DodgeHit::ProjChebyshevHalf;

// ── P7/P8: per-(motion-signature) bullet catalog ─────────────────────────
// Jesse's ProjectileCatalog reborn. Bullets with identical motion params
// are the same "type"; key by a hash of those params (no type-id field
// needed). Each entry accumulates the P8 prediction-error EMA + a learned
// safety inflation. Open-addressed fixed table; cleared on realm change.
struct CatEntry {
    uint32_t sig          = 0;
    bool     used         = false;
    float    errEma       = 0.f;   // EMA of |predicted−actual| at +1 slice (tiles)
    uint32_t samples      = 0;
    float    inflate      = 0.f;   // P8 learned extra half-size (kept for layout / now inert)
    // Long-horizon debug probe — parallel to errEma/samples but for
    // g_debugPredLongMs ahead (default 250ms) so we can see how the
    // prediction error compounds. Used only for the admin HUD.
    float    errEmaLong   = 0.f;
    uint32_t samplesLong  = 0;
};
static constexpr int kCatSize = 256;
static CatEntry g_cat[kCatSize];
static std::atomic<bool> g_catEnabled{ true };
// Configurable long-horizon probe in milliseconds. 50ms matches the
// planner slice (existing errEma); 250ms is half the planner's full
// 600ms horizon — typically reveals compounding error in accelerating
// bullets without being so long that short-lived shots expire first.
// Range clamp in the setter; set via xdodgeDebugPredLongMs IPC key.
static std::atomic<float> g_debugPredLongMs{ 250.0f };

static uint32_t ProjSig(const WorldProjectile& b)
{
    auto q = [](float v, float s) {
        return static_cast<uint32_t>(static_cast<int>(std::lround(v * s)));
    };
    uint32_t h = 2166136261u;
    auto mix = [&](uint32_t x) { h = (h ^ x) * 16777619u; };
    mix(q(b.speed, 1.f));
    mix(q(b.lifetime, 0.1f));
    mix(q(b.amplitude, 100.f));
    mix(q(b.frequency, 100.f));
    mix(q(b.magnitude, 100.f));
    mix(static_cast<uint32_t>((b.wavy ? 1 : 0) | (b.parametric ? 2 : 0)
        | (b.boomerang ? 4 : 0) | (b.isAccelerating ? 8 : 0)));
    return h ? h : 1u;
}
static CatEntry* CatGetOrAdd(uint32_t sig)
{
    int i = static_cast<int>(sig % kCatSize);
    for (int n = 0; n < kCatSize; ++n, i = (i + 1) % kCatSize) {
        if (g_cat[i].used && g_cat[i].sig == sig) return &g_cat[i];
        if (!g_cat[i].used) {
            g_cat[i] = CatEntry{};
            g_cat[i].sig = sig; g_cat[i].used = true;
            return &g_cat[i];
        }
    }
    return nullptr;   // table full → no per-type adaptation for this one
}
static void CatClear() { for (auto& e : g_cat) e = CatEntry{}; }

static CatEntry* CatFind(uint32_t sig)
{
    int i = static_cast<int>(sig % kCatSize);
    for (int n = 0; n < kCatSize; ++n, i = (i + 1) % kCatSize) {
        if (g_cat[i].used && g_cat[i].sig == sig) return &g_cat[i];
        if (!g_cat[i].used) return nullptr;
    }
    return nullptr;
}
// Read-only learned safety inflation for this bullet's type (0 if none).
static float CatInflate(const WorldProjectile& /*b*/)
{
    // Disabled — the learned per-bullet inflation made the planner refuse
    // tight gaps after a session of taking hits. The catalog still
    // observes (CatalogObserve below) so the data is available if we ever
    // want to re-enable it under a stricter cap, but downstream danger-
    // stamping no longer pays a per-type margin. The dashboard toggle
    // still controls whether observation runs.
    return 0.f;
}

// ── P8: continuous prediction-error feedback ─────────────────────────────
// Per bullet: last rebuild we stored where our model said it would be
// "about now"; this rebuild compare to the LIVE actual position
// (CopyActiveForDraw re-anchored b.x/b.y to the game object). The residual
// per motion-signature drives an EMA → a learned safety inflation for that
// type. Pre-emptive (no hit needed); hit is a booster (OnPlayerHit).
struct PredSlot { int id = 0; bool used = false; uint64_t whenMs = 0; float px = 0.f, py = 0.f; };
static constexpr int kPredSize = 512;
static PredSlot g_pred[kPredSize];
// Parallel long-horizon predictions (for the admin debug HUD). Same
// open-addressed layout, separate array so the existing 50ms probe is
// untouched.
static PredSlot g_predLong[kPredSize];
static constexpr float    kErrThresh = 0.40f;  // tiles before we distrust the model
static constexpr float    kErrSane   = 6.0f;   // residual above this = bad live read, ignore
static constexpr float    kInflGain  = 0.8f;
static constexpr float    kInflMax   = 0.6f;   // max learned extra half (tiles)
static constexpr uint64_t kPredTol   = 45;     // ms window to match a stored prediction

static PredSlot* PredSlotFor(int id)
{
    int i = (id & 0x7fffffff) % kPredSize;
    for (int n = 0; n < kPredSize; ++n, i = (i + 1) % kPredSize) {
        if (g_pred[i].used && g_pred[i].id == id) return &g_pred[i];
        if (!g_pred[i].used) { g_pred[i] = PredSlot{}; g_pred[i].id = id; g_pred[i].used = true; return &g_pred[i]; }
    }
    return nullptr;
}

// Parallel slot accessor for the long-horizon debug probe. Same open-
// addressed scheme over g_predLong[], so identical id collision rules.
static PredSlot* PredSlotForLong(int id)
{
    int i = (id & 0x7fffffff) % kPredSize;
    for (int n = 0; n < kPredSize; ++n, i = (i + 1) % kPredSize) {
        if (g_predLong[i].used && g_predLong[i].id == id) return &g_predLong[i];
        if (!g_predLong[i].used) {
            g_predLong[i] = PredSlot{}; g_predLong[i].id = id; g_predLong[i].used = true;
            return &g_predLong[i];
        }
    }
    return nullptr;
}

static void CatalogObserve(const std::vector<WorldProjectile>& projs)
{
    // Observation also runs when the admin projectile-prediction overlay is
    // on, so the HUD stats stay live even with the catalog toggle off.
    if (!g_catEnabled.load(std::memory_order_relaxed)
        && !g_drawProjPredEnabled.load(std::memory_order_relaxed)) return;
    const uint64_t nowMs = GetTickCount64();
    for (const auto& b : projs) {
        if (!b.valid) continue;
        PredSlot* s = PredSlotFor(b.bulletId);
        if (!s) continue;
        // Compare a matured prediction to the live actual position.
        if (s->whenMs != 0 && (nowMs > s->whenMs ? nowMs - s->whenMs : s->whenMs - nowMs) <= kPredTol) {
            const float ex = std::fabs(b.x - s->px);
            const float ey = std::fabs(b.y - s->py);
            const float err = std::sqrt(ex * ex + ey * ey);
            if (std::isfinite(err) && err < kErrSane) {
                CatEntry* e = CatGetOrAdd(ProjSig(b));
                if (e) {
                    e->errEma += 0.25f * (err - e->errEma);
                    if (e->samples < 0xffffffu) ++e->samples;
                    e->inflate = (e->errEma > kErrThresh)
                        ? std::clamp((e->errEma - kErrThresh) * kInflGain, 0.f, kInflMax)
                        : 0.f;
                }
            }
        }
        // Store a fresh prediction for ~one slice ahead.
        const float elapsed = static_cast<float>(nowMs > b.spawnTick ? nowMs - b.spawnTick : 0u);
        float fx = b.x, fy = b.y;
        ProjectileTracking::ComputePosAtSafe(b, elapsed + g_planStepMs, fx, fy);
        if (std::isfinite(fx) && std::isfinite(fy)) {
            s->px = fx; s->py = fy;
            s->whenMs = nowMs + static_cast<uint64_t>(g_planStepMs);
        }

        // ── Long-horizon probe (admin debug HUD) ─────────────────────
        // Same compare/store flow but at g_debugPredLongMs ahead. The
        // tolerance window scales with the horizon (10% with a 30ms
        // floor) so observations match cleanly even when rebuild cadence
        // varies — at 250ms ahead a 25ms window still catches every
        // observation.
        PredSlot* sL = PredSlotForLong(b.bulletId);
        if (!sL) continue;
        const float longMs = g_debugPredLongMs.load(std::memory_order_relaxed);
        const uint64_t longTolMs = std::max<uint64_t>(30,
                                       static_cast<uint64_t>(longMs * 0.1f));
        if (sL->whenMs != 0
            && (nowMs > sL->whenMs ? nowMs - sL->whenMs : sL->whenMs - nowMs) <= longTolMs) {
            const float exL = std::fabs(b.x - sL->px);
            const float eyL = std::fabs(b.y - sL->py);
            const float errL = std::sqrt(exL * exL + eyL * eyL);
            if (std::isfinite(errL) && errL < kErrSane) {
                CatEntry* e = CatGetOrAdd(ProjSig(b));
                if (e) {
                    e->errEmaLong += 0.25f * (errL - e->errEmaLong);
                    if (e->samplesLong < 0xffffffu) ++e->samplesLong;
                }
            }
        }
        float lx = b.x, ly = b.y;
        ProjectileTracking::ComputePosAtSafe(b, elapsed + longMs, lx, ly);
        if (std::isfinite(lx) && std::isfinite(ly)) {
            sL->px = lx; sL->py = ly;
            sL->whenMs = nowMs + static_cast<uint64_t>(longMs);
        }
    }
}

// P8 hit booster: a taken hit proves a model was wrong — bump inflation on
// every type we've sampled so the next encounter is safer immediately.
void OnPlayerHit()
{
    for (auto& e : g_cat)
        if (e.used && e.samples > 0)
            e.inflate = std::clamp(e.inflate + 0.15f, 0.f, kInflMax);
}

// Admin debug: sample each live bullet's predicted future positions over
// the planner's horizon, finer than the danger-grid stamping step. The
// renderer draws the captured polylines so the user can compare what
// ComputePosAt thinks vs. where bullets actually go in-game. No effect
// on movement; pure visualisation.
static void CaptureProjPredictionViz(const std::vector<WorldProjectile>& projs,
                                     uint64_t nowMs)
{
    g_vizProjCount = 0;
    if (!g_drawProjPredEnabled.load(std::memory_order_relaxed)) return;
    const float horizonMs = static_cast<float>(kMaxT) * g_effStepMs;
    const float stepMs    = (kVizProjSamples > 1)
                              ? horizonMs / static_cast<float>(kVizProjSamples - 1)
                              : horizonMs;
    for (const auto& b : projs) {
        if (!b.valid) continue;
        if (g_vizProjCount >= kMaxVizProjs) break;
        const float elapsed = static_cast<float>(
            nowMs > b.spawnTick ? nowMs - b.spawnTick : 0u);
        int n = 0;
        for (int i = 0; i < kVizProjSamples; ++i) {
            const float tMs = elapsed + static_cast<float>(i) * stepMs;
            if (b.lifetime > 0.f && tMs >= b.lifetime) break;
            // Initialize to live pos so ComputePosAtSafe's fallback is the current
            // position, not uninitialized stack memory (which would be world-origin
            // and project toward the top-left of the screen).
            float bx = b.x, by = b.y;
            if (i > 0) {
                ProjectileTracking::ComputePosAtSafe(b, tMs, bx, by);
                if (!std::isfinite(bx) || !std::isfinite(by)) break;
            }
            const int slot = g_vizProjCount * kVizProjSamples + n;
            g_vizProj[slot * 2 + 0] = bx;
            g_vizProj[slot * 2 + 1] = by;
            ++n;
        }
        g_vizProjLen[g_vizProjCount] = n;
        ++g_vizProjCount;
    }
}

// ── Walkability cache (perf: walls don't move) ───────────────────────────
// IsWalkPositionBlocked is an IL2CPP call; the inline pass did 625 of them
// EVERY rebuild — and rebuild is forced on every projectile spawn, so in a
// bullet-hell that was ~625 IL2CPP calls/frame on the game-update thread,
// delaying the game's own damage/NEWTICK processing (→ AutoNexus reacting
// late → deaths). Walls are static, so cache the layer and recompute only
// when the player's grid cell changes (the grid recenters on the player)
// or a slow safety timer elapses — NEVER because a projectile spawned.
// The projectile danger stamp is untouched ⇒ dodge reactivity to bullets
// is identical; this is cost-only. Off ⇒ recompute every call (old path).
static std::atomic<bool> g_walkCacheEnabled{ true };
static uint8_t  g_walkBlocked[kSide][kSide];
static bool     g_walkValid = false;
static bool     g_walkAny   = false;   // any wall in the grid? (skip LOS if none)
static int      g_walkCellX = 0, g_walkCellY = 0;
static uint64_t g_walkMs    = 0;
static constexpr uint64_t kWalkRefreshMs = 500;  // safety re-probe (doors/destructibles)

static void RefreshWalkabilityCache(float px, float py)
{
    const int cellX = static_cast<int>(std::floor(px / kCell));
    const int cellY = static_cast<int>(std::floor(py / kCell));
    const uint64_t now = GetTickCount64();
    const bool recompute =
        !g_walkCacheEnabled.load(std::memory_order_relaxed)   // disabled ⇒ old behavior
        || !g_walkValid
        || cellX != g_walkCellX || cellY != g_walkCellY        // grid recentered ≥1 cell
        || (now - g_walkMs) >= kWalkRefreshMs;                  // slow safety re-probe
    if (!recompute) return;

    // Probe at cell CENTER (matches the old pass exactly).
    bool any = false;
    for (int gx = 0; gx < kSide; ++gx)
        for (int gy = 0; gy < kSide; ++gy) {
            const float wx = g_originX + (gx + 0.5f) * kCell;
            const float wy = g_originY + (gy + 0.5f) * kCell;
            const uint8_t b = TestTAB::IsWalkPositionBlocked(wx, wy) ? 1 : 0;
            g_walkBlocked[gx][gy] = b;
            any |= (b != 0);
        }
    g_walkAny   = any;
    g_walkValid = true;
    g_walkCellX = cellX; g_walkCellY = cellY; g_walkMs = now;
}

// ─────────────────────────────────────────────────────────────────────────────
// BuildGrid
// Clears and rebuilds the spacetime danger array for the current frame.
// ─────────────────────────────────────────────────────────────────────────────
static void BuildGrid(const std::vector<WorldProjectile>& projs, float px, float py)
{
    g_originX = px - kRad * kCell;
    g_originY = py - kRad * kCell;
    std::memset(g_danger, 0, sizeof(g_danger));

    // ── Walkability (time-independent, cached) ────────────────────────────
    // IsWalkPositionBlocked already expands for the player's 0.2285-tile
    // half-hitbox (XDriver FUN_180030ab0). Recomputed only on grid-recenter
    // / slow timer (see RefreshWalkabilityCache) — not per projectile spawn.
    RefreshWalkabilityCache(px, py);
    for (int gx = 0; gx < kSide; ++gx) {
        for (int gy = 0; gy < kSide; ++gy) {
            if (g_walkBlocked[gx][gy]) {
                for (int t = 0; t <= kMaxT; ++t)
                    g_danger[t][gx][gy] = kSevLethal;
            }
        }
    }

    // ── Wall fringe (Jesse's wall inflation) ──────────────────────────────
    // Cells adjacent to a wall get a graded sub-block cost so A*'s weighted
    // cost (which already reads cell severity) routes WITH clearance instead
    // of hugging geometry. Still passable, so tight corridors stay usable.
    // Sparse: only the neighbors of known wall cells; timeless (all t). The
    // cached wall map is the source so bullet cells never become "walls".
    if (g_wallAvoidEnabled.load(std::memory_order_relaxed)) {
        for (int gx = 0; gx < kSide; ++gx)
            for (int gy = 0; gy < kSide; ++gy) {
                if (!g_walkBlocked[gx][gy]) continue;
                for (int d = 0; d < kNDirs; ++d) {
                    const int nx = gx + kDx[d], ny = gy + kDy[d];
                    if (nx < 0 || nx >= kSide || ny < 0 || ny >= kSide) continue;
                    if (g_walkBlocked[nx][ny]) continue;        // wall itself
                    for (int t = 0; t <= kMaxT; ++t)
                        if (g_danger[t][nx][ny] < kSevWallFringe)
                            g_danger[t][nx][ny] = kSevWallFringe;
                }
            }
    }

    // ── Projectile danger per time step ───────────────────────────────────
    const uint64_t nowMs = GetTickCount64();
    for (const auto& b : projs) {
        if (!b.valid) continue;

        // Effective Chebyshev half-size (runtime field → spawn → 0.5 default)
        const float baseH = ProjChebyshevHalf(b);
        const float eff = baseH * g_hitScale + CatInflate(b);   // P8 learned inflation
        if (eff <= 0.f) continue;

        const float elapsed = static_cast<float>(
            nowMs > b.spawnTick ? nowMs - b.spawnTick : 0u);

        for (int t = 0; t <= kMaxT; ++t) {
            const float tMs = elapsed + t * g_effStepMs;
            if (b.lifetime > 0.f && tMs >= b.lifetime) break; // projectile expired

            float bx = b.x, by = b.y;
            if (t > 0) {
                ProjectileTracking::ComputePosAtSafe(b, tMs, bx, by);
                if (!std::isfinite(bx) || !std::isfinite(by)) break;
            }

            // Rasterise AABB onto grid (inclusive on both ends). These are
            // the cells the projectile physically covers at time t — the
            // lethal CORE, stamped exactly where the old binary grid set
            // `=1`. Unclamped extents first so the fringe ring can extend
            // one cell past the core even when the core touches the edge.
            const int c0x = static_cast<int>(std::floor((bx - eff - g_originX) / kCell));
            const int c1x = static_cast<int>(std::ceil ((bx + eff - g_originX) / kCell));
            const int c0y = static_cast<int>(std::floor((by - eff - g_originY) / kCell));
            const int c1y = static_cast<int>(std::ceil ((by + eff - g_originY) / kCell));

            const int g0x = std::max(0, c0x), g1x = std::min(kSide - 1, c1x);
            const int g0y = std::max(0, c0y), g1y = std::min(kSide - 1, c1y);

            // Core: max-combine to lethal (only ever raises a cell).
            for (int gx = g0x; gx <= g1x; ++gx)
                for (int gy = g0y; gy <= g1y; ++gy)
                    if (g_danger[t][gx][gy] < kSevLethal)
                        g_danger[t][gx][gy] = kSevLethal;

            // Fringe: sparse +kFringeCells dilation ring around the core,
            // graded (< kSevBlock). BFS never sees it (reflex unchanged);
            // it only widens A* away from near-misses. Bounded by the AABB
            // size — no full-grid pass — so the perf profile is preserved.
            if (g_weightingEnabled.load(std::memory_order_relaxed)) {
                const int f0x = std::max(0,         c0x - kFringeCells);
                const int f1x = std::min(kSide - 1, c1x + kFringeCells);
                const int f0y = std::max(0,         c0y - kFringeCells);
                const int f1y = std::min(kSide - 1, c1y + kFringeCells);
                for (int gx = f0x; gx <= f1x; ++gx)
                    for (int gy = f0y; gy <= f1y; ++gy) {
                        const bool inCore = (gx >= g0x && gx <= g1x &&
                                             gy >= g0y && gy <= g1y);
                        if (inCore) continue;
                        if (g_danger[t][gx][gy] < kSevFringe)
                            g_danger[t][gx][gy] = kSevFringe;
                    }
            }
        }
    }

    // ── Enemy/boss body danger ────────────────────────────────────────────
    // Contact damage means we should never stand on enemies. Stamp each
    // live enemy's AABB as lethal at all time slices, plus a 1-cell
    // fringe ring so A* prefers clearance instead of grazing. AutoAim's
    // EnumerateLiveEnemies already filters out NPCs / walls / non-
    // attackable types (kIgnoredEnemyObjectTypes) — same scan as the
    // auto-aim picker. No game read added; just walking the existing
    // enemy list. Non-capturing lambda so it converts to the C callback.
    if (g_avoidEnemiesEnabled.load(std::memory_order_relaxed)) {
        AutoAim::EnumerateLiveEnemies(
            [](float ex, float ey, int32_t /*eid*/, void* /*u*/) {
                const float coreHalf = kEnemyContactHalf + kPlayerHalf;
                const int c0x = static_cast<int>(std::floor((ex - coreHalf - g_originX) / kCell));
                const int c1x = static_cast<int>(std::ceil ((ex + coreHalf - g_originX) / kCell));
                const int c0y = static_cast<int>(std::floor((ey - coreHalf - g_originY) / kCell));
                const int c1y = static_cast<int>(std::ceil ((ey + coreHalf - g_originY) / kCell));
                const int g0x = std::max(0, c0x), g1x = std::min(kSide - 1, c1x);
                const int g0y = std::max(0, c0y), g1y = std::min(kSide - 1, c1y);
                if (g0x > g1x || g0y > g1y) return;
                // Core: lethal at all time slices. Enemies move much slower
                // than bullets across the planner horizon, so stamping at
                // current position for all t is a sound approximation.
                for (int gx = g0x; gx <= g1x; ++gx)
                    for (int gy = g0y; gy <= g1y; ++gy)
                        for (int t = 0; t <= kMaxT; ++t)
                            if (g_danger[t][gx][gy] < kSevLethal)
                                g_danger[t][gx][gy] = kSevLethal;
                // 1-cell fringe ring for clearance.
                const int f0x = std::max(0, c0x - 1), f1x = std::min(kSide - 1, c1x + 1);
                const int f0y = std::max(0, c0y - 1), f1y = std::min(kSide - 1, c1y + 1);
                for (int gx = f0x; gx <= f1x; ++gx)
                    for (int gy = f0y; gy <= f1y; ++gy) {
                        if (gx >= g0x && gx <= g1x && gy >= g0y && gy <= g1y) continue;
                        for (int t = 0; t <= kMaxT; ++t)
                            if (g_danger[t][gx][gy] < kSevFringe)
                                g_danger[t][gx][gy] = kSevFringe;
                    }
            }, nullptr);
    }

    // ── Aggregate incoming-shot direction (Jesse's perp accumulator) ──────
    // Damage/distance-weighted sum of projectile travel angles → dominant
    // bullet-flow axis near the player. g_incMag is the coherence (vector
    // sum length / total weight): low when shots come from all sides, so
    // the perp bias self-disables in crossfire. Snapshot-only; no game read.
    double sx = 0.0, sy = 0.0, sw = 0.0;
    for (const auto& b : projs) {
        if (!b.valid) continue;
        const float ddx = b.x - px, ddy = b.y - py;
        const float dist = std::sqrt(ddx * ddx + ddy * ddy);
        const float w = static_cast<float>(b.damage > 0 ? b.damage : 1)
                        / std::max(dist, 0.5f);
        sx += std::cos(b.angle) * w;
        sy += std::sin(b.angle) * w;
        sw += w;
    }
    const double mag = std::sqrt(sx * sx + sy * sy);
    if (mag > 1e-4 && sw > 1e-4) {
        g_incX   = static_cast<float>(sx / mag);
        g_incY   = static_cast<float>(sy / mag);
        g_incMag = std::clamp(static_cast<float>(mag / sw), 0.f, 1.f);
    } else {
        g_incX = g_incY = g_incMag = 0.f;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// BuildA2D — collapse the 3-D danger grid into the 2-D strategic map A*
// paths against. Called once per rebuild, right after BuildGrid.
// ─────────────────────────────────────────────────────────────────────────────
static void BuildA2D()
{
    for (int gx = 0; gx < kSide; ++gx)
        for (int gy = 0; gy < kSide; ++gy) {
            if (g_danger[0][gx][gy] >= kSevBlock) {   // wall / occupied NOW
                g_a2dBlocked[gx][gy] = 1;
                g_a2dCost[gx][gy]    = 0.f;
                continue;
            }
            g_a2dBlocked[gx][gy] = 0;
            float c = 0.f;
            for (int t = 0; t <= kMaxT; ++t)
                c += static_cast<float>(g_danger[t][gx][gy]) / static_cast<float>(1 + t);
            g_a2dCost[gx][gy] = c;
        }
}

// ── A* min-heap on g_fScore ──────────────────────────────────────────────
static void HeapPush(int idx)
{
    int i = g_heapSize++;
    g_heap[i] = idx;
    while (i > 0) {
        const int parent = (i - 1) >> 1;
        if (g_fScore[g_heap[parent]] <= g_fScore[g_heap[i]]) break;
        std::swap(g_heap[parent], g_heap[i]);
        i = parent;
    }
}
static int HeapPop()
{
    const int top = g_heap[0];
    g_heap[0] = g_heap[--g_heapSize];
    int i = 0;
    for (;;) {
        int best = i;
        const int l = 2 * i + 1, r = 2 * i + 2;
        if (l < g_heapSize && g_fScore[g_heap[l]] < g_fScore[g_heap[best]]) best = l;
        if (r < g_heapSize && g_fScore[g_heap[r]] < g_fScore[g_heap[best]]) best = r;
        if (best == i) break;
        std::swap(g_heap[i], g_heap[best]);
        i = best;
    }
    return top;
}

// ─────────────────────────────────────────────────────────────────────────────
// RunAStar — weighted A* on the spacetime grid to (goalGX,goalGY).
// Impassable = severity >= kSevBlock (walls / projectile core) — identical
// to the BFS block test. Step cost = move + stay + own fringe severity +
// neighbor-severity (Jesse's weighted cost). On success sets g_nextX/g_nextY
// to the t=1 step and feeds the SAME single-step NativeMoveTo executor —
// the game-write path is unchanged. Returns false ⇒ caller falls to BFS.
// ─────────────────────────────────────────────────────────────────────────────
// Plain 2-D weighted A* over g_a2dCost / g_a2dBlocked (the time-decayed
// projection). 625 states instead of 8 125 — far cheaper and stable. The
// 3-D BFS reflex still owns time-accurate dodging; this just picks the
// strategic lane to the goal. Sets g_nextX/g_nextY to the first step.
static bool RunAStar(int pGX, int pGY, int goalGX, int goalGY)
{
    const int N = kSide * kSide;
    auto IX = [](int gx, int gy) { return gy * kSide + gx; };

    std::memset(g_aClosed, 0, static_cast<size_t>(N));
    for (int i = 0; i < N; ++i) { g_gScore[i] = 1e9f; g_aDist[i] = 1e9f; }
    g_heapSize = 0;
    const float spd = std::max(g_obsSpeed, 0.5f);   // measured tiles/sec

    const int startIdx = IX(pGX, pGY);
    g_gScore[startIdx] = 0.f;
    g_aDist[startIdx]  = 0.f;
    g_fScore[startIdx] = static_cast<float>(std::max(std::abs(pGX - goalGX), std::abs(pGY - goalGY)));
    g_aParent[startIdx] = { static_cast<int8_t>(pGX), static_cast<int8_t>(pGY), 0 };
    HeapPush(startIdx);

    while (g_heapSize > 0) {
        const int curIdx = HeapPop();
        if (g_aClosed[curIdx]) continue;
        g_aClosed[curIdx] = 1;

        const int curGX = curIdx % kSide;
        const int curGY = curIdx / kSide;

        if (std::abs(curGX - goalGX) <= 1 && std::abs(curGY - goalGY) <= 1) {
            // Collect the full route (goal→start), reverse into the debug
            // polyline; the step to issue is the cell right after start.
            int tmpX[kMaxPathPts], tmpY[kMaxPathPts];
            int n = 0;
            int tx = curGX, ty = curGY;
            tmpX[n] = tx; tmpY[n] = ty; ++n;
            while (!(tx == pGX && ty == pGY) && n < kMaxPathPts) {
                const AParent& p = g_aParent[IX(tx, ty)];
                if (p.gx == tx && p.gy == ty) break;     // self-parent safety
                tx = p.gx; ty = p.gy;
                tmpX[n] = tx; tmpY[n] = ty; ++n;
            }
            g_pathLen = 0;
            for (int i = n - 1; i >= 0 && g_pathLen < kMaxPathPts; --i) {
                g_pathPts[g_pathLen * 2 + 0] = g_originX + tmpX[i] * kCell;
                g_pathPts[g_pathLen * 2 + 1] = g_originY + tmpY[i] * kCell;
                ++g_pathLen;
            }
            const int stepI = (g_pathLen > 1) ? 1 : 0;
            g_nextX    = g_pathPts[stepI * 2 + 0];
            g_nextY    = g_pathPts[stepI * 2 + 1];
            g_havePlan = true;
            g_planTier = PlanTier::AStar;
            return true;
        }

        for (int d = 0; d < kNDirs; ++d) {
            if (kDx[d] == 0 && kDy[d] == 0) continue;        // no "stay" in 2-D path
            const int ngx = curGX + kDx[d];
            const int ngy = curGY + kDy[d];
            if (ngx < 0 || ngx >= kSide || ngy < 0 || ngy >= kSide) continue;
            if (g_a2dBlocked[ngx][ngy]) continue;            // wall / occupied now
            // Diagonal corner-clip (wall map only — bullet-threading is the
            // 3-D BFS reflex's job, not the strategic 2-D path's).
            if (kDx[d] != 0 && kDy[d] != 0
                && g_wallAvoidEnabled.load(std::memory_order_relaxed)
                && (g_walkBlocked[ngx][curGY] || g_walkBlocked[curGX][ngy]))
                continue;

            const int nIdx = IX(ngx, ngy);
            if (g_aClosed[nIdx]) continue;

            // P2 arrival-time: when would we actually be standing here?
            // Sample the 3-D danger grid at THAT slice, not a static
            // collapse — the route is timed against the future bullets.
            const float stepTiles = kDirCost[d] * kCell;
            const float distHere  = g_aDist[curIdx] + stepTiles;
            int slice = static_cast<int>(distHere / spd * 1000.f / g_planStepMs + 0.5f);
            if (slice < 0)      slice = 0;
            if (slice > kMaxT)  slice = kMaxT;
            const uint8_t sevAtArrival = g_danger[slice][ngx][ngy];
            if (sevAtArrival >= kSevBlock) continue;   // lethal WHEN we'd be there

            float moveCost = kDirCost[d];
            moveCost += sevAtArrival * g_a2dW;          // danger at arrival time
            if (g_perpEnabled.load(std::memory_order_relaxed) && g_incMag > 0.f) {
                const float inv = 1.0f / kDirCost[d];
                const float along = std::fabs((kDx[d] * g_incX + kDy[d] * g_incY) * inv);
                moveCost += g_aStarPerpW * along * g_incMag;
            }

            const float tentG = g_gScore[curIdx] + moveCost;
            if (tentG < g_gScore[nIdx]) {
                g_gScore[nIdx] = tentG;
                g_aDist[nIdx]  = distHere;
                const float h = static_cast<float>(std::max(std::abs(ngx - goalGX), std::abs(ngy - goalGY)));
                g_fScore[nIdx] = tentG + h;
                g_aParent[nIdx] = { static_cast<int8_t>(curGX), static_cast<int8_t>(curGY), 0 };
                HeapPush(nIdx);
            }
        }
    }
    return false; // no path — caller falls back to BFS
}

// True if cell (gx,gy) stays non-lethal from arrival slice `nt` through
// the hold window — i.e. the 3-D map shows no bullet sweeps it just after
// we'd get there. This is what makes BFS not dodge into a doomed tile.
static bool CellHoldsSafe(int gx, int gy, int nt)
{
    const int last = std::min(kMaxT, nt + kEscapeHoldSlices);
    for (int k = nt; k <= last; ++k)
        if (g_danger[k][gx][gy] >= kSevBlock) return false;
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// RunBFS
// Spacetime BFS from (pGX, pGY, t=0).
// If hasGoal: find path to (goalGX, goalGY), extract t=1 step.
// If !hasGoal: find any safe cell reachable at t>=1, extract t=1 step.
// Sets g_nextX/g_nextY and g_havePlan on success.
// ─────────────────────────────────────────────────────────────────────────────
static bool RunBFS(int pGX, int pGY, int goalGX, int goalGY, bool hasGoal)
{
    std::memset(g_visited, 0, sizeof(g_visited));

    int qHead = 0, qTail = 0;

    // Neighbor visiting order (tiebreak — same safety, same BFS depth).
    // Threat-aware: when a coherent shot is incoming (g_incMag high) the
    // escape prefers directions PERPENDICULAR to the bullet axis — a
    // lateral sidestep, NOT a backpedal along the threat. When there's no
    // clear incoming threat it falls back to goal-ward (P5). Blended by
    // g_incMag so it auto-selects the right behavior per situation.
    int dord[kNDirs];
    for (int i = 0; i < kNDirs; ++i) dord[i] = i;
    if (g_bfsBiasEnabled.load(std::memory_order_relaxed)) {
        const float gdx = static_cast<float>(goalGX - pGX);
        const float gdy = static_cast<float>(goalGY - pGY);
        const float glen = std::sqrt(gdx * gdx + gdy * gdy);
        const float gnx = glen > 1e-3f ? gdx / glen : 0.f;
        const float gny = glen > 1e-3f ? gdy / glen : 0.f;
        const float incM = g_incMag;                // 0..1 threat coherence
        float key[kNDirs];
        for (int d = 0; d < kNDirs; ++d) {
            if (kDx[d] == 0 && kDy[d] == 0) { key[d] = -1e9f; continue; } // never "stay" to escape
            const float dl  = (kDx[d] && kDy[d]) ? 1.41421356f : 1.0f;
            const float ndx = kDx[d] / dl, ndy = kDy[d] / dl;
            const float perpInc = 1.0f - std::fabs(ndx * g_incX + ndy * g_incY); // 1=lateral
            const float alongGoal = ndx * gnx + ndy * gny;                       // [-1,1]
            key[d] = perpInc * incM            // sidestep the incoming shot
                   + alongGoal * (1.0f - incM); // else head toward goal
        }
        for (int a = 1; a < kNDirs; ++a) {          // insertion sort, desc
            const int v = dord[a]; const float kv = key[v];
            int b = a - 1;
            while (b >= 0 && key[dord[b]] < kv) { dord[b + 1] = dord[b]; --b; }
            dord[b + 1] = v;
        }
    }

    // STAY is a valid escape: in pure-escape mode (no goal), if the
    // player's own cell stays safe through the hold window, the right
    // answer is DON'T MOVE — not "first neighbor in dord order" (which,
    // with no incoming threat, is the raw (-1,-1) up-left cell: the
    // "orange line always points top-left when standing still" bug).
    if (!hasGoal && CellHoldsSafe(pGX, pGY, 0)) {
        g_nextX = g_originX + pGX * kCell;
        g_nextY = g_originY + pGY * kCell;
        g_havePlan = true;
        return true;
    }

    // Seed: player at t=0 (even if player IS in danger — we still BFS outward)
    g_visited[0][pGX][pGY] = 1;
    g_prev[0][pGX][pGY]    = {static_cast<int8_t>(pGX), static_cast<int8_t>(pGY)};
    g_queue[qTail++]        = {0, static_cast<uint8_t>(pGX), static_cast<uint8_t>(pGY)};

    while (qHead < qTail) {
        const STState s = g_queue[qHead++];
        if (s.t >= kMaxT) continue; // horizon reached

        const int nt = s.t + 1;

        for (int oi = 0; oi < kNDirs; ++oi) {
            const int d = dord[oi];
            const int ngx = static_cast<int>(s.gx) + kDx[d];
            const int ngy = static_cast<int>(s.gy) + kDy[d];

            if (ngx < 0 || ngx >= kSide || ngy < 0 || ngy >= kSide) continue;
            if (g_danger[nt][ngx][ngy] >= kSevBlock) continue; // wall / bullet core
            // Diagonal corner-clip filter (wall map only — bullet-threading
            // diagonals stay allowed so the reflex can still slip gaps).
            if (kDx[d] != 0 && kDy[d] != 0
                && g_wallAvoidEnabled.load(std::memory_order_relaxed)
                && (g_walkBlocked[ngx][static_cast<int>(s.gy)]
                    || g_walkBlocked[static_cast<int>(s.gx)][ngy]))
                continue;
            if (g_visited[nt][ngx][ngy])  continue; // already expanded

            g_visited[nt][ngx][ngy] = 1;
            g_prev[nt][ngx][ngy]    = {static_cast<int8_t>(s.gx), static_cast<int8_t>(s.gy)};
            g_queue[qTail++]        = {static_cast<uint8_t>(nt),
                                       static_cast<uint8_t>(ngx),
                                       static_cast<uint8_t>(ngy)};

            // ── Goal check ────────────────────────────────────────────────
            if (hasGoal) {
                if (std::abs(ngx - goalGX) <= 1 && std::abs(ngy - goalGY) <= 1
                    && CellHoldsSafe(ngx, ngy, nt)) {
                    // Trace back through prev to find the t=1 cell
                    int tx = ngx, ty = ngy, tt = nt;
                    while (tt > 1) {
                        const Prev2 p = g_prev[tt][tx][ty];
                        tx = static_cast<uint8_t>(p.gx);
                        ty = static_cast<uint8_t>(p.gy);
                        --tt;
                    }
                    g_nextX = g_originX + tx * kCell;
                    g_nextY = g_originY + ty * kCell;
                    g_havePlan = true;
                    return true;
                }
            } else if (CellHoldsSafe(ngx, ngy, nt)) {
                // No goal: nearest cell that STAYS safe through the hold
                // window (BFS explores nearest-first → closest sustainably
                // -safe escape; doomed-soon tiles are skipped, not picked).
                int tx = ngx, ty = ngy, tt = nt;
                while (tt > 1) {
                    const Prev2 p = g_prev[tt][tx][ty];
                    tx = static_cast<uint8_t>(p.gx);
                    ty = static_cast<uint8_t>(p.gy);
                    --tt;
                }
                g_nextX = g_originX + tx * kCell;
                g_nextY = g_originY + ty * kCell;
                g_havePlan = true;
                return true;
            }
        }
    }
    return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// FallbackScan
// If BFS fails entirely (completely surrounded), scan t=0 for any safe cell
// and move there. NativeMoveTo is speed-clamped so this is safe.
// ─────────────────────────────────────────────────────────────────────────────
static bool FallbackScan(int pGX, int pGY)
{
    float bestDist = 1e9f;
    int bestGX = -1, bestGY = -1;

    for (int gx = 0; gx < kSide; ++gx) {
        for (int gy = 0; gy < kSide; ++gy) {
            if (g_danger[0][gx][gy] >= kSevBlock) continue;
            const float d = static_cast<float>((gx - pGX) * (gx - pGX) + (gy - pGY) * (gy - pGY));
            if (d < bestDist) {
                bestDist = d;
                bestGX   = gx;
                bestGY   = gy;
            }
        }
    }

    if (bestGX >= 0) {
        g_nextX = g_originX + bestGX * kCell;
        g_nextY = g_originY + bestGY * kCell;
        g_havePlan = true;
        return true;
    }

    // Completely trapped — every cell is lethal at t=0. Standing still here
    // is the worst option (the cell we're on is also lethal). Pick the
    // LEAST-bad neighbor (lowest danger over a short horizon) and step into
    // it: take a hit if we must, but always keep moving. The 8-neighbour
    // scan keeps it cheap. Horizon is small so we choose by what hurts NOW,
    // not by speculative future danger.
    constexpr int kLeastBadHorizon = 2;
    int   lbGX = -1, lbGY = -1;
    int   bestSev = 0;
    float bestN   = 0.f;
    bool  haveBest = false;
    for (int d = 0; d < kNDirs; ++d) {
        const int gx = pGX + kDx[d], gy = pGY + kDy[d];
        if (gx < 0 || gx >= kSide || gy < 0 || gy >= kSide) continue;
        if (g_walkBlocked[gx][gy]) continue;   // walls are hard-no, hits are not
        int sev = 0;
        const int tEnd = std::min(kMaxT - 1, kLeastBadHorizon);
        for (int t = 0; t <= tEnd; ++t) sev += g_danger[t][gx][gy];
        const float n = static_cast<float>((kDx[d] != 0) + (kDy[d] != 0));   // 1 = orthogonal, 2 = diag
        if (!haveBest || sev < bestSev || (sev == bestSev && n < bestN)) {
            haveBest = true; bestSev = sev; bestN = n; lbGX = gx; lbGY = gy;
        }
    }
    if (lbGX < 0) return false; // surrounded by walls AND lethal — give up
    g_nextX = g_originX + lbGX * kCell;
    g_nextY = g_originY + lbGY * kCell;
    g_havePlan = true;
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// SelectStandoffGoal — enemy-lock soft standoff. Scan the WHOLE local map;
// the goal is the cell minimizing
//   danger·(implicit 1) + |dist(cell,enemy) − R|·kStandoffW
//                       + dist(cell,player)·kStandoffTravelW.
// Danger (g_a2dCost) is large under fire so it dominates → movement is
// fully bullet-driven (no radial/tangential constraint). When clear, all
// safe cells cost ~0 so the standoff/travel terms pick the nearest safe
// cell that's still ~weapon range — the orbit emerges, it isn't forced.
// ─────────────────────────────────────────────────────────────────────────────
// Wall-only line of sight from a grid cell to the enemy world pos. Walks
// the segment in cell steps; a WALL cell on the line blocks the shot.
// Beyond the grid edge is treated as clear (we only know nearby walls;
// this is a soft preference anyway).
static bool LosClearToEnemy(int gx, int gy, float ex, float ey)
{
    const float cx = g_originX + gx * kCell;
    const float cy = g_originY + gy * kCell;
    float dx = ex - cx, dy = ey - cy;
    const float d = std::sqrt(dx * dx + dy * dy);
    if (d < 1e-3f) return true;
    dx /= d; dy /= d;
    const int steps = std::min(static_cast<int>(d / kCell), kSide * 2);
    for (int s = 1; s <= steps; ++s) {
        const float wx = cx + dx * (s * kCell);
        const float wy = cy + dy * (s * kCell);
        const int lx = static_cast<int>(std::roundf((wx - g_originX) / kCell));
        const int ly = static_cast<int>(std::roundf((wy - g_originY) / kCell));
        if (lx < 0 || lx >= kSide || ly < 0 || ly >= kSide) break; // off grid → assume clear
        if (g_walkBlocked[lx][ly]) return false;                   // wall between us
    }
    return true;
}

static bool SelectStandoffGoal(float ex, float ey, float R,
                               int pGX, int pGY, int& outGX, int& outGY)
{
    // Finding-B perf: LOS-per-cell over the whole grid was the heaviest
    // per-rebuild cost. Pass 1 = O(cells) base score (no LOS), keep the
    // global best AND the K best. If LOS is off OR there are no walls in
    // the grid, return the global best (LOS would never penalize). Else
    // Pass 2 applies LOS only to the K candidates — bounded regardless of
    // grid size (the true optimum is virtually always in the top-K, since
    // the LOS penalty is bounded at kLosBlockedW).
    const bool losOn = g_losGoalEnabled.load(std::memory_order_relaxed) && g_walkAny;
    // Anti-flee + lateral preference is computed in cell space (matches the
    // existing `travel` units). Skip cleanly if disabled or if the enemy is
    // effectively on top of us (no meaningful direction vector).
    const bool latOn = g_lateralPrefEnabled.load(std::memory_order_relaxed);
    const float egx = (ex - g_originX) / kCell;
    const float egy = (ey - g_originY) / kCell;
    const float vex = egx - static_cast<float>(pGX);
    const float vey = egy - static_cast<float>(pGY);
    const float vmag = std::sqrt(vex * vex + vey * vey);
    const bool dirOk = latOn && vmag > 0.5f;
    const float uex = dirOk ? (vex / vmag) : 0.f;  // player→enemy unit vector
    const float uey = dirOk ? (vey / vmag) : 0.f;  // (cells)
    // Goal hysteresis: small discount on the previously-picked cell so we
    // commit to a direction unless something *meaningfully* better appears.
    const bool      stickyOn = g_goalStickyEnabled.load(std::memory_order_relaxed);
    const int       lgx   = g_lastGoalGX.load(std::memory_order_relaxed);
    const int       lgy   = g_lastGoalGY.load(std::memory_order_relaxed);
    const uint64_t  lgMs  = g_lastGoalMs.load(std::memory_order_relaxed);
    const uint64_t  nowMs = GetTickCount64();
    const bool      stickyValid = stickyOn && lgx >= 0
                                  && (nowMs - lgMs) < kGoalStickyTtlMs;
    constexpr int K = 24;
    float kS[K]; int kX[K], kY[K]; int kn = 0;
    float gBest = 1e18f; int gX = -1, gY = -1;
    for (int gx = 0; gx < kSide; ++gx)
        for (int gy = 0; gy < kSide; ++gy) {
            if (g_a2dBlocked[gx][gy]) continue;
            const float wx = g_originX + gx * kCell;
            const float wy = g_originY + gy * kCell;
            const float dE = std::sqrt((wx - ex) * (wx - ex) + (wy - ey) * (wy - ey));
            const int ddx = gx - pGX, ddy = gy - pGY;
            const float travel = std::sqrt(static_cast<float>(ddx * ddx + ddy * ddy));
            // along = dot(displacement, player→enemy). Positive = candidate
            // moves us toward the enemy; negative = retreating. perp = the
            // perpendicular component (sideways step magnitude).
            float retreatTerm = 0.f, lateralTerm = 0.f;
            if (dirOk) {
                const float along = ddx * uex + ddy * uey;
                const float perpSq = std::max(0.f,
                    static_cast<float>(ddx * ddx + ddy * ddy) - along * along);
                if (along < 0.f) retreatTerm = (-along) * kRetreatPenalty;
                lateralTerm = -std::sqrt(perpSq) * kLateralBonus;
            }
            const float stickyBonus = (stickyValid && gx == lgx && gy == lgy)
                                      ? -kGoalStickyBonus : 0.f;
            const float base = g_a2dCost[gx][gy]
                             + std::fabs(dE - R) * kStandoffW
                             + travel * kStandoffTravelW
                             + retreatTerm
                             + lateralTerm
                             + stickyBonus;
            if (base < gBest) { gBest = base; gX = gx; gY = gy; }
            if (!losOn) continue;
            if (kn < K) { kS[kn] = base; kX[kn] = gx; kY[kn] = gy; ++kn; }
            else {
                int wi = 0; for (int i = 1; i < K; ++i) if (kS[i] > kS[wi]) wi = i;
                if (base < kS[wi]) { kS[wi] = base; kX[wi] = gx; kY[wi] = gy; }
            }
        }
    if (gX < 0) return false;
    if (!losOn) {
        outGX = gX; outGY = gY;
        if (stickyOn) {
            g_lastGoalGX.store(outGX, std::memory_order_relaxed);
            g_lastGoalGY.store(outGY, std::memory_order_relaxed);
            g_lastGoalMs.store(nowMs, std::memory_order_relaxed);
        }
        return true;
    }

    float bestScore = 1e18f; int bgx = gX, bgy = gY;
    for (int i = 0; i < kn; ++i) {
        // Carry the sticky discount through the LOS pass too so it can't be
        // re-overruled by a marginal LOS difference.
        const float stickyBonus = (stickyValid && kX[i] == lgx && kY[i] == lgy)
                                  ? -kGoalStickyBonus : 0.f;
        const float s = kS[i]
            + (LosClearToEnemy(kX[i], kY[i], ex, ey) ? 0.f : kLosBlockedW)
            + stickyBonus;
        if (s < bestScore) { bestScore = s; bgx = kX[i]; bgy = kY[i]; }
    }
    outGX = bgx; outGY = bgy;
    if (stickyOn) {
        g_lastGoalGX.store(outGX, std::memory_order_relaxed);
        g_lastGoalGY.store(outGY, std::memory_order_relaxed);
        g_lastGoalMs.store(nowMs, std::memory_order_relaxed);
    }
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// SelectSmartGoal — Jesse's SelectGoalNearTarget. Within a kGoalSearch
// window around the raw clipped goal, pick the cell minimizing
//   summed severity over t=0..kGoalHorizonT  +  distance² to the raw goal.
// Cell must be unblocked at t=0. Bounded window×horizon scan over the
// already-stamped grid — no game read, no full-grid pass. Returns false
// (caller keeps the raw goal) if nothing better than the raw cell is found.
// ─────────────────────────────────────────────────────────────────────────────
static bool SelectSmartGoal(int rawGX, int rawGY, int& outGX, int& outGY)
{
    const int x0 = std::max(0, rawGX - kGoalSearch);
    const int x1 = std::min(kSide - 1, rawGX + kGoalSearch);
    const int y0 = std::max(0, rawGY - kGoalSearch);
    const int y1 = std::min(kSide - 1, rawGY + kGoalSearch);
    const int tMax = std::min(kMaxT, kGoalHorizonT);

    float bestScore = 1e18f;
    int   bestGX = -1, bestGY = -1;

    for (int gx = x0; gx <= x1; ++gx) {
        for (int gy = y0; gy <= y1; ++gy) {
            if (g_danger[0][gx][gy] >= kSevBlock) continue; // can't stand here now
            int sevSum = 0;
            for (int t = 0; t <= tMax; ++t)
                sevSum += g_danger[t][gx][gy];
            const int ddx = gx - rawGX, ddy = gy - rawGY;
            const float distSq = static_cast<float>(ddx * ddx + ddy * ddy);
            // Severity dominates; the distance term only breaks ties toward
            // the intended goal so we don't wander off objective.
            const float score = static_cast<float>(sevSum) + distSq * 0.5f;
            if (score < bestScore) {
                bestScore = score;
                bestGX = gx;
                bestGY = gy;
            }
        }
    }
    if (bestGX < 0) return false;
    outGX = bestGX;
    outGY = bestGY;
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// SelectSafestCell — the SURVIVE goal. Lowest-a2d-cost non-blocked cell,
// tie-broken toward the player so we don't sprint across the room when a
// near pocket is just as safe. O(cells), cheap; recomputed every rebuild so
// it tracks a moving safe pocket.
// ─────────────────────────────────────────────────────────────────────────────
static bool SelectSafestCell(int pGX, int pGY, int& outGX, int& outGY)
{
    // Same anti-flee + lateral preference as SelectStandoffGoal so SURVIVE
    // mode stops sprinting backwards. When there's an active lock we know
    // which direction "retreat" is; without a lock we fall back to the
    // original "nearest safest cell" scoring.
    const bool latOn = g_lateralPrefEnabled.load(std::memory_order_relaxed);
    float lEx = 0.f, lEy = 0.f, lR = 0.f, lWpn = 0.f;
    const bool haveLock = latOn
        && DangerPlanner::GetLockTarget(lEx, lEy, lR, lWpn);
    float uex = 0.f, uey = 0.f; bool dirOk = false;
    if (haveLock) {
        const float egx = (lEx - g_originX) / kCell;
        const float egy = (lEy - g_originY) / kCell;
        const float vex = egx - static_cast<float>(pGX);
        const float vey = egy - static_cast<float>(pGY);
        const float vmag = std::sqrt(vex * vex + vey * vey);
        if (vmag > 0.5f) { uex = vex / vmag; uey = vey / vmag; dirOk = true; }
    }
    // Goal hysteresis (same memory as SelectStandoffGoal — they don't run
    // concurrently, and SURVIVE↔ORBIT switches also benefit from the sticky
    // bias).
    const bool      stickyOn = g_goalStickyEnabled.load(std::memory_order_relaxed);
    const int       lgx   = g_lastGoalGX.load(std::memory_order_relaxed);
    const int       lgy   = g_lastGoalGY.load(std::memory_order_relaxed);
    const uint64_t  lgMs  = g_lastGoalMs.load(std::memory_order_relaxed);
    const uint64_t  nowMs = GetTickCount64();
    const bool      stickyValid = stickyOn && lgx >= 0
                                  && (nowMs - lgMs) < kGoalStickyTtlMs;
    float bestScore = 1e18f;
    int   bgx = -1, bgy = -1;
    for (int gx = 0; gx < kSide; ++gx)
        for (int gy = 0; gy < kSide; ++gy) {
            if (g_a2dBlocked[gx][gy]) continue;
            const int ddx = gx - pGX, ddy = gy - pGY;
            float retreatTerm = 0.f, lateralTerm = 0.f;
            if (dirOk) {
                const float along = ddx * uex + ddy * uey;
                const float perpSq = std::max(0.f,
                    static_cast<float>(ddx * ddx + ddy * ddy) - along * along);
                if (along < 0.f) retreatTerm = (-along) * kRetreatPenalty;
                lateralTerm = -std::sqrt(perpSq) * kLateralBonus;
            }
            const float stickyBonus = (stickyValid && gx == lgx && gy == lgy)
                                      ? -kGoalStickyBonus : 0.f;
            const float score = g_a2dCost[gx][gy]
                              + std::sqrt(static_cast<float>(ddx * ddx + ddy * ddy)) * 0.5f
                              + retreatTerm
                              + lateralTerm
                              + stickyBonus;
            if (score < bestScore) { bestScore = score; bgx = gx; bgy = gy; }
        }
    if (bgx < 0) return false;
    outGX = bgx; outGY = bgy;
    if (stickyOn) {
        g_lastGoalGX.store(outGX, std::memory_order_relaxed);
        g_lastGoalGY.store(outGY, std::memory_order_relaxed);
        g_lastGoalMs.store(nowMs, std::memory_order_relaxed);
    }
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// CcdStepUnsafe — P6. True swept continuous collision detection of the
// committed step (player→target at measured speed) vs every bullet's exact
// predicted path, fine-sampled. Returns true if the step gets clipped.
// ─────────────────────────────────────────────────────────────────────────────
static bool CcdStepUnsafe(float px, float py, float tx, float ty,
                          const std::vector<WorldProjectile>& projs)
{
    const float dx = tx - px, dy = ty - py;
    const float dist = std::sqrt(dx * dx + dy * dy);
    const float spd  = std::max(g_obsSpeed, 0.5f);
    const uint64_t nowMs = GetTickCount64();
    for (float t = 0.f; t <= kCcdHorizonMs; t += kCcdStepMs) {
        float u = (dist > 1e-4f) ? (spd * (t / 1000.f)) / dist : 1.f;
        if (u > 1.f) u = 1.f;
        const float plx = px + dx * u, ply = py + dy * u;
        for (const auto& b : projs) {
            if (!b.valid) continue;
            const float elapsed = static_cast<float>(
                nowMs > b.spawnTick ? nowMs - b.spawnTick : 0u);
            if (b.lifetime > 0.f && (elapsed + t) >= b.lifetime) continue;
            float bx = b.x, by = b.y;
            ProjectileTracking::ComputePosAtSafe(b, elapsed + t, bx, by);
            if (!std::isfinite(bx) || !std::isfinite(by)) continue;
            const float half = ProjChebyshevHalf(b) * g_hitScale + kPlayerHalf + g_ccdPad + CatInflate(b);
            if (std::fabs(bx - plx) < half && std::fabs(by - ply) < half)
                return true;   // Chebyshev overlap → clipped
        }
    }
    return false;
}

// ── Public interface ───────────────────────────────────────────────────────
void SetEnabled(bool en)
{
    g_enabled = en;
    if (!en) {
        ProjectileTracking::ClearHazardSpawnCallback();
        g_newProjSinceRebuild.store(false, std::memory_order_relaxed);
    }
}
bool IsEnabled() { return g_enabled; }
void OnEnter()
{
    g_havePlan   = false;
    g_frameCount = 0;
    g_newProjSinceRebuild.store(false, std::memory_order_relaxed);
    ProjectileTracking::RegisterHazardSpawnCallback(OnHazardSpawn, nullptr);
}

void SetHitScale(float s)       { g_hitScale   = std::clamp(s,    0.5f, 2.0f); }
void SetRebuildN(int n)         { g_rebuildN   = std::clamp(n,    1,    10);   }
void SetPlanStepMs(float ms)    { g_planStepMs = std::clamp(ms,   10.f, 200.f);}
void SetSearchRadius(float t)   { (void)t; /* kRad is compile-time, this is display only */ }

float GetHitScale()     { return g_hitScale; }
int   GetRebuildN()     { return g_rebuildN; }
float GetPlanStepMs()   { return g_planStepMs; }
float GetSearchRadius() { return kRad * kCell; }

void SetAstarEnabled(bool en)     { g_astarEnabled.store(en, std::memory_order_relaxed); }
bool GetAstarEnabled()            { return g_astarEnabled.load(std::memory_order_relaxed); }
void SetWeightingEnabled(bool en) { g_weightingEnabled.store(en, std::memory_order_relaxed); }
bool GetWeightingEnabled()        { return g_weightingEnabled.load(std::memory_order_relaxed); }
void SetSmartGoalEnabled(bool en) { g_smartGoalEnabled.store(en, std::memory_order_relaxed); }
bool GetSmartGoalEnabled()        { return g_smartGoalEnabled.load(std::memory_order_relaxed); }
void SetPerpEnabled(bool en)      { g_perpEnabled.store(en, std::memory_order_relaxed); }
bool GetPerpEnabled()             { return g_perpEnabled.load(std::memory_order_relaxed); }
void SetSpeedMatchEnabled(bool en){ g_speedMatchEnabled.store(en, std::memory_order_relaxed); }
bool GetSpeedMatchEnabled()       { return g_speedMatchEnabled.load(std::memory_order_relaxed); }
void SetWalkCacheEnabled(bool en) { g_walkCacheEnabled.store(en, std::memory_order_relaxed); }
bool GetWalkCacheEnabled()        { return g_walkCacheEnabled.load(std::memory_order_relaxed); }
void SetWallAvoidEnabled(bool en) { g_wallAvoidEnabled.store(en, std::memory_order_relaxed); }
bool GetWallAvoidEnabled()        { return g_wallAvoidEnabled.load(std::memory_order_relaxed); }
void SetArbiterEnabled(bool en)   { g_arbiterEnabled.store(en, std::memory_order_relaxed); }
bool GetArbiterEnabled()          { return g_arbiterEnabled.load(std::memory_order_relaxed); }
void SetBfsBiasEnabled(bool en)   { g_bfsBiasEnabled.store(en, std::memory_order_relaxed); }
bool GetBfsBiasEnabled()          { return g_bfsBiasEnabled.load(std::memory_order_relaxed); }
void SetCcdEnabled(bool en)       { g_ccdEnabled.store(en, std::memory_order_relaxed); }
bool GetCcdEnabled()              { return g_ccdEnabled.load(std::memory_order_relaxed); }
void SetCcdPad(float t)           { g_ccdPad = std::clamp(t, 0.f, 0.5f); }
float GetCcdPad()                 { return g_ccdPad; }
void SetCatalogEnabled(bool en)   { g_catEnabled.store(en, std::memory_order_relaxed); }
bool GetCatalogEnabled()          { return g_catEnabled.load(std::memory_order_relaxed); }
void SetDrawPathEnabled(bool en)  { g_drawPathEnabled.store(en, std::memory_order_relaxed); }
bool GetDrawPathEnabled()         { return g_drawPathEnabled.load(std::memory_order_relaxed); }
void SetDrawProjPredEnabled(bool en) { g_drawProjPredEnabled.store(en, std::memory_order_relaxed); }
bool GetDrawProjPredEnabled()        { return g_drawProjPredEnabled.load(std::memory_order_relaxed); }
void SetDebugPredLongMs(float ms)    { g_debugPredLongMs.store(std::clamp(ms, 80.f, 1000.f), std::memory_order_relaxed); }
float GetDebugPredLongMs()           { return g_debugPredLongMs.load(std::memory_order_relaxed); }
void SetAvoidEnemiesEnabled(bool en) { g_avoidEnemiesEnabled.store(en, std::memory_order_relaxed); }
bool GetAvoidEnemiesEnabled()        { return g_avoidEnemiesEnabled.load(std::memory_order_relaxed); }
void SetLosGoalEnabled(bool en)   { g_losGoalEnabled.store(en, std::memory_order_relaxed); }
bool GetLosGoalEnabled()          { return g_losGoalEnabled.load(std::memory_order_relaxed); }
void SetWasdYieldEnabled(bool en) { g_wasdYieldEnabled.store(en, std::memory_order_relaxed); }
bool GetWasdYieldEnabled()        { return g_wasdYieldEnabled.load(std::memory_order_relaxed); }
void SetLateralPrefEnabled(bool en) { g_lateralPrefEnabled.store(en, std::memory_order_relaxed); }
bool GetLateralPrefEnabled()        { return g_lateralPrefEnabled.load(std::memory_order_relaxed); }
void SetGoalStickyEnabled(bool en)  { g_goalStickyEnabled.store(en, std::memory_order_relaxed); }
bool GetGoalStickyEnabled()         { return g_goalStickyEnabled.load(std::memory_order_relaxed); }
void SetCommitDwellEnabled(bool en) { g_commitDwellEnabled.store(en, std::memory_order_relaxed); }
bool GetCommitDwellEnabled()        { return g_commitDwellEnabled.load(std::memory_order_relaxed); }
// THE live A* danger weight (replaces the dead "danger/stay penalty"
// knobs). Client sends 0..5 (default 2 ⇒ g_a2dW 0.004 = current). Lower
// = tighter/threads closer; higher = wider avoidance.
void  SetDangerWeight(float v)    { g_a2dW = std::clamp(v * 0.002f, 0.f, 0.05f); }
float GetDangerWeight()           { return g_a2dW / 0.002f; }

// ─────────────────────────────────────────────────────────────────────────────
// Tick — called from Detour_AppEngineUpdate every game frame (~17ms @ 60fps).
// ─────────────────────────────────────────────────────────────────────────────
void Tick(void* player, float px, float py, float dt)
{
    if (!player || !g_enabled) return;

    ++g_frameCount;

    // ── Observed-speed estimator (anti rubber-band) ──────────────────────
    // Realized tiles/sec from the motion the game actually granted between
    // ticks — the true post-clamp/post-status speed. Pure observation of
    // (px,py,dt) already passed in; no game call. Used ONLY for the
    // per-frame step clamp (don't command past reach). The prediction slice
    // stays the fixed g_planStepMs — scaling it by observed speed made the
    // grid coarse when slow (up to 200 ms/slice) and reactions visibly
    // late, so that part is removed; the step clamp is what actually
    // prevents the server snap-back.
    if (g_speedMatchEnabled.load(std::memory_order_relaxed)) {
        if (g_havePrevPos && dt > 1e-3f) {
            const float ddx = px - g_prevPx, ddy = py - g_prevPy;
            const float inst = std::sqrt(ddx * ddx + ddy * ddy) / dt;
            // P9: only learn from MEANINGFUL motion — standing still must
            // not decay obsSpeed toward 0 (that made arrival-time
            // over-cautious and laggy when you then move). Teleport-sized
            // jumps = realm change. Keep obsSpeed in RotMG's real band so
            // it's never garbage post-teleport / when stationary.
            if (inst >= 1.0f && inst < 25.f)
                g_obsSpeed += 0.20f * (inst - g_obsSpeed);
            else if (inst >= 25.f)            // teleport / realm change
                CatClear();                   // P7: drop stale per-type cache
            g_obsSpeed = std::clamp(g_obsSpeed, 2.0f, 12.0f);
        }
        g_prevPx = px; g_prevPy = py; g_havePrevPos = true;
    } else {
        g_havePrevPos = false;          // reset so re-enable starts clean
    }
    g_effStepMs = g_planStepMs;         // fixed slice — snappy, not speed-coarsened

    // ── Rebuild spacetime grid every N frames, or immediately when new
    //    projectiles have spawned since the last rebuild.
    //    Bullets can spawn on any game frame (not just every N frames), so we
    //    must not wait out the cadence when new shots are already in flight.
    const bool newProj     = g_newProjSinceRebuild.exchange(false, std::memory_order_relaxed);
    const bool shouldRebuild = newProj || (g_frameCount % g_rebuildN == 0);
    if (shouldRebuild) {

        std::vector<WorldProjectile> projs;
        ProjectileTracking::CopyActiveForDraw(projs);

        CatalogObserve(projs);   // P8: measure prediction error → learn per-type inflation
        CaptureProjPredictionViz(projs, GetTickCount64());  // admin debug overlay
        BuildGrid(projs, px, py);
        BuildA2D();   // collapse 3-D → 2-D strategic map for A*

        // Player is always at grid center
        const int pGX = kRad;
        const int pGY = kRad;

        // Determine goal
        float extX = 0.f, extY = 0.f;
        const bool hasGoal = DangerPlanner::GetExternalGoal(extX, extY);

        // Check whether the player's CURRENT cell will be hit at ANY future
        // time step, not just t=0.  A bullet arriving in 50-600ms at our
        // position is just as dangerous as one overlapping us right now —
        // if we only checked t=0 we'd idle while an incoming shot threads
        // straight into us.
        bool imminent       = false;  // cell hit within the near reaction window
        bool playerInDanger = false;  // cell hit anywhere in the horizon
        for (int t = 0; t <= kMaxT; ++t) {
            if (g_danger[t][pGX][pGY] >= kSevBlock) {
                playerInDanger = true;
                imminent = (t <= kImminentT);   // earliest threatened slice
                break;
            }
        }

        // Throttled diagnostic — pinpoints WHY dodge isn't moving:
        //   projs=0          → ProjectileTracking not capturing bullets
        //                       (hook/offset stale on this game build)
        //   projs>0, danger=0→ bullets seen but danger grid not flagging us
        //   danger=1 found=0 → BFS/FallbackScan failing
        //   havePlan=1       → plan exists; if still no move, NativeMoveTo
        //                       (game move fn) is the stale piece
        static int s_diagN = 0;
        const bool diag = ((s_diagN++ % 120) == 0);
        if (diag)
            DBG_FILE_LOG("[XDodge] rebuild: projs=" << projs.size()
                << " hasGoal=" << (int)hasGoal
                << " playerInDanger=" << (int)playerInDanger
                << " pos=(" << px << "," << py << ")");

        // ── P3 arbiter: ORBIT ↔ SURVIVE (mode-hysteresis) ───────────────
        bool surviving = false;
        int  survGX = pGX, survGY = pGY;
        if (g_arbiterEnabled.load(std::memory_order_relaxed)) {
            float goalCellCost = 1e9f;
            if (hasGoal) {
                const int ggx = std::clamp(static_cast<int>(std::roundf((extX - g_originX) / kCell)), 0, kSide - 1);
                const int ggy = std::clamp(static_cast<int>(std::roundf((extY - g_originY) / kCell)), 0, kSide - 1);
                goalCellCost = g_a2dBlocked[ggx][ggy] ? 1e9f : g_a2dCost[ggx][ggy];
            }
            const uint64_t nowMs = GetTickCount64();
            if (g_mode == Mode::Survive) {
                const bool clear = !playerInDanger && goalCellCost < kSurviveExitCost;
                if (clear && (nowMs - g_modeSinceMs) >= kSurviveDwellMs) {
                    g_mode = Mode::Orbit; g_modeSinceMs = nowMs;
                }
            } else if (playerInDanger && (!hasGoal || goalCellCost > kSurviveEnterCost)) {
                g_mode = Mode::Survive; g_modeSinceMs = nowMs;
            }
            if (g_mode == Mode::Survive && SelectSafestCell(pGX, pGY, survGX, survGY))
                surviving = true;   // flee to the (re-tracked) safest pocket
        }

        // ── Enemy-lock = SOFT standoff (dynamic, not a ring) ────────────
        // GetLockTarget gives the enemy centre + weapon range. The goal is
        // the safest reachable cell that also keeps ~that range, picked
        // from the whole local map each rebuild (SelectStandoffGoal) — so
        // movement is driven by the actual bullets, with range only a
        // gentle pull. No radial/tangential constraint.
        float lockEx = 0.f, lockEy = 0.f, lockR = 0.f, lockWpn = 0.f;
        const bool lockRing = !surviving && hasGoal
            && DangerPlanner::GetLockTarget(lockEx, lockEy, lockR, lockWpn)
            && lockR > 0.5f;
        int  stGX = pGX, stGY = pGY;
        bool haveSt = false;
        if (lockRing)
            haveSt = SelectStandoffGoal(lockEx, lockEy, lockR, pGX, pGY, stGX, stGY);

        const float goalDist = hasGoal
            ? std::sqrt((extX - px) * (extX - px) + (extY - py) * (extY - py))
            : 1e9f;

        bool parked;
        if (lockRing && haveSt) {
            const int dgx = stGX - pGX, dgy = stGY - pGY;     // already in the best
            parked = (dgx * dgx + dgy * dgy) <= kParkCells * kParkCells;
        } else {
            parked = hasGoal && goalDist <= kGoalDeadzoneTiles;
        }
        // Safe-here stickiness: don't backpedal chasing a marginally cheaper
        // cell when the cell I'm on is safe. BUT this must NOT block A* from
        // travelling toward an active goal — whether that's a lock standoff
        // OR an external goal (auto-follow another player, follow-mouse,
        // BagLooter pickup). Only "stick" when we're actually parked at the
        // goal or there's no goal at all. Real danger still overrides.
        if (!imminent && !playerInDanger
            && g_a2dCost[pGX][pGY] <= kStickSafeCost
            && (parked || !hasGoal))
            parked = true;
        if (!surviving && !imminent && ((!hasGoal && !playerInDanger) || parked)) {
            // Nothing about to hit, and either no destination (and calm) or
            // already in the best safe-in-range spot → STAND STILL. BFS
            // still fires the moment a hit becomes imminent.
            g_havePlan = false;
            g_planTier = PlanTier::None;
        } else {
            int goalGX = pGX, goalGY = pGY;
            if (surviving) {
                goalGX = survGX; goalGY = survGY;          // P3: flee target
            } else if (lockRing && haveSt) {
                goalGX = stGX; goalGY = stGY;              // soft-standoff target
            } else if (hasGoal) {
                goalGX = std::clamp(static_cast<int>(std::roundf((extX - g_originX) / kCell)), 0, kSide - 1);
                goalGY = std::clamp(static_cast<int>(std::roundf((extY - g_originY) / kCell)), 0, kSide - 1);
            }

            g_havePlan = false;
            g_planTier = PlanTier::None;
            bool found = false;

            // NOT imminent + goal → A* travels smartly toward it. A* over
            // the spacetime grid already avoids the far/horizon danger, so
            // it's safe to drive here even while bullets exist further out.
            // IMMINENT → A* skipped so the snappy BFS escape owns it.
            if (!imminent && (hasGoal || surviving)
                && g_astarEnabled.load(std::memory_order_relaxed)) {
                int aGoalGX = goalGX, aGoalGY = goalGY;
                if (!surviving && !lockRing && g_smartGoalEnabled.load(std::memory_order_relaxed))
                    SelectSmartGoal(goalGX, goalGY, aGoalGX, aGoalGY);
                found = RunAStar(pGX, pGY, aGoalGX, aGoalGY);  // sets tier=AStar
            }

            // BFS. IMMINENT (or no goal) → escape mode: nearest safe cell =
            // snappy reactive dodge, NOT goal-seeking. Not imminent but A*
            // failed → still head toward the goal if we have one.
            if (!found) {
                g_planTier = PlanTier::BFS;
                const bool bfsGoal = (!imminent) && (hasGoal || surviving);
                found = RunBFS(pGX, pGY, goalGX, goalGY, bfsGoal);
            }

            if (!found) {
                g_planTier = PlanTier::Fallback;
                FallbackScan(pGX, pGY);
            }

            // ── P6: CCD-exact tight commit ──────────────────────────────
            // The grid is 50 ms-quantized; verify the chosen step against
            // exact bullet trajectories and, if it clips, slide to the
            // nearest CCD-safe neighbor (≤8). If none, keep the original
            // (never worse than the grid plan).
            if (g_havePlan && g_ccdEnabled.load(std::memory_order_relaxed)
                && CcdStepUnsafe(px, py, g_nextX, g_nextY, projs)) {
                const int tgx = std::clamp(static_cast<int>(std::roundf((g_nextX - g_originX) / kCell)), 0, kSide - 1);
                const int tgy = std::clamp(static_cast<int>(std::roundf((g_nextY - g_originY) / kCell)), 0, kSide - 1);
                float bestX = g_nextX, bestY = g_nextY, bestD = 1e18f;
                bool refined = false;
                for (int d = 0; d < kNDirs; ++d) {
                    if (kDx[d] == 0 && kDy[d] == 0) continue;
                    const int cgx = tgx + kDx[d], cgy = tgy + kDy[d];
                    if (cgx < 0 || cgx >= kSide || cgy < 0 || cgy >= kSide) continue;
                    if (g_a2dBlocked[cgx][cgy]) continue;
                    const float cx = g_originX + cgx * kCell;
                    const float cy = g_originY + cgy * kCell;
                    if (CcdStepUnsafe(px, py, cx, cy, projs)) continue;
                    const float dd = (cx - g_nextX) * (cx - g_nextX)
                                   + (cy - g_nextY) * (cy - g_nextY);
                    if (dd < bestD) { bestD = dd; bestX = cx; bestY = cy; refined = true; }
                }
                if (refined) { g_nextX = bestX; g_nextY = bestY; }
            }

            // ── "Stay is a valid dodge" — CCD-gate the reactive step ────
            // RunBFS always returns a neighbor (never "stay"), and the grid
            // over-stamps "imminent", so BFS was forced to move 1 cell every
            // rebuild → continuous pull-away. If this is a reactive escape
            // (BFS/Fallback) and EXACT CCD says holding still is actually
            // safe, suppress the move and stand put. A* (strategic
            // repositioning) is untouched.
            if (g_havePlan && g_ccdEnabled.load(std::memory_order_relaxed)
                && (g_planTier == PlanTier::BFS || g_planTier == PlanTier::Fallback)
                && !CcdStepUnsafe(px, py, px, py, projs)) {
                g_havePlan = false;       // staying is exactly safe → don't twitch
                g_planTier = PlanTier::None;
            }

            // ── Commit-layer direction dwell ────────────────────────────
            // Hold the last committed step direction for kCommitDwellMs
            // before allowing a sharp (>90deg) reversal. Stops the visible
            // flip-flopping that happens when A* picks different first
            // steps between rebuilds even with a stable goal. Imminent
            // danger always overrides — never blocks a real dodge.
            if (g_havePlan && g_commitDwellEnabled.load(std::memory_order_relaxed)) {
                const float fdx = g_nextX - px, fdy = g_nextY - py;
                const float fmag2 = fdx * fdx + fdy * fdy;
                if (fmag2 > 1e-6f) {
                    // Quantize to {-1,0,1} per axis (cell-direction sign).
                    const float half = 0.5f * kCell;
                    const int ndx = (fdx >  half) ?  1 : (fdx < -half ? -1 : 0);
                    const int ndy = (fdy >  half) ?  1 : (fdy < -half ? -1 : 0);
                    const uint64_t nowMs = GetTickCount64();
                    const bool inDwell  = (nowMs - g_lastStepMs) < kCommitDwellMs;
                    const bool hadStep  = (g_lastStepDX != 0 || g_lastStepDY != 0);
                    const int  dotProd  = ndx * g_lastStepDX + ndy * g_lastStepDY;
                    const bool sharpFlip = hadStep && dotProd < 0;   // >90deg turn
                    if (inDwell && sharpFlip && !imminent) {
                        // Suppress this flip — keep the previous direction
                        // by skipping this commit. Next rebuild gets to
                        // reconsider; if it still wants the new direction
                        // after dwell, it'll commit normally.
                        g_havePlan = false;
                        g_planTier = PlanTier::None;
                    } else {
                        g_lastStepDX = ndx;
                        g_lastStepDY = ndy;
                        g_lastStepMs = nowMs;
                    }
                }
            }

            // ── Debug: capture BOTH plans for the overlay ───────────────
            // Only when drawing — doubles search this rebuild, debug-only.
            // Save/restore the chosen plan's outputs so MOVEMENT is the
            // committed one; the extra A*/BFS runs only fill viz buffers.
            if (g_drawPathEnabled.load(std::memory_order_relaxed)) {
                const float  sNX = g_nextX, sNY = g_nextY;
                const bool   sHP = g_havePlan;
                const PlanTier sT = g_planTier;
                g_vizAlen = 0;
                if (RunAStar(pGX, pGY, goalGX, goalGY)) {
                    g_vizAlen = std::min(g_pathLen, kMaxPathPts);
                    for (int i = 0; i < g_vizAlen * 2; ++i) g_vizApts[i] = g_pathPts[i];
                }
                g_vizBfsValid = RunBFS(pGX, pGY, pGX, pGY, false); // nearest-safe escape
                g_vizBfsX = g_nextX; g_vizBfsY = g_nextY;
                g_nextX = sNX; g_nextY = sNY;                      // restore mover
                g_havePlan = sHP; g_planTier = sT;
            }
            if (diag)
                DBG_FILE_LOG("[XDodge] plan: imminent=" << (int)imminent
                    << " danger=" << (int)playerInDanger
                    << " hasGoal=" << (int)hasGoal
                    << " goalDist=" << goalDist
                    << " tier=" << (g_planTier == PlanTier::AStar ? "A*"
                                  : g_planTier == PlanTier::BFS ? "BFS"
                                  : g_planTier == PlanTier::Fallback ? "Fallback" : "none")
                    << " found=" << (int)found
                    << " next=(" << g_nextX << "," << g_nextY << ")");
        }
    }

    // ── Issue movement every frame toward planned target ───────────────────
    // Manual-WASD yield: if the player is driving, issue NOTHING (the plan
    // above stays fresh, so dodge resumes the instant keys are released).
    if (g_havePlan && !ManualMoveHeld()) {
        float tgtX = g_nextX, tgtY = g_nextY;
        // Step clamp: never command farther than the player can actually
        // travel this frame (obsSpeed × dt). Commanding past reach is what
        // the server snaps back. Same direction, capped magnitude — applies
        // to BOTH the BFS step and the A* step (single chokepoint).
        if (g_speedMatchEnabled.load(std::memory_order_relaxed) && dt > 1e-3f) {
            const float dx = tgtX - px, dy = tgtY - py;
            const float dist = std::sqrt(dx * dx + dy * dy);
            const float budget = g_obsSpeed * dt;   // tiles reachable this frame
            if (dist > budget && budget > 1e-4f && dist > 1e-4f) {
                const float s = budget / dist;
                tgtX = px + dx * s;
                tgtY = py + dy * s;
            }
        }
        DangerPlanner::NativeMoveTo(player, tgtX, tgtY);
        static int s_mvN = 0;
        if ((s_mvN++ % 120) == 0)
            DBG_FILE_LOG("[XDodge] NativeMoveTo -> (" << tgtX << "," << tgtY
                << ") obsSpd=" << g_obsSpeed << " effStep=" << g_effStepMs
                << " from=(" << px << "," << py << ")");
    }
}

// ── Debug overlay: draw BOTH plans at once ───────────────────────────────
// GREEN polyline  = A* strategic route (goal = red dot)
// ORANGE line+dot = BFS reflex escape step
// YELLOW dot      = the step actually being committed this frame
// So you can watch the attractor (A*) and the repeller (BFS) together.
void RenderDebugPath(float camX, float camY, float angle, float zoom, float cx, float cy)
{
    const bool pathOn = g_drawPathEnabled.load(std::memory_order_relaxed);
    const bool projOn = g_drawProjPredEnabled.load(std::memory_order_relaxed);
    if (!pathOn && !projOn) return;
    ImDrawList* dl = ImGui::GetForegroundDrawList();
    if (!dl) return;
    const ImU32 colPath = IM_COL32(0, 255, 128, 200);   // A* route
    const ImU32 colGoal = IM_COL32(255, 80, 80, 255);    // A* goal
    const ImU32 colBfs  = IM_COL32(255, 165, 0, 230);    // BFS escape
    const ImU32 colNext = IM_COL32(255, 255, 0, 255);    // committed step
    const ImU32 colProj = IM_COL32(255,  64, 255, 200);  // projectile prediction

    // Predicted bullet trajectories (admin debug). Draw FIRST so the A*
    // path and committed step render on top of them.
    if (projOn) {
        for (int p = 0; p < g_vizProjCount; ++p) {
            const int n = g_vizProjLen[p];
            if (n < 1) continue;
            const int base = p * kVizProjSamples * 2;
            float lastSx = 0.f, lastSy = 0.f; bool haveLast = false;
            for (int i = 0; i < n; ++i) {
                float sx, sy;
                if (!W2S(g_vizProj[base + i * 2 + 0], g_vizProj[base + i * 2 + 1],
                         sx, sy, camX, camY, angle, zoom, cx, cy)) { haveLast = false; continue; }
                if (haveLast)
                    dl->AddLine(ImVec2(lastSx, lastSy), ImVec2(sx, sy), colProj, 1.5f);
                dl->AddCircleFilled(ImVec2(sx, sy), (i == 0 ? 3.f : 1.5f), colProj);
                lastSx = sx; lastSy = sy; haveLast = true;
            }
        }

        // ── Tracking-accuracy HUD ───────────────────────────────────
        // Two horizons reported side-by-side: the 50ms probe matches the
        // planner's slice spacing (immediate aliasing); the long probe
        // (configurable, default 250ms) reveals compounding error that
        // matters for the late-horizon planning decisions. If 50ms is
        // small but long is large, ComputePosAt has a per-step bias that
        // compounds — typical of accelerating bullet handling.
        // Bands: <0.1 great, 0.2-0.4 = under-stamp by that much, >0.5 =
        // model meaningfully wrong.
        int   nShort = 0,    nLong = 0;
        float sumS  = 0.f,   sumL  = 0.f;
        float maxS  = 0.f,   maxL  = 0.f;
        uint32_t worstSigS = 0, worstSigL = 0;
        uint32_t worstNS   = 0, worstNL   = 0;
        for (const auto& e : g_cat) {
            if (!e.used) continue;
            if (e.samples > 0) {
                ++nShort; sumS += e.errEma;
                if (e.errEma > maxS) { maxS = e.errEma; worstSigS = e.sig; worstNS = e.samples; }
            }
            if (e.samplesLong > 0) {
                ++nLong; sumL += e.errEmaLong;
                if (e.errEmaLong > maxL) { maxL = e.errEmaLong; worstSigL = e.sig; worstNL = e.samplesLong; }
            }
        }
        const float avgS = nShort > 0 ? sumS / static_cast<float>(nShort) : 0.f;
        const float avgL = nLong  > 0 ? sumL / static_cast<float>(nLong)  : 0.f;
        const float longMs = g_debugPredLongMs.load(std::memory_order_relaxed);
        char buf[200];
        const ImU32 colHud   = IM_COL32(255, 220, 80, 230);
        const ImU32 colHudBg = IM_COL32(0, 0, 0, 160);
        dl->AddRectFilled(ImVec2(8.f, 8.f), ImVec2(420.f, 120.f), colHudBg, 4.f);
        std::snprintf(buf, sizeof buf,
            "Projectile tracking (per-type residual, tiles)");
        dl->AddText(ImVec2(14.f, 12.f), colHud, buf);
        std::snprintf(buf, sizeof buf,
            "  @50ms : types=%d  avg=%.3f  max=%.3f", nShort, avgS, maxS);
        dl->AddText(ImVec2(14.f, 28.f), colHud, buf);
        std::snprintf(buf, sizeof buf,
            "          worst sig=0x%08X (%u samples)", worstSigS, worstNS);
        dl->AddText(ImVec2(14.f, 44.f), colHud, buf);
        std::snprintf(buf, sizeof buf,
            "  @%4.0fms: types=%d  avg=%.3f  max=%.3f", longMs, nLong, avgL, maxL);
        dl->AddText(ImVec2(14.f, 64.f), colHud, buf);
        std::snprintf(buf, sizeof buf,
            "          worst sig=0x%08X (%u samples)", worstSigL, worstNL);
        dl->AddText(ImVec2(14.f, 80.f), colHud, buf);
        // Growth ratio — long-horizon error per ms vs short-horizon. If
        // it's ~1.0 the model has zero bias; >2.0 means error compounds
        // much faster at long range (classic accelerating-bullet sign).
        const float ratio = (avgS > 1e-6f && longMs > 0.f)
            ? (avgL / avgS) / (longMs / 50.f) : 0.f;
        std::snprintf(buf, sizeof buf,
            "  growth ratio (long/short per ms) = %.2fx", ratio);
        dl->AddText(ImVec2(14.f, 100.f), colHud, buf);
    }

    if (!pathOn) return;   // path overlay sections below are gated separately

    // A* strategic route (green polyline, red goal)
    if (g_vizAlen >= 2) {
        bool havePrev = false; float ppx = 0.f, ppy = 0.f;
        for (int i = 0; i < g_vizAlen; ++i) {
            float sx, sy;
            if (!W2S(g_vizApts[i * 2 + 0], g_vizApts[i * 2 + 1], sx, sy,
                     camX, camY, angle, zoom, cx, cy)) { havePrev = false; continue; }
            if (havePrev) dl->AddLine(ImVec2(ppx, ppy), ImVec2(sx, sy), colPath, 2.0f);
            if (i == g_vizAlen - 1) dl->AddCircleFilled(ImVec2(sx, sy), 5.f, colGoal);
            else                    dl->AddCircleFilled(ImVec2(sx, sy), 3.f, colPath);
            ppx = sx; ppy = sy; havePrev = true;
        }
    }
    // BFS reflex escape (orange line from player + dot)
    if (g_vizBfsValid) {
        float bx, by;
        if (W2S(g_vizBfsX, g_vizBfsY, bx, by, camX, camY, angle, zoom, cx, cy)) {
            dl->AddLine(ImVec2(cx, cy), ImVec2(bx, by), colBfs, 2.0f);
            dl->AddCircleFilled(ImVec2(bx, by), 5.f, colBfs);
        }
    }
    // The step actually driving the character this frame (yellow)
    if (g_havePlan) {
        float nx, ny;
        if (W2S(g_nextX, g_nextY, nx, ny, camX, camY, angle, zoom, cx, cy))
            dl->AddCircleFilled(ImVec2(nx, ny), 4.f, colNext);
    }
}

// ── ImGui settings panel ──────────────────────────────────────────────────
void RenderSettings()
{
    ImGui::TextUnformatted("RE-Plus");
    ImGui::Separator();
    ImGui::TextDisabled("Grid: 25x25 cells, %.2f tile/cell, 3 tile radius", kCell);
    ImGui::TextDisabled("Horizon: %d steps x %.0f ms = %.0f ms",
                        kMaxT, g_planStepMs, kMaxT * g_planStepMs);
    ImGui::Spacing();

    float v;

    v = g_hitScale;
    if (ImGui::SliderFloat("Hit scale##xd", &v, 0.5f, 2.0f, "%.2f"))
        g_hitScale = v;
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip(">1.0 = wider safety margin around bullets.\n"
                          "1.0 = matches Realm's actual Chebyshev AABB.");

    v = g_planStepMs;
    if (ImGui::SliderFloat("Plan step (ms)##xd", &v, 10.f, 200.f, "%.0f"))
        g_planStepMs = v;
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Milliseconds between spacetime grid slices.\n"
                          "Smaller = finer time resolution, more compute.\n"
                          "Default 50 ms ≈ 3 frames at 60fps.");

    int rn = g_rebuildN;
    if (ImGui::SliderInt("Rebuild every N frames##xd", &rn, 1, 10))
        g_rebuildN = rn;
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Danger grid is rebuilt every N game frames.\n"
                          "3 = ~50ms at 60fps (matches XDriver cadence).\n"
                          "1 = rebuild every frame (max accuracy, more CPU).");

    ImGui::Spacing();
    ImGui::Text("Goal pathing (A*)");
    bool aOn = g_astarEnabled.load(std::memory_order_relaxed);
    if (ImGui::Checkbox("A* goal tier##xd", &aOn))
        g_astarEnabled.store(aOn, std::memory_order_relaxed);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Weighted A* toward an external goal while SAFE.\n"
                          "Any danger → snappy BFS escape instead.\n"
                          "Off = exact BFS-only build.");
    bool wOn = g_weightingEnabled.load(std::memory_order_relaxed);
    if (ImGui::Checkbox("Weighted danger field##xd", &wOn))
        g_weightingEnabled.store(wOn, std::memory_order_relaxed);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Sparse fringe ring around bullets shapes A* cost\n"
                          "(smoother/safer paths). Invisible to BFS.\n"
                          "Off = binary grid (old behavior).");
    bool sgOn = g_smartGoalEnabled.load(std::memory_order_relaxed);
    if (ImGui::Checkbox("Smart goal##xd", &sgOn))
        g_smartGoalEnabled.store(sgOn, std::memory_order_relaxed);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("A* aims at the safest cell near the intended\n"
                          "goal instead of the raw goal cell. A* only;\n"
                          "BFS keeps the raw goal. Off = raw goal cell.");
    bool ppOn = g_perpEnabled.load(std::memory_order_relaxed);
    if (ImGui::Checkbox("Perp bias##xd", &ppOn))
        g_perpEnabled.store(ppOn, std::memory_order_relaxed);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("A* prefers sidesteps perpendicular to the\n"
                          "incoming bullet flow. Self-disables in\n"
                          "crossfire. A* only.");
    bool smOn = g_speedMatchEnabled.load(std::memory_order_relaxed);
    if (ImGui::Checkbox("Speed match (anti rubber-band)##xd", &smOn))
        g_speedMatchEnabled.store(smOn, std::memory_order_relaxed);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Scales time slices to realized player speed and\n"
                          "clamps the commanded step to reach. BFS + A*.\n"
                          "Off = fixed plan-step, no clamp (old behavior).");
    bool wcOn = g_walkCacheEnabled.load(std::memory_order_relaxed);
    if (ImGui::Checkbox("Walkability cache##xd", &wcOn))
        g_walkCacheEnabled.store(wcOn, std::memory_order_relaxed);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Caches the static-wall layer (recompute on\n"
                          "grid-recenter / 0.5s, not per bullet spawn).\n"
                          "Stops stalling the game thread → AutoNexus on\n"
                          "time. Cost-only. Off = recompute every rebuild.");
    bool waOn = g_wallAvoidEnabled.load(std::memory_order_relaxed);
    if (ImGui::Checkbox("Wall avoidance##xd", &waOn))
        g_wallAvoidEnabled.store(waOn, std::memory_order_relaxed);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Graded fringe around walls (A* keeps clearance)\n"
                          "+ diagonal corner-clip filter (BFS+A* won't cut\n"
                          "between two wall cells). Off = walls hard-block\n"
                          "only (old behavior).");

    bool dpOn = g_drawPathEnabled.load(std::memory_order_relaxed);
    if (ImGui::Checkbox("Draw planned path (debug)##xd", &dpOn))
        g_drawPathEnabled.store(dpOn, std::memory_order_relaxed);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Overlay the planned route on screen:\n"
                          "A* polyline (green; next=yellow, goal=red)\n"
                          "or the BFS committed step.");

    ImGui::Spacing();
    ImGui::TextDisabled("obsSpeed %.2f t/s  effStep %.0f ms",
                        g_obsSpeed, g_effStepMs);
    const char* tier = g_planTier == PlanTier::AStar ? "A*"
                     : g_planTier == PlanTier::BFS ? "BFS"
                     : g_planTier == PlanTier::Fallback ? "Fallback" : "idle";
    ImGui::TextDisabled("Plan: %s (%s)", g_havePlan ? "active" : "idle", tier);
    ImGui::TextDisabled("Next: (%.2f, %.2f)", g_nextX, g_nextY);
}

} // namespace XDodge
