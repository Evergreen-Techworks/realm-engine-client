#include "pch-il2cpp.h"

#include "features/combat/autoaim/modes/AutoAim.h"
#include "features/combat/autoaim/shoot/AimHooks.h"
#include "features/combat/autoaim/core/WeaponProfile.h"
#include "features/combat/autoaim/core/TargetSelector.h"
#include "features/combat/autoaim/core/LockPolicy.h"
#include "features/combat/enemytracker/EnemyTracker.h"
#include "features/combat/autoaim/shoot/ProjNoclip.h"
#include "core/il2cpp/Il2CppContainers.h"
#include "gui/tabs/WorldTAB.h"
#include "DangerPlanner.h"
#include "DiagTiming.h"
#include "GameState.h"
#include "RuntimeOffsets.h"
#include "core/runtime/MemRead.h"
#include "game/objects/GameObjects.h"
#include "ProjectileTracking.h"
#include "AoeTracking.h"

#include <Windows.h>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>

namespace {

// ── Frame-level state ─────────────────────────────────────────────────────────
static std::atomic<bool>    s_enabled{ false };
static std::atomic<int>     s_aimModeInt{ 0 };
static std::atomic<int32_t> s_lockedEnemyId{ -1 };

static std::atomic<bool>    s_shootInvulnerable{ false };
static std::atomic<bool>    s_prioritizeBosses{ false };
static std::atomic<bool>    s_ignoreWalls{ true };
static std::atomic<bool>    s_ignoreScenery{ true };
static std::atomic<bool>    s_shootWhileStealthed{ true };
static std::atomic<bool>    s_mouseBoundingEnabled{ true };
static std::atomic<float>   s_mouseBoundingRange{ 2.f };
static std::atomic<float>   s_rangeLeadBias{ 1.f };
static std::atomic<bool>    s_reverseCultStaff{ true };
static std::atomic<bool>    s_offsetColossus{ false };

static std::atomic<bool>    s_hasTarget{ false };
static std::atomic<float>   s_aimX{ 0.f };
static std::atomic<float>   s_aimY{ 0.f };
static std::atomic<int32_t> s_aimFocusId{ 0 };

static const int32_t*       s_skipObjTypes = nullptr;
static int                  s_skipObjCount = 0;

static ULONGLONG s_lastThrottleMs = 0;

static bool LocalStealthBlocksAim(void* player)
{
    if (s_shootWhileStealthed.load(std::memory_order_relaxed)) return false;
    Game::Character ch(player);
    uint64_t full = 0;
    if (!ch.Conditions(full)) return false;
    return RuntimeOffsets::HasCondition(full, RuntimeOffsets::ConditionEffects::Invisible);
}

// ── Field capture: a locked target that is not being aimed at ─────────────────
//
//   GREP THE TRACE LOG FOR:  [Diag/LockEngage]
//
// OFF unless RE_ASSETS/diag-timing.flag exists (DiagTiming.h); remove the flag to
// stop it. DangerPlanner's [Diag/Lock] names each new lock; this says whether
// AutoAim is actually on it. While a lock is set (script scriptEnemyLockId /
// scriptCombatTargetId, or the Locked radio) it names the rule that keeps
// TargetSelector off it: an EnemyTracker drop (EnemyClassify reason, which
// uDodge's lock inherits too) or LockPolicy's hold. One line when a lock stops
// being engaged or its reason changes, one when it engages again. Render thread,
// never per frame in steady state.
//
// blockedSquaresOnLine counts squares on the straight player→target line that
// block MOVEMENT (walls, OccupySquare objects, NoWalk ground including deep
// water). No lock or aim rule reads walls; the count is here to test the "it's
// the walls" theory against real misses. Water does not stop shots, so it is an
// upper bound on wall hits, and with projectile noclip on walls stop none.
static int CountBlockedSquaresOnLine(float ax, float ay, float bx, float by)
{
    const float dx = bx - ax, dy = by - ay;
    const float len = std::sqrt(dx * dx + dy * dy);
    if (!std::isfinite(len) || len > 64.f) return -1;
    const int steps = static_cast<int>(len / 0.25f) + 1;
    int lastTx = INT32_MIN, lastTy = INT32_MIN, blocked = 0;
    for (int i = 1; i < steps; ++i) {   // skip the player's own square (i = 0)
        const float t = static_cast<float>(i) / static_cast<float>(steps);
        const int tx = static_cast<int>(std::floor(ax + dx * t));
        const int ty = static_cast<int>(std::floor(ay + dy * t));
        if (tx == lastTx && ty == lastTy) continue;
        lastTx = tx; lastTy = ty;
        if (tx == static_cast<int>(std::floor(bx)) && ty == static_cast<int>(std::floor(by))) break;
        if (WorldTAB::IsTileBlocked(tx, ty)) ++blocked;
    }
    return blocked;
}

static void DiagLockEngagement(const TargetSelector::Config& cfg, const TargetSelector::Result& result,
                               float px, float py)
{
    DiagTiming::PollFlag();
    const int32_t want = (DiagTiming::On() && cfg.mode == TargetSelector::Mode::Locked && cfg.lockedEnemyId > 0)
        ? cfg.lockedEnemyId : 0;
    EnemyTracker::SetWatchedId(want);

    static int32_t   s_lastId = 0;
    static char      s_lastReason[48] = "";
    static ULONGLONG s_lastLogMs = 0;
    if (want == 0) { s_lastId = 0; s_lastReason[0] = '\0'; return; }

    const EnemyTracker::WatchVerdict verdict = EnemyTracker::GetWatchVerdict();
    const EnemyTracker::Entry* entry = nullptr;
    for (const EnemyTracker::Entry& e : EnemyTracker::GetSnapshot())
        if (e.id == want) { entry = &e; break; }

    const char* reason = "engaged";
    if (!(result.found && result.enemyId == want)) {
        if (!entry) {
            if (verdict.id != want) return;   // no build has looked for this id yet
            reason = verdict.reason;
        }
        else if (LockPolicy::Decide(entry, cfg.shootInvulnerable) == LockPolicy::Use::Hold)
            reason = "hold:invulnerable";
        else
            reason = "aim:not-selected";
    }

    const bool changed = want != s_lastId || std::strcmp(reason, s_lastReason) != 0;
    if (!changed) return;
    // First sight of a lock that is already engaged is not news.
    if (want != s_lastId && std::strcmp(reason, "engaged") == 0) {
        s_lastId = want;
        strncpy_s(s_lastReason, sizeof(s_lastReason), reason, _TRUNCATE);
        return;
    }
    const ULONGLONG now = GetTickCount64();
    if (now - s_lastLogMs < 250ULL) return;   // flapping: the next change after this re-logs
    s_lastLogMs = now;
    s_lastId = want;
    strncpy_s(s_lastReason, sizeof(s_lastReason), reason, _TRUNCATE);

    char name[64] = "?";
    if (verdict.id == want && Mem::AddrOk(verdict.objProps)) {
        void* idStr = Mem::ReadPtr(verdict.objProps, RuntimeOffsets::OP_IdStr);
        if (Mem::AddrOk(idStr)) Il2CppC::ReadString(idStr, name, sizeof(name));
    }
    const bool  haveVerdict = verdict.id == want && verdict.inWorld;
    const float tx = entry ? entry->x : verdict.x;
    const float ty = entry ? entry->y : verdict.y;
    const bool  havePos = entry || haveVerdict;
    const float dist = havePos ? std::sqrt((tx - px) * (tx - px) + (ty - py) * (ty - py)) : -1.f;
    const int   walls = havePos ? CountBlockedSquaresOnLine(px, py, tx, ty) : -1;

    DiagTiming::Logf("[Diag/LockEngage] lock id=%d %s reason=%s name='%s' type=0x%X hp=%d/%d dist=%.1f "
                     "blockedSquaresOnLine=%d noclip=%d aimFocus=%d dodgeLock=%d inSnapshot=%d",
                     want, std::strcmp(reason, "engaged") == 0 ? "ENGAGED" : "NOT ENGAGED", reason, name,
                     static_cast<unsigned>(entry ? entry->objType : verdict.objType),
                     entry ? entry->hp : verdict.hp, entry ? entry->maxHp : verdict.maxHp, dist, walls,
                     ProjNoclip::IsEnabled() ? 1 : 0, result.found ? result.enemyId : 0,
                     DangerPlanner::GetEnemyLock(), entry ? 1 : 0);
}

static void RunTick()
{
    const bool aimOn = s_enabled.load(std::memory_order_relaxed);

    void* local = GameState::GetLocalPtr();

    // Aim is inactive — clear target. Hooks must be installed and the player must
    // not be stealthed (when ShootWhileStealthed is off).
    if (!aimOn || !local || !AimHooks::IsInstalled() || LocalStealthBlocksAim(local)) {
        s_hasTarget.store(false, std::memory_order_relaxed);
        s_aimFocusId.store(0, std::memory_order_relaxed);
        AimHooks::SetTarget(false, 0.f, 0.f);
        return;
    }

    // Refresh shared data sources for target selection. EnemyTracker::Tick is
    // self-throttled, so callers of EnumerateLiveEnemies can also trigger it.
    WeaponCalibrator::Tick(local);
    EnemyTracker::Tick();

    float px = 0.f, py = 0.f;
    if (!Game::Entity(local).TryPos(px, py)) {
        s_hasTarget.store(false, std::memory_order_relaxed);
        AimHooks::SetTarget(false, 0.f, 0.f);
        return;
    }

    TargetSelector::Config cfg;
    cfg.mode                 = static_cast<TargetSelector::Mode>(s_aimModeInt.load(std::memory_order_relaxed));
    cfg.shootInvulnerable    = s_shootInvulnerable.load(std::memory_order_relaxed);
    cfg.prioritizeBosses     = s_prioritizeBosses.load(std::memory_order_relaxed);
    cfg.ignoreWalls          = s_ignoreWalls.load(std::memory_order_relaxed);
    cfg.ignoreScenery        = s_ignoreScenery.load(std::memory_order_relaxed);
    cfg.rangeLeadBias        = s_rangeLeadBias.load(std::memory_order_relaxed);
    cfg.mouseBoundingEnabled = s_mouseBoundingEnabled.load(std::memory_order_relaxed);
    cfg.mouseBoundingRange   = s_mouseBoundingRange.load(std::memory_order_relaxed);
    cfg.lockedEnemyId        = s_lockedEnemyId.load(std::memory_order_relaxed);
    cfg.skipObjTypes         = s_skipObjTypes;
    cfg.skipObjCount         = s_skipObjCount;

    // Mouse world position is read inside TargetSelector::Select via TestTAB
    const TargetSelector::Result result = TargetSelector::Select(
        cfg, px, py, 0.f, 0.f, WeaponCalibrator::GetProfile());
    DiagLockEngagement(cfg, result, px, py);

    s_hasTarget.store(result.found, std::memory_order_relaxed);
    s_aimX.store(result.aimX, std::memory_order_relaxed);
    s_aimY.store(result.aimY, std::memory_order_relaxed);
    s_aimFocusId.store(result.found ? result.enemyId : 0, std::memory_order_relaxed);
    AimHooks::SetTarget(result.found, result.aimX, result.aimY);
}

} // namespace

namespace AutoAim {

void Install()
{
    // Lazy installs — safe to call every tick; each guards itself
    ProjectileTracking::Install();
    AoeTracking::Install();
    AimHooks::Install();
}

void Uninstall()
{
    AimHooks::Uninstall();
    s_hasTarget.store(false, std::memory_order_relaxed);
    s_aimFocusId.store(0, std::memory_order_relaxed);
    WeaponCalibrator::Reset();
}

void Tick()
{
    Install();

    const ULONGLONG wall = GetTickCount64();
    if (wall - s_lastThrottleMs < 8ULL) return;
    s_lastThrottleMs = wall;

    RunTick();
}

void SetEnabled(bool on) {
    s_enabled.store(on, std::memory_order_relaxed);
    if (!on) {
        s_hasTarget.store(false, std::memory_order_relaxed);
        AimHooks::SetTarget(false, 0.f, 0.f);
    }
}
bool IsEnabled() { return s_enabled.load(std::memory_order_relaxed); }

void SetAimMode(TargetSelector::Mode mode) {
    const int raw = static_cast<int>(mode);
    s_aimModeInt.store((raw < 0 || raw > 3) ? 0 : raw, std::memory_order_relaxed);
}
TargetSelector::Mode GetAimMode() {
    return static_cast<TargetSelector::Mode>(s_aimModeInt.load(std::memory_order_relaxed));
}

void SetLockTarget(int32_t enemyId) {
    s_lockedEnemyId.store(enemyId, std::memory_order_relaxed);
    s_aimModeInt.store(static_cast<int>(TargetSelector::Mode::Locked), std::memory_order_relaxed);
}

// Pure forwarder — precedence lives in AimHooks (see the note in AutoAim.h).
// It routes through here rather than KillAura reaching into shoot/ directly so
// the hook state keeps exactly one owner.
void SetKillAuraAimOverride(bool active, float x, float y, int32_t enemyId) {
    AimHooks::SetKillAuraOverride(active, x, y, enemyId);
}

void SetShootInvulnerable(bool on)   { s_shootInvulnerable.store(on, std::memory_order_relaxed); }
bool IsShootInvulnerable()           { return s_shootInvulnerable.load(std::memory_order_relaxed); }

void SetPrioritizeBosses(bool on)    { s_prioritizeBosses.store(on, std::memory_order_relaxed); }
bool IsPrioritizeBosses()            { return s_prioritizeBosses.load(std::memory_order_relaxed); }

void SetIgnoreWalls(bool on)         { s_ignoreWalls.store(on, std::memory_order_relaxed); }
bool IsIgnoreWalls()                 { return s_ignoreWalls.load(std::memory_order_relaxed); }

void SetIgnoreScenery(bool on)       { s_ignoreScenery.store(on, std::memory_order_relaxed); }
bool IsIgnoreScenery()               { return s_ignoreScenery.load(std::memory_order_relaxed); }

void SetShootWhileStealthed(bool on) { s_shootWhileStealthed.store(on, std::memory_order_relaxed); }
bool IsShootWhileStealthed()         { return s_shootWhileStealthed.load(std::memory_order_relaxed); }

void SetPhaseSkipTypes(const int32_t* types, int count) {
    s_skipObjTypes = types;
    s_skipObjCount = count;
}

void SetMouseBoundingEnabled(bool on)  { s_mouseBoundingEnabled.store(on, std::memory_order_relaxed); }
bool IsMouseBoundingEnabled()          { return s_mouseBoundingEnabled.load(std::memory_order_relaxed); }
void SetMouseBoundingRange(float t)    {
    if (!std::isfinite(t) || t < 0.f) t = 0.f;
    if (t > 200.f) t = 200.f;
    s_mouseBoundingRange.store(t, std::memory_order_relaxed);
}
float GetMouseBoundingRange()          { return s_mouseBoundingRange.load(std::memory_order_relaxed); }

void SetRangeLeadBias(float t)         {
    if (!std::isfinite(t) || t < 0.f) t = 0.f;
    if (t > 50.f) t = 50.f;
    s_rangeLeadBias.store(t, std::memory_order_relaxed);
}
float GetRangeLeadBias()               { return s_rangeLeadBias.load(std::memory_order_relaxed); }

void SetReverseCultStaff(bool on)    { s_reverseCultStaff.store(on, std::memory_order_relaxed); AimHooks::SetReverseCultStaff(on); }
bool IsReverseCultStaff()            { return s_reverseCultStaff.load(std::memory_order_relaxed); }

void SetOffsetColossusSword(bool on) { s_offsetColossus.store(on, std::memory_order_relaxed); AimHooks::SetOffsetColossusSword(on); }
bool IsOffsetColossusSword()         { return s_offsetColossus.load(std::memory_order_relaxed); }

bool    HasTarget()       { return s_hasTarget.load(std::memory_order_relaxed); }
void    GetAimTarget(float& ox, float& oy) {
    ox = s_aimX.load(std::memory_order_relaxed);
    oy = s_aimY.load(std::memory_order_relaxed);
}
int32_t GetAimFocusEnemyId() { return s_aimFocusId.load(std::memory_order_relaxed); }

const WeaponProfile& GetWeaponProfile() { return WeaponCalibrator::GetProfile(); }

void OnLocalPlayerProjectileSpawn(void* projProps, bool isAbility,
                                   int32_t attackerObjId, uint32_t ownerObjId)
{
    if (isAbility || !projProps) return;
    if (!GameState::GetLocalPtr()) return;
    int32_t dk = ProjectileTracking::GetLocalPlayerObjectId();
    if (dk == 0) dk = EnemyTracker::GetLocalPlayerObjectId();
    if (dk == 0 || (attackerObjId != dk && static_cast<int32_t>(ownerObjId) != dk)) return;
    WeaponCalibrator::OnProjectileSpawn(projProps, GameState::GetLocalPtr());
}

void EnumerateLiveEnemies(EnemyScanCallback cb, void* user) {
    if (!cb) return;
    // Ensure a fresh snapshot — consumers (auto-dodge) may run with auto-aim off.
    // EnemyTracker::Tick is self-throttled, so this is deduped against the aim path.
    EnemyTracker::Tick();
    struct Ctx { EnemyScanCallback cb; void* user; };
    Ctx ctx{ cb, user };
    EnemyTracker::Enumerate([](const EnemyTracker::Entry& e, void* u) {
        auto* c = static_cast<Ctx*>(u);
        c->cb(e.x, e.y, e.id, c->user);
    }, &ctx);
}

} // namespace AutoAim
