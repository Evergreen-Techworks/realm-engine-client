#include "pch-il2cpp.h"

#include "AutoAim.h"
#include "AimHooks.h"
#include "WeaponProfile.h"
#include "TargetSelector.h"
#include "features/combat/enemytracker/EnemyTracker.h"
#include "GameState.h"
#include "RuntimeOffsets.h"
#include "ProjectileTracking.h"
#include "AoeTracking.h"

#include <Windows.h>
#include <atomic>
#include <cmath>
#include <cstdint>

namespace {

static inline bool AddrOk(const void* p) {
    const uintptr_t a = reinterpret_cast<uintptr_t>(p);
    return a > 0x10000 && a < 0x7FFFFFFFFFFFULL;
}

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
    if (!AddrOk(player)) return false;
    uint32_t w0 = 0, w1 = 0;
    if (!RuntimeOffsets::TryReadMapObjectConditions(player, &w0, &w1)) return false;
    const uint64_t full = RuntimeOffsets::GetFullConditions(w0, w1);
    return RuntimeOffsets::HasCondition(full, RuntimeOffsets::ConditionEffects::Invisible);
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
    __try {
        uint8_t* lp = reinterpret_cast<uint8_t*>(local);
        px = *reinterpret_cast<float*>(lp + RuntimeOffsets::PosX);
        py = *reinterpret_cast<float*>(lp + RuntimeOffsets::PosY);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
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
