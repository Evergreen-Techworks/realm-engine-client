#include "pch-il2cpp.h"
#include "AoeTracking.h"
#include "Il2CppResolver.h"
#include "GameState.h"
#include "RuntimeOffsets.h"
#include "MemRead.h"
#include "Il2CppContainers.h"
#include "game/objects/GameObjects.h"
#include "Il2CppHook.h"
#include "DbgFileLog.h"
#include "BootGate.h"
#include "minhook/MinHook.h"
#include <windows.h>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

// ─────────────────────────────────────────────────────────────────────────────
// IL2CPP BeeByte class/method names (GameAssembly.dll.lst + ClaudeAgents tree).
//
// GJJCEFJMNMK (: EEGJPHBMENN : LKHPPBEGNOM : KJMONHENJEN) — the server-sent
//   throwable ENTITY.  Lives in allDict, HAS ObjectProperties with isEnemy.
//   KOBMINBDOBD is the init/setter, 4 params:
//     GJJCEFJMNMK* KOBMINBDOBD(Vector2 origin, Vector2 dest, Color color, int dur=1500)
//   x64 ABI: rcx=this, rdx=Vector2 origin (8 bytes in reg), r8=Vector2 dest (8 bytes),
//            r9=Color* (16 bytes, hidden ptr), [rsp+0x28]=int dur, [rsp+0x30]=MethodInfo*
//   After original runs, fields are populated at confirmed runtime offsets:
//     +0x368 = origin Vector2 (GuiCanvasSwitcher — BeeByte decoy name)
//     +0x370 = dest Vector2   (IAJJLFBDJGE)
//     +0x378 = color Color    (UpdateRadialValue — BeeByte decoy name)
//     +0x388 = durationMs int (EAICINLCCJK)
//   Ownership: this→ObjectProperties (+0x18) → isEnemy (+OP_IsEnemy) from KJMONHENJEN base.
//   This replaces the old FHOHCELBPDO hook which was a pure visual with NO isEnemy info.
//
// FGOFPGIIEPC (: EGOGOKPFFIP) — throwable explosion controller. KOBMINBDOBD has
//   3 params: void(LKHPPBEGNOM* anchor, CustomExplosionEntrance* data, float dur)
//   anchor.x/y (via RuntimeOffsets::PosX/PosY) = throw origin.
//   CustomExplosionEntrance.distance (+0x38) = spread/ring radius.
// ─────────────────────────────────────────────────────────────────────────────
static constexpr const char* kThrowableClass   = "GJJCEFJMNMK";
static constexpr const char* kFhohClass        = "FHOHCELBPDO";
static constexpr const char* kExplSpawnerClass = "FGOFPGIIEPC";
static constexpr const char* kSpawnMethod      = "KOBMINBDOBD";
static constexpr int         kGjjParamCount    = 4;  // (Vector2, Vector2, Color, int)
static constexpr int         kFhohParamCount   = 5;  // (int animIdx, Color, int durationMs, Vector2 origin, Vector2 dest)
static constexpr int         kExplParamCount   = 3;  // (LKHPPBEGNOM*, CustomExplosionEntrance*, float)

// GJJCEFJMNMK field offsets — resolved at runtime via RuntimeOffsets.
// Fallback values are RUNTIME offsets (ACTK shift already baked in parent chain dump).
// Assembly-confirmed: [rbx+368h] origin, [rbx+370h] dest, [rbx+388h] durationMs.

// FHOHCELBPDO field offsets — resolved at runtime via RuntimeOffsets.
// Origin fields are the inherited BMO world position (RuntimeOffsets::PosX/PosY).
// Pure visual landing-zone circle — ObjectProperties is NEVER populated.

// Deduplication tolerance: skip FHOH entry if a GJJ entry exists at same dest (within this dist)
static constexpr float kDedupTolSq = 0.01f;  // (0.1 tile)^2

// CustomExplosionEntrance.distance offset — resolved at runtime via RuntimeOffsets.

// Default radius used when the spawning packet/visual doesn't carry one.
// The FGOFPGIIEPC explosion path reads the real CEE+0x38 maxBlastRadius
// already (typically 3.0). The Sfx packet (Throw/Nova/CircleTelegraph/AoE),
// FHOHCELBPDO landing-circle, and some GJJ throwable paths don't have a
// readable radius — for those, 2.0 was empirically too small (Daichi /
// Marble Colossus / O3 platform / Bilgewater bomb are 3-4.5 tiles), so the
// bot was walking out of the visible ring and back into the kill zone.
// 3.5 errs on the side of false-positive — better to over-stamp the danger
// than chip the player.
static constexpr float kDefaultAoeRadiusTiles = 3.5f;

// HJMBOMEHGDJ::CGBILOJJPEI — ShowEffect packet handler (RVA 0x180B33560).
// Catches THROW(4), NOVA(5), CIRCLE_TELEGRAPH(23), AoE(39) effect types.
// x64 ABI: rcx=this (HJMBOMEHGDJ*), rdx=COEFCBBIBMC* msg, r8=MethodInfo*
static constexpr const char* kShowEffectClass      = "HJMBOMEHGDJ";
static constexpr const char* kShowEffectMethod     = "CGBILOJJPEI";
static constexpr int         kShowEffectParamCount = 1;  // (COEFCBBIBMC* msg)

// COEFCBBIBMC ShowEffect packet field offsets — resolved at runtime via RuntimeOffsets.

// ShowEffect effectType values we care about

// ShowEffect effectType values we care about (game protocol constants — not class field offsets)
static constexpr int32_t kSfxType_Throw           =  4;  // throw arc visual (pos1=src, pos2=dest)
static constexpr int32_t kSfxType_Nova            =  5;  // expanding ring at pos1
static constexpr int32_t kSfxType_CircleTelegraph = 23;  // ground warning circle at pos1
static constexpr int32_t kSfxType_AoE             = 39;  // Exalt-specific AoE at pos1

// #region agent log
// Hypotheses: H1=IL2CPP klass/method resolve fails, H2=MinHook init/create/enable fails,
//             H3=FHOHCELBPDO detour never fires or bad origin, H4=FGOFPGIIEPC detour never fires,
//             H5=CopyActiveForDraw emits few rows or collR stays 0
//
// Compiled out in Release. When enabled ({_DEBUG} + non-empty
// RE_AOE_DEBUG_LOG env var), appends one JSON line per AoE detour to the
// path in the env var. Historically this used a hardcoded developer path
// that failed silently on any other machine — the env-var contract lets
// you keep the log wherever you want without shipping your username.
static inline void AgentLogAoe(const char* hypothesisId, const char* location, const char* message,
    const std::string& dataJsonObject)
{
#ifdef _DEBUG
    static const std::string kLogPath = [] {
        char*  buf = nullptr;
        size_t len = 0;
        if (_dupenv_s(&buf, &len, "RE_AOE_DEBUG_LOG") != 0 || !buf) return std::string();
        std::string v(buf);
        free(buf);
        return v;
    }();
    if (kLogPath.empty()) return;
    std::ofstream f(kLogPath, std::ios::app | std::ios::binary);
    if (!f)
        return;
    const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    f << "{\"sessionId\":\"99a079\",\"runId\":\"aoe-debug\",\"hypothesisId\":\"" << hypothesisId
      << "\",\"location\":\"" << location << "\",\"message\":\"" << message << "\",\"data\":"
      << dataJsonObject << ",\"timestamp\":" << ms << "}\n";
#else
    (void)hypothesisId; (void)location; (void)message; (void)dataJsonObject;
#endif
}

// #endregion

// ─────────────────────────────────────────────────────────────────────────────
// Ring buffer
// ─────────────────────────────────────────────────────────────────────────────
static constexpr int kMaxAoes = 128;

static WorldAoe              g_Aoes[kMaxAoes]{};
static std::atomic<uint32_t> g_WriteIdx{ 0 };
static CRITICAL_SECTION      g_Cs;
static bool                  g_CsInit = false;

static std::atomic<uint32_t> g_DbgFhohRecordLogs{ 0 };
static std::atomic<uint32_t> g_DbgFhohBadSelfLogs{ 0 };
static std::atomic<uint32_t> g_DbgFhohSkipOriginLogs{ 0 };
static std::atomic<uint32_t> g_DbgFhohSehOnce{ 0 };
static std::atomic<uint32_t> g_DbgExplLogs{ 0 };

static bool TryReadAnchorXY(void* anchor, float& outX, float& outY)
{
    float x, y;
    if (!Mem::TryRead(anchor, RuntimeOffsets::PosX, x)) return false;
    if (!Mem::TryRead(anchor, RuntimeOffsets::PosY, y)) return false;
    if (x != x || y != y) return false;
    outX = x;
    outY = y;
    return true;
}

static bool TryReadCeeDistanceUnsafe(void* ep, float& outDist)
{
    return Mem::TryRead(ep, RuntimeOffsets::Cee_Distance, outDist);
}

static bool TryReadCeeSpeedUnsafe(void* ep, float& outSpeed)
{
    return Mem::TryRead(ep, RuntimeOffsets::Cee_Speed, outSpeed);
}

static bool TryReadGjjFromSelf(void* self, float& ox, float& oy, float& dx, float& dy,
    int32_t& durMs)
{
    if (!Mem::TryRead(self, RuntimeOffsets::Gjj_OriginX,    ox))    return false;
    if (!Mem::TryRead(self, RuntimeOffsets::Gjj_OriginY,    oy))    return false;
    if (!Mem::TryRead(self, RuntimeOffsets::Gjj_DestX,      dx))    return false;
    if (!Mem::TryRead(self, RuntimeOffsets::Gjj_DestY,      dy))    return false;
    if (!Mem::TryRead(self, RuntimeOffsets::Gjj_DurationMs, durMs)) return false;
    return true;
}

// FHOH field reader.
// Origin (ox/oy) comes from the inherited BMO world position (RuntimeOffsets::PosX/PosY).
static bool TryReadFhohFromSelf(void* self, float& ox, float& oy, float& dx, float& dy,
    int32_t& durMs)
{
    if (!Mem::TryRead(self, RuntimeOffsets::PosX,            ox))    return false;
    if (!Mem::TryRead(self, RuntimeOffsets::PosY,            oy))    return false;
    if (!Mem::TryRead(self, RuntimeOffsets::Fhoh_DestX,      dx))    return false;
    if (!Mem::TryRead(self, RuntimeOffsets::Fhoh_DestY,      dy))    return false;
    if (!Mem::TryRead(self, RuntimeOffsets::Fhoh_DurationMs, durMs)) return false;
    return true;
}

// Returns true if there is already an active AOE entry with dest within kDedupTolSq of (tdx,tdy).
// Must be called with g_Cs held.
static bool HasActiveAoeAtDest(float tdx, float tdy)
{
    const ULONGLONG now = GetTickCount64();
    for (int i = 0; i < kMaxAoes; ++i) {
        const WorldAoe& a = g_Aoes[i];
        if (!a.valid) continue;
        if (static_cast<float>(now - a.spawnTick) >= a.lifetime) continue;
        float ddx = a.destX - tdx;
        float ddy = a.destY - tdy;
        if (ddx * ddx + ddy * ddy <= kDedupTolSq) return true;
    }
    return false;
}

// SEH-safe: chase entity → ObjectProperties* (+0x18) → isEnemy (+OP_IsEnemy).
// Returns true if the read SUCCEEDED (ObjectProperties was valid).
// outIsEnemy receives the actual isEnemy value only when returning true.
static bool TryReadIsEnemy(void* entity, bool& outIsEnemy)
{
    outIsEnemy = false;
    void* props = Game::Entity(entity).Props();
    if (!props) return false;
    return Mem::TryRead(props, RuntimeOffsets::OP_IsEnemy, outIsEnemy);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entity-dict position-match: walk WorldManager.allDict to find the entity
// at a given world position and check its ObjectProperties.isEnemy.
// Returns: 0 = no entity found at position (unresolved)
//          1 = entity found, isEnemy=true  (enemy throwable)
//          2 = entity found, isEnemy=false (friendly throwable)
static int FindOwnerIsEnemyAtPos(float targetX, float targetY)
{
    void* dictPtr = Mem::ReadPtr(GameState::GetWorldMgr(), RuntimeOffsets::WM_AllDict);
    const float kTol = 0.5f;          // half-tile tolerance
    int result = 0;                   // 0=unresolved, 1=enemy, 2=friendly
    Il2CppC::WalkDict(dictPtr, 4096, [&](int32_t /*key*/, void* entity) {
        if (result != 0) return;      // first match at throw origin wins
        Game::Entity e(entity);
        if (!e.Ok()) return;

        float dx = e.X() - targetX;
        float dy = e.Y() - targetY;
        if (dx * dx + dy * dy > kTol * kTol) return;

        // Found entity at throw origin — check its isEnemy. Keep the raw isEnemy
        // read: props-null and a faulted read both skip (result stays unresolved so
        // a later entity can win), which Entity::IsEnemy()'s bool collapse loses.
        void* props = e.Props();
        if (!props) return;
        bool isEn;
        if (!Mem::TryRead(props, RuntimeOffsets::OP_IsEnemy, isEn)) return;
        result = isEn ? 1 : 2;
    });
    return result;
}

// Walk WorldManager.allDict by key (objectId) to find an entity and check isEnemy.
// Used by ShowEffect hook where targetObjectId IS the source entity (not a throwable object).
// Returns: 0=not found, 1=enemy, 2=friendly
static int FindEntityIsEnemyById(int32_t targetId)
{
    if (targetId <= 0) return 0;
    void* dictPtr = Mem::ReadPtr(GameState::GetWorldMgr(), RuntimeOffsets::WM_AllDict);
    int result = 0;
    Il2CppC::WalkDict(dictPtr, 4096, [&](int32_t key, void* entity) {
        if (result != 0) return;
        if (key != targetId) return;
        Game::Entity e(entity);
        if (!e.Ok()) return;

        void* props = e.Props();
        if (!props) return;
        bool isEn;
        if (!Mem::TryRead(props, RuntimeOffsets::OP_IsEnemy, isEn)) return;
        result = isEn ? 1 : 2;
    });
    return result;
}

// Read HHPOJBFICAH (objectId, BMO +0x034) from any BMO-derived object.
static int32_t TryReadObjectId(void* base)
{
    return Game::Entity(base).ObjId();
}

// SEH-safe reader for COEFCBBIBMC (ShowEffect packet) fields.
static bool TryReadShowEffectFields(void* msg, int32_t& outType, int32_t& outObjId,
    float& outP1X, float& outP1Y, float& outP2X, float& outP2Y, float& outDur)
{
    if (!Mem::TryRead(msg, RuntimeOffsets::Sfx_EffectType,  outType))  return false;
    if (!Mem::TryRead(msg, RuntimeOffsets::Sfx_TargetObjId, outObjId)) return false;
    if (!Mem::TryRead(msg, RuntimeOffsets::Sfx_Pos1X,       outP1X))   return false;
    if (!Mem::TryRead(msg, RuntimeOffsets::Sfx_Pos1Y,       outP1Y))   return false;
    if (!Mem::TryRead(msg, RuntimeOffsets::Sfx_Pos2X,       outP2X))   return false;
    if (!Mem::TryRead(msg, RuntimeOffsets::Sfx_Pos2Y,       outP2Y))   return false;
    if (!Mem::TryRead(msg, RuntimeOffsets::Sfx_Duration,    outDur))   return false;
    return true;
}

static void RecordAoe(float originX, float originY,
    float destX, float destY,
    float radius, float innerR, float lifetimeMs,
    bool isDamaging, bool isEnemy,
    void* livePtr, int32_t ownerObjId = 0, bool isEnemyChecked = true,
    uint8_t source = kAoeSrcGjj, int32_t sfxEffectType = 0,
    float arcMs = 0.f)
{
    if (!g_CsInit) return;
    if (!std::isfinite(radius) || radius < 1e-4f)
        radius = kDefaultAoeRadiusTiles;
    if (!std::isfinite(innerR) || innerR < 0.f)
        innerR = 0.f;
    if (lifetimeMs < 100.f || !std::isfinite(lifetimeMs))
        lifetimeMs = 3000.f;
    if (!std::isfinite(arcMs) || arcMs < 0.f)
        arcMs = 0.f;

    EnterCriticalSection(&g_Cs);
    const uint32_t idx = g_WriteIdx.fetch_add(1, std::memory_order_relaxed) % kMaxAoes;
    WorldAoe& a    = g_Aoes[idx];
    a.x            = originX;
    a.y            = originY;
    a.destX        = destX;
    a.destY        = destY;
    a.radius       = radius;
    a.innerR       = innerR;
    a.lifetime     = lifetimeMs;
    a.arcMs        = arcMs;
    a.spawnTick    = GetTickCount64();
    a.valid        = true;
    a.isDamaging      = isDamaging;
    a.isEnemy         = isEnemy;
    a.isEnemyChecked  = isEnemyChecked;
    a.source          = source;
    a.sfxEffectType   = sfxEffectType;
    a.ptr             = livePtr;
    a.ownerObjId      = ownerObjId;
    LeaveCriticalSection(&g_Cs);
}

// ─────────────────────────────────────────────────────────────────────────────
// GJJCEFJMNMK::KOBMINBDOBD hook  (throwable entity init/setter)
//
// GJJCEFJMNMK is EEGJPHBMENN→LKHPPBEGNOM→KJMONHENJEN — a real entity in allDict
// with ObjectProperties. This replaces the old FHOHCELBPDO hook which was a
// pure visual landing-circle with NO ownership info.
//
// x64 ABI: rcx=this, rdx=Vector2 origin (8B reg), r8=Vector2 dest (8B reg),
//          r9=Color* (16B hidden ptr), [rsp+0x28]=int dur, [rsp+0x30]=MethodInfo*
// Returns: GJJCEFJMNMK* (void*)
// ─────────────────────────────────────────────────────────────────────────────
using GjjKobFn = void* (__fastcall*)(void* self, int64_t origin, int64_t dest,
                                     void* colorPtr, int32_t dur, void* method);
static GjjKobFn g_OrigGjjKob = nullptr;
static void*    g_GjjTarget   = nullptr;

// ── GJJ field-offset self-heal via param-match ──────────────────────────────
// KOBMINBDOBD is handed the true origin/dest as params, so we can recover the
// (BeeByte-renamed) origin/dest FIELD offsets deterministically: match each param
// value against the instance's float pairs. Runs until resolved; one throwable
// (e.g. a Medusa cast in the Godlands) is enough.
static std::atomic<bool> g_gjjFieldsResolved{ false };
static uint32_t          g_gjjResolvedOriginOff = 0;
static uint32_t          g_gjjResolvedDestOff   = 0;

// Scan `self` for the Vector2 field (two consecutive floats) equal to (vx,vy).
// SEH-guarded, POD-only (no C++ unwinding in the __try) — a read past the object
// faults into __except and returns 0. Returns the byte offset, or 0 if not found.
static uint32_t FindVec2FieldOffset(void* self, float vx, float vy)
{
    if (!Mem::AddrOk(self)) return 0;
    __try {
        const uint8_t* base = reinterpret_cast<const uint8_t*>(self);
        for (uint32_t off = 0x10u; off + 8u <= 0x800u; off += 4u) {
            const float fx = *reinterpret_cast<const float*>(base + off);
            const float fy = *reinterpret_cast<const float*>(base + off + 4u);
            if (fabsf(fx - vx) < 0.01f && fabsf(fy - vy) < 0.01f) return off;
        }
        return 0;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return 0;
    }
}

static void* __fastcall GjjKobDetour(void* self, int64_t origin, int64_t dest,
                                     void* colorPtr, int32_t dur, void* method)
{
    void* ret = nullptr;
    if (g_OrigGjjKob)
        ret = g_OrigGjjKob(self, origin, dest, colorPtr, dur, method);

    // Self-heal the GJJ origin/dest field offsets from the method params (ground
    // truth, rename-proof). One matched throwable corrects RuntimeOffsets::Gjj_*,
    // so TryReadGjjFromSelf below reads the right place even after a BeeByte rename.
    if (Mem::AddrOk(self) && !g_gjjFieldsResolved.load(std::memory_order_relaxed)) {
        const uint32_t olo = static_cast<uint32_t>(static_cast<uint64_t>(origin));
        const uint32_t ohi = static_cast<uint32_t>(static_cast<uint64_t>(origin) >> 32);
        const uint32_t dlo = static_cast<uint32_t>(static_cast<uint64_t>(dest));
        const uint32_t dhi = static_cast<uint32_t>(static_cast<uint64_t>(dest) >> 32);
        float pox, poy, pdx, pdy;
        std::memcpy(&pox, &olo, 4); std::memcpy(&poy, &ohi, 4);
        std::memcpy(&pdx, &dlo, 4); std::memcpy(&pdy, &dhi, 4);
        if (std::isfinite(pox) && std::isfinite(poy) && (pox != 0.f || poy != 0.f)) {
            const uint32_t oOff = FindVec2FieldOffset(self, pox, poy);
            if (oOff) {
                RuntimeOffsets::Gjj_OriginX = oOff;
                RuntimeOffsets::Gjj_OriginY = oOff + 4u;
                uint32_t dOff = (std::isfinite(pdx) && std::isfinite(pdy))
                                ? FindVec2FieldOffset(self, pdx, pdy) : 0u;
                if (dOff) { RuntimeOffsets::Gjj_DestX = dOff; RuntimeOffsets::Gjj_DestY = dOff + 4u; }
                g_gjjResolvedOriginOff = oOff;
                g_gjjResolvedDestOff   = dOff;
                g_gjjFieldsResolved.store(true, std::memory_order_relaxed);
                DBG_FILE_LOG("[AoeTracking] GJJ fields self-healed via param-match: origin=0x"
                    << std::hex << oOff << " dest=0x" << dOff << std::dec
                    << " (fallbacks were 0x368/0x370)");
            }
        }
    }

    // #region agent log
    if (!Mem::AddrOk(self)) {
        const uint32_t n = g_DbgFhohBadSelfLogs.fetch_add(1, std::memory_order_relaxed);
        if (n < 5u)
            AgentLogAoe("H3", "AoeTracking.cpp:GjjKobDetour", "bad_self",
                "{\"self\":0}");
        return ret;
    }
    // #endregion

    float ox = 0.f, oy = 0.f, dx = 0.f, dy = 0.f;
    int32_t durMs = 0;
    if (!TryReadGjjFromSelf(self, ox, oy, dx, dy, durMs)) {
        // #region agent log
        if (g_DbgFhohSehOnce.fetch_add(1, std::memory_order_relaxed) < 4u)
            AgentLogAoe("H3", "AoeTracking.cpp:GjjKobDetour", "seh_after_orig",
                "{\"reason\":\"TryReadGjjFromSelf\"}");
        // #endregion
        return ret;
    }

    if (!std::isfinite(ox) || !std::isfinite(oy)) {
        // #region agent log
        const uint32_t n = g_DbgFhohSkipOriginLogs.fetch_add(1, std::memory_order_relaxed);
        if (n < 12u || (n % 40u) == 0u) {
            std::ostringstream d;
            d << "{\"self\":" << static_cast<uint64_t>(reinterpret_cast<uintptr_t>(self))
              << ",\"ox\":" << ox << ",\"oy\":" << oy << ",\"reason\":\"nonfinite_origin\"}";
            AgentLogAoe("H3", "AoeTracking.cpp:GjjKobDetour", "skip_record", d.str());
        }
        // #endregion
        return ret;
    }
    if (!std::isfinite(dx) || !std::isfinite(dy)) { dx = ox; dy = oy; }

    float lifeMs = (durMs > 100 && durMs < 120000)
        ? static_cast<float>(durMs) : 3000.f;

    // GJJCEFJMNMK itself is an "object", not an "enemy" — its isEnemy is always false.
    // Ownership is resolved in CopyActiveForDraw by position-matching the throw origin
    // against the entity dict to find the actual thrower and check THEIR isEnemy.
    const int32_t objId = TryReadObjectId(self);
    RecordAoe(ox, oy, dx, dy, kDefaultAoeRadiusTiles, 0.f, lifeMs,
              /*isDamaging=*/true, /*isEnemy=*/false, self, objId, /*isEnemyChecked=*/false,
              kAoeSrcGjj);

    // #region agent log
    const uint32_t lr = g_DbgFhohRecordLogs.fetch_add(1, std::memory_order_relaxed);
    if (lr < 24u || (lr % 48u) == 0u) {
        std::ostringstream d;
        d << "{\"self\":" << static_cast<uint64_t>(reinterpret_cast<uintptr_t>(self))
          << ",\"ox\":" << ox << ",\"oy\":" << oy << ",\"dx\":" << dx << ",\"dy\":" << dy
          << ",\"durMs\":" << durMs << ",\"lifeMs\":" << lifeMs
          << ",\"objId\":" << objId << ",\"note\":\"isEnemy deferred to dict walk\"}";
        AgentLogAoe("H3", "AoeTracking.cpp:GjjKobDetour", "record_gjj", d.str());
    }
    // #endregion
    return ret;
}

// ─────────────────────────────────────────────────────────────────────────────
// FHOHCELBPDO::KOBMINBDOBD hook  (catch-all visual fallback)
//
// Fires for EVERY throwable visual, including non-GJJCEFJMNMK sources.
// We skip it if a GJJ entry already exists at the same dest (dedup by position).
// isEnemy is deferred via entity dict position-match, same as GJJ path.
//
// x64 ABI: rcx=this, rdx=int animIdx, r8=Color* (16B hidden ptr),
//          r9=int durationMs, [rsp+0x28]=Vector2 origin, [rsp+0x30]=Vector2 dest,
//          [rsp+0x38]=MethodInfo*
// ─────────────────────────────────────────────────────────────────────────────
using FhohKobFn = void (__fastcall*)(void* self, int32_t animIdx, void* colorPtr,
                                     int32_t durMs, int64_t origin, int64_t dest,
                                     void* method);
static FhohKobFn g_OrigFhohKob = nullptr;
static void*     g_FhohTarget  = nullptr;

static void __fastcall FhohKobDetour(void* self, int32_t animIdx, void* colorPtr,
                                     int32_t durMs, int64_t origin, int64_t dest,
                                     void* method)
{
    if (g_OrigFhohKob)
        g_OrigFhohKob(self, animIdx, colorPtr, durMs, origin, dest, method);

    if (!Mem::AddrOk(self)) return;

    float ox = 0.f, oy = 0.f, dx = 0.f, dy = 0.f;
    int32_t fhohDurMs = 0;
    if (!TryReadFhohFromSelf(self, ox, oy, dx, dy, fhohDurMs)) return;
    if (!std::isfinite(ox) || !std::isfinite(oy)) return;
    if (!std::isfinite(dx) || !std::isfinite(dy)) { dx = ox; dy = oy; }

    float lifeMs = (fhohDurMs > 100 && fhohDurMs < 120000)
        ? static_cast<float>(fhohDurMs) : 3000.f;

    // Skip if GJJ already recorded this throwable (dedup by dest position)
    if (g_CsInit) {
        EnterCriticalSection(&g_Cs);
        bool dup = HasActiveAoeAtDest(dx, dy);
        LeaveCriticalSection(&g_Cs);
        if (dup) return;
    }

    const int32_t objId = TryReadObjectId(self);
    RecordAoe(ox, oy, dx, dy, kDefaultAoeRadiusTiles, 0.f, lifeMs,
              /*isDamaging=*/true, /*isEnemy=*/false, self, objId, /*isEnemyChecked=*/false,
              kAoeSrcFhoh);

    // #region agent log
    const uint32_t lr = g_DbgFhohRecordLogs.fetch_add(1, std::memory_order_relaxed);
    if (lr < 12u || (lr % 48u) == 0u) {
        std::ostringstream d;
        d << "{\"self\":" << static_cast<uint64_t>(reinterpret_cast<uintptr_t>(self))
          << ",\"ox\":" << ox << ",\"oy\":" << oy << ",\"dx\":" << dx << ",\"dy\":" << dy
          << ",\"durMs\":" << fhohDurMs << ",\"note\":\"fhoh_fallback\"}";
        AgentLogAoe("H3", "AoeTracking.cpp:FhohKobDetour", "record_fhoh_fallback", d.str());
    }
    // #endregion
}

// ─────────────────────────────────────────────────────────────────────────────
// FGOFPGIIEPC::KOBMINBDOBD hook (thrown-bomb controller)
// ─────────────────────────────────────────────────────────────────────────────
using ExplSpawnFn = void (__fastcall*)(void* self, void* anchor, void* ep, float dur, void* method);
static ExplSpawnFn g_OrigExplSpawn = nullptr;
static void*       g_ExplTarget    = nullptr;

static void __fastcall ExplSpawnDetour(void* self, void* anchor, void* ep, float dur, void* method)
{
    float originX = 0.f, originY = 0.f;
    TryReadAnchorXY(anchor, originX, originY);

    float r = kDefaultAoeRadiusTiles;
    float dist = 0.f;
    if (TryReadCeeDistanceUnsafe(ep, dist)
        && dist > 1e-4f && dist < 30.f && std::isfinite(dist))
        r = dist;

    // Read CustomExplosionEntrance.speed (+0x3C) for diagnostic / future
    // use. Not currently applied to lifetime or arming — FGOFPGIIEPC
    // empirically fires AT detonation (blast already in progress), so
    // extending lifetime by the arc duration or ramping severity during
    // what would be the arc window is wrong: the blast is full-strength
    // from elapsed=0 and ends when blastMs elapses. Keeping the field
    // captured on the AoE entry so we can revisit if per-boss profiling
    // reveals a controller that fires at arc-start instead.
    float speed = 0.f;
    float arcMs = 0.f;
    if (TryReadCeeSpeedUnsafe(ep, speed)
        && speed > 0.1f && speed < 30.f && std::isfinite(speed)
        && dist > 1e-4f && std::isfinite(dist)) {
        arcMs = (dist / speed) * 1000.f;
        if (arcMs > 3000.f) arcMs = 3000.f;
    }

    const float lifeMs = (dur > 0.f && dur < 120.f && std::isfinite(dur))
        ? dur * 1000.f : 2000.f;

    if (g_OrigExplSpawn)
        g_OrigExplSpawn(self, anchor, ep, dur, method);

    // FGOFPGIIEPC only fires for actual explosions — always damaging.
    // Read isEnemy from anchor→ObjectProperties→isEnemy.
    bool isEnemy = false;
    TryReadIsEnemy(anchor, isEnemy);

    // ownerObjId: anchor entity's HHPOJBFICAH (BMO +0x034) — identifies the thrower.
    const int32_t anchorObjId = TryReadObjectId(anchor);
    if (originX != 0.f || originY != 0.f)
        RecordAoe(originX, originY, originX, originY, r, 0.f, lifeMs, /*isDamaging=*/true, isEnemy, nullptr, anchorObjId,
                  /*isEnemyChecked=*/true, kAoeSrcExpl, /*sfxEffectType=*/0, arcMs);

    // #region agent log
    const uint32_t le = g_DbgExplLogs.fetch_add(1, std::memory_order_relaxed);
    if (le < 20u || (le % 48u) == 0u) {
        std::ostringstream d;
        d << "{\"anchor\":" << static_cast<uint64_t>(reinterpret_cast<uintptr_t>(anchor))
          << ",\"ep\":" << static_cast<uint64_t>(reinterpret_cast<uintptr_t>(ep))
          << ",\"ox\":" << originX << ",\"oy\":" << originY << ",\"r\":" << r
          << ",\"speed\":" << speed << ",\"arcMs\":" << arcMs
          << ",\"isEnemy\":" << (isEnemy ? 1 : 0)
          << ",\"dur_s\":" << dur << ",\"lifeMs\":" << lifeMs
          << ",\"recorded\":" << ((originX != 0.f || originY != 0.f) ? 1 : 0) << "}";
        AgentLogAoe("H4", "AoeTracking.cpp:ExplSpawnDetour", "expl_spawn", d.str());
    }
    // #endregion
}

// ─────────────────────────────────────────────────────────────────────────────
// HJMBOMEHGDJ::CGBILOJJPEI hook  (ShowEffect packet handler)
//
// Catches server-sent ShowEffect packets before game processes them.
// Filters to: THROW(4)=throw arc, NOVA(5)=ring, CIRCLE_TELEGRAPH(23)=ground warn, AoE(39).
// targetObjectId is the source entity — used for direct ID-based isEnemy lookup.
// THROW entries are deduped against existing GJJ/FHOH AOE entries by destination.
//
// x64 ABI: rcx=this (HJMBOMEHGDJ*), rdx=COEFCBBIBMC* msg, r8=MethodInfo*
// ─────────────────────────────────────────────────────────────────────────────
using ShowEffectFn = void (__fastcall*)(void* self, void* msg, void* method);
static ShowEffectFn g_OrigShowEffect = nullptr;
static void*        g_SfxTarget      = nullptr;

static std::atomic<uint32_t> g_DbgSfxLogs{ 0 };

static void __fastcall ShowEffectDetour(void* self, void* msg, void* method)
{
    if (g_OrigShowEffect)
        g_OrigShowEffect(self, msg, method);

    if (!Mem::AddrOk(msg)) return;

    int32_t effectType = 0, targetObjId = 0;
    float p1x = 0.f, p1y = 0.f, p2x = 0.f, p2y = 0.f, dur = 0.f;
    if (!TryReadShowEffectFields(msg, effectType, targetObjId, p1x, p1y, p2x, p2y, dur))
        return;

    if (effectType != kSfxType_Throw &&
        effectType != kSfxType_Nova  &&
        effectType != kSfxType_CircleTelegraph &&
        effectType != kSfxType_AoE)
        return;

    // Duration: float field — if <= 120 treat as seconds, else already ms.
    float lifeMs;
    if (dur > 0.f && dur <= 120.f && std::isfinite(dur))
        lifeMs = dur * 1000.f;
    else if (dur > 120.f && dur <= 120000.f && std::isfinite(dur))
        lifeMs = dur;
    else
        lifeMs = 2000.f;

    float originX, originY, destX, destY;
    if (effectType == kSfxType_Throw) {
        // THROW: pos1=source position, pos2=landing spot
        originX = p1x; originY = p1y;
        destX   = p2x; destY   = p2y;
        // Skip if GJJ/FHOH already recorded this same throwable
        if (g_CsInit) {
            EnterCriticalSection(&g_Cs);
            bool dup = HasActiveAoeAtDest(destX, destY);
            LeaveCriticalSection(&g_Cs);
            if (dup) return;
        }
    } else {
        // NOVA / CIRCLE_TELEGRAPH / AoE: pos1 is the effect centre
        originX = p1x; originY = p1y;
        destX   = p1x; destY   = p1y;
    }

    if (!std::isfinite(originX) || !std::isfinite(originY)) return;
    if (!std::isfinite(destX)   || !std::isfinite(destY))   { destX = originX; destY = originY; }

    // Resolve isEnemy via targetObjectId → direct entity dict key lookup.
    // Falls back to deferred position-match in CopyActiveForDraw if not yet in dict.
    bool isEnemy = false;
    bool isEnemyChecked = false;
    if (targetObjId > 0) {
        int r = FindEntityIsEnemyById(targetObjId);
        if (r != 0) {
            isEnemy        = (r == 1);
            isEnemyChecked = true;
        }
    }

    RecordAoe(originX, originY, destX, destY,
              kDefaultAoeRadiusTiles, 0.f, lifeMs,
              /*isDamaging=*/true, isEnemy, nullptr, targetObjId, isEnemyChecked,
              kAoeSrcSfx, effectType);

    // #region agent log
    const uint32_t ls = g_DbgSfxLogs.fetch_add(1, std::memory_order_relaxed);
    if (ls < 24u || (ls % 48u) == 0u) {
        std::ostringstream d;
        d << "{\"type\":" << effectType << ",\"objId\":" << targetObjId
          << ",\"p1x\":" << p1x << ",\"p1y\":" << p1y
          << ",\"p2x\":" << p2x << ",\"p2y\":" << p2y
          << ",\"dur\":" << dur << ",\"lifeMs\":" << lifeMs
          << ",\"isEnemy\":" << (isEnemy ? 1 : 0)
          << ",\"checked\":" << (isEnemyChecked ? 1 : 0) << "}";
        AgentLogAoe("H3", "AoeTracking.cpp:ShowEffectDetour", "record_sfx", d.str());
    }
    // #endregion
}

static bool HookShowEffectPath()
{
    if (g_SfxTarget) return true;
    Il2CppClass* klass = Resolver::GetClass("", kShowEffectClass);
    if (!klass) {
        AgentLogAoe("H1", "AoeTracking.cpp:HookShowEffectPath", "no_klass",
            "{\"class\":\"HJMBOMEHGDJ\"}");
        return false;
    }
    const MethodInfo* mi = il2cpp_class_get_method_from_name(klass, kShowEffectMethod, kShowEffectParamCount);
    if (!mi || !mi->methodPointer) {
        AgentLogAoe("H1", "AoeTracking.cpp:HookShowEffectPath", "no_method",
            mi ? "{\"methodPointer\":0}" : "{\"methodInfo\":0}");
        return false;
    }

    void* target = reinterpret_cast<void*>(mi->methodPointer);
    g_OrigShowEffect = nullptr;
    if (!Il2CppHook::InstallMinHook(target, reinterpret_cast<void*>(&ShowEffectDetour),
            reinterpret_cast<void**>(&g_OrigShowEffect), "AoeTracking:ShowEffect")) {
        g_OrigShowEffect = nullptr;
        AgentLogAoe("H2", "AoeTracking.cpp:HookShowEffectPath", "mh_install_fail",
            "{\"target\":" + std::to_string(static_cast<uint64_t>(reinterpret_cast<uintptr_t>(target))) + "}");
        return false;
    }
    g_SfxTarget = target;
    AgentLogAoe("H1", "AoeTracking.cpp:HookShowEffectPath", "sfx_hook_ok",
        "{\"target\":" + std::to_string(static_cast<uint64_t>(reinterpret_cast<uintptr_t>(target))) + "}");
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
static bool s_mhInit = false;

static void TryInitInfrastructure()
{
    if (!g_CsInit) {
        InitializeCriticalSection(&g_Cs);
        g_CsInit = true;
    }
    if (!s_mhInit) {
        MH_STATUS st = MH_Initialize();
        if (st != MH_OK && st != MH_ERROR_ALREADY_INITIALIZED) {
            // #region agent log
            static std::atomic<uint32_t> s_mhFailLog{ 0 };
            if (s_mhFailLog.fetch_add(1, std::memory_order_relaxed) < 4u) {
                std::ostringstream d;
                d << "{\"status\":" << static_cast<int>(st) << "}";
                AgentLogAoe("H2", "AoeTracking.cpp:TryInitInfrastructure", "mh_init_fail", d.str());
            }
            // #endregion
            return;
        }
        s_mhInit = true;
    }
}

static bool HookThrowablePath()
{
    if (g_GjjTarget) return true;
    Il2CppClass* klass = Resolver::GetClass("", kThrowableClass);
    if (!klass) {
        // #region agent log
        AgentLogAoe("H1", "AoeTracking.cpp:HookThrowablePath", "no_klass",
            "{\"class\":\"GJJCEFJMNMK\"}");
        // #endregion
        return false;
    }
    const MethodInfo* mi = il2cpp_class_get_method_from_name(klass, kSpawnMethod, kGjjParamCount);
    if (!mi || !mi->methodPointer) {
        // #region agent log
        AgentLogAoe("H1", "AoeTracking.cpp:HookThrowablePath", "no_method",
            mi ? "{\"methodPointer\":0}" : "{\"methodInfo\":0}");
        // #endregion
        return false;
    }

    void* target = reinterpret_cast<void*>(mi->methodPointer);
    g_OrigGjjKob = nullptr;
    if (!Il2CppHook::InstallMinHook(target, reinterpret_cast<void*>(&GjjKobDetour),
            reinterpret_cast<void**>(&g_OrigGjjKob), "AoeTracking:GjjKob")) {
        g_OrigGjjKob = nullptr;
        // #region agent log
        AgentLogAoe("H2", "AoeTracking.cpp:HookThrowablePath", "mh_install_fail",
            "{\"target\":" + std::to_string(static_cast<uint64_t>(reinterpret_cast<uintptr_t>(target))) + "}");
        // #endregion
        return false;
    }
    g_GjjTarget = target;
    // #region agent log
    AgentLogAoe("H1", "AoeTracking.cpp:HookThrowablePath", "gjj_hook_ok",
        "{\"target\":" + std::to_string(static_cast<uint64_t>(reinterpret_cast<uintptr_t>(target))) + "}");
    // #endregion
    return true;
}

static bool HookFhohPath()
{
    if (g_FhohTarget) return true;
    Il2CppClass* klass = Resolver::GetClass("", kFhohClass);
    if (!klass) return false;
    const MethodInfo* mi = il2cpp_class_get_method_from_name(klass, kSpawnMethod, kFhohParamCount);
    if (!mi || !mi->methodPointer) return false;

    void* target = reinterpret_cast<void*>(mi->methodPointer);
    g_OrigFhohKob = nullptr;
    if (!Il2CppHook::InstallMinHook(target, reinterpret_cast<void*>(&FhohKobDetour),
            reinterpret_cast<void**>(&g_OrigFhohKob), "AoeTracking:FhohKob")) {
        g_OrigFhohKob = nullptr;
        return false;
    }
    g_FhohTarget = target;
    AgentLogAoe("H1", "AoeTracking.cpp:HookFhohPath", "fhoh_hook_ok",
        "{\"target\":" + std::to_string(static_cast<uint64_t>(reinterpret_cast<uintptr_t>(target))) + "}");
    return true;
}

static bool HookExplosionPath()
{
    if (g_ExplTarget) return true;
    Il2CppClass* klass = Resolver::GetClass("", kExplSpawnerClass);
    if (!klass) {
        // #region agent log
        AgentLogAoe("H1", "AoeTracking.cpp:HookExplosionPath", "no_klass",
            "{\"class\":\"FGOFPGIIEPC\"}");
        // #endregion
        return false;
    }
    const MethodInfo* mi = il2cpp_class_get_method_from_name(klass, kSpawnMethod, kExplParamCount);
    if (!mi || !mi->methodPointer) {
        // #region agent log
        AgentLogAoe("H1", "AoeTracking.cpp:HookExplosionPath", "no_method",
            mi ? "{\"methodPointer\":0}" : "{\"methodInfo\":0}");
        // #endregion
        return false;
    }

    void* target = reinterpret_cast<void*>(mi->methodPointer);
    g_OrigExplSpawn = nullptr;
    if (!Il2CppHook::InstallMinHook(target, reinterpret_cast<void*>(&ExplSpawnDetour),
            reinterpret_cast<void**>(&g_OrigExplSpawn), "AoeTracking:ExplSpawn")) {
        g_OrigExplSpawn = nullptr;
        // #region agent log
        AgentLogAoe("H2", "AoeTracking.cpp:HookExplosionPath", "mh_install_fail",
            "{\"target\":" + std::to_string(static_cast<uint64_t>(reinterpret_cast<uintptr_t>(target))) + "}");
        // #endregion
        return false;
    }
    g_ExplTarget = target;
    // #region agent log
    AgentLogAoe("H1", "AoeTracking.cpp:HookExplosionPath", "expl_hook_ok",
        "{\"target\":" + std::to_string(static_cast<uint64_t>(reinterpret_cast<uintptr_t>(target))) + "}");
    // #endregion
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
namespace AoeTracking {

void GetGjjProbe(bool& resolved, uint32_t& originOff, uint32_t& destOff)
{
    resolved  = g_gjjFieldsResolved.load(std::memory_order_relaxed);
    originOff = g_gjjResolvedOriginOff;
    destOff   = g_gjjResolvedDestOff;
}

void Install()
{
    EnsureInstalled();
}

void EnsureInstalled()
{
    // Feature gate (mirrors ProjectileTracking): don't install AoE hooks against
    // a stale/patched game. FeatureAllowed() is fail-closed until BootGate is
    // Ready with the AoE anchors healthy; installing detours over shifted AoE
    // offsets crashes on load-in. Called from every dodge sensor + WorldTAB, so
    // the gate lives here (the shared choke point), not in Install().
    if (!BootGate::FeatureAllowed("AoeTracking")) {
        static std::atomic<uint32_t> s_gate{ 0 };
        const uint32_t n = s_gate.fetch_add(1, std::memory_order_relaxed);
        if (n == 0u || (n % 240u) == 0u)
            DBG_FILE_LOG("[AoeTracking] EnsureInstalled gated — BootGate not Ready / "
                "AoE anchor stale; AoE tracking OFF until offsets refresh");
        return;
    }
    RuntimeOffsets::EnsureAll();
    TryInitInfrastructure();
    if (!s_mhInit || !g_CsInit) {
        // #region agent log
        static std::atomic<uint32_t> s_infraLog{ 0 };
        const uint32_t n = s_infraLog.fetch_add(1, std::memory_order_relaxed);
        if (n < 6u || (n % 200u) == 0u) {
            std::ostringstream d;
            d << "{\"mhInit\":" << (s_mhInit ? 1 : 0) << ",\"csInit\":" << (g_CsInit ? 1 : 0) << "}";
            AgentLogAoe("H2", "AoeTracking.cpp:EnsureInstalled", "infra_not_ready", d.str());
        }
        // #endregion
        return;
    }

    const bool th = HookThrowablePath();
    const bool fh = HookFhohPath();
    const bool ex = HookExplosionPath();
    const bool sf = HookShowEffectPath();
    // #region agent log
    static std::atomic<uint32_t> s_ensureTick{ 0 };
    const uint32_t t = s_ensureTick.fetch_add(1, std::memory_order_relaxed);
    if (t < 8u || (t % 120u) == 0u) {
        const int hc = (g_GjjTarget ? 1 : 0) + (g_FhohTarget ? 1 : 0)
                     + (g_ExplTarget ? 1 : 0) + (g_SfxTarget ? 1 : 0);
        std::ostringstream d;
        d << "{\"gjjOk\":" << (th ? 1 : 0) << ",\"fhohOk\":" << (fh ? 1 : 0)
          << ",\"explOk\":" << (ex ? 1 : 0) << ",\"sfxOk\":" << (sf ? 1 : 0)
          << ",\"hookCount\":" << hc << "}";
        AgentLogAoe("H2", "AoeTracking.cpp:EnsureInstalled", "ensure_tick", d.str());
    }
    // #endregion
}

void Uninstall()
{
    if (g_GjjTarget) {
        MH_DisableHook(g_GjjTarget);
        MH_RemoveHook(g_GjjTarget);
        g_GjjTarget   = nullptr;
        g_OrigGjjKob  = nullptr;
    }
    if (g_FhohTarget) {
        MH_DisableHook(g_FhohTarget);
        MH_RemoveHook(g_FhohTarget);
        g_FhohTarget  = nullptr;
        g_OrigFhohKob = nullptr;
    }
    if (g_ExplTarget) {
        MH_DisableHook(g_ExplTarget);
        MH_RemoveHook(g_ExplTarget);
        g_ExplTarget    = nullptr;
        g_OrigExplSpawn = nullptr;
    }
    if (g_SfxTarget) {
        MH_DisableHook(g_SfxTarget);
        MH_RemoveHook(g_SfxTarget);
        g_SfxTarget      = nullptr;
        g_OrigShowEffect = nullptr;
    }
}

void CopyActiveForDraw(std::vector<WorldAoe>& out)
{
    out.clear();
    if (!g_CsInit) return;
    const ULONGLONG now = GetTickCount64();
    size_t emitted = 0;
    float  maxR    = 0.f;
    int    withPtr = 0;
    EnterCriticalSection(&g_Cs);
    for (int i = 0; i < kMaxAoes; ++i) {
        WorldAoe a = g_Aoes[i];  // value copy so we can patch radius outside the lock
        if (!a.valid) continue;
        float elapsed = static_cast<float>(now - a.spawnTick);
        if (elapsed >= a.lifetime) continue;

        // GJJ entries use kDefaultAoeRadiusTiles; EXPL entries have real radius from CEE+0x38.

        // Deferred isEnemy resolution (two strategies, either can resolve):
        //
        // 1. ID-based:  FindEntityIsEnemyById(ownerObjId) — direct dict key lookup.
        //    Correct for ShowEffect entries (ownerObjId = targetObjectId = source entity).
        //    Returns wrong result for GJJ entries (ownerObjId = GJJCEFJMNMK throwable, not thrower).
        //
        // 2. Position-based: FindOwnerIsEnemyAtPos(a.x, a.y) — position match at throw origin.
        //    Correct for GJJ/FHOH entries (thrower stands at throw origin).
        //    May fail for effects far from the source (e.g. remote nova).
        //
        // Rule: "enemy" wins — mark enemy if EITHER strategy returns enemy.
        //       Only mark friendly if ALL successful lookups agree.
        if (!a.isEnemyChecked) {
            bool resolved = false;
            bool resultIsEnemy = false;

            if (a.ownerObjId > 0) {
                int r = FindEntityIsEnemyById(a.ownerObjId);
                if (r == 1) { resolved = true; resultIsEnemy = true; }
                else if (r == 2) { resolved = true; /* resultIsEnemy stays false */ }
            }

            // If ID lookup didn't find enemy, try position match (authoritative for GJJ/FHOH).
            if (!resultIsEnemy) {
                int r = FindOwnerIsEnemyAtPos(a.x, a.y);
                if (r == 1) { resolved = true; resultIsEnemy = true; }
                else if (r == 2 && !resolved) { resolved = true; }
            }

            if (resolved) {
                a.isEnemy        = resultIsEnemy;
                a.isEnemyChecked = true;
                g_Aoes[i].isEnemy        = a.isEnemy;
                g_Aoes[i].isEnemyChecked = true;
            }
        }

        out.push_back(a);
        ++emitted;
        if (Mem::AddrOk(a.ptr))
            ++withPtr;
        if (a.radius > maxR)
            maxR = a.radius;
    }
    LeaveCriticalSection(&g_Cs);

    // #region agent log
    static ULONGLONG s_lastDrawLog = 0;
    if (now - s_lastDrawLog >= 5000ULL) {
        s_lastDrawLog = now;
        std::ostringstream d;
        d << "{\"emitted\":" << emitted << ",\"maxRadius\":" << maxR << ",\"withPtr\":" << withPtr << "}";
        AgentLogAoe("H5", "AoeTracking.cpp:CopyActiveForDraw", "draw_snapshot", d.str());
    }
    // #endregion
}

int CountActive()
{
    if (!g_CsInit) return 0;
    const ULONGLONG now = GetTickCount64();
    int n = 0;
    EnterCriticalSection(&g_Cs);
    for (int i = 0; i < kMaxAoes; ++i) {
        const WorldAoe& a = g_Aoes[i];
        if (!a.valid) continue;
        float elapsed = static_cast<float>(now - a.spawnTick);
        if (elapsed < a.lifetime) ++n;
    }
    LeaveCriticalSection(&g_Cs);
    return n;
}

int CountHooks()
{
    int c = 0;
    if (g_GjjTarget)  ++c;
    if (g_FhohTarget) ++c;
    if (g_ExplTarget) ++c;
    if (g_SfxTarget)  ++c;
    return c;
}

} // namespace AoeTracking
