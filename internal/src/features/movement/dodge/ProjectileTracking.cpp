#include "pch-il2cpp.h"

#include "ProjectileTracking.h"
#include "ProjectileCatalog.h"
#include "../../projectiles/ProjectileRuntimeReader.h"
#include "../../projectiles/ProjectileStore.h"
#include "../../projectiles/ProjectileTrajectory.h"
#include "features/projectiles/ShotOrigin.h"
#include "features/projectiles/ShotOriginHook.h"
#include "features/combat/autoaim/modes/AutoAim.h"
#include "features/combat/autoaim/modes/KillAura.h"
#include "gui/tabs/WorldTAB.h"
#include "BootGate.h"
#include "Il2CppResolver.h"
#include "DbgFileLog.h"
#include "game/symbols/GameClasses.h"
#include "game/objects/GameObjects.h"
#include "RuntimeOffsets.h"
#include "MemRead.h"
#include "Il2CppHook.h"

#include <windows.h>
#include <atomic>
#include <unordered_set>
#include <cmath>
#include <cstring>
#include <unordered_map>
#include <vector>

// UI scale on native per-projectile mult (IL2CPP field KDAJOMOFMJB on HBEAKBIHANL).
static std::atomic<float> g_flashSpeedMulAtomic{1.f};

// Muzzle offset along aim (tiles). Default 0.3 = vanilla. The slider's clamp
// lives here; the decision of whether it applies to a given shot belongs to
// ShotOrigin::Resolve (features/projectiles/ShotOrigin.cpp).
static std::atomic<float> g_localMuzzleOffsetTiles{0.3f};
static constexpr float kMuzzleMinTiles    = 0.3f;
static constexpr float kMuzzleMaxTiles    = 2.225f;

namespace {
static const char* kProjClassName   = "HBEAKBIHANL";
static const char* kSpawnMethodName = "KOBMINBDOBD";
static const int   kSpawnParamCount = 12;

// Projectile's BeeByte-obfuscated class changes per build; GameClasses::Projectile()
// owns that policy (alias map first, kProjClassName as the fallback literal,
// cached, logged once) — see game/symbols/GameClasses.h.
using SpawnProjectileFn = void* (__fastcall*)(
    void*    projInstance,
    void*    objProps,
    void*    projProps,
    int32_t  attackerObjId,
    uint32_t ownerObjId,
    float    angle,
    int32_t  bulletId,
    void*    name,
    void*    group,
    float    startX,
    float    startY,
    bool     canHitPlayer,
    bool     isAbility,
    void*    methodInfo);

SpawnProjectileFn         g_OriginalSpawn = nullptr;
CRITICAL_SECTION          g_EntCs;
std::atomic<int32_t>      g_LocalDictKey{ 0 };

std::unordered_map<int32_t, std::pair<float, float>> g_EntityPos;
bool                      g_Installed = false;
bool                      g_EntCsInit = false;

// Transition-only witness: a stale/unresolved speed-mul offset silently degrades
// prediction (per-shot speed multiplier ignored). Log only on a state change so
// steady state is a single integer compare with no per-frame disk writes.
static int g_speedMulOffLogged = -1;   // -1 unknown, 0 unresolved, 1 resolved
static void WitnessSpeedMulOffset(uint32_t off)
{
    const int now = (off != 0u) ? 1 : 0;
    if (now == g_speedMulOffLogged) return;
    g_speedMulOffLogged = now;
    if (now)
        DBG_FILE_LOG("[ProjectileTracking] speed-mul offset KDAJOMOFMJB resolved -> 0x"
            << std::hex << off << std::dec);
    else
        DBG_FILE_LOG("[ProjectileTracking] speed-mul offset KDAJOMOFMJB UNRESOLVED "
            "— using flashTune only (per-shot speed multiplier ignored)");
}

static float ComputeEffectiveSpeedMulFromInstance(void* hbeakInstance)
{
    float flashTune = ProjectileTracking::GetFlashSpeedMultiplier();
    if (!(flashTune > 0.01f) || flashTune > 50.f)
        flashTune = 1.f;

    float inst = 1.f;
    const uint32_t off = RuntimeOffsets::Hbeak_SpeedMul;   // 0 until registry resolves it
    WitnessSpeedMulOffset(off);                            // transition-only log
    float v;
    if (off != 0u && Mem::TryRead(hbeakInstance, off, v)) {
        if (std::isfinite(v) && v > 1e-6f && v < 100.f)
            inst = v;
    }

    float p = inst * flashTune;
    if (!(p > 1e-6f) || p > 100.f)
        return 1.f;
    return p;
}

static bool TryReadLivePos(void* projInst, float& outX, float& outY)
{
    outX = 0.f;
    outY = 0.f;
    if (!Game::Entity(projInst).TryPos(outX, outY)) return false;
    return true;
}

static void LookupShooterOrigin(int32_t attackerObjId, uint32_t ownerObjId, float& originX, float& originY)
{
    EnterCriticalSection(&g_EntCs);
    auto itA = g_EntityPos.find(attackerObjId);
    if (itA != g_EntityPos.end()) {
        originX = itA->second.first;
        originY = itA->second.second;
        LeaveCriticalSection(&g_EntCs);
        return;
    }
    auto itO = g_EntityPos.find(static_cast<int32_t>(ownerObjId));
    if (itO != g_EntityPos.end()) {
        originX = itO->second.first;
        originY = itO->second.second;
        LeaveCriticalSection(&g_EntCs);
        return;
    }
    LeaveCriticalSection(&g_EntCs);
}

// Transition-only witness: which provider decided the local spawn offset. Logged
// only on a change, so steady state is one byte compare per shot with no disk I/O.
static ShotOrigin::Source g_lastShotOriginLogged = static_cast<ShotOrigin::Source>(0xFF);
static void WitnessShotOrigin(ShotOrigin::Source src)
{
    if (src == g_lastShotOriginLogged) return;
    g_lastShotOriginLogged = src;
    const char* name = "?";
    switch (src) {
        case ShotOrigin::Source::Vanilla:  name = "VANILLA";  break;
        case ShotOrigin::Source::Muzzle:   name = "MUZZLE";   break;
        case ShotOrigin::Source::Magnet:   name = "MAGNET";   break;
        case ShotOrigin::Source::KillAura: name = "KILLAURA"; break;
    }
    DBG_FILE_LOG("[ProjectileTracking] local shot origin -> " << name);
}

static bool TryReadObjectPropertiesIsEnemy(void* objProps, bool& outIsEnemy)
{
    outIsEnemy = false;
    return Mem::TryRead(objProps, RuntimeOffsets::OP_IsEnemy, outIsEnemy);
}

void* __fastcall SpawnProjectileDetour(
    void*    projInstance,
    void*    objProps,
    void*    projProps,
    int32_t  attackerObjId,
    uint32_t ownerObjId,
    float    angle,
    int32_t  bulletId,
    void*    name,
    void*    group,
    float    startX,
    float    startY,
    bool     canHitPlayer,
    bool     isAbility,
    void*    methodInfo)
{
    RuntimeOffsets::EnsureAll();

    float spawnX = startX;
    float spawnY = startY;
    const int32_t dk = g_LocalDictKey.load(std::memory_order_relaxed);
    const bool isLocalShot = dk != 0 && (attackerObjId == dk || static_cast<int32_t>(ownerObjId) == dk);

    ShotOrigin::Request req;
    req.isLocalShot = isLocalShot;
    req.angle       = angle;
    req.startX      = startX;
    req.startY      = startY;
    req.muzzleTiles = g_localMuzzleOffsetTiles.load(std::memory_order_relaxed);
    if (isLocalShot) {
        float ex = 0.f, ey = 0.f;
        LookupShooterOrigin(attackerObjId, ownerObjId, ex, ey);
        req.haveShooter = (fabsf(ex) > 0.5f || fabsf(ey) > 0.5f);
        req.shooterX = ex;
        req.shooterY = ey;
    }
    const ShotOrigin::Source src = ShotOrigin::Resolve(req, spawnX, spawnY);
    WitnessShotOrigin(src);

    AutoAim::OnLocalPlayerProjectileSpawn(projProps, isAbility, attackerObjId, ownerObjId);

    // Capture spawn timestamp BEFORE the original spawn runs. The IL2CPP method does
    // allocations / virtual dispatch and can take 0.2-2 ms; if we capture spawnTick
    // afterward (and after our own LookupShooterOrigin / live-pos read / CS enter)
    // every prediction is biased late by that amount, manifesting as "bullets arrive
    // earlier than predicted" -> chip damage.
    // GetTickCount64 is 10-16ms coarse; also grab a QueryPerformanceCounter stamp so
    // the prediction-accuracy path has a microsecond time base (per-projectile clock
    // calibration refines it further from the live position each tick).
    const ULONGLONG spawnTickPre = GetTickCount64();
    const double    spawnQpcPre  = ProjectileStore::QpcNowMs();

    // Call game first: HBEAKBIHANL_KOBMINBDOBD returns the live projectile instance.
    // The first argument is not reliably that instance (factory/this); using it for X/Y was wrong.
    void* ret = g_OriginalSpawn(
        projInstance, objProps, projProps, attackerObjId, ownerObjId, angle, bulletId,
        name, group, spawnX, spawnY, canHitPlayer, isAbility, methodInfo);

    if (!Mem::AddrOk(ret))
        return ret;

    // KillAura: arm the ONE-SHOT origin override for the projectile the spawn
    // funnel just handed back. The position we pass is ABSOLUTE world tiles —
    // ComputeShotOrigin already returns that, and the setter takes it in that
    // space, so nothing is rebased here (rebasing it into shooter-relative space
    // and handing it to the spawn call was the bug this replaces). The actual
    // move happens in ShotOriginHook's detour on KJMONHENJEN::BDEBGEHBPCJ.
    bool  kaMoved = false;
    float kaX = 0.f, kaY = 0.f;
    if (isLocalShot && KillAura::ComputeShotOrigin(angle, kaX, kaY)) {
        ShotOriginHook::ArmOneShot(ret, static_cast<int32_t>(ownerObjId), kaX, kaY);
        kaMoved = ShotOriginHook::IsInstalled();
    }

    bool ownerIsEnemy = false;
    const bool ownerClassified = TryReadObjectPropertiesIsEnemy(objProps, ownerIsEnemy);
    // Broadened: store any shot the owner is classed enemy OR that can hit the
    // player, regardless of the (occasionally stale) OP_IsEnemy classified flag.
    // A dodge must see everything that can hit the player; own outgoing shots are
    // already excluded by the isLocalShot guard. Shared with PJDodge (intended).
    const bool isEnemyShot = !isLocalShot && (ownerIsEnemy || canHitPlayer);
    if (!isLocalShot && !isEnemyShot)
        return ret;

    float entityX = 0.f, entityY = 0.f;
    LookupShooterOrigin(attackerObjId, ownerObjId, entityX, entityY);

    float sx, sy;
    if (kaMoved) {
        // Track the shot from where killaura is about to put it, not from the
        // muzzle — same value the old (broken) rebase produced here, so the
        // local-shot overlay keeps the behaviour it had.
        sx = kaX;
        sy = kaY;
    } else if (fabsf(entityX) > 0.5f || fabsf(entityY) > 0.5f) {
        sx = entityX + spawnX;
        sy = entityY + spawnY;
    } else {
        float liveX = 0.f, liveY = 0.f;
        if (TryReadLivePos(ret, liveX, liveY) &&
            (fabsf(liveX) > 0.5f || fabsf(liveY) > 0.5f)) {
            sx = liveX;
            sy = liveY;
        } else {
            sx = spawnX;
            sy = spawnY;
        }
    }

    WorldProjectile p{};
    p.startX = sx;
    p.startY = sy;
    p.angle = angle;
    p.spawnTick = spawnTickPre;
    p.spawnQpcMs = spawnQpcPre;
    p.valid = true;
    p.canHitPlayer = canHitPlayer;
    p.ptr = ret;
    p.bulletId = bulletId;
    p.attackerObjId = attackerObjId;
    p.ownerObjId = ownerObjId;
    p.speed = 5000.f;
    p.lifetime = 2000.f;
    p.minDamage = 100;
    p.damage = 100;
    p.isAccelerating = false;
    p.useAccel       = false;
    p.acceleration = 0.f;
    p.accelerationInv = 0.f;
    p.velocityChangeRate = 0.f;
    p.velocityChangeRateInv = 0.f;
    p.accelDelay = 0.f;
    p.speedClamp = 0.f;
    p.projPropsPtr = nullptr;
    p.x = sx;
    p.y = sy;

    void* const ppEffective = ProjectileRuntimeReader::EffectivePropsFromProjectile(ret, projProps);
    if (ProjectileRuntimeReader::ApplyProperties(p, ret, ppEffective, ProjectileCollisionFallback::SpawnHook)) {
        if (p.speed < 1.f || p.speed > 50000.f || p.lifetime < 50.f || p.lifetime > 600000.f) {
            p.speed = 5000.f;
            p.lifetime = 2000.f;
            p.minDamage = 100;
            p.damage = 100;
        }
    }

    p.speedMul = ComputeEffectiveSpeedMulFromInstance(ret);

    float livePosX, livePosY;
    if (Game::Entity(ret).TryPos(livePosX, livePosY)) {
        p.x = livePosX;
        p.y = livePosY;
    } else {
        float posX = p.x;
        float posY = p.y;
        if (ProjectileTrajectory::GetPositionAtTime(p, 0.f, posX, posY)) {
            p.x = posX;
            p.y = posY;
        }
    }

    ProjectileTrajectory::CachePath(p);

    const WorldProjectile snap = ProjectileStore::StoreProjectile(isEnemyShot, p);
    if (isEnemyShot) {
        // Seed per-dungeon type catalog (debug viz only — planner doesn't read).
        // Owner type passed as 0 here; resolution from WorldTAB is done later by
        // debug tools that care. Same-bullet/0-owner entries deduplicate safely.
        ProjectileCatalog::RecordSpawn(0, snap);
        ProjectileStore::NotifyHazardSpawn(snap);
    }

    return ret;
}

} // namespace

namespace ProjectileTracking {

static void* g_spawnTarget = nullptr;

void Install()
{
    if (g_Installed) {
        // Spawn hook is up; keep retrying only the subordinate origin hook. Its
        // class can resolve later than ours, and this is the only path that gets
        // called again after we latch — without it a single early failure would
        // leave killaura permanently unable to move the bullet. Both exits are a
        // bool test once installed (or once permanently refused).
        ShotOriginHook::Install();
        return;
    }
    // Feature gate: after a game patch BootGate parks in UpdateDetected until
    // offsets are re-resolved. FeatureAllowed() is fail-closed — false unless
    // BootGate is Ready AND every anchor the feature needs is healthy. Installing
    // the spawn hook against a stale 'Projectile' layout makes the detour read
    // bullet fields at shifted offsets and hard-crashes the game on load-in, so
    // refuse to install until the gate opens. Bullet capture (and therefore
    // auto-dodge) simply stays off on a stale/patched game instead of crashing.
    if (!BootGate::FeatureAllowed("ProjectileTracking")) {
        static int s_g = 0;
        if ((s_g++ % 240) == 0)
            DBG_FILE_LOG("[ProjectileTracking] Install gated — BootGate not Ready / "
                "'Projectile' anchor stale; bullet capture OFF until offsets refresh "
                "(gate-attempt=" << s_g << ")");
        return;
    }
    {
        static int s_n = 0;
        if ((s_n++ % 240) == 0)
            DBG_FILE_LOG("[ProjectileTracking] Install() reached, not yet installed "
                "(attempt=" << s_n << ") — resolving hook target...");
    }
    ProjectileStore::Initialize();
    if (!g_EntCsInit) {
        InitializeCriticalSection(&g_EntCs);
        g_EntCsInit = true;
    }

    Il2CppClass* klass = GameClasses::Projectile();
    if (!klass) {
        static int s_n = 0;
        if ((s_n++ % 240) == 0)
            DBG_FILE_LOG("[ProjectileTracking] Install: projectile class '"
                << kProjClassName << "' UNRESOLVED — BeeByte name stale for this "
                "game build. No bullets captured → XDodge has nothing to dodge. "
                "(attempt=" << s_n << ")");
        return;
    }
    const MethodInfo* mi = Il2CppHook::ResolveMethodCached(
        klass->name, kSpawnMethodName, kSpawnParamCount,
        false, klass->namespaze ? klass->namespaze : "");
    if (!mi) {
        static int s_n = 0;
        if ((s_n++ % 240) == 0)
            DBG_FILE_LOG("[ProjectileTracking] Install: class OK but spawn method '"
                << kSpawnMethodName << "'(" << kSpawnParamCount << " args) UNRESOLVED "
                "— BeeByte method name/arity stale. (attempt=" << s_n << ")");
        return;
    }

    g_spawnTarget = reinterpret_cast<void*>(mi->methodPointer);
    g_OriginalSpawn = reinterpret_cast<SpawnProjectileFn>(g_spawnTarget);

    if (!Il2CppHook::EnsureRuntime("ProjectileTracking")) return;

    if (!Il2CppHook::InstallMinHook(g_spawnTarget,
            reinterpret_cast<void*>(&SpawnProjectileDetour),
            reinterpret_cast<void**>(&g_OriginalSpawn),
            "ProjectileTracking"))
        return;

    g_Installed = true;
    DBG_FILE_LOG("[ProjectileTracking] Install: spawn hook INSTALLED — bullets now captured");

    // Killaura's local-bullet origin rewrite rides the same lifecycle: the spawn
    // detour arms it, the entity-position detour applies it. It is deliberately
    // NOT fatal here — a refusal only costs killaura damage, never bullet
    // capture — and it logs its own INSTALLED/REFUSED line.
    ShotOriginHook::Install();
}

bool IsInstalled()
{
    return g_Installed;
}

void Uninstall()
{
    if (g_Installed) {
        Il2CppHook::UninstallMinHook(g_spawnTarget, "ProjectileTracking");
        g_OriginalSpawn = nullptr;
        g_Installed = false;
    }
    // After the spawn detour, never before: the arm side (spawn) must die first
    // so the apply side is never asked for an override it can no longer receive.
    ShotOriginHook::Uninstall();
    ProjectileStore::Shutdown();
    if (g_EntCsInit) {
        DeleteCriticalSection(&g_EntCs);
        g_EntCsInit = false;
    }
}

void ComputePosAtSafe(const WorldProjectile& proj, float tMs, float& outX, float& outY)
{
    const float fallbackX = outX;
    const float fallbackY = outY;
    if (!ProjectileTrajectory::GetPositionAtTime(proj, tMs, outX, outY)) {
        outX = fallbackX;
        outY = fallbackY;
    }
}

void SetLocalPlayerObjectId(int32_t objectId)
{
    g_LocalDictKey.store(objectId, std::memory_order_relaxed);
}

int32_t GetLocalPlayerObjectId()
{
    return g_LocalDictKey.load(std::memory_order_relaxed);
}

void OnWorldRefreshBegin()
{
    if (!g_EntCsInit) return;
    EnterCriticalSection(&g_EntCs);
    g_EntityPos.clear();
    LeaveCriticalSection(&g_EntCs);
}

void OnWorldEntity(int32_t objectId, float x, float y)
{
    if (!g_EntCsInit) return;
    EnterCriticalSection(&g_EntCs);
    g_EntityPos[objectId] = { x, y };
    LeaveCriticalSection(&g_EntCs);
}

void SnapshotToWorld(std::vector<WorldProjectile>& out)
{
    ProjectileStore::SnapshotToWorld(out);
}

void CopyActiveForDraw(std::vector<WorldProjectile>& out)
{
    ProjectileStore::CopyActiveForDraw(out);
}

int CountValidForDiagnostics()
{
    return ProjectileStore::CountValidForDiagnostics();
}

void SetPredictionAccuracy(bool enabled)
{
    ProjectileStore::SetPredictionAccuracy(enabled);
}

bool GetPredictionAccuracy()
{
    return ProjectileStore::GetPredictionAccuracy();
}

PredictionDiag GetPredictionDiag()
{
    const ProjectileStore::PredictionDiag s = ProjectileStore::GetPredictionDiag();
    PredictionDiag d{};
    d.enabled       = s.enabled;
    d.calibrated    = s.calibrated;
    d.emaAbsTauMs   = s.emaAbsTauMs;
    d.maxAbsTauMs   = s.maxAbsTauMs;
    d.emaCrossTiles = s.emaCrossTiles;
    d.maxCrossTiles = s.maxCrossTiles;
    return d;
}

void CopyActiveLocalForDraw(std::vector<WorldProjectile>& out)
{
    ProjectileStore::CopyActiveLocalForDraw(out);
}

bool RetireProjectile(const WorldProjectile& proj)
{
    return ProjectileStore::RetireProjectile(proj);
}

void ReconcileWithLivePool()
{
    static std::unordered_set<uintptr_t> s_live;   // reused to avoid a per-call alloc
    // If the pool read fails (WorldManager unreadable), CollectLiveProjectilePtrs
    // returns false and we prune NOTHING — a lingering lane is safe, a wrongly-pruned
    // LIVE shot (missed → death) is not.
    if (!WorldTAB::CollectLiveProjectilePtrs(s_live)) return;
    const int retired = ProjectileStore::RetireNotInLiveSet(s_live, /*minAgeMs=*/150.f);
    if (retired > 0)
        DBG_FILE_LOG("[ProjTrack] reconcile: live=" << s_live.size()
            << " retired(early-deleted)=" << retired);
}

void ComputePosAt(const WorldProjectile& proj, float tMs, float& outX, float& outY)
{
    const float fallbackX = outX;
    const float fallbackY = outY;
    if (!ProjectileTrajectory::GetPositionAtTime(proj, tMs, outX, outY)) {
        outX = fallbackX;
        outY = fallbackY;
    }
}

void SetFlashSpeedMultiplier(float m)
{
    float c = m;
    if (!(c > 0.01f) || c > 50.f)
        c = 1.f;
    g_flashSpeedMulAtomic.store(c, std::memory_order_relaxed);
}

float GetFlashSpeedMultiplier()
{
    return g_flashSpeedMulAtomic.load(std::memory_order_relaxed);
}

void SetLocalPlayerMuzzleOffsetTiles(float tiles)
{
    float v = tiles;
    if (v < kMuzzleMinTiles) v = kMuzzleMinTiles;
    if (v > kMuzzleMaxTiles) v = kMuzzleMaxTiles;
    g_localMuzzleOffsetTiles.store(v, std::memory_order_relaxed);
}

float GetLocalPlayerMuzzleOffsetTiles()
{
    return g_localMuzzleOffsetTiles.load(std::memory_order_relaxed);
}

float EffectiveSpeedMulFromProjectile(void* hbeakInstance)
{
    return ComputeEffectiveSpeedMulFromInstance(hbeakInstance);
}

float NormalizeProjectileLifetimeMs(float rawFromProps)
{
    return ProjectileTrajectory::NormalizeLifetimeMs(rawFromProps);
}

float NormalizeAccelDelayMs(float rawFromProps)
{
    return ProjectileTrajectory::NormalizeAccelDelayMs(rawFromProps);
}

static int g_projRadiusTrustLogged = -1;   // -1 unknown, 0 not-trusted, 1 trusted

bool TryReadProjRadiusFromInstance(void* hbeakInstance, float& outRadius)
{
    outRadius = 0.f;
    if (!hbeakInstance) return false;
    {
        // Transition-only witness: reports whether projRadius resolved from live
        // metadata (read-only state query — not a write gate). Observability only;
        // the read path and its range gate below are unchanged.
        const bool trusted = RuntimeOffsets::IsFieldWriteTrusted(&RuntimeOffsets::Hbeak_ProjRadius);
        const int now = trusted ? 1 : 0;
        if (now != g_projRadiusTrustLogged) {
            g_projRadiusTrustLogged = now;
            if (!trusted)
                DBG_FILE_LOG("[ProjectileTracking] projRadius HHFDCMIIIHF offset NOT metadata-resolved "
                    "— hitbox radius may be stale for this build");
        }
    }
    return Mem::TryRead(hbeakInstance, RuntimeOffsets::Hbeak_ProjRadius, outRadius);
}

uint32_t GetHbeakProjRadiusOffset()
{
    return RuntimeOffsets::Hbeak_ProjRadius;
}

void RegisterHazardSpawnCallback(HazardSpawnCb cb, void* user)
{
    ProjectileStore::RegisterHazardSpawnCallback(cb, user);
}

void ClearHazardSpawnCallback()
{
    ProjectileStore::ClearHazardSpawnCallback();
}

} // namespace ProjectileTracking
