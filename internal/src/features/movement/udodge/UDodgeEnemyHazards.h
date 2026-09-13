#pragma once
#include "UDodgeTypes.h"
#include <cstdint>

namespace UDodge { namespace EnemyHazards {
// Enemy-centred avoidance policy, not a detected explosion or damage estimate.
//
// Some attacks give the dodge no time at all: damage that starts ON the enemy
// with no travel and no telegraph. A projectile or a thrown bomb can be seen and
// dodged; a blast centred on an enemy the player is standing next to lands the
// same instant the danger becomes visible. The only defence is to keep out of
// that radius around every living enemy that attacks this way.
//
// Two sources feed the keep-out:
//   1. HARD-CODED: GC Mushroom Slammer Melee / Melee E (DisplayId Mushroom
//      Brawler, 0xb2a9 / 0xb502). objects.xml gives it no <Projectile> at all —
//      its attack is a server AOE centred on itself. User-supplied RealmEye
//      reference: successive self blasts, maximum radius 3.
//   2. LEARNED from the game's own data, so every enemy with the same attack
//      shape is covered without naming it (see ObserveBlast / ObserveStationaryShot):
//        • an AOE packet whose centre sits on a living enemy of the packet's own
//          originType, with no throw/landing telegraph near it — a self blast;
//        • a projectile that does not move and was spawned on its owner — a
//          stationary damage field around the enemy (e.g. setpiece towers whose
//          projectile has <Speed>0</Speed>).
//      The learned radius is the observed blast radius (or the projectile's
//      contact half, circumscribed), capped so a misread cannot wall off a map.
//
// The normal player footprint is added by the zone math. Never publish this
// policy to Auto Nexus as damage.
constexpr float kHardcodedBrawlerRadius = 3.35f;
constexpr float kLearnedMarginTiles     = 0.35f;  // same margin the Brawler radius carries over its 3-tile blast
constexpr float kLearnedMaxRadiusTiles  = 6.0f;   // cap: a misread must not wall off a room
constexpr float kLearnedMinRadiusTiles  = 0.3f;
constexpr float kSelfCentreTiles        = 1.0f;   // blast centre within this of the enemy = "on the enemy"
constexpr float kTelegraphReachTiles    = 1.0f;   // a telegraph landing this close (plus radius) warned of the blast
constexpr int   kMaxLearned             = 64;

struct Learned { int objectType = 0; float radius = 0.f; };

// Game-update thread only (Sensors::RebuildZones / BuildMap) — no locking.
struct LearnedTable {
    Learned entries[kMaxLearned]{};
    int     count = 0;
};
inline LearnedTable& Table() { static LearnedTable t; return t; }

inline float LearnedRadius(int objectType)
{
    const LearnedTable& t = Table();
    for (int i = 0; i < t.count; ++i)
        if (t.entries[i].objectType == objectType) return t.entries[i].radius;
    return 0.f;
}

// Records (or widens) a learned keep-out. Returns true when the table changed.
inline bool Learn(int objectType, float radius)
{
    if (objectType <= 0 || !std::isfinite(radius)) return false;
    radius = std::clamp(radius, kLearnedMinRadiusTiles, kLearnedMaxRadiusTiles);
    LearnedTable& t = Table();
    for (int i = 0; i < t.count; ++i) {
        if (t.entries[i].objectType != objectType) continue;
        if (radius <= t.entries[i].radius) return false;
        t.entries[i].radius = radius;
        return true;
    }
    if (t.count >= kMaxLearned) return false;
    t.entries[t.count++] = Learned{ objectType, radius };
    return true;
}

inline void ClearLearned() { Table() = LearnedTable{}; }

inline float KeepoutRadius(int objectType)
{
    if (objectType == 0xb2a9 || objectType == 0xb502) return kHardcodedBrawlerRadius;
    const float learned = LearnedRadius(objectType);
    return learned > 0.f ? learned + kLearnedMarginTiles : 0.f;
}

// `hp` > 0 means "alive". Invulnerable scenery that reports no HP passes 1.
inline bool Append(DangerMap& map, int objectType, int hp, Vec2 position, Vec2 player)
{
    const float radius = KeepoutRadius(objectType);
    if (hp <= 0 || radius <= 0.f || !std::isfinite(position.x) || !std::isfinite(position.y)
        || LenSq(Sub(position, player)) > (16.f + radius) * (16.f + radius)) return false;
    if (map.zoneCount >= kMaxAoes) { map.limited = true; return false; }
    ZoneThreat& zone = map.zones[map.zoneCount++];
    zone.pos = position;
    zone.radius = radius;
    zone.active = true;
    return true;
}

// ── Learning (pure classifiers; the caller supplies the world) ──────────────
struct EnemyRef     { int objectType = 0; Vec2 pos{}; };
struct TelegraphRef { Vec2 landing{}; float ageMs = 0.f; };   // throw / landing-circle warnings seen recently

// A server AOE of `radius` at `centre`, attributed to `originType`. It is a SELF
// blast when a living enemy of that type stands on its centre and no telegraph
// landed near it in the preceding window. Thrown bombs are telegraphed (throw
// visual / landing circle) and aimed at the player, so they are not learned.
inline bool IsUnwarnedSelfBlast(Vec2 centre, float radius, int originType,
                                const EnemyRef* enemies, int enemyCount,
                                const TelegraphRef* telegraphs, int telegraphCount)
{
    if (originType <= 0 || !std::isfinite(radius) || radius <= 0.f) return false;
    for (int i = 0; i < telegraphCount; ++i) {
        const float reach = radius + kTelegraphReachTiles;
        if (LenSq(Sub(telegraphs[i].landing, centre)) <= reach * reach) return false;
    }
    for (int i = 0; i < enemyCount; ++i) {
        if (enemies[i].objectType != originType) continue;
        if (LenSq(Sub(enemies[i].pos, centre)) <= kSelfCentreTiles * kSelfCentreTiles) return true;
    }
    return false;
}

inline bool ObserveBlast(Vec2 centre, float radius, int originType,
                         const EnemyRef* enemies, int enemyCount,
                         const TelegraphRef* telegraphs, int telegraphCount)
{
    if (!IsUnwarnedSelfBlast(centre, radius, originType, enemies, enemyCount, telegraphs, telegraphCount))
        return false;
    return Learn(originType, radius);
}

// A traced lane that never moves (every sample within 0.05 tiles of the live
// position) and sits on its owner is a stationary damage field on that enemy.
// Its keep-out is the contact half circumscribed (Chebyshev box → disc).
inline bool IsStationaryLane(const LaneThreat& lane)
{
    if (lane.beam || lane.pointCount < 2) return false;
    for (int i = 1; i < lane.pointCount; ++i)
        if (LenSq(Sub(lane.points[i], lane.points[0])) > 0.05f * 0.05f) return false;
    return true;
}

inline bool ObserveStationaryShot(const LaneThreat& lane, int ownerType, Vec2 ownerPos)
{
    if (ownerType <= 0 || !IsStationaryLane(lane)) return false;
    if (LenSq(Sub(ownerPos, lane.points[0])) > kSelfCentreTiles * kSelfCentreTiles) return false;
    return Learn(ownerType, std::clamp(lane.hitHalf, 0.05f, 2.5f) * 1.41421356f);
}
} }
