#include "pch-il2cpp.h"

#include "AutoAim.h"
#include "GameState.h"
#include "gui/tabs/TestTAB.h"
#include "ProjectileTracking.h"
#include "AoeTracking.h"
#include "helpers.h"
#include "Il2CppResolver.h"
#include "RuntimeOffsets.h"
#include "DbgFileLog.h"
#include <string>

#include "minhook/MinHook.h"

#include <Windows.h>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <unordered_map>
#include <fstream>
#include <sstream>
#include <cstdio>

namespace {

// Game-specific offsets â€” resolved at runtime by RuntimeOffsets::EnsureAll().
static const uint32_t& kOffPosX     = RuntimeOffsets::PosX;
static const uint32_t& kOffPosY     = RuntimeOffsets::PosY;
static const uint32_t& kOffHp       = RuntimeOffsets::HP;
static const uint32_t& kOffMaxHp    = RuntimeOffsets::MaxHP;
static const uint32_t& kOffObjProps      = RuntimeOffsets::ObjProps;         // KJMONHENJEN.OBAKMCCDBJA â†’ ObjectProperties*
static const uint32_t& kOffOpIsEnemy     = RuntimeOffsets::OP_IsEnemy;       // ObjectProperties.isEnemy (XML <Enemy/>)
static const uint32_t& kOffOpNoHealthBar = RuntimeOffsets::OP_NoHealthBar;   // ObjectProperties.noHealthBar â€” no visible HP bar
static const uint32_t& kOffOpInvincElem  = RuntimeOffsets::OP_InvincibleElem;// ObjectProperties.InvincibleElement â€” non-null = permanently invincible
static const uint32_t& kOffObjType       = RuntimeOffsets::ObjType;          // KJMONHENJEN.HFDNHJFNEKA â€” entity objectType
static const uint32_t& kOffMoConds       = RuntimeOffsets::MoConditions;     // LKHPPBEGNOM.COHCKAPOLCA UInt32[]

constexpr uint32_t kIl2CppArrMaxLen = 0x18;
constexpr uint32_t kIl2CppArrData  = 0x20;

// Object types excluded from auto-aim, wizard cluster scans, and any other path using SehReadEnemyCandidate.
static constexpr int32_t kIgnoredEnemyObjectTypes[] = { 28491 };

// Quest / boss objectType IDs â€” these are prioritised as first-pass targets.
// Sourced from multitool Class27.list_0 (hardcoded quest-priority list).
// These are aimed at first even if non-quest enemies exist.
static constexpr int32_t kQuestObjectTypes[] = {
    1337, 2048, 2340, 2349, 3448, 3449, 3452, 3613, 3622, 4312,
    4324, 4325, 4326, 5943, 8200, 24092, 24327, 24351, 24363, 24587,
    29003, 29021, 29039, 29341, 29342, 29723, 29764, 30026, 45104, 45371,
    45076, 28618, 28619, 32751, 29793
};

static bool IsQuestObjectType(int32_t objType)
{
    for (int32_t q : kQuestObjectTypes) {
        if (q == objType) return true;
    }
    return false;
}

static bool IsIgnoredEnemyObjectType(int32_t objType)
{
    for (int32_t ignored : kIgnoredEnemyObjectTypes) {
        if (ignored == objType)
            return true;
    }
    return false;
}

// Object types explicitly allowed for auto-aim even if they trip generic filters.
// Used to bypass the maxHp==200 heuristic and any ignored-type filter.
static constexpr int32_t kAutoAimWhitelistedObjectTypes[] = { 31104 };

static bool IsWhitelistedEnemyObjectType(int32_t objType)
{
    for (int32_t allowed : kAutoAimWhitelistedObjectTypes) {
        if (allowed == objType)
            return true;
    }
    return false;
}

// Object types that should only be aimed at when no other valid targets exist.
// (Lowest priority auto-aim list.)
static constexpr int32_t kAutoAimFallbackObjectTypes[] = { 2928 };

static bool IsFallbackEnemyObjectType(int32_t objType)
{
    for (int32_t allowed : kAutoAimFallbackObjectTypes) {
        if (allowed == objType)
            return true;
    }
    return false;
}

// Default aim-range bias (tiles beyond computed weapon range). Exposed via g_rangeLeadBias /
// AutoAim::SetRangeLeadBias â€” matches multitool AutoAimRangeLead.
// Default aim-range bias — Multitool Settings.AutoAimRangeLead = 1.0.
static constexpr float kDefaultRangeLeadBiasTiles = 1.0f;
// Character-side projectile tuning fields used by the decompiled AutoAim helpers.
// The RE notes have not named these yet, but the decompiled formulas treat +0x188
// as the projectile speed multiplier and +0x18C as the projectile lifetime/range multiplier.
// xrDriver FUN_18011ed00 (CalcMaxRange) also reads *(float*)(player + 0x6b8) as an
// additional final range multiplier after the base speed*lifetime integration.
static constexpr uint32_t kOffCharProjSpeedMul    = 0x188;
static constexpr uint32_t kOffCharProjLifetimeMul = 0x18C;
static constexpr uint32_t kOffCharProjRangeMul    = 0x6B8;
static constexpr uint32_t kOffProjId              = 0x15C;
// Projectile objectType ids (objects.xml) — Multitool weapon-specific aim tweaks.
static constexpr int32_t kProjIdCultistFireShot = 0xB0EB; // Staff of Unholy Sacrifice
static constexpr int32_t kProjIdColossusSlash    = 0xB106; // Sword of the Colossus

static const uint32_t& kOffWmDict   = RuntimeOffsets::WM_AllDict;
// IL2CPP Dictionary<int,T> / Array layout â€” .NET runtime invariants, not game-specific.
constexpr uint32_t kOffDictEnt   = 0x18;
constexpr uint32_t kOffDictCnt   = 0x20;
constexpr uint32_t kOffArrMax    = 0x18;
constexpr uint32_t kOffArrData   = 0x20;
constexpr int      kEntryStride  = 24;
// kOffShotAngle: angle field in the SHOOT packet struct at +0x1C (4th slot after 0x10 header).
// TODO: resolve via il2cpp once the exact packet class name is confirmed in the dump.
constexpr uint32_t kOffShotAngle = 0x1C;

// â”€â”€ Dynamic method resolution config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Update these names from a fresh runtime dump when the game updates.
// The resolver finds methods via IL2CPP metadata at runtime, so RVAs
// are never hardcoded and ASLR is irrelevant.
static const char* kPlayerClassName = "LKHPPBEGNOM";  // player entity class
static const char* kShootClassName  = "FKALGHJIADI";  // shoot-handler class
static const char* kCSAMethodName   = "ELCBJAFBLJG";  // ComputeShootAngle
static const int   kCSAParamCount   = 4;
static const char* kSWAMethodName   = "EHGHCACPAGH";  // ShootWithAngle
static const int   kSWAParamCount   = 1;
static const char* kSSPMethodName   = "PMIANFBMMNN";  // SendShotPacket
static const int   kSSPParamCount   = 2;

static void* g_csaTarget = nullptr;
static void* g_swaTarget = nullptr;
static void* g_sspTarget = nullptr;

struct AimVelEntry {
    float     x = 0.f;
    float     y = 0.f;
    ULONGLONG t = 0;
    float     vx = 0.f;
    float     vy = 0.f;
};

using ComputeShootAngleFn = void(__fastcall*)(void* player, uint8_t slotIndex, float* outAngle, bool* outCanShoot, bool boolArg, void* method);
using ShootWithAngleFn    = void(__fastcall*)(void* player, float angle, void* method);
using SendShotPacketFn    = void(__fastcall*)(void* player, void* shotData, int32_t projCount, void* method);

ComputeShootAngleFn g_ComputeShootAngleOriginal = nullptr;
ShootWithAngleFn    g_ShootWithAngleOriginal    = nullptr;
SendShotPacketFn    g_SendShotPacketOriginal    = nullptr;

std::atomic<bool>        g_autoAimEnabled{ false };
std::atomic<bool>        g_enemyNextTickOverlay{ false };
std::atomic<int>         g_aimMode{ 0 };   // Multitool AutoAimMode: 0 closest, 1 highest HP, 2 mouse
std::atomic<float>       g_aimTargetX{ 0.f };
std::atomic<float>       g_aimTargetY{ 0.f };
std::atomic<bool>        g_hasAimTarget{ false };

// Feature toggles (Multitool AutoAim* config + xrDriver DAT_* globals).
std::atomic<bool>        g_shootInvulnerable{ false };     // AutoAimShootInvulnerable
std::atomic<bool>        g_prioritizeBosses{ false };   // PrioritizeBosses — quest/boss targets prioritised; normal enemies still valid
std::atomic<bool>        g_ignoreWalls{ true };            // AutoAimIgnoreWalls
std::atomic<bool>        g_reverseCultStaff{ true };       // AutoAimReverseCultStaff
std::atomic<bool>        g_offsetColossusSword{ false };   // AutoAimOffsetColossusSword
std::atomic<bool>        g_shootWhileStealthed{ true };    // AutoAimShootWhileStealthed (Settings migration default)
std::atomic<bool>        g_mouseBoundingEnabled{ true };   // xrDriver MouseBounding; always on in mouse mode
std::atomic<float>       g_mouseBoundingRange{ 2.f };      // AutoAimMouseDist (Multitool default 2.0 tiles)
std::atomic<float>       g_rangeLeadBias{ kDefaultRangeLeadBiasTiles }; // AutoAimRangeLead
std::atomic<int32_t>     g_aimFocusEnemyId{ 0 };
std::atomic<void*>       g_lastLocalProjProps{ nullptr };
std::atomic<int32_t>     g_lastLocalProjId{ 0 };
std::atomic<float>       g_playerProjSpeedMul{ 1.f };
std::atomic<float>       g_playerProjLifetimeMul{ 1.f };
std::atomic<float>       g_playerProjSpeedRaw{ 10000.f };
std::atomic<float>       g_playerProjLifetimeMs{ 2000.f };  // read from projProps+0x158 at spawn
std::atomic<float>       g_playerProjRangeTiles{ 15.f };    // decomp-style max range cache
std::atomic<float>       g_playerProjAverageSpeedTps{ 10.f };
// True once the range has been resolved from REAL data — either a
// successful RefreshEquippedWeaponRange chain or a fired shot's
// projProps. Lets the planner distinguish detected range from the
// placeholder default, so it can fall back to the user's manual setting.
std::atomic<bool>        g_playerProjRangeResolved{ false };
// Realm-transition suspension deadline (GetTickCount64). Aim Tick body
// no-ops while now < deadline; keeps shoot hooks from firing at stale
// pointers from the previous world.
std::atomic<uint64_t>    g_suspendUntilMs{ 0 };
// Diagnostic counters for the passive equipped-weapon range refresh.
std::atomic<uint32_t>    g_wrRefreshAttempts { 0 };
std::atomic<uint32_t>    g_wrRefreshSuccesses{ 0 };
std::atomic<const char*> g_wrLastError    { "init" };

std::atomic<bool>        g_allowTick{ false };

std::unordered_map<int32_t, AimVelEntry> g_aimVelMap;
ULONGLONG                g_aimVelPruneAt = 0;

ULONGLONG                g_firstInstallTick = 0;
bool                     g_hooksInstalled = false;

static void*             s_tickLastPlayerPtr = nullptr;
static ULONGLONG         s_lastTickThrottleMs = 0;

static inline bool AddrOk(const void* p)
{
    const uintptr_t a = reinterpret_cast<uintptr_t>(p);
    return a > 0x10000 && a < 0x7FFFFFFFFFFFULL;
}

// â”€â”€ AutoAim diagnostic logger â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Log path: C:\Users\trump\Desktop\Current\autoaim_debug.log
static constexpr const char* kAimLogPath = "C:\\Users\\trump\\Desktop\\Current\\autoaim_debug.log";
static ULONGLONG s_aimLogLastFlush = 0;
static std::ostringstream s_aimLogBuf;
static int s_aimLogEntries = 0;
static constexpr int kAimLogMaxEntries = 120;  // cap to avoid huge files

static void AimLog(const char* msg)
{
    if (s_aimLogEntries >= kAimLogMaxEntries) return;
    ++s_aimLogEntries;
    s_aimLogBuf << msg << "\n";
}

static void AimLogFlush()
{
    const ULONGLONG now = GetTickCount64();
    if (now - s_aimLogLastFlush < 2000ULL) return;
    s_aimLogLastFlush = now;
    if (s_aimLogBuf.str().empty()) return;
    std::ofstream f(kAimLogPath, std::ios::app);
    if (f.is_open()) {
        f << s_aimLogBuf.str();
        s_aimLogBuf.str("");
        s_aimLogBuf.clear();
    }
}

// Scan memory around a base address and dump values â€” used to find the real COHCKAPOLCA offset.
// Writes one line per 4-byte slot over [base+startOff .. base+startOff+count*4].
static void AimLogScanU32(const char* label, uint8_t* base, uint32_t startOff, int count)
{
    char line[256];
    for (int i = 0; i < count; ++i) {
        uint32_t off = startOff + static_cast<uint32_t>(i) * 4;
        uint32_t val = 0;
        __try { val = *reinterpret_cast<uint32_t*>(base + off); }
        __except (EXCEPTION_EXECUTE_HANDLER) { val = 0xDEADBEEF; }
        snprintf(line, sizeof(line), "  %s[+0x%X] = 0x%08X", label, off, val);
        AimLog(line);
    }
}

// Dump the candidate UInt32[] array at a given pointer field offset on entity.
// Prints maxLen, data[0], data[1] so we can verify COHCKAPOLCA shape.
static void AimLogCondArray(const char* label, uint8_t* entity, uint32_t fieldOff)
{
    char line[256];
    void* arr = nullptr;
    __try { arr = *reinterpret_cast<void**>(entity + fieldOff); }
    __except (EXCEPTION_EXECUTE_HANDLER) { arr = nullptr; }

    if (!arr || !AddrOk(arr)) {
        snprintf(line, sizeof(line), "  %s @+0x%X: arr=NULL/bad", label, fieldOff);
        AimLog(line);
        return;
    }
    int32_t maxLen = 0;
    uint32_t d0 = 0, d1 = 0;
    __try {
        uint8_t* a = reinterpret_cast<uint8_t*>(arr);
        maxLen = *reinterpret_cast<int32_t*>(a + 0x18);
        d0     = *reinterpret_cast<uint32_t*>(a + 0x20);
        d1     = *reinterpret_cast<uint32_t*>(a + 0x24);
    } __except (EXCEPTION_EXECUTE_HANDLER) { maxLen = -1; }

    snprintf(line, sizeof(line), "  %s @+0x%X: arr=%p maxLen=%d d0=0x%08X d1=0x%08X",
             label, fieldOff, arr, maxLen, d0, d1);
    AimLog(line);
}

static bool GatesOpen()
{
    return g_autoAimEnabled.load(std::memory_order_relaxed);
}

// Multitool AutoAimShootWhileStealthed: when false, do not aim while local has Invisible.
static bool LocalStealthBlocksAutoAim(void* player)
{
    if (g_shootWhileStealthed.load(std::memory_order_relaxed))
        return false;
    if (!AddrOk(player))
        return false;
    uint32_t w0 = 0, w1 = 0;
    if (!RuntimeOffsets::TryReadMapObjectConditions(player, &w0, &w1))
        return false;
    const uint64_t full = RuntimeOffsets::GetFullConditions(w0, w1);
    return RuntimeOffsets::HasCondition(full, RuntimeOffsets::ConditionEffects::Invisible);
}

static bool AimRedirectionActive(void* player)
{
    return GatesOpen() && !LocalStealthBlocksAutoAim(player);
}

// Staff of Unholy Sacrifice / Cultist Fire Shot — Multitool reverses firing direction (+π).
// Sword of the Colossus / Colossus Slash — optional offset when enabled (exact radians TBD from Multitool DLL).
static float MultitoolApplyWeaponAngleTweaks(float angleRad)
{
    const int32_t pid = g_lastLocalProjId.load(std::memory_order_relaxed);
    float a = angleRad;
    if (g_reverseCultStaff.load(std::memory_order_relaxed) && pid == kProjIdCultistFireShot)
        a += 3.14159265f;
    if (g_offsetColossusSword.load(std::memory_order_relaxed) && pid == kProjIdColossusSlash)
        a += 0.f; // TODO: match Multitool version.dll fixed offset when extracted
    return a;
}

static float ResolveProjectileLinearAccel(uint8_t* projProps)
{
    const float rawAccel = *reinterpret_cast<float*>(projProps + RuntimeOffsets::PP_Acceleration);
    if (std::isfinite(rawAccel) && fabsf(rawAccel) > 1e-6f)
        return rawAccel;
    const float accelInv = *reinterpret_cast<float*>(projProps + RuntimeOffsets::PP_AccelerationInv);
    if (std::isfinite(accelInv) && fabsf(accelInv) > 1e-12f)
        return 1.f / accelInv;
    const float velRate = *reinterpret_cast<float*>(projProps + RuntimeOffsets::PP_VelocityChangeRate);
    if (std::isfinite(velRate) && fabsf(velRate) > 1e-6f)
        return velRate;
    const float velRateInv = *reinterpret_cast<float*>(projProps + RuntimeOffsets::PP_VelocityChangeRateInv);
    if (std::isfinite(velRateInv) && fabsf(velRateInv) > 1e-12f)
        return 1.f / velRateInv;
    return 0.f;
}
static float IntegratedProjectileDistance(
    uint8_t* projProps,
    float lifetimeMs,
    float speedMul,
    float rawSpeed)
{
    const float clampedSpeedMul = (speedMul > 1e-6f && speedMul < 100.f) ? speedMul : 1.f;
    const float baseSpeedTilesPerMs = (rawSpeed / 10000.f) * clampedSpeedMul;
    if (!(lifetimeMs > 0.f))
        return 0.f;
    float accelLinear = ResolveProjectileLinearAccel(projProps);
    const bool isBoomerang = *reinterpret_cast<bool*>(projProps + RuntimeOffsets::PP_IsBoomerang);
    if (fabsf(accelLinear) <= 1e-6f && isBoomerang && lifetimeMs > 1e-3f && rawSpeed > 1.f && rawSpeed <= 50000.f)
        accelLinear = -2.f * rawSpeed / lifetimeMs;
    if (fabsf(accelLinear) <= 1e-6f)
        return lifetimeMs * baseSpeedTilesPerMs;
    const float accelTilesPerMs2 = (accelLinear / 1000000.f) * clampedSpeedMul;
    const float rawDelay = *reinterpret_cast<float*>(projProps + RuntimeOffsets::PP_AccelDelay);
    const float delayMs = ProjectileTracking::NormalizeAccelDelayMs(rawDelay);
    const float scaledDelayMs = (delayMs > 0.f) ? delayMs / clampedSpeedMul : 0.f;
    if (lifetimeMs <= scaledDelayMs)
        return lifetimeMs * baseSpeedTilesPerMs;
    const float firstSegment = scaledDelayMs * baseSpeedTilesPerMs;
    const float accelTimeMs = lifetimeMs - scaledDelayMs;
    float accelDistance = baseSpeedTilesPerMs * accelTimeMs + 0.5f * accelTilesPerMs2 * accelTimeMs * accelTimeMs;
    const float speedClamp = *reinterpret_cast<float*>(projProps + RuntimeOffsets::PP_SpeedClamp);
    if (speedClamp > 0.f && std::isfinite(speedClamp)) {
        const float clampTilesPerMs = (speedClamp / 1000.f) * clampedSpeedMul;
        if (accelTilesPerMs2 > 1e-12f && clampTilesPerMs > baseSpeedTilesPerMs) {
            const float timeToClamp = (clampTilesPerMs - baseSpeedTilesPerMs) / accelTilesPerMs2;
            if (timeToClamp > 0.f && accelTimeMs > timeToClamp) {
                const float preClamp = baseSpeedTilesPerMs * timeToClamp +
                    0.5f * accelTilesPerMs2 * timeToClamp * timeToClamp;
                accelDistance = preClamp + clampTilesPerMs * (accelTimeMs - timeToClamp);
            }
        } else if (accelTilesPerMs2 < -1e-12f && clampTilesPerMs < baseSpeedTilesPerMs && clampTilesPerMs >= 0.f) {
            const float timeToFloor = (baseSpeedTilesPerMs - clampTilesPerMs) / (-accelTilesPerMs2);
            if (timeToFloor > 0.f && accelTimeMs > timeToFloor) {
                const float toFloor = baseSpeedTilesPerMs * timeToFloor +
                    0.5f * accelTilesPerMs2 * timeToFloor * timeToFloor;
                accelDistance = toFloor + clampTilesPerMs * (accelTimeMs - timeToFloor);
            }
        }
    } else if (accelTilesPerMs2 < 0.f) {
        const float timeToStop = baseSpeedTilesPerMs / (-accelTilesPerMs2);
        if (timeToStop > 0.f && accelTimeMs > timeToStop) {
            accelDistance = baseSpeedTilesPerMs * timeToStop +
                0.5f * accelTilesPerMs2 * timeToStop * timeToStop;
        }
    }
    return firstSegment + accelDistance;
}
static bool ReadLocalProjectileTuners(void* local, float& outSpeedMul, float& outLifetimeMul, float& outRangeMul)
{
    if (!AddrOk(local))
        return false;
    __try {
        uint8_t* p = reinterpret_cast<uint8_t*>(local);
        outSpeedMul = *reinterpret_cast<float*>(p + kOffCharProjSpeedMul);
        outLifetimeMul = *reinterpret_cast<float*>(p + kOffCharProjLifetimeMul);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
    outRangeMul = 1.f;
    __try {
        outRangeMul = *reinterpret_cast<float*>(reinterpret_cast<uint8_t*>(local) + kOffCharProjRangeMul);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        outRangeMul = 1.f;
    }
    if (!std::isfinite(outSpeedMul) || outSpeedMul <= 0.f || outSpeedMul > 100.f)
        outSpeedMul = 1.f;
    if (!std::isfinite(outLifetimeMul) || outLifetimeMul <= 0.f || outLifetimeMul > 100.f)
        outLifetimeMul = 1.f;
    if (!std::isfinite(outRangeMul) || outRangeMul <= 0.f || outRangeMul > 100.f)
        outRangeMul = 1.f;
    return true;
}
static void UpdateAutoAimValues(void* local)
{
    void* projProps = g_lastLocalProjProps.load(std::memory_order_relaxed);
    if (!AddrOk(local) || !AddrOk(projProps))
        return;
    float speedMul = 1.f;
    float lifetimeMul = 1.f;
    float rangeMul = 1.f;
    if (!ReadLocalProjectileTuners(local, speedMul, lifetimeMul, rangeMul))
        return;
    __try {
        uint8_t* pp = reinterpret_cast<uint8_t*>(projProps);
        const int32_t rawSpeedInt = *reinterpret_cast<int32_t*>(pp + RuntimeOffsets::PP_Speed);
        if (rawSpeedInt <= 100 || rawSpeedInt >= 500000)
            return;
        const float rawSpeed = static_cast<float>(rawSpeedInt);
        const float rawLifetime = *reinterpret_cast<float*>(pp + RuntimeOffsets::PP_Lifetime);
        const float lifetimeMs = ProjectileTracking::NormalizeProjectileLifetimeMs(rawLifetime) * lifetimeMul;
        if (!(lifetimeMs > 1.f) || !std::isfinite(lifetimeMs))
            return;
        float maxRangeTiles = 0.f;
        if (*reinterpret_cast<bool*>(pp + RuntimeOffsets::PP_IsParametric)) {
            const float magnitude = *reinterpret_cast<float*>(pp + RuntimeOffsets::PP_Magnitude);
            maxRangeTiles = (std::isfinite(magnitude) && magnitude > 0.f) ? magnitude * speedMul : 0.f;
        } else {
            maxRangeTiles = IntegratedProjectileDistance(pp, lifetimeMs, speedMul, rawSpeed);
        }
        if (!(maxRangeTiles > 0.f) || !std::isfinite(maxRangeTiles))
            return;
        // xrDriver FUN_18011ed00 applies player+0x6b8 as a final range scalar on top of speed*lifetime.
        maxRangeTiles *= rangeMul;
        float averageSpeedTps = (maxRangeTiles / lifetimeMs) * 1000.f;
        if (!(averageSpeedTps > 0.01f) || !std::isfinite(averageSpeedTps))
            averageSpeedTps = (rawSpeed / 10000.f) * speedMul * 1000.f;
        g_playerProjSpeedMul.store(speedMul, std::memory_order_relaxed);
        g_playerProjLifetimeMul.store(lifetimeMul, std::memory_order_relaxed);
        g_playerProjSpeedRaw.store(rawSpeed, std::memory_order_relaxed);
        g_playerProjLifetimeMs.store(lifetimeMs, std::memory_order_relaxed);
        g_playerProjRangeTiles.store(maxRangeTiles, std::memory_order_relaxed);
        g_playerProjAverageSpeedTps.store(averageSpeedTps, std::memory_order_relaxed);
    } __except (EXCEPTION_EXECUTE_HANDLER) {}
}

// FacingAngle hook: LKHPPBEGNOM_ACCKOGJECPB @ 0x01B51FE0
// DIA4A's primary/recommended hook. Returns the facing angle baseline â€” overriding
// here makes the player sprite rotate to face target and feeds the correct angle
// into ComputeShootAngle as its starting point.
// ComputeShootAngle hook: LKHPPBEGNOM_ELCBJAFBLJG @ 0x01B54BA0
// Called by the game to resolve final shot angle + canShoot flag.
// Strategy: call original first (so canShoot logic runs normally), then
// overwrite *outAngle with atan2(target - player). One write here propagates
// to projectile visual, packet field, and server hit-reg â€” the primary hook
// for actual shot redirection (FacingAngle was cosmetic-only and crashes on
// Detours trampolines during realm entity initialization).

void __fastcall ComputeShootAngleDetour(
    void*    player,
    uint8_t  slotIndex,
    float*   outAngle,
    bool*    outCanShoot,
    bool     boolArg,
    void*    method)
{
    g_ComputeShootAngleOriginal(player, slotIndex, outAngle, outCanShoot, boolArg, method);

    if (!AimRedirectionActive(player)) return;
    if (!AddrOk(player)) return;

    void* local = GameState::GetLocalPtr();
    if (!local || player != local) return;
    if (!g_hasAimTarget.load(std::memory_order_relaxed)) return;
    if (!outAngle) return;

    float px = 0.f, py = 0.f;
    __try {
        uint8_t* lp = reinterpret_cast<uint8_t*>(player);
        px = *reinterpret_cast<float*>(lp + kOffPosX);
        py = *reinterpret_cast<float*>(lp + kOffPosY);
    } __except (EXCEPTION_EXECUTE_HANDLER) { return; }

    float tx = g_aimTargetX.load(std::memory_order_relaxed);
    float ty = g_aimTargetY.load(std::memory_order_relaxed);
    *outAngle = MultitoolApplyWeaponAngleTweaks(atan2f(ty - py, tx - px));
}

void __fastcall ShootWithAngleDetour(void* player, float angle, void* method)
{
    if (AimRedirectionActive(player) && AddrOk(player)) {
        void* local = GameState::GetLocalPtr();
        if (local && player == local && g_hasAimTarget.load(std::memory_order_relaxed)) {
            float px2 = 0.f, py2 = 0.f;
            __try {
                uint8_t* lp = reinterpret_cast<uint8_t*>(player);
                px2 = *reinterpret_cast<float*>(lp + kOffPosX);
                py2 = *reinterpret_cast<float*>(lp + kOffPosY);
            } __except (EXCEPTION_EXECUTE_HANDLER) {
                g_ShootWithAngleOriginal(player, angle, method);
                return;
            }
            float tx = g_aimTargetX.load(std::memory_order_relaxed);
            float ty = g_aimTargetY.load(std::memory_order_relaxed);
            float newAngle = MultitoolApplyWeaponAngleTweaks(atan2f(ty - py2, tx - px2));
            g_ShootWithAngleOriginal(player, newAngle, method);
            return;
        }
    }
    g_ShootWithAngleOriginal(player, angle, method);
}

void __fastcall SendShotPacketDetour(void* player, void* shotData, int32_t projCount, void* method)
{
    // Realm / handshake paths may call with projCount==0 or non-standard shotData; skip writes (DIA4A parity for combat only).
    const bool shotBufOk =
        AddrOk(shotData) && AddrOk(reinterpret_cast<const uint8_t*>(shotData) + 0x24); // cover shotData+0x1C float write
    if (AimRedirectionActive(player) && AddrOk(player) && shotBufOk && projCount > 0) {
        void* local = GameState::GetLocalPtr();
        if (local && player == local && g_hasAimTarget.load(std::memory_order_relaxed)) {
            float px2 = 0.f, py2 = 0.f;
            __try {
                uint8_t* lp = reinterpret_cast<uint8_t*>(player);
                px2 = *reinterpret_cast<float*>(lp + kOffPosX);
                py2 = *reinterpret_cast<float*>(lp + kOffPosY);
            } __except (EXCEPTION_EXECUTE_HANDLER) {
                g_SendShotPacketOriginal(player, shotData, projCount, method);
                return;
            }
            float tx = g_aimTargetX.load(std::memory_order_relaxed);
            float ty = g_aimTargetY.load(std::memory_order_relaxed);
            float newAngle = MultitoolApplyWeaponAngleTweaks(atan2f(ty - py2, tx - px2));
            __try {
                *reinterpret_cast<float*>(reinterpret_cast<uint8_t*>(shotData) + kOffShotAngle) = newAngle;
            } __except (EXCEPTION_EXECUTE_HANDLER) {}
            __try {
                *reinterpret_cast<float*>(reinterpret_cast<uint8_t*>(player) + RuntimeOffsets::Player_FacingAngle) = newAngle;
            } __except (EXCEPTION_EXECUTE_HANDLER) {}
        }
    }
    g_SendShotPacketOriginal(player, shotData, projCount, method);
}

// C2712: __try cannot share a function with std::unordered_map (AutoAimThreadProc). Isolate SEH here.
static bool SehReadLocalKlassAndPos(void* local, float* outX, float* outY, uint64_t* outKlass)
{
    __try {
        uint8_t* lp = reinterpret_cast<uint8_t*>(local);
        *outX = *reinterpret_cast<float*>(lp + kOffPosX);
        *outY = *reinterpret_cast<float*>(lp + kOffPosY);
        *outKlass = *reinterpret_cast<uint64_t*>(lp);
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

// wm: WorldMgr ptr (from GameState::GetWorldMgr()); appMgr param unused, kept for signature compat.
static bool SehResolveAllDict(void* wm, void** /*unused*/, void** outAllDict)
{
    __try {
        if (!AddrOk(wm))
            return false;
        void* ad = *reinterpret_cast<void**>(reinterpret_cast<uint8_t*>(wm) + kOffWmDict);
        *outAllDict = ad;
        return AddrOk(ad);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

static bool SehReadDictArrayHeader(void* allDict, void** outEntries, int32_t* outCount)
{
    __try {
        *outEntries = *reinterpret_cast<void**>(reinterpret_cast<uint8_t*>(allDict) + kOffDictEnt);
        *outCount = *reinterpret_cast<int32_t*>(reinterpret_cast<uint8_t*>(allDict) + kOffDictCnt);
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

static bool SehReadArrayMaxLength(void* entriesArr, int32_t* outMaxLen)
{
    __try {
        *outMaxLen = *reinterpret_cast<int32_t*>(reinterpret_cast<uint8_t*>(entriesArr) + kOffArrMax);
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

// Closed-form quadratic intercept (same as multitool sub_180003e20).
// Solves for the smallest positive t such that |enemyPos + enemyVel*t - playerPos| == speed*t.
// t is in seconds; enemyVel and speed are tiles/sec.
// Returns t >= 0 and sets outAimX/Y on success; returns -1 and sets outAimX/Y = enemyPos on failure.
static float QuadraticIntercept(float px, float py, float ex, float ey,
                                 float vx, float vy, float speed,
                                 float& outAimX, float& outAimY)
{
    const float dx = ex - px, dy = ey - py;
    const float a  = vx * vx + vy * vy - speed * speed;
    const float b  = 2.f * (dx * vx + dy * vy);
    const float c  = dx * dx + dy * dy;

    float t = -1.f;
    if (fabsf(a) < 1e-5f) {
        // Near-linear: enemy speed â‰ˆ proj speed â€” simple t = -c/b
        if (fabsf(b) > 1e-9f) t = -c / b;
    } else {
        const float disc = b * b - 4.f * a * c;
        if (disc >= 0.f) {
            const float sqD = sqrtf(disc);
            const float t1  = (-b + sqD) / (2.f * a);
            const float t2  = (-b - sqD) / (2.f * a);
            // Pick smallest positive root (same logic as multitool)
            if (t2 > 0.f && (t1 <= 0.f || t2 < t1))
                t = t2;
            else if (t1 > 0.f)
                t = t1;
        }
    }

    if (t > 0.f) {
        outAimX = ex + vx * t;
        outAimY = ey + vy * t;
        return t;
    }
    outAimX = ex;
    outAimY = ey;
    return -1.f;
}

// Shared enemy filter: not local/same klass, ObjectProperties.isEnemy, valid HP,
// no health bar, not permanently invincible, not runtime-untargetable.
// outIsQuest is set to true when the entity's objectType is in the quest priority list.
// outEntity (optional) receives the raw entity pointer for ECGPFJKCCAN velocity reading.
// outIsInvulnerable (optional) is set to true when the entity has a non-empty InvincibleElement
// string — only returned instead of rejected when g_shootInvulnerable is enabled.
// outHp (optional) receives the entity's current HP for HighestHP aim mode.
static bool SehReadEnemyCandidate(
    uint8_t* entry,
    void*    local,
    uint64_t localKlass,
    int32_t* outId,
    float*   outX,
    float*   outY,
    int32_t* outObjType,
    bool*    outIsQuest        = nullptr,
    void**   outEntity         = nullptr,
    bool*    outIsInvulnerable = nullptr,
    int32_t* outHp             = nullptr)
{
    __try {
        if (*reinterpret_cast<int32_t*>(entry) < 0)
            return false;
        void* entity = *reinterpret_cast<void**>(entry + 16);
        if (!entity || entity == local)
            return false;
        uint64_t entKlass = *reinterpret_cast<uint64_t*>(entity);
        if (entKlass == localKlass)
            return false;
        void* objProps = *reinterpret_cast<void**>(reinterpret_cast<uint8_t*>(entity) + kOffObjProps);
        if (!objProps || !AddrOk(objProps))
            return false;
        uint8_t* op = reinterpret_cast<uint8_t*>(objProps);
        uint8_t* ent = reinterpret_cast<uint8_t*>(entity);

        // â”€â”€ Diagnostic logging (first kAimLogMaxEntries isEnemy entities only) â”€â”€â”€â”€â”€â”€
        static bool s_diagHeaderWritten = false;
        const bool doLog = (s_aimLogEntries < kAimLogMaxEntries);
        if (doLog) {
            if (!s_diagHeaderWritten) {
                s_diagHeaderWritten = true;
                AimLog("=== AutoAim SehReadEnemyCandidate diag (first 120 isEnemy hits) ===");
                char hdr[128];
                snprintf(hdr, sizeof(hdr), "Offsets: HP=0x%X MaxHP=0x%X ObjType=0x%X ObjProps=0x%X",
                         kOffHp, kOffMaxHp, kOffObjType, kOffObjProps);
                AimLog(hdr);
                snprintf(hdr, sizeof(hdr), "OP_IsEnemy=0x%X OP_NoHealthBar=0x%X OP_InvincElem=0x%X MoConds=0x%X",
                         kOffOpIsEnemy, kOffOpNoHealthBar, kOffOpInvincElem, kOffMoConds);
                AimLog(hdr);
            }
        }

        // XML isEnemy flag.
        if (!*reinterpret_cast<uint8_t*>(op + kOffOpIsEnemy))
            return false;

        // -- entity passed isEnemy, log it --
        int32_t objTypeEarly = 0;
        __try { objTypeEarly = *reinterpret_cast<int32_t*>(ent + kOffObjType); } __except(EXCEPTION_EXECUTE_HANDLER) {}
        int32_t hpEarly = 0, maxHpEarly = 0;
        __try { hpEarly   = *reinterpret_cast<int32_t*>(ent + kOffHp);    } __except(EXCEPTION_EXECUTE_HANDLER) {}
        __try { maxHpEarly = *reinterpret_cast<int32_t*>(ent + kOffMaxHp); } __except(EXCEPTION_EXECUTE_HANDLER) {}

        uint8_t noHB   = 0;
        void*   invPtr = nullptr;
        __try { noHB   = *reinterpret_cast<uint8_t*>(op + kOffOpNoHealthBar); } __except(EXCEPTION_EXECUTE_HANDLER) { noHB = 0xFF; }
        __try { invPtr = *reinterpret_cast<void**>(op + kOffOpInvincElem);     } __except(EXCEPTION_EXECUTE_HANDLER) { invPtr = (void*)0xDEAD; }

        // check InvincibleElement string length early so we can include it in the log line
        int32_t invStrLen = -1;
        if (invPtr && AddrOk(invPtr) && invPtr != (void*)0xDEAD) {
            __try { invStrLen = *reinterpret_cast<int32_t*>(reinterpret_cast<uint8_t*>(invPtr) + 0x10); }
            __except (EXCEPTION_EXECUTE_HANDLER) { invStrLen = -2; }
        }

        if (doLog) {
            char line[256];
            snprintf(line, sizeof(line),
                "ent=%p type=%d hp=%d maxHp=%d noHB=%u invPtr=%p invLen=%d",
                entity, objTypeEarly, hpEarly, maxHpEarly, noHB, invPtr, invStrLen);
            AimLog(line);
        }

        // noHealthBar — Multitool AutoAimIgnoreWalls: when true, treat as wall/destructible (skip).
        if (g_ignoreWalls.load(std::memory_order_relaxed) && noHB && noHB != 0xFF) {
            if (doLog) AimLog("  -> REJECTED: noHealthBar");
            return false;
        }

        // XML <Invincible/> static flag â€” InvincibleElement string pointer non-null = permanently invincible.
        // Also check the string length to guard against empty-string false positives.
        // When g_shootInvulnerable is true we keep invuln targets as candidates (but flag them so the
        // caller can deprioritise them below non-invulnerable enemies). Matches multitool
        // AutoAimShootInvulnerable / xrDriver targetInvulnerable behaviour.
        bool isInvulnerable = false;
        if (invPtr && AddrOk(invPtr) && invPtr != (void*)0xDEAD) {
            int32_t strLen = -1;
            __try { strLen = *reinterpret_cast<int32_t*>(reinterpret_cast<uint8_t*>(invPtr) + 0x10); }
            __except (EXCEPTION_EXECUTE_HANDLER) { strLen = -1; }
            if (strLen > 0) {
                isInvulnerable = true;
                if (!g_shootInvulnerable.load(std::memory_order_relaxed)) {
                    if (doLog) { char l[128]; snprintf(l,sizeof(l),"  -> REJECTED: InvincibleElement strLen=%d", strLen); AimLog(l); }
                    return false;
                }
            }
        }

        int32_t hp = *reinterpret_cast<int32_t*>(ent + kOffHp);
        int32_t maxHp = *reinterpret_cast<int32_t*>(ent + kOffMaxHp);
        if (hp <= 0 || maxHp <= 0) {
            if (doLog) { char l[64]; snprintf(l,sizeof(l),"  -> REJECTED: hp=%d maxHp=%d", hp, maxHp); AimLog(l); }
            return false;
        }
        const int32_t objType = *reinterpret_cast<int32_t*>(ent + kOffObjType);
        const bool whitelisted = IsWhitelistedEnemyObjectType(objType);

        if (!whitelisted) {
            if (maxHp == 200 || (hp == 200 && maxHp == 0)) {
                if (doLog) AimLog("  -> REJECTED: maxHp==200 heuristic");
                return false;
            }
            if (IsIgnoredEnemyObjectType(objType)) {
                if (doLog) AimLog("  -> REJECTED: ignored objType");
                return false;
            }
        }

        // Runtime condition check: use TryReadMapObjectConditions which has correct SEH
        // handling and the same maxLen==2 guard.
        // Root cause of the bug: the old manual array walk left cond0=cond1=0 whenever
        // maxLen != 2 (which is always true for enemy entities, since COHCKAPOLCA is a
        // player-class field and enemies store a float 1.0f there instead of an array
        // pointer). MapObjectConditionsMakeUntargetable(0,0) always returned false, so
        // invulnerable enemies were never rejected by the runtime condition check.
        // Fix: delegate to TryReadMapObjectConditions and only apply the untargetable
        // check when it successfully reads a valid UInt32[2] array (condReadOk==true
        // and at least one word is non-zero). If the read fails or returns zero words
        // (wrong entity class), we skip the runtime check and rely solely on the XML
        // InvincibleElement check above, which already handles static invincibility.
        uint32_t cond0 = 0, cond1 = 0;
        const bool condReadOk = RuntimeOffsets::TryReadMapObjectConditions(entity, &cond0, &cond1);
        if (condReadOk && (cond0 | cond1) != 0 && RuntimeOffsets::MapObjectConditionsMakeUntargetable(cond0, cond1)) {
            if (doLog) { char l[128]; snprintf(l,sizeof(l),"  -> REJECTED: untargetable cond0=0x%08X cond1=0x%08X", cond0, cond1); AimLog(l); }
            return false;
        }
        if (doLog) { char l[128]; snprintf(l,sizeof(l),"  -> PASSED all filters (condReadOk=%d cond0=0x%08X)", (int)condReadOk, cond0); AimLog(l); }

        *outX = *reinterpret_cast<float*>(reinterpret_cast<uint8_t*>(entity) + kOffPosX);
        *outY = *reinterpret_cast<float*>(reinterpret_cast<uint8_t*>(entity) + kOffPosY);
        *outId = *reinterpret_cast<int32_t*>(entry + 8);
        if (outObjType) *outObjType = objType;
        if (outIsQuest) *outIsQuest = IsQuestObjectType(objType);
        if (outEntity) *outEntity = entity;
        if (outIsInvulnerable) *outIsInvulnerable = isInvulnerable;
        if (outHp) *outHp = hp;
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

// Typical server NEWTICK step (~200 ms). Used to weight chord velocity when sample spacing matches one tick.
static constexpr float kServerTickMsMin = 115.f;
static constexpr float kServerTickMsMax = 290.f;
// MoVelocity / finite-difference sanity: tiles/ms (10 tiles/s = 0.01; leave headroom).
static constexpr float kMaxVelTilesPerMs = 0.1f;
static constexpr float kMoVelSmooth = 0.65f; // blend toward fresh MoVelocity reads

// Prefer ECGPFJKCCAN (MoVelocity) when resolved; else estimate chord velocity from successive
// world positions. When dt between samples falls in kServerTickMs* range, weight raw dp/dt
// heavily (server-style snapshot pair). QuadraticIntercept expects tiles/sec â€” multiply by 1000.
static void UpdateAimVelForEntity(int32_t id, float ex, float ey, ULONGLONG nowAim, void* entity)
{
    float moVx = 0.f, moVy = 0.f;
    bool haveMo = false;
    const uint32_t velOff = RuntimeOffsets::MoVelocity;
    if (velOff != 0 && AddrOk(entity)) {
        __try {
            uint8_t* ent = reinterpret_cast<uint8_t*>(entity);
            float rvx = *reinterpret_cast<float*>(ent + velOff);
            float rvy = *reinterpret_cast<float*>(ent + velOff + 4);
            if (std::isfinite(rvx) && std::isfinite(rvy) &&
                fabsf(rvx) < kMaxVelTilesPerMs && fabsf(rvy) < kMaxVelTilesPerMs) {
                moVx = rvx;
                moVy = rvy;
                haveMo = true;
            }
        } __except (EXCEPTION_EXECUTE_HANDLER) {}
    }

    auto it = g_aimVelMap.find(id);
    if (it == g_aimVelMap.end()) {
        g_aimVelMap[id] = { ex, ey, nowAim, haveMo ? moVx : 0.f, haveMo ? moVy : 0.f };
        return;
    }

    AimVelEntry& e = it->second;

    if (haveMo) {
        e.vx = e.vx * (1.f - kMoVelSmooth) + moVx * kMoVelSmooth;
        e.vy = e.vy * (1.f - kMoVelSmooth) + moVy * kMoVelSmooth;
        e.x = ex;
        e.y = ey;
        e.t = nowAim;
        return;
    }

    const float dt = static_cast<float>(nowAim > e.t ? (nowAim - e.t) : 1ULL);
    float dtClamped = dt;
    if (dtClamped < 1.f) dtClamped = 1.f;
    else if (dtClamped > 500.f) dtClamped = 500.f;
    const float dx = ex - e.x;
    const float dy = ey - e.y;
    const float distSq = dx * dx + dy * dy;

    // tiles/ms; linear client lerp has constant dp/dt along a segment, so per-poll iv matches chord rate.
    float ivx = dx / dtClamped;
    float ivy = dy / dtClamped;
    const float instMag = sqrtf(ivx * ivx + ivy * ivy);
    static constexpr float kMaxInstTilesPerMs = 0.08f;
    if (instMag > kMaxInstTilesPerMs && instMag > 1e-8f) {
        const float s = kMaxInstTilesPerMs / instMag;
        ivx *= s;
        ivy *= s;
    }

    float blend = 0.4f;
    if (dt >= kServerTickMsMin && dt <= kServerTickMsMax && distSq > 1e-10f)
        blend = 0.9f;

    if (e.t != 0 && distSq > 1e-14f) {
        e.vx = e.vx * (1.f - blend) + ivx * blend;
        e.vy = e.vy * (1.f - blend) + ivy * blend;
    } else if (distSq > 1e-14f) {
        e.vx = ivx;
        e.vy = ivy;
    }

    e.x = ex;
    e.y = ey;
    e.t = nowAim;
}

// Single aim tick: must run from Present/render thread (see AutoAim::Tick) â€” avoids racing realm transitions.
// State-change-only logger for AutoAim. Kept OUT of RunAutoAimTickBody because
// that function uses __try and MSVC forbids C++ object destructors (std::string,
// std::ostringstream from DBG_FILE_LOG) in the same frame as SEH.
static int s_autoAimLastBailReason = -1;

__declspec(noinline) static void AutoAimLogBail(int reason, const char* msg)
{
    if (reason == s_autoAimLastBailReason) return;
    s_autoAimLastBailReason = reason;
    DBG_FILE_LOG("[AutoAim::Tick] state=" << msg);
}

__declspec(noinline) static void AutoAimLogRunning(int32_t count, int32_t maxLength, float px, float py)
{
    if (s_autoAimLastBailReason == 0) return;
    s_autoAimLastBailReason = 0;
    DBG_FILE_LOG("[AutoAim::Tick] state=running â€” count=" << count
        << " maxLength=" << maxLength
        << " player=(" << px << "," << py << ")");
}

static void RunAutoAimTickBody()
{
    const ULONGLONG now = GetTickCount64();
    const bool pastInjectDelay = (g_firstInstallTick != 0) && (now - g_firstInstallTick > 3000ULL);

    const bool aimEnabled = g_autoAimEnabled.load(std::memory_order_relaxed);
    const bool wantVelOv  = g_enemyNextTickOverlay.load(std::memory_order_relaxed);

    // GameState::Tick() (called before AutoAim::Tick in dPresent) handles all
    // AppMgr/WorldMgr/LocalPtr resolution.  No ForceRefresh needed here.

    if (!aimEnabled && !wantVelOv) {
        g_hasAimTarget.store(false, std::memory_order_relaxed);
        s_tickLastPlayerPtr = nullptr;
        AutoAimLogBail(1, "disabled");
        return;
    }

    void* local = GameState::GetLocalPtr();
    if (!local) {
        if (aimEnabled)
            g_hasAimTarget.store(false, std::memory_order_relaxed);
        s_tickLastPlayerPtr = nullptr;
        AutoAimLogBail(2, "no LocalPtr from GameState");
        return;
    }

    const bool stealthNoAim = LocalStealthBlocksAutoAim(local);
    const bool wantAim      = aimEnabled && !stealthNoAim;

    if (local != s_tickLastPlayerPtr)
        s_tickLastPlayerPtr = local;

    float playerX = 0.f, playerY = 0.f;
    uint64_t localKlass = 0;
    if (!SehReadLocalKlassAndPos(local, &playerX, &playerY, &localKlass)) {
        if (wantAim)
            g_hasAimTarget.store(false, std::memory_order_relaxed);
        AutoAimLogBail(3, "SehReadLocalKlassAndPos failed (PosX/PosY offsets wrong?)");
        return;
    }
    if (localKlass == 0) {
        if (wantAim)
            g_hasAimTarget.store(false, std::memory_order_relaxed);
        AutoAimLogBail(4, "localKlass=0 (player not materialised yet)");
        return;
    }

    UpdateAutoAimValues(local);

    // WorldMgr is already resolved by GameState â€” just read AllDict from it.
    void* allDict = nullptr;
    if (!SehResolveAllDict(GameState::GetWorldMgr(), nullptr, &allDict)) {
        if (wantAim)
            g_hasAimTarget.store(false, std::memory_order_relaxed);
        AutoAimLogBail(5, "SehResolveAllDict failed (WM_AllDict offset wrong?)");
        return;
    }

    void* entriesArr = nullptr;
    int32_t count = 0;
    if (!SehReadDictArrayHeader(allDict, &entriesArr, &count) || !AddrOk(entriesArr) || count <= 0) {
        if (wantAim)
            g_hasAimTarget.store(false, std::memory_order_relaxed);
        char tmp[64];
        snprintf(tmp, sizeof(tmp), "SehReadDictArrayHeader count=%d", count);
        AutoAimLogBail(6, tmp);
        return;
    }

    int32_t maxLength = 0;
    if (!SehReadArrayMaxLength(entriesArr, &maxLength)) {
        if (wantAim)
            g_hasAimTarget.store(false, std::memory_order_relaxed);
        AutoAimLogBail(7, "SehReadArrayMaxLength failed");
        return;
    }

    AutoAimLogRunning(count, maxLength, playerX, playerY);

    int32_t limit = count;
    if (limit > maxLength)
        limit = maxLength;
    if (limit > 4096)
        limit = 4096;

    uint8_t* vectorBase = reinterpret_cast<uint8_t*>(entriesArr) + kOffArrData;

    const ULONGLONG nowAim = GetTickCount64();

    const int aimModeInt = g_aimMode.load(std::memory_order_relaxed);
    const bool useHighestHp  = (aimModeInt == static_cast<int>(AutoAim::AimMode::HighestHP));
    const bool useMouseRef   = (aimModeInt == static_cast<int>(AutoAim::AimMode::ClosestToMouse));
    const bool mouseBoundOn  = g_mouseBoundingEnabled.load(std::memory_order_relaxed);
    const float mouseBoundR  = g_mouseBoundingRange.load(std::memory_order_relaxed);
    const bool prioritizeBosses = g_prioritizeBosses.load(std::memory_order_relaxed);
    const float leadBias     = g_rangeLeadBias.load(std::memory_order_relaxed);

    // Reference point for "closest enemy" â€” player position normally, or mouse world pos in ClosestToMouse mode.
    float refX = playerX, refY = playerY;
    if (wantAim && useMouseRef) {
        const float mx = TestTAB::GetMouseWorldX();
        const float my = TestTAB::GetMouseWorldY();
        if (mx != 0.f || my != 0.f) { refX = mx; refY = my; }
    }

    // Use actual weapon range (speed Ã— lifetime), clamped to a sane minimum â€” aim target only.
    // Add g_rangeLeadBias so we track enemies slightly before they enter true shot range.
    const float weaponRange = g_playerProjRangeTiles.load(std::memory_order_relaxed);
    float kMaxRange = ((weaponRange > 2.f) ? weaponRange : 15.f) + leadBias;
    // xrDriver MouseBoundingEnabled: clamp candidate-to-mouse distance to MouseBoundingRange.
    if (wantAim && useMouseRef && mouseBoundOn && mouseBoundR > 0.f && mouseBoundR < kMaxRange)
        kMaxRange = mouseBoundR;
    const float kMaxRangeSq = kMaxRange * kMaxRange;

    // Normal enemy tier (non-quest, non-fallback, non-invulnerable).
    float   bestScoreDist = kMaxRangeSq;    // smaller is better
    int32_t bestScoreHp   = -1;             // larger is better (HighestHP mode)
    float   bestX = 0.f, bestY = 0.f;
    int32_t bestId = 0;
    void*   bestEntity = nullptr;
    bool    found = false;

    // Quest/boss priority tier â€” beats any normal tier pick regardless of distance/hp.
    float   questScoreDist = kMaxRangeSq;
    int32_t questScoreHp   = -1;
    float   questBestX = 0.f, questBestY = 0.f;
    int32_t questBestId = 0;
    void*   questBestEntity = nullptr;
    bool    questFound = false;

    // Fallback tier (kAutoAimFallbackObjectTypes) â€” only used if nothing else matched.
    float   fbScoreDist = kMaxRangeSq;
    int32_t fbScoreHp   = -1;
    float   fallbackBestX = 0.f, fallbackBestY = 0.f;
    int32_t fallbackBestId = 0;
    void*   fallbackBestEntity = nullptr;
    bool    fallbackFound = false;

    // Invulnerable tier â€” only populated when g_shootInvulnerable is on; below non-invuln tiers.
    float   invScoreDist = kMaxRangeSq;
    int32_t invScoreHp   = -1;
    float   invBestX = 0.f, invBestY = 0.f;
    int32_t invBestId = 0;
    void*   invBestEntity = nullptr;
    bool    invFound = false;

    for (int32_t i = 0; i < limit; ++i) {
        uint8_t* entry = vectorBase + i * kEntryStride;
        int32_t eid = 0;
        int32_t objType = 0;
        float ex = 0.f, ey = 0.f;
        bool isQuest = false;
        bool isInvuln = false;
        int32_t candHp = 0;
        void* eptr = nullptr;
        if (!SehReadEnemyCandidate(entry, local, localKlass, &eid, &ex, &ey, &objType,
                                   &isQuest, &eptr, &isInvuln, &candHp))
            continue;

        UpdateAimVelForEntity(eid, ex, ey, nowAim, eptr);

        if (!wantAim)
            continue;

        // Boss Prioritisation: when enabled, isQuest entities go to the quest tier
        // (prioritised over normal enemies). When disabled, quest entities compete
        // in the normal tier alongside other enemies. No entity is skipped — the
        // toggle only controls which tier quest entities land in.

        const float dx = ex - refX;
        const float dy = ey - refY;
        const float distSq = dx * dx + dy * dy;
        if (distSq > kMaxRangeSq)
            continue;

        // HighestHP mode: compare by HP (larger wins); otherwise by distance (smaller wins).
        auto beats = [&](float curDist, int32_t curHp, float newDist, int32_t newHp) {
            if (useHighestHp)
                return newHp > curHp || (newHp == curHp && newDist < curDist);
            return newDist < curDist;
        };

        // Whitelisted entities always go to the normal tier (never prioritised).
        const bool whitelisted = IsWhitelistedEnemyObjectType(objType);

        if (prioritizeBosses && isQuest && !whitelisted) {
            // Boss priority on: quest entities land in the quest tier (high priority).
            if (beats(questScoreDist, questScoreHp, distSq, candHp)) {
                questScoreDist = distSq;
                questScoreHp   = candHp;
                questBestX = ex; questBestY = ey;
                questBestId = eid; questBestEntity = eptr;
                questFound = true;
            }
        } else if (isInvuln) {
            // Only reached when g_shootInvulnerable is on (filter rejects it otherwise).
            if (beats(invScoreDist, invScoreHp, distSq, candHp)) {
                invScoreDist = distSq;
                invScoreHp   = candHp;
                invBestX = ex; invBestY = ey;
                invBestId = eid; invBestEntity = eptr;
                invFound = true;
            }
        } else if (prioritizeBosses && isQuest) {
            // Boss priority on but whitelisted: quest entity goes to normal tier.
            if (beats(bestScoreDist, bestScoreHp, distSq, candHp)) {
                bestScoreDist = distSq;
                bestScoreHp   = candHp;
                bestX = ex; bestY = ey;
                bestId = eid; bestEntity = eptr;
                found = true;
            }
        } else if (IsFallbackEnemyObjectType(objType)) {
            if (beats(fbScoreDist, fbScoreHp, distSq, candHp)) {
                fbScoreDist = distSq;
                fbScoreHp   = candHp;
                fallbackBestX = ex; fallbackBestY = ey;
                fallbackBestId = eid; fallbackBestEntity = eptr;
                fallbackFound = true;
            }
        } else {
            // Boss priority off (or non-quest): quest entities compete in normal tier.
            if (beats(bestScoreDist, bestScoreHp, distSq, candHp)) {
                bestScoreDist = distSq;
                bestScoreHp   = candHp;
                bestX = ex; bestY = ey;
                bestId = eid; bestEntity = eptr;
                found = true;
            }
        }
    }

    // Priority: quest/boss > normal enemies > fallback > invulnerable.
    if (wantAim && questFound) {
        bestX = questBestX; bestY = questBestY; bestId = questBestId;
        bestEntity = questBestEntity; found = true;
    } else if (wantAim && !found && fallbackFound) {
        bestX = fallbackBestX;
        bestY = fallbackBestY;
        bestId = fallbackBestId;
        bestEntity = fallbackBestEntity;
        found = true;
    } else if (wantAim && !found && invFound) {
        bestX = invBestX;
        bestY = invBestY;
        bestId = invBestId;
        bestEntity = invBestEntity;
        found = true;
    }

    if (nowAim >= g_aimVelPruneAt) {
        g_aimVelPruneAt = nowAim + 5000ULL;
        for (auto it2 = g_aimVelMap.begin(); it2 != g_aimVelMap.end();) {
            if (nowAim - it2->second.t > 8000ULL)
                it2 = g_aimVelMap.erase(it2);
            else
                ++it2;
        }
    }

    float aimX = bestX, aimY = bestY;
    if (wantAim && found && bestId != 0) {
        // Velocity: already merged per-entity in UpdateAimVelForEntity (MoVelocity + chord fallback).
        float vx = 0.f, vy = 0.f;
        const auto itVel = g_aimVelMap.find(bestId);
        if (itVel != g_aimVelMap.end()) {
            vx = itVel->second.vx;
            vy = itVel->second.vy;
        }

        // --- Compute effective projectile speed in tiles/sec (handles accelerating projs) ---
        // Use total range / lifetime as average effective speed â€” multitool's approach:
        //   projSpeed = sub_180003830(projProps, speedMult, lifetime) / (lifetime_s * speedMult)
        // Our ProjectileTracking already computes range via IntegratedDistanceAlongAim which
        // accounts for acceleration exactly the same way.
        float projSpeedTps = g_playerProjAverageSpeedTps.load(std::memory_order_relaxed);

        if (projSpeedTps < 0.1f) projSpeedTps = 10.f; // guard

        // QuadraticIntercept uses tiles/sec for enemy vel; map stores tiles/ms.
        if (vx != 0.f || vy != 0.f) {
            const float vxTps = vx * 1000.f;
            const float vyTps = vy * 1000.f;
            QuadraticIntercept(playerX, playerY, bestX, bestY, vxTps, vyTps, projSpeedTps, aimX, aimY);
        }
    }

    if (wantAim) {
        g_aimTargetX.store(aimX, std::memory_order_relaxed);
        g_aimTargetY.store(aimY, std::memory_order_relaxed);
        g_hasAimTarget.store(found, std::memory_order_relaxed);
        g_aimFocusEnemyId.store(found ? bestId : 0, std::memory_order_relaxed);
    } else {
        g_hasAimTarget.store(false, std::memory_order_relaxed);
        g_aimFocusEnemyId.store(0, std::memory_order_relaxed);
    }

    AimLogFlush();
}

// Standalone dict walk for combat helpers (cluster aim, etc.) â€” mirrors RunAutoAimTickBody entity loop.
static void EnumerateLiveEnemiesBody(AutoAim::EnemyScanCallback cb, void* user)
{
    if (!cb)
        return;

    void* local = GameState::GetLocalPtr();
    if (!local)
        return;

    float playerX = 0.f, playerY = 0.f;
    uint64_t localKlass = 0;
    if (!SehReadLocalKlassAndPos(local, &playerX, &playerY, &localKlass))
        return;
    if (localKlass == 0)
        return;

    void* allDict = nullptr;
    if (!SehResolveAllDict(GameState::GetWorldMgr(), nullptr, &allDict))
        return;

    void* entriesArr = nullptr;
    int32_t count = 0;
    if (!SehReadDictArrayHeader(allDict, &entriesArr, &count) || !AddrOk(entriesArr) || count <= 0)
        return;

    int32_t maxLength = 0;
    if (!SehReadArrayMaxLength(entriesArr, &maxLength))
        return;

    int32_t limit = count;
    if (limit > maxLength)
        limit = maxLength;
    if (limit > 4096)
        limit = 4096;

    uint8_t* vectorBase = reinterpret_cast<uint8_t*>(entriesArr) + kOffArrData;

    for (int32_t i = 0; i < limit; ++i) {
        uint8_t* entry = vectorBase + i * kEntryStride;
        int32_t eid = 0;
        int32_t objType = 0;
        float ex = 0.f, ey = 0.f;
        if (!SehReadEnemyCandidate(entry, local, localKlass, &eid, &ex, &ey, &objType))
            continue;
        cb(ex, ey, eid, user);
    }
}

} // namespace

namespace AutoAim {

void Tick()
{
    // Retry every tick until actually installed. The old code called these
    // once and set a one-shot flag EVEN ON FAILURE — if the projectile/AoE
    // IL2CPP classes weren't registered yet at that single early Tick (game
    // world still loading), the hooks never installed and projs stayed 0
    // forever (XDodge had nothing to dodge). Both Install()s self-guard with
    // `if (g_Installed) return;`, so this is a cheap no-op once done — same
    // retry pattern as DangerPlanner::TryInstall and AutoAim's g_hooksInstalled.
    ProjectileTracking::Install();
    AoeTracking::Install();
    if (!g_hooksInstalled) {
        Install();
        if (!g_hooksInstalled) return;
    }

    if (!g_allowTick.load(std::memory_order_acquire))
        return;

    const ULONGLONG wall = GetTickCount64();
    if (wall - s_lastTickThrottleMs < 8ULL)
        return;
    s_lastTickThrottleMs = wall;

    RunAutoAimTickBody();
}

void SetEnabled(bool on)
{
    g_autoAimEnabled.store(on, std::memory_order_relaxed);
    if (!on)
        g_hasAimTarget.store(false, std::memory_order_relaxed);
    // GameState::Tick() runs every frame and keeps LocalPtr/WorldMgr current â€”
    // no ForceRefresh needed.
}

bool IsEnabled()
{
    return g_autoAimEnabled.load(std::memory_order_relaxed);
}

void SetAimMode(AimMode mode)
{
    const int raw = static_cast<int>(mode);
    // Clamp to known modes (0=ClosestToPlayer, 1=ClosestToMouse, 2=HighestHP).
    const int clamped = (raw < 0 || raw > 2) ? 0 : raw;
    g_aimMode.store(clamped, std::memory_order_relaxed);
}

AimMode GetAimMode()
{
    return static_cast<AimMode>(g_aimMode.load(std::memory_order_relaxed));
}

void SetShootInvulnerable(bool on)
{
    g_shootInvulnerable.store(on, std::memory_order_relaxed);
}

bool IsShootInvulnerable()
{
    return g_shootInvulnerable.load(std::memory_order_relaxed);
}

void SetPrioritizeBosses(bool on)
{
    g_prioritizeBosses.store(on, std::memory_order_relaxed);
}

bool IsPrioritizeBosses()
{
    return g_prioritizeBosses.load(std::memory_order_relaxed);
}

void SetMouseBoundingEnabled(bool on)
{
    g_mouseBoundingEnabled.store(on, std::memory_order_relaxed);
}

bool IsMouseBoundingEnabled()
{
    return g_mouseBoundingEnabled.load(std::memory_order_relaxed);
}

void SetMouseBoundingRange(float tiles)
{
    if (!std::isfinite(tiles) || tiles < 0.f) tiles = 0.f;
    if (tiles > 200.f) tiles = 200.f;
    g_mouseBoundingRange.store(tiles, std::memory_order_relaxed);
}

float GetMouseBoundingRange()
{
    return g_mouseBoundingRange.load(std::memory_order_relaxed);
}

void SetRangeLeadBias(float tiles)
{
    if (!std::isfinite(tiles) || tiles < 0.f) tiles = 0.f;
    if (tiles > 50.f) tiles = 50.f;
    g_rangeLeadBias.store(tiles, std::memory_order_relaxed);
}

float GetRangeLeadBias()
{
    return g_rangeLeadBias.load(std::memory_order_relaxed);
}

void SetIgnoreWalls(bool on)
{
    g_ignoreWalls.store(on, std::memory_order_relaxed);
}

bool IsIgnoreWalls()
{
    return g_ignoreWalls.load(std::memory_order_relaxed);
}

void SetReverseCultStaff(bool on)
{
    g_reverseCultStaff.store(on, std::memory_order_relaxed);
}

bool IsReverseCultStaff()
{
    return g_reverseCultStaff.load(std::memory_order_relaxed);
}

void SetOffsetColossusSword(bool on)
{
    g_offsetColossusSword.store(on, std::memory_order_relaxed);
}

bool IsOffsetColossusSword()
{
    return g_offsetColossusSword.load(std::memory_order_relaxed);
}

void SetShootWhileStealthed(bool on)
{
    g_shootWhileStealthed.store(on, std::memory_order_relaxed);
}

bool IsShootWhileStealthed()
{
    return g_shootWhileStealthed.load(std::memory_order_relaxed);
}

void OnLocalPlayerProjectileSpawn(void* projProps, bool isAbility, int32_t attackerObjId, uint32_t ownerObjId)
{
    if (isAbility || !projProps)
        return;
    if (!GameState::GetLocalPtr())
        return;
    const int32_t dk = ProjectileTracking::GetLocalPlayerObjectId();
    const bool isPlayerShot = (dk != 0) && (attackerObjId == dk || static_cast<int32_t>(ownerObjId) == dk);
    if (!isPlayerShot)
        return;
    g_lastLocalProjProps.store(projProps, std::memory_order_relaxed);
    __try {
        uint8_t* pp = reinterpret_cast<uint8_t*>(projProps);
        g_lastLocalProjId.store(*reinterpret_cast<int32_t*>(pp + kOffProjId), std::memory_order_relaxed);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        g_lastLocalProjId.store(0, std::memory_order_relaxed);
    }
    UpdateAutoAimValues(GameState::GetLocalPtr());
}

bool HasTarget()
{
    return g_hasAimTarget.load(std::memory_order_relaxed);
}

void GetAimTarget(float& outX, float& outY)
{
    outX = g_aimTargetX.load(std::memory_order_relaxed);
    outY = g_aimTargetY.load(std::memory_order_relaxed);
}

int32_t GetAimFocusEnemyId()
{
    return g_aimFocusEnemyId.load(std::memory_order_relaxed);
}

bool TryGetEnemyAimLeadSample(int32_t objectId, float& outX, float& outY, float& outVx, float& outVy)
{
    if (objectId == 0)
        return false;
    const auto it = g_aimVelMap.find(objectId);
    if (it == g_aimVelMap.end())
        return false;
    outX  = it->second.x;
    outY  = it->second.y;
    outVx = it->second.vx;
    outVy = it->second.vy;
    return true;
}

float GetProjSpeedRaw()    { return g_playerProjSpeedRaw.load(std::memory_order_relaxed); }
float GetProjLifetimeMs()  { return g_playerProjLifetimeMs.load(std::memory_order_relaxed); }
float GetProjRangeTiles()  { return g_playerProjRangeTiles.load(std::memory_order_relaxed); }
bool  IsProjRangeResolved(){ return g_playerProjRangeResolved.load(std::memory_order_relaxed); }

void GetWeaponRangeDiag(float& outRangeTiles, uint32_t& outAttempts,
                        uint32_t& outSuccesses, const char*& outLastError)
{
    outRangeTiles = g_playerProjRangeTiles.load(std::memory_order_relaxed);
    outAttempts   = g_wrRefreshAttempts.load(std::memory_order_relaxed);
    outSuccesses  = g_wrRefreshSuccesses.load(std::memory_order_relaxed);
    outLastError  = g_wrLastError.load(std::memory_order_relaxed);
}

void SuspendForMs(uint64_t ms)
{
    const uint64_t deadline = GetTickCount64() + ms;
    uint64_t cur = g_suspendUntilMs.load(std::memory_order_relaxed);
    while (deadline > cur) {
        if (g_suspendUntilMs.compare_exchange_weak(
                cur, deadline,
                std::memory_order_relaxed, std::memory_order_relaxed)) {
            break;
        }
    }
    g_hasAimTarget.store(false, std::memory_order_relaxed);
    g_aimFocusEnemyId.store(0, std::memory_order_relaxed);
}

bool IsSuspended()
{
    const uint64_t deadline = g_suspendUntilMs.load(std::memory_order_relaxed);
    return deadline != 0 && GetTickCount64() < deadline;
}

void SetEnemyNextTickOverlay(bool on)
{
    g_enemyNextTickOverlay.store(on, std::memory_order_relaxed);
}

bool IsEnemyNextTickOverlay()
{
    return g_enemyNextTickOverlay.load(std::memory_order_relaxed);
}

void EnumerateEnemyVelocities(EnemyVelCallback cb, void* user)
{
    if (!cb)
        return;
    for (const auto& kv : g_aimVelMap) {
        const AimVelEntry& e = kv.second;
        cb(kv.first, e.x, e.y, e.vx, e.vy, user);
    }
}

void EnumerateLiveEnemies(EnemyScanCallback cb, void* user)
{
    EnumerateLiveEnemiesBody(cb, user);
}

static void* ResolveMethod(const char* className, const char* methodName, int paramCount, const char* /*label*/)
{
    Il2CppClass* klass = Resolver::GetClass("", className);
    if (!klass)
        return nullptr;
    const MethodInfo* mi = il2cpp_class_get_method_from_name(klass, methodName, paramCount);
    if (!mi || !mi->methodPointer)
        return nullptr;
    return reinterpret_cast<void*>(mi->methodPointer);
}

void Install()
{
    if (g_hooksInstalled)
        return;

    if (g_firstInstallTick == 0)
        g_firstInstallTick = GetTickCount64();

    g_csaTarget = ResolveMethod(kPlayerClassName, kCSAMethodName, kCSAParamCount, "CSA");
    g_swaTarget = ResolveMethod(kShootClassName,  kSWAMethodName, kSWAParamCount, "SWA");
    g_sspTarget = ResolveMethod(kShootClassName,  kSSPMethodName, kSSPParamCount, "SSP");

    if (!g_csaTarget || !g_swaTarget || !g_sspTarget)
        return;

    static bool s_mhInitDone = false;
    if (!s_mhInitDone) {
        MH_STATUS initSt = MH_Initialize();
        if (initSt != MH_OK && initSt != MH_ERROR_ALREADY_INITIALIZED)
            return;
        s_mhInitDone = true;
    }

    MH_STATUS s1 = MH_CreateHook(g_csaTarget,
        reinterpret_cast<void*>(&ComputeShootAngleDetour),
        reinterpret_cast<void**>(&g_ComputeShootAngleOriginal));
    MH_STATUS s2 = MH_CreateHook(g_swaTarget,
        reinterpret_cast<void*>(&ShootWithAngleDetour),
        reinterpret_cast<void**>(&g_ShootWithAngleOriginal));
    MH_STATUS s3 = MH_CreateHook(g_sspTarget,
        reinterpret_cast<void*>(&SendShotPacketDetour),
        reinterpret_cast<void**>(&g_SendShotPacketOriginal));

    if (s1 != MH_OK || s2 != MH_OK || s3 != MH_OK)
        return;

    MH_STATUS e1 = MH_EnableHook(g_csaTarget);
    MH_STATUS e2 = MH_EnableHook(g_swaTarget);
    MH_STATUS e3 = MH_EnableHook(g_sspTarget);
    (void)e1;
    (void)e2;
    (void)e3;

    s_lastTickThrottleMs = 0;
    s_tickLastPlayerPtr = nullptr;

    // Clear diagnostic log on fresh install.
    { std::ofstream f(kAimLogPath, std::ios::trunc); }
    s_aimLogEntries = 0;
    s_aimLogBuf.str(""); s_aimLogBuf.clear();

    g_allowTick.store(true, std::memory_order_release);
    g_hooksInstalled = true;
}

void Uninstall()
{
    if (!g_hooksInstalled)
        return;

    g_allowTick.store(false, std::memory_order_release);
    g_enemyNextTickOverlay.store(false, std::memory_order_relaxed);

    if (g_csaTarget) { MH_DisableHook(g_csaTarget); MH_RemoveHook(g_csaTarget); }
    if (g_swaTarget) { MH_DisableHook(g_swaTarget); MH_RemoveHook(g_swaTarget); }
    if (g_sspTarget) { MH_DisableHook(g_sspTarget); MH_RemoveHook(g_sspTarget); }

    g_ComputeShootAngleOriginal = nullptr;
    g_ShootWithAngleOriginal    = nullptr;
    g_SendShotPacketOriginal    = nullptr;
    g_csaTarget = g_swaTarget = g_sspTarget = nullptr;
    g_hooksInstalled = false;
    g_lastLocalProjProps.store(nullptr, std::memory_order_relaxed);
    g_lastLocalProjId.store(0, std::memory_order_relaxed);
    g_hasAimTarget.store(false, std::memory_order_relaxed);
    g_aimVelMap.clear();
}

} // namespace AutoAim
