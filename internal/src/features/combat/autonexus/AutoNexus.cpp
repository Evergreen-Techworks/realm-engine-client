#include "pch-il2cpp.h"
#include "AutoNexus.h"
#include "ProjectileTracking.h"
#include "AoeTracking.h"
#include "DodgeHit.h"
#include "DodgeGeometry.h"
#include "IpcBridge.h"
#include "W2S.h"
#include "gui/tabs/WorldTAB.h"
#include "LocalPlayer.h"
#include "RuntimeOffsets.h"
#include "Il2CppResolver.h"
#include <algorithm>
#include <cstdio>
#include <cstdint>
#include <cmath>
#include <vector>
#include <imgui/imgui.h>

namespace CombatTAB {
namespace FeatAutoNexus {

// ── Settings ─────────────────────────────────────────────────────────────
static bool  g_autoNexus     = false;
static float g_predTimeMs    = 200.f;
static bool  g_nexusProjDmg  = true;
static bool  g_nexusTileDmg  = true;
static bool  g_debugDraw     = false;

// EquipmentManager.UseInventoryItemByHotkey — resolved lazily on first
// use so the module costs nothing at startup. Cached forever once
// resolved (function pointer is stable for the process lifetime).
using UseInvByHotkeyFn = void(__fastcall*)(void* eqMgr, int32_t hotkey, void* methodInfo);
static UseInvByHotkeyFn s_fnUseInvByHotkey = nullptr;
static uint32_t          s_eqMgrFieldOff   = 0;   // FKALGHJIADI.AJJJBDBNBLM offset
static bool              s_autoPotResolved = false;

static ULONGLONG s_lastAutoNexusTick = 0;

static constexpr ULONGLONG kAutoNexusPollMs = 16ULL;

// ── Scan geometry ────────────────────────────────────────────────────────
static constexpr float kBroadStepMs = 50.f;
static constexpr float kFineStepMs  = 10.f;
static constexpr float kNexusHitPadTiles = 0.04f;
static constexpr float kMaxHorizonMs = 1000.f;
static constexpr float kMaxRetroWindowMs = 200.f;

static ULONGLONG s_lastScanMs   = 0;
static float     s_prevPlayerX  = 0.f;
static float     s_prevPlayerY  = 0.f;
static bool      s_havePrevScan = false;

// ── Player motion ────────────────────────────────────────────────────────
struct PlayerMotion {
    float x  = 0.f, y  = 0.f;
    float vx = 0.f, vy = 0.f;   // tiles per millisecond
};

static constexpr float kSpdFallback = 50.f;

// Movement-affecting conditions.
//   Paralyzed / Petrified / Stasis → the player does not move at all;
//   Slowed                         → speed is pinned at MIN_MOVE_SPEED
//   Speedy / NinjaSpeedy           → x1.5 on top of the SPD curve.
static constexpr float kMinTilesPerSec = 4.0f;
static constexpr float kSpeedyMult     = 1.5f;

static PlayerMotion ReadPlayerMotion(void* lp, uint64_t conds)
{
    PlayerMotion m{};
    m.x = LocalPlayer::GetX();
    m.y = LocalPlayer::GetY();
    if (!lp) return m;

    using CE = RuntimeOffsets::ConditionEffects;
    if (RuntimeOffsets::HasCondition(conds, CE::Paralyzed) ||
        RuntimeOffsets::HasCondition(conds, CE::Petrified) ||
        RuntimeOffsets::HasCondition(conds, CE::Stasis))
        return m;

    bool  moving = false;
    float dirX = 0.f, dirY = 0.f, spd = kSpdFallback;
    __try {
        const uint8_t* p = reinterpret_cast<const uint8_t*>(lp);
        moving = *reinterpret_cast<const bool*>(p + RuntimeOffsets::Player_Moving);
        dirX   = *reinterpret_cast<const float*>(p + RuntimeOffsets::Player_MoveDirX);
        dirY   = *reinterpret_cast<const float*>(p + RuntimeOffsets::Player_MoveDirY);
        const float s = *reinterpret_cast<const float*>(p + RuntimeOffsets::Player_Spd);
        if (std::isfinite(s) && s > 0.f && s <= 120.f) spd = s;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return m;
    }

    if (!moving || !std::isfinite(dirX) || !std::isfinite(dirY)) return m;
    const float len = std::sqrt(dirX * dirX + dirY * dirY);
    if (!(len > 0.01f)) return m;

    // Flash caps speed scaling at SPD=75; stats above that give no extra
    // movement (same clamp TestTAB::ReadPlayerStats applies).
    const float effSpd      = (spd > 75.f) ? 75.f : spd;
    float tilesPerSec = kMinTilesPerSec + 5.6f * (effSpd / 75.0f);
    if (RuntimeOffsets::HasCondition(conds, CE::Slowed)) {
        tilesPerSec = kMinTilesPerSec;                 // pinned, not scaled
    } else if (RuntimeOffsets::HasCondition(conds, CE::Speedy) ||
               RuntimeOffsets::HasCondition(conds, CE::NinjaSpeedy)) {
        tilesPerSec *= kSpeedyMult;
    }
    const float perMs       = tilesPerSec / 1000.f;
    m.vx = (dirX / len) * perMs;
    m.vy = (dirY / len) * perMs;
    return m;
}

// ── Observed velocity ────────────────────────────────────────────────────
static constexpr float kObsMinDtMs        = 8.f;   // below this, dt noise dominates
static constexpr float kObsMaxTilesPerSec = 20.f;  // hard cap on a believable speed
static constexpr float kObsTeleportTiles  = 4.f;   // portal / map change / position write
static constexpr float kObsSmoothing      = 0.35f;

struct ObservedMotion {
    bool          seeded = false;
    float         px = 0.f, py = 0.f;
    LARGE_INTEGER at{};
    float         vx = 0.f, vy = 0.f;
};
static ObservedMotion s_obs;

static void ObserveVelocity(float x, float y, float& outVx, float& outVy)
{
    LARGE_INTEGER freq{}, now{};
    if (!QueryPerformanceFrequency(&freq) || freq.QuadPart == 0 ||
        !QueryPerformanceCounter(&now)) { outVx = 0.f; outVy = 0.f; return; }

    if (!s_obs.seeded) {
        s_obs = ObservedMotion{};
        s_obs.seeded = true;
        s_obs.px = x; s_obs.py = y; s_obs.at = now;
        outVx = 0.f; outVy = 0.f;
        return;
    }

    const double dtMs = static_cast<double>(now.QuadPart - s_obs.at.QuadPart)
                      * 1000.0 / static_cast<double>(freq.QuadPart);
    if (dtMs < kObsMinDtMs)
    {
        outVx = s_obs.vx; outVy = s_obs.vy; return;
    }

    const float dx = x - s_obs.px;
    const float dy = y - s_obs.py;
    s_obs.px = x; s_obs.py = y; s_obs.at = now;

    if (std::sqrt(dx * dx + dy * dy) > kObsTeleportTiles) {
        s_obs.vx = 0.f; s_obs.vy = 0.f;
        outVx = 0.f; outVy = 0.f;
        return;
    }

    float rawVx = dx / static_cast<float>(dtMs);
    float rawVy = dy / static_cast<float>(dtMs);
    const float speed = std::sqrt(rawVx * rawVx + rawVy * rawVy);
    const float cap   = kObsMaxTilesPerSec / 1000.f;
    if (speed > cap && speed > 0.f) { rawVx *= cap / speed; rawVy *= cap / speed; }

    s_obs.vx += kObsSmoothing * (rawVx - s_obs.vx);
    s_obs.vy += kObsSmoothing * (rawVy - s_obs.vy);
    outVx = s_obs.vx;
    outVy = s_obs.vy;
}

// ── Threat list ──────────────────────────────────────────────────────────
struct Threat {
    int32_t attackerObjId = 0;
    int32_t bulletId      = 0;
    float   tHitMs        = 0.f;
    int32_t rawDamage     = 0;
    bool    armorPiercing = false;
};

// ── Debug path capture ───────────────────────────────────────────────────
static constexpr int kMaxVizProjs   = 96;
static constexpr int kVizSamples    = 32;
static float g_vizX[kMaxVizProjs * kVizSamples];
static float g_vizY[kMaxVizProjs * kVizSamples];
static int   g_vizLen[kMaxVizProjs]  = { 0 };
static bool  g_vizHit[kMaxVizProjs]  = { false };
static int   g_vizCount = 0;

// ── Predicted-player / ground-sample viz ─────────────────────────────────
static constexpr int kMaxGroundVizTiles = 48;
static int   g_gvTileX[kMaxGroundVizTiles]   = { 0 };
static int   g_gvTileY[kMaxGroundVizTiles]   = { 0 };
static int   g_gvTileDmg[kMaxGroundVizTiles] = { 0 };
static int   g_gvTileCount = 0;
static float g_gvNowX = 0.f, g_gvNowY = 0.f;
static float g_gvEndX = 0.f, g_gvEndY = 0.f;
static float g_gvVx   = 0.f, g_gvVy   = 0.f;
static float g_gvFieldVx = 0.f, g_gvFieldVy = 0.f;
static float g_gvFieldEndX = 0.f, g_gvFieldEndY = 0.f;
static float g_gvHorizonMs = 0.f;
static int   g_gvEvents    = 0;
static bool  g_gvMotion    = false;
static bool  g_gvTiles     = false;

static void CaptureGroundTile(int tx, int ty, int dmg)
{
    if (g_gvTileCount >= kMaxGroundVizTiles) return;
    g_gvTileX[g_gvTileCount]   = tx;
    g_gvTileY[g_gvTileCount]   = ty;
    g_gvTileDmg[g_gvTileCount] = dmg;
    ++g_gvTileCount;
}

// ── Instance liveness ────────────────────────────────────────────────────
static constexpr float kDeadDivergeTiles = 2.0f;
static constexpr float kLivenessGraceMs  = 60.f;

// Unfortunately this is really just our best guess of whether or not the 
// projectile is removed, as I don't know if there's a function that I could
// hook for it. If there is, please let me know and I'll change this. 
static bool InstanceLooksAlive(const WorldProjectile& proj, float elapsedNow)
{
    if (!proj.ptr) return true;
    if (elapsedNow < kLivenessGraceMs) return true;
    float bx = proj.x, by = proj.y;
    ProjectileTracking::ComputePosAtSafe(proj, elapsedNow, bx, by);
    if (!std::isfinite(bx) || !std::isfinite(by)) return true;
    const float dx = proj.x - bx;
    const float dy = proj.y - by;
    return (dx * dx + dy * dy) <= kDeadDivergeTiles * kDeadDivergeTiles;
}

static void CaptureVizPath(const WorldProjectile& proj, float elapsedNow, bool willHit)
{
    if (g_vizCount >= kMaxVizProjs) return;
    if (!InstanceLooksAlive(proj, elapsedNow)) return;
    const float remain = proj.lifetime - elapsedNow;
    if (!(remain > 0.f) || !std::isfinite(remain)) return;
    const float step = remain / static_cast<float>(kVizSamples - 1);

    const int base = g_vizCount * kVizSamples;
    int n = 0;
    for (int i = 0; i < kVizSamples; ++i) {
        float bx = proj.x, by = proj.y;
        ProjectileTracking::ComputePosAtSafe(proj, elapsedNow + step * i, bx, by);
        if (!std::isfinite(bx) || !std::isfinite(by)) break;
        g_vizX[base + n] = bx;
        g_vizY[base + n] = by;
        ++n;
    }
    if (n < 2) return;
    g_vizLen[g_vizCount] = n;
    g_vizHit[g_vizCount] = willHit;
    ++g_vizCount;
}

static bool ReadPlayerStatsCached(int32_t& hp, int32_t& maxHp, int32_t& defense)
{
    hp      = LocalPlayer::GetHP();
    maxHp   = LocalPlayer::GetMaxHP();
    // Read defense straight from game memory (RuntimeOffsets::Defense, ~0x508)
    // instead of the client-pushed `clientDefense`, which was reconstructed from
    // wire stats as `pd.defense + pd.defenseBonus` and double-counted the gear
    // boost (over-stated defense → nexus fired too late). The memory value is the
    // game's own field: if it's effective (gear-included) this is exactly correct;
    // if it's base-only it under-states defense → nexus fires earlier (safe).
    // Either way it can't get you killed the way the double-counted value did.
    // Confirm base-vs-effective via RE_STAT_DUMP.
    defense = LocalPlayer::GetDefense();
    return LocalPlayer::GetPtr() != nullptr;
}

static bool OverlapsAt(const WorldProjectile& proj, float tAbsMs,
                       float plx, float ply)
{
    float bx = proj.x, by = proj.y;
    ProjectileTracking::ComputePosAtSafe(proj, tAbsMs, bx, by);
    if (!std::isfinite(bx) || !std::isfinite(by)) return false;
    return DodgeHit::Hits(proj, bx, by, plx, ply, 1.f, kNexusHitPadTiles);
}

// ── Already-consumed bullets ─────────────────────────────────────────────
// Simmilar thing, this isn't great but it's the best I have for now.
// The goal is to just remove projectiles that have hit
// So the autonexus doesn't freak out and think it's going to hit us again.
static bool CrossedPlayerInPast(const WorldProjectile& proj, float elapsedNow,
                                float windowMs, float px0, float py0,
                                float px1, float py1)
{
    if (!(windowMs > 0.f) || !std::isfinite(elapsedNow) || elapsedNow <= 0.f) return false;
    if (windowMs > elapsedNow) windowMs = elapsedNow;
    const float t0 = elapsedNow - windowMs;

    for (float t = t0; t < elapsedNow; t += kFineStepMs) {
        const float u   = (elapsedNow - t) / windowMs;
        const float plx = px1 + (px0 - px1) * u;
        const float ply = py1 + (py0 - py1) * u;
        if (OverlapsAt(proj, t, plx, ply)) return true;
    }
    return false;
}

static float FindHitMsUntil(const WorldProjectile& proj, float elapsedNow,
                            const PlayerMotion& pm, float horizonMs)
{
    if (!std::isfinite(elapsedNow) || elapsedNow < 0.f) return -1.f;

    float span = horizonMs;
    if (proj.lifetime > 0.f) {
        const float remain = proj.lifetime - elapsedNow;
        if (!(remain > 0.f)) return -1.f;
        if (remain < span) span = remain;
    }
    if (!(span > 0.f)) return -1.f;

    if (OverlapsAt(proj, elapsedNow, pm.x, pm.y)) return 0.f;

    // First a board pass, we calculate larger intervals and do a sweep against the player's position.
    // I'm increasing the player hitbox size by 2x to determine if the sweep would hit because I'd rather
    // be safe than sorry, but it does lead to more false positives and this function being less 
    // efficient. This can be reduced to flavor. 
    const float broadR = DodgeHit::ProjChebyshevHalf(proj)
                       + 2.f * DodgeHit::kPlayerHalf
                       + kNexusHitPadTiles;

    float prevRx = 0.f, prevRy = 0.f;
    bool  havePrev = false;
    for (float t = 0.f; t < span + 0.5f * kBroadStepMs; t += kBroadStepMs) {
        const float tc = (t > span) ? span : t;
        float bx = proj.x, by = proj.y;
        ProjectileTracking::ComputePosAtSafe(proj, elapsedNow + tc, bx, by);
        if (!std::isfinite(bx) || !std::isfinite(by)) { havePrev = false; continue; }
        const float rx = bx - (pm.x + pm.vx * tc);
        const float ry = by - (pm.y + pm.vy * tc);

        if (havePrev &&
            DodgeGeometry::MinDistPointToSegment(0.f, 0.f, prevRx, prevRy, rx, ry) < broadR) {
            // If the sweep would hit the player, we do a fine tune over that 
            // interval to see when / if it would actually collde with the player.
            const float lo = (tc > kBroadStepMs) ? tc - kBroadStepMs : 0.f;
            for (float f = lo; f <= tc + 0.5f * kFineStepMs; f += kFineStepMs) {
                const float fc = (f > tc) ? tc : f;
                const float plx = pm.x + pm.vx * fc;
                const float ply = pm.y + pm.vy * fc;
                if (OverlapsAt(proj, elapsedNow + fc, plx, ply)) return fc;
            }
        }
        prevRx = rx; prevRy = ry; havePrev = true;
        if (tc >= span) break;
    }
    return -1.f;
}

// ── Predicted ground damage ──────────────────────────────────────────────
static constexpr float kGroundStepMs = 25.f;

struct GroundThreat {
    int32_t rawDamage = 0;
    float   tHitMs    = -1.f;

    int32_t        count = 0;
    IpcGroundEvent events[kIpcMaxGroundEvents] = {};

    void Add(int32_t dmg, float t)
    {
        if (count >= kIpcMaxGroundEvents) return;
        events[count].rawDamage = dmg;
        events[count].tHitMs    = t;
        ++count;
        if (count == 1) { rawDamage = dmg; tHitMs = t; }
    }
};

// ── Ground tick model ────────────────────────────────────────────────────
static constexpr float kGroundTickMs = 500.f;

struct GroundTickState {
    bool     onDamaging  = false;
    int      tx = INT32_MIN, ty = INT32_MIN;
    ULONGLONG lastTickMs = 0;
};
static GroundTickState s_groundTick;


static GroundThreat PredictGroundDamage(void* lp, const PlayerMotion& pm, float horizonMs)
{
    GroundThreat out{};
    g_gvTileCount = 0;
    g_gvTiles     = false;
    g_gvEvents    = 0;
    if (!g_nexusTileDmg || horizonMs <= 0.f) return out;

    const ULONGLONG nowMs  = GetTickCount64();
    const int       curTx  = static_cast<int>(std::floor(pm.x));
    const int       curTy  = static_cast<int>(std::floor(pm.y));
    const int       curDmg = WorldTAB::GetTileDamageLive(curTx, curTy);
    const bool      movedTile = (curTx != s_groundTick.tx || curTy != s_groundTick.ty);

    if (curDmg <= 0) {
        s_groundTick.onDamaging = false;
    } else {
        if (!s_groundTick.onDamaging || movedTile) {
            s_groundTick.lastTickMs = nowMs;
        } else if (nowMs - s_groundTick.lastTickMs >= static_cast<ULONGLONG>(kGroundTickMs)) {
            s_groundTick.lastTickMs = nowMs;
        }
        s_groundTick.onDamaging = true;
    }
    s_groundTick.tx = curTx;
    s_groundTick.ty = curTy;

    float timerAt = kGroundTickMs - static_cast<float>(nowMs - s_groundTick.lastTickMs);
    if (timerAt < 0.f) timerAt = 0.f;

    int simTx = curTx, simTy = curTy;
    int simDmg = curDmg;

    g_gvTiles = true;
    CaptureGroundTile(curTx, curTy, curDmg);

    for (float t = 0.f; t <= horizonMs + 0.5f * kGroundStepMs; t += kGroundStepMs) {
        const float tc = (t > horizonMs) ? horizonMs : t;
        const float px = pm.x + pm.vx * tc;
        const float py = pm.y + pm.vy * tc;
        if (!std::isfinite(px) || !std::isfinite(py)) break;

        const int tx = static_cast<int>(std::floor(px));
        const int ty = static_cast<int>(std::floor(py));

        if (tx != simTx || ty != simTy) {
            simTx = tx; simTy = ty;
            simDmg = WorldTAB::GetTileDamageLive(tx, ty);
            CaptureGroundTile(tx, ty, simDmg);
            // Entry into a damaging tile will immediatly hurt you. 
            // We need to calculate where we'll be after the horizon
            // and how many spaces we'll touch and take damage from.
            if (simDmg > 0) {
                out.Add(simDmg, tc);
                timerAt = tc + kGroundTickMs;
            }
        } else if (simDmg > 0 && tc >= timerAt) {
            // Standing on it long enough for the damage to tick again
            out.Add(simDmg, tc);
            timerAt = tc + kGroundTickMs;
        }

        if (out.count >= kIpcMaxGroundEvents) break;
        if (tc >= horizonMs) break;
    }

    g_gvEvents = out.count;
    return out;
}

static void PublishThreats(const std::vector<Threat>& threats, const GroundThreat& ground)
{
    IpcThreat out[kIpcMaxThreats];
    int n = 0;
    for (const auto& t : threats) {
        if (n >= kIpcMaxThreats) break;
        out[n].attackerObjId        = t.attackerObjId;
        out[n].bulletId             = t.bulletId;
        out[n].tHitMs               = t.tHitMs;
        out[n].fallbackDamage       = t.rawDamage;
        out[n].fallbackArmorPiercing = t.armorPiercing ? 1u : 0u;
        ++n;
    }
    IpcGround g{};
    g.rawDamage = ground.rawDamage;
    g.tHitMs    = ground.tHitMs;
    g.count     = ground.count;
    for (int i = 0; i < ground.count && i < kIpcMaxGroundEvents; ++i)
        g.events[i] = ground.events[i];
    IpcBridge_PublishThreats(out, n, g);
}

static void RunAutoNexus()
{
    void* lp = LocalPlayer::GetPtr();
    if (!lp) return;

    int32_t hp = 0, maxHp = 0, defense = 0;
    if (!ReadPlayerStatsCached(hp, maxHp, defense)) return;

    if (maxHp <= 0 || hp > maxHp * 4) return;
    if (defense < 0) defense = 0;

    uint32_t cW0 = 0, cW1 = 0;
    RuntimeOffsets::TryReadMapObjectConditions(lp, &cW0, &cW1);
    const uint64_t cFull = RuntimeOffsets::GetFullConditions(cW0, cW1);

    std::vector<Threat> threats;

    PlayerMotion pm = ReadPlayerMotion(lp, cFull);
    const float horizon = std::max(0.f, std::min(kMaxHorizonMs, g_predTimeMs));

    const float fieldVx = pm.vx, fieldVy = pm.vy;
    ObserveVelocity(pm.x, pm.y, pm.vx, pm.vy);

    g_gvNowX = pm.x;  g_gvNowY = pm.y;
    g_gvVx   = pm.vx; g_gvVy   = pm.vy;
    g_gvEndX = pm.x + pm.vx * horizon;
    g_gvEndY = pm.y + pm.vy * horizon;
    g_gvFieldVx   = fieldVx;
    g_gvFieldVy   = fieldVy;
    g_gvFieldEndX = pm.x + fieldVx * horizon;
    g_gvFieldEndY = pm.y + fieldVy * horizon;
    g_gvHorizonMs = horizon;
    g_gvMotion = true;

    g_vizCount = 0;

    if (g_nexusProjDmg) {
        std::vector<WorldProjectile> projs;
        ProjectileTracking::CopyActiveForDraw(projs);

        const ULONGLONG nowMs   = GetTickCount64();
        const int32_t   localId = ProjectileTracking::GetLocalPlayerObjectId();

        float retroMs = 0.f;
        if (s_havePrevScan && nowMs > s_lastScanMs) {
            const float gap = static_cast<float>(nowMs - s_lastScanMs);
            if (gap <= kMaxRetroWindowMs) retroMs = gap;
        }
        const float prevPx = s_prevPlayerX;
        const float prevPy = s_prevPlayerY;
        s_lastScanMs   = nowMs;
        s_prevPlayerX  = pm.x;
        s_prevPlayerY  = pm.y;
        s_havePrevScan = true;

        for (const auto& proj : projs) {
            if (!proj.valid) continue;
            if (localId != 0 && proj.attackerObjId == localId) continue;
            if (localId != 0 && static_cast<int32_t>(proj.ownerObjId) == localId) continue;

            const float alreadyElapsed =
                (float)((int64_t)nowMs - (int64_t)proj.spawnTick);
            if (alreadyElapsed < 0.f || alreadyElapsed > proj.lifetime + 50.f)
                continue;

            if (retroMs > 0.f &&
                CrossedPlayerInPast(proj, alreadyElapsed, retroMs, prevPx, prevPy, pm.x, pm.y)) {
                ProjectileTracking::RetireProjectile(proj);
                continue;
            }

            const float tHit = FindHitMsUntil(proj, alreadyElapsed, pm, horizon);
            if (g_debugDraw) CaptureVizPath(proj, alreadyElapsed, tHit >= 0.f);
            if (tHit < 0.f) continue;

            Threat th{};
            th.attackerObjId = proj.attackerObjId;
            th.bulletId      = proj.bulletId;
            th.tHitMs        = tHit;
            th.rawDamage     = proj.damage;
            th.armorPiercing = proj.armorPiercing;
            threats.push_back(th);
        }

        std::sort(threats.begin(), threats.end(),
                  [](const Threat& a, const Threat& b) { return a.tHitMs < b.tHitMs; });
    }

    const GroundThreat ground = PredictGroundDamage(lp, pm, horizon);

    PublishThreats(threats, ground);
}

// ── Item-use primitives ──────────────────────────────────────────────────
// Resolve EquipmentManager.UseInventoryItemByHotkey + the EquipmentManager
// pointer field on the player class. Idempotent — subsequent calls return
// immediately when s_autoPotResolved is set.
static void ResolveAutoPotOnce()
{
    if (s_autoPotResolved) return;
    Resolver::Protection::safe_call([&]() {
        Il2CppClass* em = Resolver::FindClass("DecaGames.RotMG.Managers.Equipment", "EquipmentManager");
        if (!em) em = Resolver::FindClassLoose("PNBNDBIPENP");
        if (em) {
            const MethodInfo* mi = il2cpp_class_get_method_from_name(em, "UseInventoryItemByHotkey", 1);
            if (mi && mi->methodPointer) {
                s_fnUseInvByHotkey = reinterpret_cast<UseInvByHotkeyFn>(mi->methodPointer);
            }
        }
        Il2CppClass* fk = Resolver::FindClassLoose("FKALGHJIADI");
        if (fk) {
            FieldInfo* eqf = il2cpp_class_get_field_from_name(fk, "AJJJBDBNBLM");
            if (eqf) s_eqMgrFieldOff = static_cast<uint32_t>(il2cpp_field_get_offset(eqf));
        }
    });
    if (s_fnUseInvByHotkey && s_eqMgrFieldOff) s_autoPotResolved = true;
}

static void* ReadEquipmentManagerPtr(void* localPlayer)
{
    if (!localPlayer || !s_eqMgrFieldOff) return nullptr;
    void* eqMgr = nullptr;
    __try {
        eqMgr = *reinterpret_cast<void**>(reinterpret_cast<uint8_t*>(localPlayer) + s_eqMgrFieldOff);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return nullptr;
    }
    return eqMgr;
}

static void TryDrinkHotkey(int hotkey, ULONGLONG& lastTickMs, ULONGLONG cooldownMs)
{
    ResolveAutoPotOnce();
    if (!s_fnUseInvByHotkey || !s_eqMgrFieldOff) return;
    const ULONGLONG now = GetTickCount64();
    if (now - lastTickMs < cooldownMs) return;
    void* lp = LocalPlayer::GetPtr();
    if (!lp) return;
    void* eqMgr = ReadEquipmentManagerPtr(lp);
    if (!eqMgr) return;
    Resolver::Protection::safe_call([&]() {
        s_fnUseInvByHotkey(eqMgr, hotkey, nullptr);
    });
    lastTickMs = now;
}

void Tick()
{
    const ULONGLONG now = GetTickCount64();

    if (g_autoNexus) {
        if (now - s_lastAutoNexusTick >= kAutoNexusPollMs) {
            s_lastAutoNexusTick = now;
            RunAutoNexus();
        }
    }
}

static void DrawWorldCircle(ImDrawList* dl, float wx, float wy, float radiusTiles,
                            ImU32 col, float thickness, ImU32 fill,
                            float camX, float camY, float angleRad, float zoom,
                            float cx, float cy)
{
    float sx, sy, ex, ey;
    if (!W2S(wx, wy, sx, sy, camX, camY, angleRad, zoom, cx, cy)) return;
    if (!W2S(wx + radiusTiles, wy, ex, ey, camX, camY, angleRad, zoom, cx, cy)) return;
    const float rx = ex - sx, ry = ey - sy;
    const float r  = std::sqrt(rx * rx + ry * ry);
    if (!std::isfinite(r) || r < 1.f || r > 4000.f) return;
    if ((fill >> IM_COL32_A_SHIFT) != 0u) dl->AddCircleFilled(ImVec2(sx, sy), r, fill, 32);
    dl->AddCircle(ImVec2(sx, sy), r, col, 32, thickness);
    dl->AddCircleFilled(ImVec2(sx, sy), 2.5f, col);
}

static void DrawWorldTile(ImDrawList* dl, int tx, int ty, ImU32 col, ImU32 fill,
                          float camX, float camY, float angleRad, float zoom,
                          float cx, float cy)
{
    const float x0 = static_cast<float>(tx), y0 = static_cast<float>(ty);
    ImVec2 pts[4];
    const float corners[4][2] = { {0.f,0.f}, {1.f,0.f}, {1.f,1.f}, {0.f,1.f} };
    for (int i = 0; i < 4; ++i) {
        float sx, sy;
        if (!W2S(x0 + corners[i][0], y0 + corners[i][1], sx, sy,
                 camX, camY, angleRad, zoom, cx, cy)) return;
        pts[i] = ImVec2(sx, sy);
    }
    if ((fill >> IM_COL32_A_SHIFT) != 0u) dl->AddConvexPolyFilled(pts, 4, fill);
    dl->AddPolyline(pts, 4, col, ImDrawFlags_Closed, 1.5f);
}

static int s_lastAoeDrawn = 0;
static int s_aoeHooks = 0;

void RenderDebugPath(float camX, float camY, float angleRad, float zoom, float cx, float cy)
{
    if (!g_debugDraw || !g_autoNexus) return;
    ImDrawList* dl = ImGui::GetForegroundDrawList();
    if (!dl) return;

    const ImU32 colSafe = IM_COL32(60, 220, 90, 190);
    const ImU32 colHit  = IM_COL32(255, 60, 60, 235);

    if (g_gvMotion) {
        const float nowX = g_gvNowX, nowY = g_gvNowY;
        const float endX = g_gvEndX, endY = g_gvEndY;
        const float vx = g_gvVx, vy = g_gvVy;

        if (g_gvTiles) {
            const int nT = (g_gvTileCount < kMaxGroundVizTiles)
                         ? g_gvTileCount : kMaxGroundVizTiles;
            for (int i = 0; i < nT; ++i) {
                const bool hot = g_gvTileDmg[i] > 0;
                const ImU32 tc = hot ? IM_COL32(255, 90, 50, 225)
                                     : IM_COL32(150, 150, 150, 120);
                const ImU32 tf = hot ? IM_COL32(255, 90, 50, 45)
                                     : IM_COL32(150, 150, 150, 16);
                DrawWorldTile(dl, g_gvTileX[i], g_gvTileY[i], tc, tf,
                              camX, camY, angleRad, zoom, cx, cy);
                float lx, ly;
                if (hot && W2S(static_cast<float>(g_gvTileX[i]) + 0.5f,
                               static_cast<float>(g_gvTileY[i]) + 0.5f,
                               lx, ly, camX, camY, angleRad, zoom, cx, cy)) {
                    char dlbl[16];
                    std::snprintf(dlbl, sizeof(dlbl), "%d", g_gvTileDmg[i]);
                    dl->AddText(ImVec2(lx - 6.f, ly - 6.f), tc, dlbl);
                }
            }
        }

        float psx, psy, gsx, gsy;
        const bool haveNow = W2S(nowX, nowY, psx, psy, camX, camY, angleRad, zoom, cx, cy);
        const bool haveEnd = W2S(endX, endY, gsx, gsy, camX, camY, angleRad, zoom, cx, cy);
        if (haveNow && haveEnd)
            dl->AddLine(ImVec2(psx, psy), ImVec2(gsx, gsy), IM_COL32(255, 255, 255, 160), 1.5f);

        DrawWorldCircle(dl, nowX, nowY, 0.5f, IM_COL32(255, 255, 255, 220), 1.5f,
                        IM_COL32(0, 0, 0, 0), camX, camY, angleRad, zoom, cx, cy);
        DrawWorldCircle(dl, endX, endY, 0.5f, IM_COL32(120, 220, 255, 235), 2.f,
                        IM_COL32(120, 220, 255, 30), camX, camY, angleRad, zoom, cx, cy);

        DrawWorldCircle(dl, g_gvFieldEndX, g_gvFieldEndY, 0.35f,
                        IM_COL32(220, 110, 220, 130), 1.f, IM_COL32(0, 0, 0, 0),
                        camX, camY, angleRad, zoom, cx, cy);
    }

    // ── AOE landing zones ────────────────────────────────────────────────
    // This does not work. I wish it did. If anyone knows why, please help, I think
    // the function name / offsets are wrong. 
    {
        static ULONGLONG s_lastEnsureMs = 0;
        const ULONGLONG ensureNow = GetTickCount64();
        if (ensureNow - s_lastEnsureMs >= 500ULL) {
            s_lastEnsureMs = ensureNow;
            AoeTracking::EnsureInstalled();
        }
        s_lastAoeDrawn = 0;
        s_aoeHooks = AoeTracking::CountHooks();

        static std::vector<WorldAoe> s_aoes;
        s_aoes.clear();
        if (s_aoeHooks > 0) AoeTracking::CopyActiveForDraw(s_aoes);

        const ULONGLONG now = GetTickCount64();
        for (const WorldAoe& a : s_aoes) {
            if (!a.valid || !a.isDamaging) continue;
            if (a.isEnemyChecked && !a.isEnemy) continue;
            if (!std::isfinite(a.destX) || !std::isfinite(a.destY)) continue;

            const float radius = (std::isfinite(a.radius) && a.radius > 0.f)
                               ? std::min(a.radius, 12.f) : 1.5f;
            const float elapsed = static_cast<float>(now > a.spawnTick ? now - a.spawnTick : 0ULL);
            
            const float landAtMs  = (std::isfinite(a.arcMs) && a.arcMs > 0.f)
                                  ? a.arcMs
                                  : ((std::isfinite(a.lifetime) && a.lifetime > 0.f) ? a.lifetime : 2000.f);
            const float landingMs = landAtMs - elapsed;

            ImU32 col, fill;
            if (landingMs > 0.f) {
                const float urgency = 1.f - std::min(1.f, landingMs / std::max(1.f, landAtMs));
                const int   alpha   = 90 + static_cast<int>(140.f * urgency);
                col  = IM_COL32(255, 165, 30, alpha);
                fill = IM_COL32(255, 165, 30, 28);
            } else {
                col  = IM_COL32(255, 70, 40, 235);
                fill = IM_COL32(255, 70, 40, 45);
            }
            DrawWorldCircle(dl, a.destX, a.destY, radius, col, 2.f, fill,
                            camX, camY, angleRad, zoom, cx, cy);
            ++s_lastAoeDrawn;

            float lx, ly;
            if (landingMs > 0.f && W2S(a.destX, a.destY, lx, ly, camX, camY, angleRad, zoom, cx, cy)) {
                char lbl[24];
                std::snprintf(lbl, sizeof(lbl), "%.0fms", landingMs);
                dl->AddText(ImVec2(lx + 6.f, ly + 4.f), col, lbl);
            }
        }
    }

    const int count = (g_vizCount < kMaxVizProjs) ? g_vizCount : kMaxVizProjs;
    for (int p = 0; p < count; ++p) {
        const int n = g_vizLen[p];
        if (n < 2) continue;
        const ImU32 col = g_vizHit[p] ? colHit : colSafe;
        const int base = p * kVizSamples;
        float lastSx = 0.f, lastSy = 0.f;
        bool  haveLast = false;
        for (int i = 0; i < n; ++i) {
            float sx, sy;
            if (!W2S(g_vizX[base + i], g_vizY[base + i], sx, sy,
                     camX, camY, angleRad, zoom, cx, cy)) { haveLast = false; continue; }
            if (haveLast) dl->AddLine(ImVec2(lastSx, lastSy), ImVec2(sx, sy), col, 1.5f);
            if (i == 0) dl->AddCircleFilled(ImVec2(sx, sy), 3.f, col);
            lastSx = sx; lastSy = sy; haveLast = true;
        }
    }
}

void Render()
{
    ImGui::TextColored(ImVec4(0.4f, 0.8f, 1.f, 1.f), "AUTO NEXUS");
    ImGui::TextDisabled("Configured entirely from the client plugin.\n"
                        "This panel is a read-out of the live scan state.");
    ImGui::Separator();

    ImGui::Text("Scan:      %s", g_autoNexus ? "armed" : "idle");
    if (g_autoNexus) {
        ImGui::Indent();
        ImGui::TextDisabled("Horizon:   %.0f ms", g_predTimeMs);
        ImGui::TextDisabled("Bullets:   %s", g_nexusProjDmg ? "on" : "off");
        ImGui::TextDisabled("Ground:    %s", g_nexusTileDmg ? "on" : "off");
        ImGui::TextDisabled("Overlay:   %s", g_debugDraw ? "on" : "off");
        if (g_debugDraw) {
            // The counters the corner HUD used to carry. An empty overlay and a
            // broken one look identical on screen; these tell them apart.
            ImGui::TextDisabled("  paths %d   aoe %d   aoeHooks %d",
                                g_vizCount, s_lastAoeDrawn, s_aoeHooks);
        }
        ImGui::TextDisabled("Hitbox:    DodgeHit %.4f player half", DodgeHit::kPlayerHalf);

        if (LocalPlayer::GetPtr()) {
            const int32_t hp    = LocalPlayer::GetHP();
            const int32_t maxHp = LocalPlayer::GetMaxHP();
            if (maxHp > 0 && hp > 0)
                ImGui::TextDisabled("HP:        %d / %d  (%.0f%%)", hp, maxHp,
                    static_cast<float>(hp) / static_cast<float>(maxHp) * 100.f);
        } else {
            ImGui::TextDisabled("HP:        no local player");
        }
        ImGui::Unindent();
    }
}

bool ConsumesLocalPlayer()
{
    return g_autoNexus;
}

bool OverlayEnabled()
{
    return g_autoNexus && g_debugDraw;
}

// ── Public setters (called from FeatureCommandRegistry) ─────────────────
void SetAutoNexusEnabled(bool on)            { g_autoNexus = on; }
void SetAutoNexusProjPredictEnabled(bool on) { g_nexusProjDmg = on; }
void SetAutoNexusTilePredictEnabled(bool on) { g_nexusTileDmg = on; }
void SetAutoNexusPredictedTimeMs(float ms)   { g_predTimeMs = std::max(0.f, std::min(kMaxHorizonMs, ms)); }
void SetAutoNexusDebugDraw(bool on)          { g_debugDraw = on; }

} // namespace FeatAutoNexus
} // namespace CombatTAB
