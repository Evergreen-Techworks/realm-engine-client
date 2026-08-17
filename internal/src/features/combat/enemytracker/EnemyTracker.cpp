#include "pch-il2cpp.h"

#include "EnemyTracker.h"
#include "GameState.h"
#include "RuntimeOffsets.h"
#include "core/runtime/MemRead.h"
#include "core/il2cpp/Il2CppContainers.h"
#include "game/objects/GameObjects.h"

#include <Windows.h>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <unordered_map>
#include <vector>

namespace {

// ── Object type lists ────────────────────────────────────────────────────────
// Non-enemy entity types to reject outright, and whitelisted types that bypass
// the maxHp==200 decoy heuristic. Quest/fallback tiering lives in TargetSelector.
static constexpr int32_t kIgnoredTypes[]     = { 28491 };
static constexpr int32_t kWhitelistedTypes[] = { 31104 };

static bool IsIgnoredType(int32_t t) {
    for (int32_t v : kIgnoredTypes) if (v == t) return true;
    return false;
}
static bool IsWhitelistedType(int32_t t) {
    for (int32_t v : kWhitelistedTypes) if (v == t) return true;
    return false;
}

// ── Velocity tracking ────────────────────────────────────────────────────────
struct VelEntry {
    float     x = 0.f, y = 0.f;
    ULONGLONG t = 0;
    float     vx = 0.f, vy = 0.f;
};

static std::unordered_map<int32_t, VelEntry> s_velMap;
static ULONGLONG s_pruneAt = 0;

static constexpr float kServerTickMsMin  = 115.f;
static constexpr float kServerTickMsMax  = 290.f;
static constexpr float kMaxVelTilesPerMs = 0.1f;
static constexpr float kMoVelSmooth      = 0.65f;
static constexpr float kMaxInstTilesPerMs = 0.08f;

static void UpdateVelocity(int32_t id, float ex, float ey, ULONGLONG now, void* entity)
{
    float moVx = 0.f, moVy = 0.f;
    bool  haveMo = false;
    float rvx = 0.f, rvy = 0.f;
    // Character::Velocity reads the MoVelocity Vector2 under a single SEH guard and
    // returns false if the offset is unresolved (0) / the pointer is bad / the read
    // faults — the exact guard the hand-rolled __try provided.
    if (Game::Character(entity).Velocity(rvx, rvy)) {
        // Only use MoVelocity when it reports actual movement — the field reads
        // 0.0 on enemies when the offset is wrong or the entity is stationary,
        // which would otherwise drive chord-estimated velocity toward 0 via blending.
        if (std::isfinite(rvx) && std::isfinite(rvy) &&
            fabsf(rvx) < kMaxVelTilesPerMs && fabsf(rvy) < kMaxVelTilesPerMs &&
            (fabsf(rvx) > 1e-5f || fabsf(rvy) > 1e-5f)) {
            moVx = rvx; moVy = rvy; haveMo = true;
        }
    }

    auto it = s_velMap.find(id);
    if (it == s_velMap.end()) {
        s_velMap[id] = { ex, ey, now, haveMo ? moVx : 0.f, haveMo ? moVy : 0.f };
        return;
    }

    VelEntry& e = it->second;
    if (haveMo) {
        e.vx = e.vx * (1.f - kMoVelSmooth) + moVx * kMoVelSmooth;
        e.vy = e.vy * (1.f - kMoVelSmooth) + moVy * kMoVelSmooth;
        e.x = ex; e.y = ey; e.t = now;
        return;
    }

    const float dx = ex - e.x, dy = ey - e.y;
    const float distSq = dx * dx + dy * dy;
    e.x = ex; e.y = ey;
    if (distSq > 1e-14f) {
        // dt spans the true inter-position interval (server tick), not just the poll
        // interval, because e.t is only updated when the position actually changes.
        const float dt  = static_cast<float>(now > e.t ? (now - e.t) : 1ULL);
        const float dtC = (dt < 1.f) ? 1.f : (dt > 500.f ? 500.f : dt);
        float ivx = dx / dtC, ivy = dy / dtC;
        const float mag = sqrtf(ivx * ivx + ivy * ivy);
        if (mag > kMaxInstTilesPerMs && mag > 1e-8f) {
            const float s = kMaxInstTilesPerMs / mag;
            ivx *= s; ivy *= s;
        }
        float blend = 0.4f;
        if (dt >= kServerTickMsMin && dt <= kServerTickMsMax)
            blend = 0.9f;
        if (e.t != 0) {
            e.vx = e.vx * (1.f - blend) + ivx * blend;
            e.vy = e.vy * (1.f - blend) + ivy * blend;
        } else {
            e.vx = ivx; e.vy = ivy;
        }
        e.t = now;
    }
}

// ── World scan helpers ───────────────────────────────────────────────────────
static bool SehReadLocalKlassAndPos(void* local, float* outX, float* outY, uint64_t* outKlass)
{
    __try {
        uint8_t* lp = reinterpret_cast<uint8_t*>(local);
        *outX   = *reinterpret_cast<float*>(lp + RuntimeOffsets::PosX);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
        *outY   = *reinterpret_cast<float*>(lp + RuntimeOffsets::PosY);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
        *outKlass = *reinterpret_cast<uint64_t*>(lp);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}

struct CandidateOut {
    int32_t id, objType, hp, maxHp;
    float   x, y;
    bool    isInvulnerable, hasHealthBar;
    void*   ptr;
};

// Returns true if the dict entry describes a targetable enemy.
// Soft properties (invulnerable, hasHealthBar) are always populated so callers
// can apply their own targeting policies.
static bool SehReadCandidate(void* entity, int32_t id, void* local, uint64_t localKlass, CandidateOut& out)
{
    __try {
        if (!entity || entity == local)
            return false;
        if (*reinterpret_cast<uint64_t*>(entity) == localKlass)  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
            return false;

        void* objProps = *reinterpret_cast<void**>(reinterpret_cast<uint8_t*>(entity) + RuntimeOffsets::ObjProps);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
        if (!Mem::AddrOk(objProps))
            return false;
        uint8_t* op  = reinterpret_cast<uint8_t*>(objProps);
        uint8_t* ent = reinterpret_cast<uint8_t*>(entity);

        if (!*reinterpret_cast<uint8_t*>(op + RuntimeOffsets::OP_IsEnemy))  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
            return false;

        // noHealthBar (walls/destructibles) — stored as metadata, not hard-rejected
        const uint8_t noHB = *reinterpret_cast<uint8_t*>(op + RuntimeOffsets::OP_NoHealthBar);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)

        // XML <Invincible/> — reject if InvincibleElement pointer exists (regardless of string)
        void* invPtr = *reinterpret_cast<void**>(op + RuntimeOffsets::OP_InvincibleElem);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
        if (invPtr && Mem::AddrOk(invPtr))
            return false;

        bool isInvuln = false;

        const int32_t hp    = *reinterpret_cast<int32_t*>(ent + RuntimeOffsets::HP);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
        const int32_t maxHp = *reinterpret_cast<int32_t*>(ent + RuntimeOffsets::MaxHP);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
        if (hp <= 0 || maxHp <= 0 || hp > maxHp)
            return false;

        const int32_t objType = *reinterpret_cast<int32_t*>(ent + RuntimeOffsets::ObjType);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
        if (!IsWhitelistedType(objType)) {
            if (maxHp == 200)
                return false;
            if (IsIgnoredType(objType))
                return false;
        }

        // Runtime condition check (stasis / runtime invincible)
        uint32_t cond0 = 0, cond1 = 0;
        const bool condOk = RuntimeOffsets::TryReadMapObjectConditions(entity, &cond0, &cond1);
        if (condOk && (cond0 | cond1) && RuntimeOffsets::MapObjectConditionsMakeUntargetable(cond0, cond1))
            return false;

        const float ex2 = *reinterpret_cast<float*>(ent + RuntimeOffsets::PosX);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
        const float ey2 = *reinterpret_cast<float*>(ent + RuntimeOffsets::PosY);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
        if (!std::isfinite(ex2) || !std::isfinite(ey2) || (ex2 == 0.f && ey2 == 0.f))
            return false;

        out.id            = id;
        out.objType       = objType;
        out.hp            = hp;
        out.maxHp         = maxHp;
        out.x             = ex2;
        out.y             = ey2;
        out.isInvulnerable = isInvuln;
        out.hasHealthBar  = (noHB == 0);
        out.ptr           = entity;
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}

// ── Frame state ──────────────────────────────────────────────────────────────
static std::vector<EnemyTracker::Entry> s_snapshot;
static std::atomic<int32_t>  s_localPlayerObjectId{ 0 };
static ULONGLONG             s_lastTickMs = 0;

} // namespace

namespace EnemyTracker {

void Tick()
{
    // Self-throttle: dedupes the aim path and EnumerateLiveEnemies callers within
    // a frame, and bounds the world-dict walk to ~125 Hz. On a throttled call the
    // previous snapshot (≤8 ms old) is kept rather than cleared.
    const ULONGLONG now = GetTickCount64();
    if (now - s_lastTickMs < 8ULL) return;
    s_lastTickMs = now;

    s_snapshot.clear();

    void* local = GameState::GetLocalPtr();
    if (!local) return;

    float px = 0.f, py = 0.f;
    uint64_t localKlass = 0;
    if (!SehReadLocalKlassAndPos(local, &px, &py, &localKlass) || localKlass == 0)
        return;

    void* wm = GameState::GetWorldMgr();
    if (!Mem::AddrOk(wm)) return;

    void* allDict = Mem::ReadPtr(wm, RuntimeOffsets::WM_AllDict);
    if (!Mem::AddrOk(allDict)) return;

    s_snapshot.reserve(256);

    // Walk the world's Dictionary<int, entity>. WalkDict skips free/tombstone
    // slots (hashCode < 0) — the same slots the candidate check already discarded
    // — and clamps a corrupt count to 4096, matching the prior hand loop.
    Il2CppC::WalkDict(allDict, /*maxEntries*/4096, [&](int32_t key, void* entity) {
        // Opportunistically capture local player's dict key (object ID).
        if (entity == local)
            s_localPlayerObjectId.store(key, std::memory_order_relaxed);

        CandidateOut cand{};
        if (!SehReadCandidate(entity, key, local, localKlass, cand))
            return;

        UpdateVelocity(cand.id, cand.x, cand.y, now, cand.ptr);

        Entry e{};
        e.id             = cand.id;
        e.objType        = cand.objType;
        e.x              = cand.x;
        e.y              = cand.y;
        e.hp             = cand.hp;
        e.maxHp          = cand.maxHp;
        e.isInvulnerable = cand.isInvulnerable;
        e.hasHealthBar   = cand.hasHealthBar;
        e.ptr            = cand.ptr;

        // Populate velocity from the just-updated map
        auto it = s_velMap.find(cand.id);
        if (it != s_velMap.end()) {
            e.vx = it->second.vx;
            e.vy = it->second.vy;
        }
        s_snapshot.push_back(e);
    });

    // Prune stale velocity entries every 5 seconds
    if (now >= s_pruneAt) {
        s_pruneAt = now + 5000ULL;
        for (auto it2 = s_velMap.begin(); it2 != s_velMap.end();) {
            if (now - it2->second.t > 8000ULL) it2 = s_velMap.erase(it2);
            else ++it2;
        }
    }
}

const std::vector<Entry>& GetSnapshot() { return s_snapshot; }

void Enumerate(Callback cb, void* user)
{
    if (!cb) return;
    for (const Entry& e : s_snapshot) cb(e, user);
}

int32_t GetLocalPlayerObjectId()
{
    return s_localPlayerObjectId.load(std::memory_order_relaxed);
}

} // namespace EnemyTracker
