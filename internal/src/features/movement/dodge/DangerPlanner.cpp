#include "pch-il2cpp.h"
#include "DangerPlanner.h"
#include "DodgeGeometry.h"
#include "MovementRuntime.h"
#include "XDodge.h"
#include "RolloutDodge.h"
#include "ZDodge.h"
#include "RePP.h"
#include "PJDodge.h"
#include "features/movement/udodge/UDodge.h"
#include "DbgFileLog.h"
#include "SteerInput.h"
#include "GhostHit.h"
#include "ProjectileTracking.h"
#include "LocalPlayer.h"
#include "GameState.h"
#include "Il2CppResolver.h"
#include "RuntimeOffsets.h"
#include "MemRead.h"
#include "Il2CppHook.h"
#include "BootGate.h"
#include "helpers.h"
#include "AutoAim.h"
#include "ChatToast.h"
#include "gui/tabs/TestTAB.h"
#include "gui/tabs/WorldTAB.h"

#include <cstdio>

#include "minhook/MinHook.h"

#include <algorithm>
#include <atomic>
#include <cfloat>
#include <cmath>
#include <cstring>
#include <windows.h>

namespace {

// ── Shared planner constants ─────────────────────────────────────────────
//
// Server enforces a hard cap on per-tick walk distance after the SPD-
// derived multiplier; exceeding it triggers reconciliation snap-backs.
// 9.4 tps was empirically the highest sustainable cap that didn't trigger.
constexpr float kMaxWalkTps = 9.4f;

// Cells the planner can technically reach but should treat as a
// last-resort: cells the validator marked unsafe, transit checks rejected,
// or that would require the player to clip a wall corner. The penalty has
// to outweigh any normal severity (typical layered sum < 1500), but stay
// finite so a trapped player still has SOMETHING to pick.
constexpr float kVetoedCellPenalty = 5000.f;

// Local alias for the SEH-safe position predictor — body lives in
// ProjectileTracking.cpp now (was duplicated here and in DangerMap.cpp).
inline void SehComputeProjPos(const WorldProjectile& p, float tMs, float& outX, float& outY)
{
    ProjectileTracking::ComputePosAtSafe(p, tMs, outX, outY);
}

bool ReadLivePlayerPosition(void* player, float& outX, float& outY)
{
    outX = 0.f;
    outY = 0.f;
    if (!player) return false;
    if (!Mem::TryRead(player, RuntimeOffsets::PosX, outX)) return false;
    if (!Mem::TryRead(player, RuntimeOffsets::PosY, outY)) return false;
    return std::isfinite(outX) && std::isfinite(outY);
}

// ── Dodge hit-scale (shared with MovementCorrector) ──────────────────────
// Player-tunable multiplier on effective bullet half-size for the
// CCD-based modes (Radial / Precision) and the MovementCorrector hook.
// 1.0 matches game; <1 tightens dodges (closer brushes), >1 widens for
// safety margin. Hybrid is unaffected — it scores pre-computed DangerMap
// stamps that already include their own hitbox derivation. Geometry
// helpers (InProjAabb, PushOutsideAabb, CircleSeamPoints) live in
// DodgeGeometry.h so MovementCorrector can use the exact same math
// without code duplication.
std::atomic<float> s_dodgeHitScale{ 1.0f };

inline float DodgeHitScaleNow()
{
    return s_dodgeHitScale.load(std::memory_order_relaxed);
}

// Local using-aliases so existing call sites don't need a namespace
// prefix on every helper invocation.
using DodgeGeometry::InProjAabb;
using DodgeGeometry::PushOutsideAabb;
using DodgeGeometry::CircleSeamPoints;

// ── IL2CPP glue — mirrors AStarDodge resolution pattern ──────────────────
using MoveToFn        = bool(__fastcall*)(void* __this, float x, float y, void* methodInfo);
using CalcMoveSpeedFn = float(__fastcall*)(void* __this, void* methodInfo);
using GetDeltaTimeFn  = float(__cdecl*)(void* method);

MoveToFn        s_fnMoveTo        = nullptr;
CalcMoveSpeedFn s_fnCalcMoveSpeed = nullptr;
GetDeltaTimeFn  s_fnGetDeltaTime  = nullptr;
bool s_moveResolved = false, s_cmsResolved = false, s_dtResolved = false;

void ResolveMoveTo()
{
    if (s_moveResolved) return;
    const MethodInfo* mi = Il2CppHook::ResolveMethodCached("FKALGHJIADI", "DGLCONCOIBO", 2);
    if (!mi) return;
    s_fnMoveTo = reinterpret_cast<MoveToFn>(mi->methodPointer);
    s_moveResolved = true;
}
void ResolveCalcMoveSpeed()
{
    if (s_cmsResolved) return;
    const MethodInfo* mi = Il2CppHook::ResolveMethodCached("FKALGHJIADI", "GCFKGLKAPND", 0);
    if (!mi) return;
    s_fnCalcMoveSpeed = reinterpret_cast<CalcMoveSpeedFn>(mi->methodPointer);
    s_cmsResolved = true;
}
void ResolveDeltaTime()
{
    if (s_dtResolved) return;
    const MethodInfo* mi = Il2CppHook::ResolveMethodCached("Time", "get_deltaTime", 0,
                                                            false, "UnityEngine");
    if (!mi) return;
    s_fnGetDeltaTime = reinterpret_cast<GetDeltaTimeFn>(mi->methodPointer);
    s_dtResolved = true;
}

float s_lastDeltaTime = 0.016f;

// Wall-clock delta between successive AppEngineManager::Update calls.
// Using Unity's `Time.deltaTime` directly was wrong when the hook fired
// multiple times per render frame — every invocation read the same
// frame-wide delta, and each one walked the character `tilesPerSec × dt`,
// so we moved 2–3× the legitimate walk speed per second. A true inter-
// call wall-clock delta makes the per-frame budget honest regardless
// of how often the hook fires.
static LARGE_INTEGER s_wallFreq = []{ LARGE_INTEGER f{}; QueryPerformanceFrequency(&f); return f; }();
static LARGE_INTEGER s_lastMoveWallTick{};

float GetDeltaTime()
{
    LARGE_INTEGER now{};
    QueryPerformanceCounter(&now);
    if (s_lastMoveWallTick.QuadPart == 0 || s_wallFreq.QuadPart == 0) {
        s_lastMoveWallTick = now;
        // First call after (re)install — fall back to Unity's frame dt
        // or the last-seen value so we don't overshoot with a huge gap.
        float seed = s_lastDeltaTime;
        if (s_fnGetDeltaTime) {
            __try { seed = s_fnGetDeltaTime(nullptr); }
            __except (EXCEPTION_EXECUTE_HANDLER) {}
        }
        if (seed <= 0.f || seed > 0.5f) seed = s_lastDeltaTime;
        s_lastDeltaTime = seed;
        return seed;
    }
    const double elapsed = double(now.QuadPart - s_lastMoveWallTick.QuadPart)
                         / double(s_wallFreq.QuadPart);
    s_lastMoveWallTick = now;
    float dt = static_cast<float>(elapsed);
    // Clamp to sane bounds — catches hook install edge + alt-tab stalls.
    if (dt <= 0.f)   dt = 0.f;
    if (dt > 0.1f)   dt = 0.1f;   // 10 fps floor
    s_lastDeltaTime = dt;
    return dt;
}

float GetMoveSpeedMul(void* player)
{
    if (!s_fnCalcMoveSpeed || !player) return 1.f;
    float result = 1.f;
    __try { result = s_fnCalcMoveSpeed(player, nullptr); }
    __except (EXCEPTION_EXECUTE_HANDLER) { result = 1.f; }
    if (!std::isfinite(result) || result <= 0.f) result = 1.f;
    return result;
}

bool CallMoveTo(void* player, float x, float y)
{
    if (!player) return false;
    // One-shot probe: log the ACTUAL runtime class of the player object.
    // DGLCONCOIBO (MoveTo) is virtual; DodgeRuntime::CallMoveTo re-dispatches
    // through the object's vtable, and this line confirms what class it saw.
    static volatile LONG s_logN = 0;
    if (InterlockedIncrement(&s_logN) == 1) {
        __try {
            Il2CppClass* c = il2cpp_object_get_class(reinterpret_cast<Il2CppObject*>(player));
            const char* cn = c ? il2cpp_class_get_name(c) : "(nullcls)";
            const char* ns = c ? il2cpp_class_get_namespace(c) : "";
            char buf[256];
            snprintf(buf, sizeof(buf),
                     "[Dodge] CallMoveTo: live player class = %s::%s",
                     (ns && *ns) ? ns : "<g>", cn ? cn : "?");
            DbgFileLogWrite(buf);
        } __except (EXCEPTION_EXECUTE_HANDLER) {
            DbgFileLogWrite("[Dodge] CallMoveTo: class lookup faulted");
        }
    }
    // Single MoveTo path for all dodge engines: virtual-dispatch aware,
    // SEH-guarded, resolved by name (see MovementRuntime.cpp).
    DodgeRuntime::EnsureResolved();
    return DodgeRuntime::CallMoveTo(player, x, y);
}

// (Removed) InjectMoveInput — writing MoveDirX/Y/Moving does nothing
// because those are OUTPUT status fields the game writes to reflect its
// own motion state, not input fields that drive the movement system.
// The real keyboard-equivalent is calling DGLCONCOIBO directly — that's
// what the game's input handler itself invokes.

// ── Planner state ────────────────────────────────────────────────────────
std::atomic<bool>   s_enabled{ false };
// (s_wasdLookahead removed — was never read; the WASD passthrough at the
// bottom of this file uses a literal 0.6f tile threshold. If you ever
// need the slider back, wire it into the SteerInput passthrough check.)
// Goal-search radius. Intentionally LARGER than `s_pathMaxTiles` (path
// commit radius) so the planner evaluates safer cells a couple tiles
// beyond what it can walk in a single plan — those far-out greens end up
// as the targeted goal, A* produces a 3-tile path toward them, and the
// next tick continues the migration. This implements the "primary 3 tiles
// for movement, secondary outer ring for considering safer areas" model.
// Strategic search radius (tiles). A* plans within this bubble around
// the player for the idle/threatened strategic goal. Default 5 tiles:
// big enough to see past typical bullet-hell patterns (3-5 tile wide
// shotguns, converging arcs), small enough that plans stay fast and
// relevant to the immediate tactical situation.
std::atomic<float>  s_tightLeashRadius{ 4.0f };
std::atomic<float>  s_idleMinGain{ 0.4f };
std::atomic<float>  s_stickiness{ 0.3f };
std::atomic<bool>   s_replanOnHazardSpawn{ true };
std::atomic<bool>   s_hazardRebuildFlag{ false };

std::atomic<float>  s_extGoalX{ 0.f };
std::atomic<float>  s_extGoalY{ 0.f };
std::atomic<bool>   s_extGoalActive{ false };

// Walk-to-spot goal (Shift+Click empty ground). Dedicated UDodge-consumed slot,
// independent of the external-goal (IPC) channel and the enemy lock.
std::atomic<float>  s_walkGoalX{ 0.f };
std::atomic<float>  s_walkGoalY{ 0.f };
std::atomic<bool>   s_walkGoalActive{ false };

// Enemy lock state.
std::atomic<int32_t> s_lockEnemyId{ 0 };
// Player-follow lock — Shift+click on a friendly player to follow them.
// Different from enemy lock: no weapon-range ring, no orbit, just feed
// the player's live position into the dodge planner as an external goal
// so the character walks toward them while still dodging bullets.
std::atomic<int32_t> s_followPlayerId{ 0 };
// Last resolved world position of the follow target — sticky so the
// planner can keep pursuing through brief scroll-offs / offscreen gaps
// without dropping the lock. Cleared on ClearFollowPlayer.
std::atomic<float>   s_followLastX{ 0.f };
std::atomic<float>   s_followLastY{ 0.f };
std::atomic<bool>    s_followHaveLast{ false };
// Follow distance = weaponRange × this ratio. 0.9 sits just inside max
// range, so shots always land but we're not parked at the razor-thin
// edge where a 1-tile overshoot would break the lock. Previously 0.85
// which was safe but gave up 15% of potential damage uptime.
std::atomic<float>   s_followPaddingRatio{ 0.9f };
std::atomic<float>   s_fallbackRangeTiles{ 5.0f };
// When true (default): follow distance is derived from the equipped
// weapon's actual projectile range (AutoAim::GetProjRangeTiles). When
// false: use s_fallbackRangeTiles verbatim — useful if you want a
// consistent orbit radius regardless of gear swaps.
std::atomic<bool>    s_useWeaponRange{ true };
std::atomic<bool>    s_autoLockEnabled{ false };      // auto-acquire nearest in-range enemy
uint64_t             s_autoLockNextScanMs{ 0 };       // throttle to 250 ms/scan
std::atomic<int>     s_lockMissStreak{ 0 };          // consecutive ticks enemy unresolved
std::atomic<float>   s_lockLastEnemyX{ 0.f };
std::atomic<float>   s_lockLastEnemyY{ 0.f };
std::atomic<bool>    s_lockLastResolved{ false };
std::atomic<float>   s_lockLastRangeTiles{ 0.f };     // follow-distance (parked-at)
std::atomic<float>   s_lockLastWeaponRange{ 0.f };    // raw weapon range (shot reach)
constexpr int kLockMaxMissTicks = 4;                  // auto-unlock after ~4 ticks missing
// Lock-follow → A* bridge master toggle. Off ⇒ the lock id is stored (the
// Shift+LMB chord still toggles it) but it drives no movement — exactly
// today's behavior. Default on.
std::atomic<bool>    s_lockFollowEnabled{ true };

// Auto enemy-lock. When no manual Shift+Click lock is set, the resolver
// can auto-select a target so the dodge still stays in range of an enemy.
// Modes (match the dashboard's `enemyAutoLock` select):
//   0 = Off (manual only — today's behaviour)
//   1 = Closest enemy to the player
//   2 = Whatever auto-aim is currently targeting (delegates HP / mouse
//       selection to the auto-aim plugin's own mode setting)
// Manual lock always wins when set, so this never fights the user.
std::atomic<int>      s_autoLockMode{ 0 };

// Auto-lock target tracking. Without this, mode 1 just re-picks the
// closest enemy each tick — if your target dies, the lock silently
// transfers to the next-closest with no "unlock" feedback, and the bot
// keeps standing-off as if nothing happened. We now:
//   - remember the picked enemy id across ticks
//   - detect when that id is no longer in the live-enemy list (= died)
//   - publish a visible release (ClearExternalGoal) AND hold a short
//     cooldown so the user sees the unlock before we re-acquire
std::atomic<int32_t>  s_autoLockTargetId{ 0 };
std::atomic<uint64_t> s_autoLockReleaseUntilMs{ 0 };
constexpr uint64_t    kAutoLockReleaseHoldMs = 600;

// Orbit direction for lock-follow. +1 = CCW, -1 = CW. Auto-flips when
// the chosen direction has produced no angular progress for several
// consecutive ticks (typically: boss pinned against a wall, so the CCW
// tangent is always blocked). Flipping gives the other side a chance.
std::atomic<int>   s_lockOrbitSign{ +1 };
float              s_lockLastAngle  = 0.f;   // player's angle around enemy last plan
int                s_lockStuckTicks = 0;     // plans with no angular motion

// Custom rebuild cadence. 0 = server-tick driven (default, ~200 ms).
// Positive values override and force a rebuild every N ms on top of tick/
// hazard/release triggers. Never rebuilds more than once per Unity frame.
// Default 150 ms (was 50 ms / 20 Hz). The previous cadence regenerated
// the plan + exec target at 20 Hz on top of the tick-driven 5 Hz and
// hazard-spawn triggers — effectively re-picking the path every 30-50 ms
// in combat, which is far more "twitchy" than the old PrecisionDodge.
// At 150 ms the planner still reacts to hazard spawns immediately
// (separate trigger), but quiet-frame replans no longer chase a moving
// target.
std::atomic<float> s_rebuildIntervalMs{ 150.f };
uint64_t           s_lastPlanTickMs = 0;

// Maximum world-tile distance the planner will commit to in one plan. Goals
// further away are clipped to the boundary along the direction from player
// to goal. We replan every tick, so short-horizon plans are enough to steer
// around threats as they develop.
// A* search scope. Goal is clipped to this radius before A* runs, so
// the search bubble is bounded regardless of how far the strategic
// target is (lock follow ring, idle-safest cell, external goal). Far
// bosses don't cause expensive long-path searches. 3 tiles is enough
// to see past most bullet patterns without blowing CPU.
std::atomic<float> s_pathMaxTiles{ 3.f };

// BFSDodge-style post-arrival safety window: a cell is only considered
// passable when a projectile won't arrive within `arrivalMs + window`. Lets
// us thread through bullet patterns by timing, not just occupancy. When
// auto-tune is on (default), DoPlan overrides this per-plan based on
// tilesPerSec — fast chars need less safety (they leave the cell sooner),
// slow chars need more. Manual mode: user's slider value persists.
std::atomic<float> s_postArrivalSafetyMs{ 100.f };
std::atomic<bool>  s_autoTuneSafetyMs{ true };

// Perpendicular-move bonus: A* neighbor cost is penalised by
// `perpWeight × |moveDir · incomingDir|`. 0 disables. Auto-tune scales
// up in dense bullet regions (where sidestepping wins big) and down in
// open regions (where direct paths are fine).
std::atomic<float> s_perpPenaltyWeight{ 0.3f };
std::atomic<bool>  s_autoTunePerpWeight{ true };

// Path-smoothing toggle. When true, SmoothPath collapses consecutive A*
// waypoints as long as LOS is clear — produces a few long segments for
// clean movement but hides the per-cell route on the debug map. When
// false, the raw A* cell-by-cell path is kept: more waypoints to walk
// through (still fine for RefreshExecTarget's interpolation) and a
// visually richer strategic path on the map. Default OFF because the
// strategic path is the planner's "recommendation" — we want to see
// exactly which cells A* chose, not a collapsed version.
// Default ON: without smoothing the bot walks an 8-direction staircase
// because A* outputs grid waypoints. Old PrecisionDodge walked straight
// lines from player to safe spot; smoothing closes the gap by collapsing
// colinear waypoints and removing micro-zigzags.
std::atomic<bool>  s_smoothPathEnabled{ true };

// Toggle for the strategic-direction bias injected into the reflex
// layer. The reflex layer rewards sidesteps that align with this
// direction when multiple are similarly safe — which amplifies any
// corner-bias in goal selection into an observable bottom-left drift.
// Setting this off makes reflex decisions purely threat-local (no
// strategic pull). Leaves strategic A* planning itself untouched.
std::atomic<bool>  s_strategicBiasEnabled{ true };

// Hit-aversion multiplier — how uncomfortable the planner is with
// eating shots. Applied as a divisor on the per-plan damage budget
// and as a multiplier on the lock-follow "ring is too hot" / "eat
// chip damage to keep lock" severity thresholds. Default 1.0 = old
// behavior. Higher values (1.5–3.0) make the planner refuse paths
// that clip bullets, dropping into idle-reactive earlier. Lower
// values (0.5–0.8) let the planner brute through a pattern when the
// detour would cost more than the hit.
// Range clamped [0.25, 4.0] at setter.
std::atomic<float> s_hitAversion{ 1.0f };

// When true, the published `strategicDir` uses a NEAR-term waypoint
// (first couple of tiles of the path) rather than the path's FAR end.
// Prevents a long A* path that tails bottom-left from biasing reflex
// toward the far-corner goal when the committed next step is a short
// hop in a completely different direction.
std::atomic<bool>  s_strategicUseNearWaypoint{ true };

// Weight applied to the DangerMap's `areaDensity` layer — a 3-cell-radius
// neighborhood severity sum. Default is intentionally low so gap cells
// BETWEEN bullets aren't penalised by their clustered neighbors — the
// planner should be able to thread a gap that the shortest route passes
// through. Raise this when you want the planner to more actively avoid
// bullet-dense regions entirely.
std::atomic<float> s_areaDensityWeight{ 0.0001f };

// Emergency short-range teleport — only fires when walking isn't survivable.
// Same position-write trick as TestTAB's Ctrl+click teleport.
// Emergency response trigger. Now a SPEED BOOST (not raw teleport):
// when the trigger fires, activates s_boostExpiryMs for a brief window
// and the frame phase uses a higher per-step budget. All moves still
// go through CallMoveTo → server-authorized, no snap-backs. The old
// raw-write teleport caused anti-cheat issues; this doesn't.
// Emergency speed boost — default OFF. When on, a trapped-state trigger
// activates a short window where the frame phase uses maxStep × boost
// multiplier (default 1.3×). With small hitbox defaults the trigger's
// "current cell severity ≥ 200" predicate fires inconsistently and can
// give the impression the character is moving faster than its legitimate
// speed stat. Users can re-enable from the Movement tab if they want
// the extra headroom when genuinely trapped.
std::atomic<bool>  s_tpEnabled{ false };
std::atomic<float> s_tpMaxTiles{ 2.f };
std::atomic<float> s_tpCooldownMs{ 900.f };
uint64_t           s_tpLastFireMs = 0;

// Dynamic severity-to-cost multiplier updated at plan time based on the
// local player's current HP / MaxHP / Defense. Low HP makes danger cells
// more expensive (avoid hits harder). High defense slightly reduces caution
// (hits matter less). See `RefreshStatCostMultiplier`.
std::atomic<float> s_statCostMult{ 1.0f };

// Effective move-speed multiplier (CalcMoveSpeed return value). Cached
// each tick before DoPlan runs so the planner's timing math uses the
// real speed including status effects (slowed, speedy, paralyzed). Base
// tilesPerSec × this multiplier = actual tiles/sec walked.
std::atomic<float> s_cachedMoveSpeedMul{ 1.0f };

// Emergency SPEED BOOST (replaces raw-write teleport). When the player
// is about to take a hit and no walking neighbor is safer, instead of
// raw-writing the position (which causes server snap-backs), we boost
// the interpolation rate for a short window. The native CallMoveTo
// still clamps to the game's internal speed cap — so this is safe in
// the sense that it never exceeds what the game allows — but when the
// character's base step is under-using the cap (e.g., framerate dips,
// sub-step smoothing) the boost squeezes out the remaining budget.
// Duration is short so if it does trip anti-cheat, the window is brief.
std::atomic<uint64_t> s_boostExpiryMs{ 0 };
std::atomic<float>    s_boostMultiplier{ 1.3f };   // tunable, 1.0 = off
std::atomic<uint64_t> s_boostDurationMs{ 300 };    // how long each boost lasts
uint64_t s_boostLastFireMs = 0;
std::atomic<int32_t> s_lastStatHp{ 0 };
std::atomic<int32_t> s_lastStatMaxHp{ 1 };
std::atomic<int32_t> s_lastStatDef{ 0 };

// ── Tick-aligned execution target ───────────────────────────────────────
// The ghost-hit fix: server hit detection uses our reported positions at
// tick boundaries (~200 ms) and linearly interpolates between them. If we
// change direction mid-tick, our actual sub-tick path deviates from the
// server's interpolation, so projectiles that miss visually can register
// on the server-interpolated line. Solution: lock an "execution target"
// at each tick boundary (a single point we'll be at by next tick) and
// only interpolate smoothly toward that point until the next tick.
// Replans between ticks still update the plan (for visualisation / future
// ticks) but do NOT change what we're walking toward this tick.
std::atomic<float> s_execTargetX{ 0.f };
std::atomic<float> s_execTargetY{ 0.f };
std::atomic<bool>  s_execTargetValid{ false };
uint32_t s_execTickId = 0;

// When true, exec-target refresh is restricted to server-tick boundaries
// (plus first-fire and WASD-release). Hazard-spawn and interval triggers
// still run DoPlan, but the live target the character walks toward stays
// locked across the tick. Eliminates mid-tick direction changes → matches
// server's linear-interpolation assumption → fewer ghost hits. Trade-off:
// up to ~200 ms reaction delay on projectiles that spawn mid-tick.
//
// Default false = reactive (current behavior). Flip on to A/B.
std::atomic<bool> s_execStrictTickLock{ false };

// ── Hybrid mode — path-biased greedy step at frame rate ─────────────────
// When enabled, DoFrameMove replaces A*-waypoint following with an 8-
// neighbor greedy step that uses the existing A* waypoints only as a
// reference path for bias. Goal selection + A* still run per tick; the
// difference is purely in HOW the character walks along the committed plan.
std::atomic<bool>  s_hybridMode     { false };
// ── Precision mode — CCD-per-candidate projectile threat ────────────────
std::atomic<bool>  s_precisionMode   { false };
std::atomic<float> s_precSampleMs    { 30.f };   // bullet sample cadence
std::atomic<float> s_precHorizonMs   { 800.f };  // how far ahead we predict
// ── Radial mode — radial scan + binary refine out from player position ──
// No grid neighbours; pure continuous angle/distance search with a
// perpendicular-to-shot bias. Defaults match the old "PrecisionDodge"
// weights (kParallelToShotPenalty=0.32, kIntentBonus=0.18) which the
// other lead dev liked the feel of.
std::atomic<bool>  s_radialMode      { false };
std::atomic<float> s_radHorizonMs    { 600.f };
std::atomic<float> s_radSampleMs     { 15.f };
std::atomic<float> s_radPerpWeight   { 0.32f };
std::atomic<float> s_radIntentWeight { 0.18f };
std::atomic<float> s_radMaxSearchDist{ 1.50f };
// Hybrid bias knobs. kPath pulls the greedy toward A*'s strategic
// direction; kGoal pulls it toward A*'s actual goal cell (engagement
// ring / escape cell). Both are clamped small enough that threat
// severity (weighted 3–4.5×) still dominates when a cell is stamped,
// but in open ground they give the character real commitment to the
// plan instead of chattering in place.
std::atomic<float> s_hybridPathW    { 1.0f };
std::atomic<float> s_hybridGoalW    { 0.6f };   // weight on distance-to-goal-cell reduction
std::atomic<float> s_hybridDirW     { 0.3f };   // k_dir — continuity penalty
// Hard-veto window: neighbors whose earliest-hit-ms falls inside this
// window are scored as essentially infinite cost. Was 120 ms — tighter
// than most characters' per-tile walk time, which meant a shot arriving
// in 150 ms (technically "fine" by veto) still clipped the player
// because they hadn't finished stepping. 250 ms covers a typical 6 tps
// character's reaction + step budget with margin to spare.
std::atomic<float> s_hybridMinHitMs { 250.f };
// Last-step direction — sampled from the last step actually committed
// via CallMoveTo. Used to bias the next greedy pick toward directional
// continuity so the character doesn't chatter between opposite cells.
std::atomic<float> s_hybridLastDirX { 0.f };
std::atomic<float> s_hybridLastDirY { 0.f };
std::atomic<bool>  s_hybridLastDirValid { false };

std::atomic<float>  s_lastTickMs{ 0.f };
std::atomic<float>  s_lastPlanMs{ 0.f };
const char*         s_lastFallback = "ok";
std::atomic<bool>   s_noPath{ false };       // true when the current plan is "park in place — no route found"
std::atomic<int>    s_noPathExpansion{ 0 };  // how many radius-expansion retries fired this plan (debug readout)
// Goal source tracker — enumerates which code path picked the current
// goal. Lets the debug map answer "why is my path going there?" at a
// glance instead of forcing us to guess.
// 0=none, 1=external, 2=lock, 3=idle, 4=stayput, 5=expansion, 6=eatHits, 7=hysteresis
std::atomic<int>    s_goalSource{ 0 };
std::atomic<float>  s_goalWorldX{ 0.f };
std::atomic<float>  s_goalWorldY{ 0.f };

// Path state (planner-thread only).
constexpr int kMaxWaypoints = 48;
struct Waypoint { float x, y; };

// Double-buffered so the render thread's `GetWaypoints` never observes
// a partial write. Plan writes into s_path[1-readIdx], then stores
// readIdx atomically with release semantics. Readers acquire readIdx
// and consume that buffer; at most one rebuild cycle of staleness.
std::atomic<int>    s_pathLen{ 0 };
Waypoint            s_path[2][kMaxWaypoints]{};
std::atomic<int>    s_pathReadIdx{ 0 };
// Commit distance (tiles). Strategic plan may extend further than this;
// RefreshExecTarget / frame phase only walk up to s_commitTiles of
// cumulative path distance. Renderer uses this to split strategic
// (dim) from tactical (bright) portions of the displayed path.
std::atomic<float>  s_commitTiles{ 2.5f };

// Strategic direction — unit vector from player toward the far endpoint
// of the current plan's smoothed path. Computed once per plan and used
// by the SUB-TICK tactical layer (frame reflex) as an alignment bias
// when choosing sidestep directions. "Prefer sidesteps that still make
// progress toward the strategic target, over ones that retreat."
std::atomic<float>  s_strategicDirX{ 0.f };
std::atomic<float>  s_strategicDirY{ 0.f };
std::atomic<bool>   s_strategicDirValid{ false };
std::atomic<int>    s_pathIdx{ 0 };
std::atomic<int>    s_prevGoalGx{ -1 };
std::atomic<int>    s_prevGoalGy{ -1 };

// Published step target (what Frame phase walks toward).
std::atomic<float>  s_stepX{ 0.f };
std::atomic<float>  s_stepY{ 0.f };
std::atomic<bool>   s_stepValid{ false };
std::atomic<bool>   s_validatorHolding{ false };

uint32_t s_lastServerTickId = 0;

// Frame-level sub-tick reflex dodge layer (retained for API compat).
std::atomic<bool>  s_reflexEnabled{ true };

// ── Hazard-spawn callback ────────────────────────────────────────────────
void OnHazardSpawn(const WorldProjectile& /*p*/, void*)
{
    if (!s_enabled.load(std::memory_order_relaxed)) return;
    if (!s_replanOnHazardSpawn.load(std::memory_order_relaxed)) return;
    s_hazardRebuildFlag.store(true, std::memory_order_release);
}

// ─────────────────────────────────────────────────────────────────────────────
// ResolveEnemyLock — the missing lock→goal bridge.
//
// Non-invasive: adds NO game read/hook. Reuses connections that already run
// every frame — AutoAim::EnumerateLiveEnemies (the same enemy scan auto-aim
// uses) to find the locked id's world pos, AutoAim::GetProjRangeTiles for
// the stand-off radius — and publishes through the EXISTING SetExternalGoal
// channel that XDodge's A* already consumes. So our weighted A* paths to
// the lock (smart-goal refines to the safest nearby cell, BFS still
// preempts on imminent danger). Pure algorithm; the game-move path is
// untouched. Off (s_lockFollowEnabled) ⇒ no movement effect = today.
// ─────────────────────────────────────────────────────────────────────────────
static void ResolveEnemyLock(float px, float py)
{
    if (!s_lockFollowEnabled.load(std::memory_order_relaxed)) return;

    const int32_t id = s_lockEnemyId.load(std::memory_order_relaxed);
    bool  found = false;
    float ex = 0.f, ey = 0.f;

    if (id != 0) {
        // Manual Shift+Click lock — always wins when set.
        struct Ctx { int32_t want; bool found; float ex, ey; } c{ id, false, 0.f, 0.f };
        AutoAim::EnumerateLiveEnemies(
            [](float x, float y, int32_t eid, void* u) {
                auto* k = static_cast<Ctx*>(u);
                if (!k->found && eid == k->want) { k->found = true; k->ex = x; k->ey = y; }
            }, &c);
        found = c.found; ex = c.ex; ey = c.ey;
    } else {
        // No manual lock — try the auto-lock mode.
        const int      mode    = s_autoLockMode.load(std::memory_order_relaxed);
        const uint64_t nowMs   = GetTickCount64();
        const int32_t  lastId  = s_autoLockTargetId.load(std::memory_order_relaxed);
        const uint64_t holdEnd = s_autoLockReleaseUntilMs.load(std::memory_order_relaxed);
        const bool     onCooldown = nowMs < holdEnd;

        if (mode == 0) {
            // Auto-lock disabled — make sure tracking is clean.
            if (lastId != 0)
                s_autoLockTargetId.store(0, std::memory_order_relaxed);
        } else if (mode == 1) {
            // Closest enemy. STICKY: prefer the previously-tracked target
            // (so the lock stays on one enemy across frames). If that id is
            // no longer in the live list = it died / despawned: publish a
            // release pulse + start a short cooldown so the unlock is
            // visible before we re-acquire.
            if (lastId != 0) {
                struct CtxT { int32_t want; bool found; float ex, ey; }
                    ct{ lastId, false, 0.f, 0.f };
                AutoAim::EnumerateLiveEnemies(
                    [](float x, float y, int32_t eid, void* u) {
                        auto* k = static_cast<CtxT*>(u);
                        if (!k->found && eid == k->want) { k->found = true; k->ex = x; k->ey = y; }
                    }, &ct);
                if (ct.found) {
                    found = true; ex = ct.ex; ey = ct.ey;
                } else {
                    // Target gone — start the release window.
                    s_autoLockTargetId.store(0, std::memory_order_relaxed);
                    s_autoLockReleaseUntilMs.store(nowMs + kAutoLockReleaseHoldMs,
                                                   std::memory_order_relaxed);
                }
            }
            if (!found && !onCooldown) {
                // No tracked target (or just lost it). After cooldown,
                // acquire the new closest enemy.
                struct CtxC { float px, py; bool found; float bestD2, ex, ey; int32_t pickedId; }
                    cc{ px, py, false, 1e30f, 0.f, 0.f, 0 };
                AutoAim::EnumerateLiveEnemies(
                    [](float x, float y, int32_t eid, void* u) {
                        auto* k = static_cast<CtxC*>(u);
                        const float dx = x - k->px, dy = y - k->py;
                        const float d2 = dx * dx + dy * dy;
                        if (d2 < k->bestD2) {
                            k->bestD2 = d2; k->ex = x; k->ey = y;
                            k->pickedId = eid; k->found = true;
                        }
                    }, &cc);
                if (cc.found) {
                    found = true; ex = cc.ex; ey = cc.ey;
                    s_autoLockTargetId.store(cc.pickedId, std::memory_order_relaxed);
                }
            }
        } else if (mode == 2) {
            // Follow whatever auto-aim is currently targeting. AutoAim
            // tells us the target id, so we can detect kill/disappear
            // here the same way as mode 1.
            const int32_t aimId = AutoAim::GetAimFocusEnemyId();
            if (aimId == 0 || !AutoAim::HasTarget()) {
                if (lastId != 0) {
                    s_autoLockTargetId.store(0, std::memory_order_relaxed);
                    s_autoLockReleaseUntilMs.store(nowMs + kAutoLockReleaseHoldMs,
                                                   std::memory_order_relaxed);
                }
                // else: nothing to release; just stay idle this tick.
            } else if (!onCooldown) {
                AutoAim::GetAimTarget(ex, ey);
                found = true;
                if (lastId != aimId)
                    s_autoLockTargetId.store(aimId, std::memory_order_relaxed);
            }
        }
        // not found (cooldown, no enemies, or off): fall through to release.
    }

    if (!found) {
        if (s_lockLastResolved.exchange(false, std::memory_order_acq_rel))
            DangerPlanner::ClearExternalGoal();
        return;
    }

    // Stand-off radius = weapon range × padding (existing tunables), else
    // the fallback range. Clamped to a sane band.
    float weaponRange;
    if (s_useWeaponRange.load(std::memory_order_relaxed) && AutoAim::IsProjRangeResolved())
        weaponRange = AutoAim::GetProjRangeTiles();
    else
        weaponRange = s_fallbackRangeTiles.load(std::memory_order_relaxed);
    const float pad   = s_followPaddingRatio.load(std::memory_order_relaxed);
    const float range = std::clamp(weaponRange * pad, 1.0f, 16.0f);

    // Goal = `range` tiles from the enemy along enemy→player (back off to
    // weapon range on the side we're already on — shots still land, we keep
    // distance). A* + smart-goal handle the actual safe routing there.
    const float dx = px - ex, dy = py - ey;
    const float d  = std::sqrt(dx * dx + dy * dy);
    float gx, gy;
    if (d < 1e-3f) { gx = ex + range; gy = ey; }
    else           { gx = ex + dx / d * range; gy = ey + dy / d * range; }

    DangerPlanner::SetExternalGoal(gx, gy);
    s_lockLastEnemyX.store(ex, std::memory_order_relaxed);
    s_lockLastEnemyY.store(ey, std::memory_order_relaxed);
    s_lockLastRangeTiles.store(range, std::memory_order_relaxed);
    s_lockLastWeaponRange.store(weaponRange, std::memory_order_relaxed);
    s_lockLastResolved.store(true, std::memory_order_release);
}

using UpdateFn = void(__fastcall*)(void* __this, void* method);
UpdateFn s_origUpdate = nullptr;
void*    s_hookTarget = nullptr;
bool     s_hookInstalled = false;

// Dodge sensor/planner work for one frame. Extracted from the detour so the
// detour can run it under SEH (see DodgeTickGuarded) without tripping C2712 —
// this body legitimately holds C++ temporaries (ostringstream via DBG_FILE_LOG),
// which a __try scope in the same function cannot unwind.
static void RunDodgeTickBody()
{
    // Two dodge engines run from this hook (mutually exclusive): XDodge
    // (spacetime BFS/A*) and RolloutDodge (forward input-simulation). They
    // share the preamble, goal plumbing, and GhostHit safety net below.
    const bool xdodgeOn  = XDodge::IsEnabled();
    const bool rolloutOn = RolloutDodge::IsEnabled();
    const bool zaclinOn = ZDodge::IsEnabled();
    const bool reppOn   = RePP::IsEnabled();
    const bool pjOn     = PJDodge::IsEnabled();
    const bool uniOn    = UDodge::IsEnabled();
    if (xdodgeOn || rolloutOn || zaclinOn || reppOn || pjOn || uniOn) {
        // BootGate safety gate: on a patched/degraded game the entity/projectile
        // offsets are stale. The dodge sensors fill fixed-size buffers from counts
        // read at those offsets, so a garbage count overruns a buffer and hard-
        // crashes (observed: 0xC0000005 write-AV inside an in-DLL sensor array via
        // memcpy). Skip ALL dodge work until the offsets recover; Degraded() clears
        // and this re-enables automatically once the self-heal writes back healthy
        // offsets. Gating the capture hooks alone was insufficient — the per-frame
        // Tick/sensors read enemies/tiles too, not just the (now-gated) bullets.
        if (BootGate::Degraded()) {
            static int s_degN = 0;
            if ((s_degN++ % 240) == 0)
                DBG_FILE_LOG("[Dodge] Detour gated — BootGate degraded (stale offsets "
                             "after game patch); dodge OFF until offsets refresh "
                             "(attempt=" << s_degN << ")");
            return;
        }
        // Use GameState::GetLocalPtr() directly — the EXACT source AutoAim
        // uses (and AutoAim works). LocalPlayer::GetPtr() is a second-hand
        // mirror refreshed only by LocalPlayer::Tick() on the render thread
        // (dPresent), which is throttled by the Present FPS cap — so this
        // game-update-thread detour read it NULL even when the live ptr was
        // valid. dll-trace confirmed continuous LocalPlayer::GetPtr() NULL.
        void* p = GameState::GetLocalPtr();
        if (!p) {
            static int s_pNullN = 0;
            if ((s_pNullN++ % 240) == 0)
                DBG_FILE_LOG("[Dodge] Detour: GameState::GetLocalPtr() NULL "
                             "(attempt=" << s_pNullN << ") — not in a live world");
            return;
        }
        ResolveDeltaTime();
        const float dt = GetDeltaTime();
        // Player world position read identically to AutoAim, but guarded: the
        // local pointer can go stale during realm transitions / player swap frames.
        float px = 0.f, py = 0.f;
        if (!ReadLivePlayerPosition(p, px, py))
            return;
        // SteerInput maintains the WASD release edge (cheap); it no longer
        // gates. ResolveEnemyLock publishes the lock/auto-lock standoff as the
        // shared external goal that dodge engines can consume.
        SteerInput::Tick();
        ResolveEnemyLock(px, py);
        if (uniOn)          UDodge::Tick(p, px, py, dt);
        else if (pjOn)      PJDodge::Tick(p, px, py, dt);
        else if (reppOn)    RePP::Tick(p, px, py, dt);
        else if (zaclinOn)  ZDodge::Tick(p, px, py, dt);
        else if (rolloutOn) RolloutDodge::Tick(p, px, py, dt);
        else                XDodge::Tick(p, px, py, dt);
        // GhostHit runs independently — a SAFETY net for bullets the game's
        // own per-tick collision skipped. Cheap when off (one atomic load).
        GhostHit::Tick(p, px, py);
        return;
    }
}

// SEH firewall around the dodge frame. A stale-offset sensor read (documented
// in the body above) or any other fault inside dodge must not take down the
// game process: swallow it, log once per ~240 frames, and let the game keep
// running. The __except handler uses only the plain DbgFileLogWrite (no C++
// temporaries) so this function has nothing to unwind (avoids C2712).
static void DodgeTickGuarded()
{
    __try {
        RunDodgeTickBody();
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        static volatile LONG s_ex = 0;
        if ((InterlockedIncrement(&s_ex) % 240) == 1)
            DbgFileLogWrite("[Dodge] detour: SEH caught a fault in dodge tick — "
                            "frame skipped (stale entity/projectile offset?)");
    }
}

void __fastcall Detour_AppEngineUpdate(void* __this, void* method)
{
    if (s_origUpdate) s_origUpdate(__this, method);
    DodgeTickGuarded();
}

} // namespace

namespace DangerPlanner {

void TryInstall()
{
    if (s_hookInstalled) return;

    const MethodInfo* mi = Il2CppHook::ResolveMethodCached("AppEngineManager", "Update", 0);
    void* target = mi ? reinterpret_cast<void*>(mi->methodPointer) : nullptr;
    if (!target) {
        // Throttled so a stuck resolve doesn't flood the log. This is the
        // single most likely reason dodge "does nothing" on an updated game
        // build: AppEngineManager / Update renamed by BeeByte obfuscation.
        static int s_unresolvedN = 0;
        if ((s_unresolvedN++ % 240) == 0)
            DBG_FILE_LOG("[DangerPlanner] TryInstall: AppEngineManager::Update UNRESOLVED "
                         "(attempt=" << s_unresolvedN
                         << ") — hook NOT installed, XDodge will not run");
        return;
    }

    static bool s_mhInit = false;
    if (!s_mhInit) {
        const MH_STATUS st = MH_Initialize();
        if (st != MH_OK && st != MH_ERROR_ALREADY_INITIALIZED) {
            DBG_FILE_LOG("[DangerPlanner] TryInstall: MH_Initialize failed st=" << (int)st);
            return;
        }
        s_mhInit = true;
    }
    if (!Il2CppHook::InstallMinHook(target,
                                    reinterpret_cast<void*>(&Detour_AppEngineUpdate),
                                    reinterpret_cast<void**>(&s_origUpdate),
                                    "DangerPlanner")) {
        DBG_FILE_LOG("[DangerPlanner] TryInstall: hook install FAILED");
        return;
    }

    s_hookTarget    = target;
    s_hookInstalled = true;
    DBG_FILE_LOG("[DangerPlanner] TryInstall: AppEngineManager::Update hook INSTALLED — XDodge live");

    // Reset the wall-clock dt baseline so the very first frame doesn't
    // burn a stale multi-second gap into a single movement budget.
    s_lastMoveWallTick.QuadPart = 0;

    ProjectileTracking::RegisterHazardSpawnCallback(&OnHazardSpawn, nullptr);
}

void Uninstall()
{
    // Balance the consumer ref that SetEnabled(true) took out; skipping this
    // would leave LocalPlayer ticking HP reads for a DLL that's unloading.
    if (s_enabled.exchange(false, std::memory_order_acq_rel)) {
        LocalPlayer::RemoveConsumer();
    }
    s_execTargetValid.store(false, std::memory_order_release);
    ProjectileTracking::ClearHazardSpawnCallback();
    if (s_hookInstalled && s_hookTarget) {
        MH_DisableHook(s_hookTarget);
        MH_RemoveHook(s_hookTarget);
        s_hookTarget    = nullptr;
        s_origUpdate    = nullptr;
        s_hookInstalled = false;
    }
    s_moveResolved = s_cmsResolved = s_dtResolved = false;
    s_fnMoveTo = nullptr;
    s_fnCalcMoveSpeed = nullptr;
    s_fnGetDeltaTime = nullptr;
}

void SetEnabled(bool on)
{
    const bool prev = s_enabled.exchange(on, std::memory_order_acq_rel);
    if (on && !prev) {
        // Registering as a LocalPlayer consumer makes LocalPlayer::Tick read
        // HP / MaxHP / Defense each frame so the stat-aware cost multiplier
        // has live data. Without this, GetHP/GetDefense always return 0.
        LocalPlayer::AddConsumer();
    }
    if (!on && prev) {
        LocalPlayer::RemoveConsumer();
    }
    if (on) TryInstall();
}
bool IsEnabled()          { return s_enabled.load(std::memory_order_acquire); }

void SetExternalGoal(float x, float y)
{
    s_extGoalX.store(x, std::memory_order_relaxed);
    s_extGoalY.store(y, std::memory_order_relaxed);
    s_extGoalActive.store(true, std::memory_order_release);
}
void ClearExternalGoal()  { s_extGoalActive.store(false, std::memory_order_release); }
bool HasExternalGoal()    { return s_extGoalActive.load(std::memory_order_acquire); }
bool GetExternalGoal(float& outX, float& outY)
{
    if (!s_extGoalActive.load(std::memory_order_acquire)) return false;
    outX = s_extGoalX.load(std::memory_order_relaxed);
    outY = s_extGoalY.load(std::memory_order_relaxed);
    return true;
}

void SetWalkGoal(float x, float y)
{
    s_walkGoalX.store(x, std::memory_order_relaxed);
    s_walkGoalY.store(y, std::memory_order_relaxed);
    s_walkGoalActive.store(true, std::memory_order_release);
}
void ClearWalkGoal() { s_walkGoalActive.store(false, std::memory_order_release); }
bool GetWalkGoal(float& outX, float& outY, bool& outActive)
{
    outActive = s_walkGoalActive.load(std::memory_order_acquire);
    if (!outActive) return false;
    outX = s_walkGoalX.load(std::memory_order_relaxed);
    outY = s_walkGoalY.load(std::memory_order_relaxed);
    return true;
}

void SetEnemyLock(int32_t objectId)
{
    // Enemy lock and player follow are mutually exclusive.
    if (objectId != 0) {
        s_followPlayerId.store(0, std::memory_order_relaxed);
        s_followHaveLast.store(false, std::memory_order_relaxed);
    }
    const int32_t prev = s_lockEnemyId.exchange(objectId, std::memory_order_relaxed);
    s_lockMissStreak.store(0, std::memory_order_relaxed);
    s_lockLastResolved.store(false, std::memory_order_relaxed);
    s_hazardRebuildFlag.store(true, std::memory_order_release); // replan immediately
    char buf[96];
    if (prev == 0 || prev == objectId) {
        std::snprintf(buf, sizeof(buf), "Locked target (id %d).", objectId);
    } else {
        // ImGui default font is Latin-1 only; stick to ASCII glyphs.
        std::snprintf(buf, sizeof(buf), "Switched target (id %d -> %d).", prev, objectId);
    }
    ChatToast::Push(ChatToast::Kind::Success, buf);
}
void ClearEnemyLock()
{
    const int32_t prev = s_lockEnemyId.exchange(0, std::memory_order_relaxed);
    s_lockMissStreak.store(0, std::memory_order_relaxed);
    s_lockLastResolved.store(false, std::memory_order_relaxed);
    s_hazardRebuildFlag.store(true, std::memory_order_release);
    if (prev != 0) {
        char buf[96];
        std::snprintf(buf, sizeof(buf), "Unlocked target (id %d).", prev);
        ChatToast::Push(ChatToast::Kind::Info, buf);
    }
}
int32_t GetEnemyLock() { return s_lockEnemyId.load(std::memory_order_relaxed); }
void SetLockFollowEnabled(bool en) { s_lockFollowEnabled.store(en, std::memory_order_relaxed); }
bool GetLockFollowEnabled()        { return s_lockFollowEnabled.load(std::memory_order_relaxed); }
void SetAutoLockMode(int mode)     { s_autoLockMode.store(std::clamp(mode, 0, 2), std::memory_order_relaxed); }
int  GetAutoLockMode()             { return s_autoLockMode.load(std::memory_order_relaxed); }

void SetFollowPlayer(int32_t objectId)
{
    const int32_t prev = s_followPlayerId.exchange(objectId, std::memory_order_relaxed);
    // Toggling player-follow clears enemy lock and vice versa — the
    // two modes are mutually exclusive. Clicking a player should
    // cancel any previous enemy orbit, and clicking an enemy should
    // cancel any previous player pursuit.
    if (objectId != 0) {
        s_lockEnemyId.store(0, std::memory_order_relaxed);
    }
    // Reset sticky last-known position whenever the follow target changes
    // (including on explicit clear). A fresh target shouldn't inherit the
    // previous target's last seen coords.
    s_followHaveLast.store(false, std::memory_order_relaxed);
    s_followLastX.store(0.f, std::memory_order_relaxed);
    s_followLastY.store(0.f, std::memory_order_relaxed);
    s_hazardRebuildFlag.store(true, std::memory_order_release);
    char buf[96];
    if (objectId == 0) {
        if (prev != 0) {
            std::snprintf(buf, sizeof(buf), "Stopped following (id %d).", prev);
            ChatToast::Push(ChatToast::Kind::Info, buf);
        }
    } else if (prev == 0 || prev == objectId) {
        std::snprintf(buf, sizeof(buf), "Following player (id %d).", objectId);
        ChatToast::Push(ChatToast::Kind::Success, buf);
    } else {
        std::snprintf(buf, sizeof(buf), "Switched follow (%d -> %d).", prev, objectId);
        ChatToast::Push(ChatToast::Kind::Success, buf);
    }
}
void ClearFollowPlayer() { SetFollowPlayer(0); }
int32_t GetFollowPlayer() { return s_followPlayerId.load(std::memory_order_relaxed); }
void SetFollowPaddingRatio(float r)
{
    s_followPaddingRatio.store(std::clamp(r, 0.3f, 1.0f), std::memory_order_relaxed);
}
float GetFollowPaddingRatio() { return s_followPaddingRatio.load(std::memory_order_relaxed); }
void SetFallbackRangeTiles(float t)
{
    s_fallbackRangeTiles.store(std::clamp(t, 1.f, 16.f), std::memory_order_relaxed);
}
float GetFallbackRangeTiles() { return s_fallbackRangeTiles.load(std::memory_order_relaxed); }

void  SetUseWeaponRange(bool on) { s_useWeaponRange.store(on, std::memory_order_relaxed); }
bool  GetUseWeaponRange()        { return s_useWeaponRange.load(std::memory_order_relaxed); }

void SetAutoLockEnabled(bool enabled)
{
    s_autoLockEnabled.store(enabled, std::memory_order_relaxed);
    if (!enabled) s_autoLockNextScanMs = 0;
}
bool GetAutoLockEnabled() { return s_autoLockEnabled.load(std::memory_order_relaxed); }

bool GetLockTarget(float& outEnemyX, float& outEnemyY,
                   float& outFollowTiles, float& outWeaponRangeTiles)
{
    if (s_lockEnemyId.load(std::memory_order_relaxed) == 0) return false;
    if (!s_lockLastResolved.load(std::memory_order_relaxed)) return false;
    outEnemyX           = s_lockLastEnemyX.load(std::memory_order_relaxed);
    outEnemyY           = s_lockLastEnemyY.load(std::memory_order_relaxed);
    outFollowTiles      = s_lockLastRangeTiles.load(std::memory_order_relaxed);
    outWeaponRangeTiles = s_lockLastWeaponRange.load(std::memory_order_relaxed);
    return true;
}

bool GetPlannedTarget(float& x, float& y)
{
    if (!s_stepValid.load(std::memory_order_acquire)) return false;
    x = s_stepX.load(std::memory_order_relaxed);
    y = s_stepY.load(std::memory_order_relaxed);
    return true;
}

// Per-tick walking destination — interpolated one server-tick of motion
// along the planned path from the player's current position. This is
// where the character's frame phase actually moves each frame. Different
// from GetPlannedTarget (which returns the PATH ENDPOINT after smoothing,
// usually many tiles away when LOS is clear through the committed path).
bool GetExecTarget(float& x, float& y)
{
    if (!s_execTargetValid.load(std::memory_order_acquire)) return false;
    x = s_execTargetX.load(std::memory_order_relaxed);
    y = s_execTargetY.load(std::memory_order_relaxed);
    return true;
}

int GetWaypoints(float* outXY, int maxPoints)
{
    const int len = std::min(s_pathLen.load(std::memory_order_acquire), maxPoints);
    const Waypoint* path = s_path[s_pathReadIdx.load(std::memory_order_acquire)];
    for (int i = 0; i < len; ++i) {
        outXY[i * 2]     = path[i].x;
        outXY[i * 2 + 1] = path[i].y;
    }
    return len;
}

float GetLastTickMs()        { return s_lastTickMs.load(std::memory_order_relaxed); }
float GetLastPlanMs()        { return s_lastPlanMs.load(std::memory_order_relaxed); }
const char* GetLastFallbackReason() { return s_lastFallback; }

bool NativeMoveTo(void* player, float worldX, float worldY)
{
    // Ensure the function pointer is resolved (no-op after first call).
    ResolveMoveTo();
    return CallMoveTo(player, worldX, worldY);
}

bool IsNoPath()               { return s_noPath.load(std::memory_order_acquire); }
float GetCommitTiles()        { return s_commitTiles.load(std::memory_order_relaxed); }
int  GetNoPathExpansionIdx()  { return s_noPathExpansion.load(std::memory_order_relaxed); }

int  GetGoalSource()          { return s_goalSource.load(std::memory_order_relaxed); }
void GetGoalWorld(float& x, float& y)
{
    x = s_goalWorldX.load(std::memory_order_relaxed);
    y = s_goalWorldY.load(std::memory_order_relaxed);
}

void SetWasdLookahead(float)      { /* stub — atomic removed; passthrough uses literal 0.6f */ }
void SetTightLeashRadius(float t) { s_tightLeashRadius.store(std::clamp(t, 1.f, 12.f), std::memory_order_relaxed); }
void SetIdleMinGain(float v)      { s_idleMinGain.store(std::max(0.f, v), std::memory_order_relaxed); }
void SetStickiness(float v)       { s_stickiness.store(std::max(0.f, v), std::memory_order_relaxed); }
void SetReplanOnHazardSpawn(bool on) { s_replanOnHazardSpawn.store(on, std::memory_order_relaxed); }

float GetWasdLookahead()          { return 0.6f;  /* stub — atomic removed; matches passthrough literal */ }
float GetTightLeashRadius()       { return s_tightLeashRadius.load(std::memory_order_relaxed); }
float GetIdleMinGain()            { return s_idleMinGain.load(std::memory_order_relaxed); }
float GetStickiness()             { return s_stickiness.load(std::memory_order_relaxed); }
bool  GetReplanOnHazardSpawn()    { return s_replanOnHazardSpawn.load(std::memory_order_relaxed); }

void  SetRebuildIntervalMs(float ms)
{
    if (ms < 0.f) ms = 0.f;
    if (ms > 0.f && ms < 50.f)   ms = 50.f;
    if (ms > 1000.f)             ms = 1000.f;
    s_rebuildIntervalMs.store(ms, std::memory_order_relaxed);
}
float GetRebuildIntervalMs()      { return s_rebuildIntervalMs.load(std::memory_order_relaxed); }

void  SetPathMaxTiles(float tiles)
{
    if (tiles < 1.f)  tiles = 1.f;
    if (tiles > 12.f) tiles = 12.f;
    s_pathMaxTiles.store(tiles, std::memory_order_relaxed);
}
float GetPathMaxTiles()           { return s_pathMaxTiles.load(std::memory_order_relaxed); }

void SetTeleportEnabled(bool on)   { s_tpEnabled.store(on, std::memory_order_relaxed); }

// Emergency speed-boost tunables (activated by the same trigger that
// used to fire the raw-write teleport). Multiplier scales the per-frame
// step budget; durationMs is how long each boost lasts; the existing
// tpCooldownMs gates how often it can fire.
void SetBoostMultiplier(float mul)
{
    if (mul < 1.0f) mul = 1.0f;
    if (mul > 2.5f) mul = 2.5f;
    s_boostMultiplier.store(mul, std::memory_order_relaxed);
}
float GetBoostMultiplier() { return s_boostMultiplier.load(std::memory_order_relaxed); }
void SetBoostDurationMs(uint64_t ms)
{
    if (ms < 50)   ms = 50;
    if (ms > 2000) ms = 2000;
    s_boostDurationMs.store(ms, std::memory_order_relaxed);
}
uint64_t GetBoostDurationMs() { return s_boostDurationMs.load(std::memory_order_relaxed); }
bool     IsBoostActive()      { return GetTickCount64() < s_boostExpiryMs.load(std::memory_order_relaxed); }
void SetTeleportMaxTiles(float t)
{
    if (t < 0.5f) t = 0.5f;
    if (t > 4.f)  t = 4.f;
    s_tpMaxTiles.store(t, std::memory_order_relaxed);
}
void SetTeleportCooldownMs(float ms)
{
    if (ms < 200.f)  ms = 200.f;
    if (ms > 3000.f) ms = 3000.f;
    s_tpCooldownMs.store(ms, std::memory_order_relaxed);
}
bool  GetTeleportEnabled()    { return s_tpEnabled.load(std::memory_order_relaxed); }
float GetTeleportMaxTiles()   { return s_tpMaxTiles.load(std::memory_order_relaxed); }
float GetTeleportCooldownMs() { return s_tpCooldownMs.load(std::memory_order_relaxed); }

void  SetPostArrivalSafetyMs(float ms)
{
    if (ms < 0.f)    ms = 0.f;
    if (ms > 500.f)  ms = 500.f;
    s_postArrivalSafetyMs.store(ms, std::memory_order_relaxed);
}
float GetPostArrivalSafetyMs() { return s_postArrivalSafetyMs.load(std::memory_order_relaxed); }

void  SetPerpPenaltyWeight(float w)
{
    if (w < 0.f)  w = 0.f;
    if (w > 3.f)  w = 3.f;
    s_perpPenaltyWeight.store(w, std::memory_order_relaxed);
}
float GetPerpPenaltyWeight() { return s_perpPenaltyWeight.load(std::memory_order_relaxed); }

void  SetReflexEnabled(bool on)     { s_reflexEnabled.store(on, std::memory_order_relaxed); }
bool  GetReflexEnabled()            { return s_reflexEnabled.load(std::memory_order_relaxed); }

void  SetStrategicBiasEnabled(bool on)      { s_strategicBiasEnabled.store(on, std::memory_order_relaxed); }
bool  GetStrategicBiasEnabled()             { return s_strategicBiasEnabled.load(std::memory_order_relaxed); }
void  SetStrategicUseNearWaypoint(bool on)  { s_strategicUseNearWaypoint.store(on, std::memory_order_relaxed); }
bool  GetStrategicUseNearWaypoint()         { return s_strategicUseNearWaypoint.load(std::memory_order_relaxed); }

void  SetHitAversion(float v)
{
    if (!(v >= 0.25f)) v = 0.25f;
    if (v > 4.0f)      v = 4.0f;
    s_hitAversion.store(v, std::memory_order_relaxed);
}
float GetHitAversion() { return s_hitAversion.load(std::memory_order_relaxed); }

void  SetDodgeHitScale(float scale)
{
    if (!(scale >= 0.5f)) scale = 0.5f;
    if (scale > 2.0f)     scale = 2.0f;
    s_dodgeHitScale.store(scale, std::memory_order_relaxed);
}
float GetDodgeHitScale() { return s_dodgeHitScale.load(std::memory_order_relaxed); }

void  SetAutoTuneSafetyMs(bool on)  { s_autoTuneSafetyMs.store(on, std::memory_order_relaxed); }
bool  GetAutoTuneSafetyMs()         { return s_autoTuneSafetyMs.load(std::memory_order_relaxed); }
void  SetAutoTunePerpWeight(bool on){ s_autoTunePerpWeight.store(on, std::memory_order_relaxed); }
bool  GetAutoTunePerpWeight()       { return s_autoTunePerpWeight.load(std::memory_order_relaxed); }

void  SetPathSmoothEnabled(bool on) { s_smoothPathEnabled.store(on, std::memory_order_relaxed); }
bool  GetPathSmoothEnabled()        { return s_smoothPathEnabled.load(std::memory_order_relaxed); }

void  SetAreaDensityWeight(float w)
{
    if (w < 0.f)     w = 0.f;
    if (w > 0.005f)  w = 0.005f;
    s_areaDensityWeight.store(w, std::memory_order_relaxed);
}
float GetAreaDensityWeight() { return s_areaDensityWeight.load(std::memory_order_relaxed); }

void  SetExecStrictTickLock(bool on) { s_execStrictTickLock.store(on, std::memory_order_relaxed); }
bool  GetExecStrictTickLock()        { return s_execStrictTickLock.load(std::memory_order_relaxed); }

void SetHybridMode(bool on)
{
    const bool prev = s_hybridMode.exchange(on, std::memory_order_acq_rel);
    if (prev != on) {
        // Reset last-dir memory so mode switch doesn't inherit stale bias.
        s_hybridLastDirValid.store(false, std::memory_order_relaxed);
    }
}
bool GetHybridMode() { return s_hybridMode.load(std::memory_order_relaxed); }

void SetHybridPathWeight(float w)
{
    if (w < 0.f) w = 0.f;
    if (w > 3.f) w = 3.f;
    s_hybridPathW.store(w, std::memory_order_relaxed);
}
float GetHybridPathWeight() { return s_hybridPathW.load(std::memory_order_relaxed); }

void SetHybridGoalWeight(float w)
{
    if (w < 0.f) w = 0.f;
    if (w > 3.f) w = 3.f;
    s_hybridGoalW.store(w, std::memory_order_relaxed);
}
float GetHybridGoalWeight() { return s_hybridGoalW.load(std::memory_order_relaxed); }

void SetHybridDirWeight(float w)
{
    if (w < 0.f) w = 0.f;
    if (w > 2.f) w = 2.f;
    s_hybridDirW.store(w, std::memory_order_relaxed);
}
float GetHybridDirWeight() { return s_hybridDirW.load(std::memory_order_relaxed); }

void SetHybridMinHitMs(float ms)
{
    if (ms < 40.f)  ms = 40.f;
    if (ms > 400.f) ms = 400.f;
    s_hybridMinHitMs.store(ms, std::memory_order_relaxed);
}
float GetHybridMinHitMs() { return s_hybridMinHitMs.load(std::memory_order_relaxed); }

void SetPrecisionMode(bool on)
{
    const bool prev = s_precisionMode.exchange(on, std::memory_order_acq_rel);
    if (prev != on) {
        s_hybridLastDirValid.store(false, std::memory_order_relaxed);
    }
}
bool GetPrecisionMode() { return s_precisionMode.load(std::memory_order_relaxed); }

void SetPrecisionSampleStepMs(float ms)
{
    if (ms < 10.f)  ms = 10.f;
    if (ms > 120.f) ms = 120.f;
    s_precSampleMs.store(ms, std::memory_order_relaxed);
}
float GetPrecisionSampleStepMs() { return s_precSampleMs.load(std::memory_order_relaxed); }

void SetPrecisionHorizonMs(float ms)
{
    if (ms < 200.f)  ms = 200.f;
    if (ms > 2000.f) ms = 2000.f;
    s_precHorizonMs.store(ms, std::memory_order_relaxed);
}
float GetPrecisionHorizonMs() { return s_precHorizonMs.load(std::memory_order_relaxed); }

void SetRadialMode(bool on)
{
    const bool prev = s_radialMode.exchange(on, std::memory_order_acq_rel);
    if (prev != on) {
        s_hybridLastDirValid.store(false, std::memory_order_relaxed);
    }
}
bool GetRadialMode() { return s_radialMode.load(std::memory_order_relaxed); }

void SetRadialHorizonMs(float ms)
{
    if (ms < 300.f)  ms = 300.f;
    if (ms > 1500.f) ms = 1500.f;
    s_radHorizonMs.store(ms, std::memory_order_relaxed);
}
float GetRadialHorizonMs() { return s_radHorizonMs.load(std::memory_order_relaxed); }

void SetRadialSampleStepMs(float ms)
{
    if (ms < 8.f)  ms = 8.f;
    if (ms > 40.f) ms = 40.f;
    s_radSampleMs.store(ms, std::memory_order_relaxed);
}
float GetRadialSampleStepMs() { return s_radSampleMs.load(std::memory_order_relaxed); }

void SetRadialPerpWeight(float w)
{
    if (w < 0.f)  w = 0.f;
    if (w > 1.5f) w = 1.5f;
    s_radPerpWeight.store(w, std::memory_order_relaxed);
}
float GetRadialPerpWeight() { return s_radPerpWeight.load(std::memory_order_relaxed); }

void SetRadialIntentWeight(float w)
{
    if (w < 0.f) w = 0.f;
    if (w > 0.6f) w = 0.6f;
    s_radIntentWeight.store(w, std::memory_order_relaxed);
}
float GetRadialIntentWeight() { return s_radIntentWeight.load(std::memory_order_relaxed); }

void SetRadialMaxSearchDist(float tiles)
{
    if (tiles < 0.5f) tiles = 0.5f;
    if (tiles > 2.5f) tiles = 2.5f;
    s_radMaxSearchDist.store(tiles, std::memory_order_relaxed);
}
float GetRadialMaxSearchDist() { return s_radMaxSearchDist.load(std::memory_order_relaxed); }

void GetStatCostSnapshot(int32_t& outHp, int32_t& outMaxHp,
                         int32_t& outDef, float& outMultiplier)
{
    outHp         = s_lastStatHp.load(std::memory_order_relaxed);
    outMaxHp      = s_lastStatMaxHp.load(std::memory_order_relaxed);
    outDef        = s_lastStatDef.load(std::memory_order_relaxed);
    outMultiplier = s_statCostMult.load(std::memory_order_relaxed);
}

} // namespace DangerPlanner
