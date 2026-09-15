// UDodge scenario harness — drives the PRODUCTION UDodge::Tick, worker cycle,
// grid pathfinder, solver and route follower through synthetic worlds, and
// measures whether the player actually gets where it was sent.
//
// What is real and what is modelled:
//   REAL (compiled from the tree under test): UDodge.cpp (Tick, nav cache, re-plan
//     triggers, FillNavGrid/FillOccGrid), UDodgePathfinder.cpp, UDodgeSolver.cpp,
//     UDodgeCore.cpp, SpacetimeCore.cpp, TileSensor.cpp (the live CanOccupy),
//     UDodgeNavigation.h, UDodgeEnemyHazards.h.
//   REPLICATED from IL2CPP-bound code (kept line-for-line where noted):
//     WorldTAB RebuildBlockedMap / CopyBoxBlocked, TestTAB IsPositionBlocked /
//     IsCircleBlocked, Sensors::CanOccupy's footprint corners, the worker loop
//     body. When the tree carries the shared pure headers (TileOccupancy.h,
//     UDodgeWorkerCycle.h) the harness uses those instead of its copies.
//   MODELLED: the game. Movement truth is "the XML says so": NoWalk squares and
//     occupying objects block the player's 0.2285 box, FullOccupy objects apply
//     the Flash isValidPosition half-tile rule, sink squares slow the player by
//     their Speed, and a refused step slides along one axis (with the Flash
//     half-tile border snap) like the game's move code. Bullets fly straight.
//
// Output: one JSON object per scenario on stdout.
#include "pch-il2cpp.h"
#include "UDodge.h"
#include "UDodgeTypes.h"
#include "UDodgeCore.h"
#include "UDodgePathfinder.h"
#include "UDodgeSolver.h"
#include "UDodgeWorker.h"
#include "UDodgeSensors.h"
#include "UDodgeDebug.h"
#include "UDodgeEnemyHazards.h"
#include "UDodgeTimedPlanner.h"
#include "MovementRuntime.h"
#include "features/movement/dodge/MovementSpeed.h"
#if __has_include("features/movement/nav/Runtime.h")
#include "features/movement/nav/Runtime.h"
#define HARNESS_GLOBAL_NAVIGATOR 1
#endif
#include "DangerPlanner.h"
#include "features/combat/autoaim/modes/AutoAim.h"
#include "features/combat/enemytracker/EnemyTracker.h"
#if __has_include("features/combat/enemytracker/LockLiveness.h")
#include "features/combat/enemytracker/LockLiveness.h"
#define HARNESS_LOCK_LIVENESS 1
#endif
#include "gui/tabs/TestTAB.h"
#include "gui/tabs/WorldTAB.h"
#include "features/movement/sensors/TileSensor.h"
#if __has_include("features/movement/sensors/TileOccupancy.h")
#include "features/movement/sensors/TileOccupancy.h"
#define HARNESS_SHARED_OCCUPANCY 1
#endif
#if __has_include("features/movement/nav/Collision.h")
#include "features/movement/nav/Collision.h"
#define HARNESS_NAV_FOUNDATION 1   // navigation rebuild Stage 1: collision rule, speed layer
#endif
#if __has_include("UDodgeWorkerCycle.h")
#include "UDodgeWorkerCycle.h"
#define HARNESS_SHARED_WORKER_CYCLE 1
#endif

#include <cmath>
#include <functional>
#include <random>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

using namespace UDodge;

// ─────────────────────────────────────────────────────────────────────────────
// Simulated clock and world
// ─────────────────────────────────────────────────────────────────────────────
namespace H {

double   g_nowMs = 100000.0;   // non-zero: several production timers treat 0 as "unset"
uint64_t g_frame = 0;

struct Ground { bool noWalk = false, sink = false, push = false; float speed = 0.f; int damage = 0; };
struct Obj    { int tx = 0, ty = 0; bool occ = false, full = false, enemyOcc = false; };
struct Enemy  { int id = 0, type = 0; float x = 0.f, y = 0.f; int hp = 1000, maxHp = 1000;
                bool healthBar = true, scenery = false, invuln = false;
                float shotRange = 0.f; };   // longest projectile reach of the type (EnemyTracker::Entry)
struct Bullet { double t0 = 0; float x0 = 0, y0 = 0, vx = 0, vy = 0; float lifeMs = 0, half = 0.4f;
                int owner = 0, id = 0; bool alive = true; };

inline uint32_t Key(int tx, int ty)
{
    return (static_cast<uint32_t>(static_cast<uint16_t>(tx)) << 16) |
            static_cast<uint32_t>(static_cast<uint16_t>(ty));
}
inline int FloorI(float v) { return static_cast<int>(std::floor(v)); }

struct World {
    std::unordered_map<uint32_t, Ground> tiles;   // absent = never streamed (void)
    std::unordered_map<uint32_t, Obj>    objs;
    std::unordered_map<uint32_t, Obj>    hiddenObjs;   // block the player but never reach the DLL's view
    std::vector<uint32_t> streamOrder;            // tile list order (append on stream)
    std::vector<Enemy>  enemies;
    std::vector<Bullet> bullets;
    uint32_t bulletVersion = 0;
    int      nextBulletId = 1;
    float px = 0, py = 0;
    float tps = 6.0f;                             // base tiles/s (SPD ~35)
    bool  speedy = false;                         // Speedy condition: x1.5, confirmed by the game's getter
    bool  slowed = false;                         // Slowed condition: the game pins MIN_MOVE_SPEED
    bool  paralyzed = false;                      // Paralyzed / Stasis / Petrified: no movement at all
    uint32_t extraHits = 0;                       // damage the script dealt outside bullets (self blasts)
    int   watchId = 0;                            // enemy whose closest approach is recorded
    float watchMinDist = 1e9f;
    int32_t lockId = 0;
    bool  walkActive = false;
    float walkX = 0, walkY = 0;
    float weaponRange = 7.0f;
    std::function<void(World&)> script;           // per-frame scenario behaviour

    void SetGround(int tx, int ty, Ground g)
    {
        const uint32_t k = Key(tx, ty);
        if (!tiles.count(k)) streamOrder.push_back(k);
        tiles[k] = g;
    }
    const Ground* GroundAt(int tx, int ty) const
    {
        auto it = tiles.find(Key(tx, ty));
        return it == tiles.end() ? nullptr : &it->second;
    }
    const Obj* ObjAt(int tx, int ty) const
    {
        auto it = objs.find(Key(tx, ty));
        return it == objs.end() ? nullptr : &it->second;
    }
    void Fill(int x0, int y0, int x1, int y1, Ground g)
    {
        for (int y = y0; y <= y1; ++y) for (int x = x0; x <= x1; ++x) SetGround(x, y, g);
    }
    void PutObj(int tx, int ty, bool full, bool occ = true)
    {
        Obj o; o.tx = tx; o.ty = ty; o.full = full; o.occ = occ; o.enemyOcc = full;
        objs[Key(tx, ty)] = o;
    }
    void Fire(float x, float y, float angle, float tilesPerSec, float lifeMs, float half, int owner)
    {
        Bullet b;
        b.t0 = g_nowMs; b.x0 = x; b.y0 = y;
        b.vx = std::cos(angle) * tilesPerSec / 1000.f;
        b.vy = std::sin(angle) * tilesPerSec / 1000.f;
        b.lifeMs = lifeMs; b.half = half; b.owner = owner; b.id = nextBulletId++;
        bullets.push_back(b);
        ++bulletVersion;
    }
};

World* g_world = nullptr;

// ── "Game truth" collision (modelled) ───────────────────────────────────────
// The game's walkability test is a POINT test (86ad651b HJMBOMEHGDJ::PEGDEDNHEHD,
// reached from FKALGHJIADI::CJCEGCEMIGE, the move routine): the centre's square must
// be walkable with no occupySquare object, then the FullOccupy half-tile rule at 0.5.
// There is no player box — no 0.2285 constant exists anywhere in GameAssembly. The
// DLL's own occupancy keeps its 0.2285 box as a margin; the truth does not.
// kGameHalf remains for the self-blast reach test (a body-sized contact margin).
constexpr float kGameHalf = 0.2285f;
constexpr float kGameCollisionHalf = 0.f;

bool TruthSquareOpen(const World& w, int tx, int ty)
{
    const Ground* g = w.GroundAt(tx, ty);
    if (!g || g->noWalk) return false;               // XML NoWalk is authoritative
    const Obj* o = w.ObjAt(tx, ty);
    if (o && (o->occ || o->full || o->enemyOcc)) return false;
    if (w.hiddenObjs.count(Key(tx, ty))) return false;
    return true;
}
bool TruthFull(const World& w, int tx, int ty)
{
    const Obj* o = w.ObjAt(tx, ty);
    return o && o->full;
}
bool TruthValid(const World& w, float x, float y)
{
    for (int tx = FloorI(x - kGameCollisionHalf); tx <= FloorI(x + kGameCollisionHalf); ++tx)
        for (int ty = FloorI(y - kGameCollisionHalf); ty <= FloorI(y + kGameCollisionHalf); ++ty)
            if (!TruthSquareOpen(w, tx, ty)) return false;
    // Flash Player.isValidPosition section B (the FullOccupy half-tile rule).
    const int tx = FloorI(x), ty = FloorI(y);
    const float fx = x - static_cast<float>(tx), fy = y - static_cast<float>(ty);
    auto fo = [&](int a, int b) { return TruthFull(w, a, b); };
    if (fx < 0.5f) {
        if (fo(tx - 1, ty)) return false;
        if      (fy < 0.5f) { if (fo(tx, ty - 1) || fo(tx - 1, ty - 1)) return false; }
        else if (fy > 0.5f) { if (fo(tx, ty + 1) || fo(tx - 1, ty + 1)) return false; }
    } else if (fx > 0.5f) {
        if (fo(tx + 1, ty)) return false;
        if      (fy < 0.5f) { if (fo(tx, ty - 1) || fo(tx + 1, ty - 1)) return false; }
        else if (fy > 0.5f) { if (fo(tx, ty + 1) || fo(tx + 1, ty + 1)) return false; }
    } else {
        if      (fy < 0.5f) { if (fo(tx, ty - 1)) return false; }
        else if (fy > 0.5f) { if (fo(tx, ty + 1)) return false; }
    }
    return true;
}
float TruthSpeedMul(const World& w, float x, float y)
{
    const Ground* g = w.GroundAt(FloorI(x), FloorI(y));
    return (g && g->speed > 0.f) ? g->speed : 1.f;
}
// The game's own move speed (86ad651b FKALGHJIADI::GAFGPNKFMOJ): Slowed pins
// MIN_MOVE_SPEED (4 tiles/s) before the SPD curve, then the square's speed applies.
float TruthTilesPerSec(const World& w, float x, float y)
{
    if (w.paralyzed) return 0.f;
    return (w.slowed ? 4.f : w.tps * (w.speedy ? 1.5f : 1.f)) * TruthSpeedMul(w, x, y);
}
// Server SPD that yields a base tiles/s on the game's curve (4 + 5.6 * SPD / 75).
int TruthSpd(const World& w) { return static_cast<int>(std::lround((w.tps - 4.f) / 5.6f * 75.f)); }

// One refused axis snaps to the half-tile border it was crossing (Flash
// modifyStep), so a player can settle onto a FullOccupy corridor's centre line.
float SnapAxis(float from, float to)
{
    const float lo = std::min(from, to), hi = std::max(from, to);
    const float border = std::floor(hi * 2.f) / 2.f;
    return (border >= lo && border <= hi) ? border : from;
}

struct MoveStats { uint32_t calls = 0, refused = 0, overspeed = 0; double refusedTiles = 0, maxStepRatio = 0; };
MoveStats g_move;

Vec2 TruthMove(const World& w, Vec2 from, Vec2 to)
{
    const Vec2 d = Sub(to, from);
    const float len = Len(d);
    if (len < 1e-6f) return from;
    const int steps = std::max(1, static_cast<int>(std::ceil(len / 0.05f)));
    Vec2 cur = from;
    const Vec2 step = Mul(d, 1.f / static_cast<float>(steps));
    for (int i = 0; i < steps; ++i) {
        const Vec2 full = Add(cur, step);
        if (TruthValid(w, full.x, full.y)) { cur = full; continue; }
        const bool xFirst = std::fabs(step.x) >= std::fabs(step.y);
        bool moved = false;
        for (int pass = 0; pass < 2 && !moved; ++pass) {
            const bool doX = (pass == 0) == xFirst;
            Vec2 c = doX ? Vec2{ full.x, cur.y } : Vec2{ cur.x, full.y };
            if ((doX ? std::fabs(step.x) : std::fabs(step.y)) > 1e-7f && TruthValid(w, c.x, c.y)) {
                cur = c; moved = true; break;
            }
            // Border snap on the other axis, then retry this axis.
            Vec2 s = doX ? Vec2{ full.x, SnapAxis(cur.y, full.y) } : Vec2{ SnapAxis(cur.x, full.x), full.y };
            if (TruthValid(w, s.x, s.y) && LenSq(Sub(s, cur)) > 1e-10f) { cur = s; moved = true; }
        }
        if (!moved) break;
    }
    return cur;
}

// ── WorldTAB view (what the DLL believes) ───────────────────────────────────
enum : uint8_t { kKnown = 0x01, kBlocked = 0x02, kFullOcc = 0x04, kDamaging = 0x08, kSink = 0x10 };
std::unordered_map<uint32_t, uint8_t> g_view;
std::unordered_map<uint32_t, float> g_viewSpeed;   // WorldTAB s_tileSpeedMap
std::vector<uint32_t> g_fullOccKeys;   // WorldTAB s_fullOccKeys
// 0 = every tile; 1 = first 65536 (pre-#70); 2 = newest 65536 + 128 window (#70);
// 3 = every entry inside the 128 window, wherever it sits in the list (SquareCoordCache)
int g_tileScanMode = 0;

void RebuildView(const World& w)
{
    g_view.clear();
    g_viewSpeed.clear();
    g_fullOccKeys.clear();
    const size_t cap = 65536;
    const size_t n = w.streamOrder.size();
    size_t first = 0, last = n;
    if (g_tileScanMode == 1) last = std::min(n, cap);
    if (g_tileScanMode == 2) first = n > cap ? n - cap : 0;
    const int cx = FloorI(w.px), cy = FloorI(w.py);
    for (size_t i = first; i < last; ++i) {
        const uint32_t k = w.streamOrder[i];
        const int tx = static_cast<int16_t>(k >> 16), ty = static_cast<int16_t>(k & 0xFFFF);
        if ((g_tileScanMode == 2 || g_tileScanMode == 3) &&
            (std::abs(tx - cx) > 128 || std::abs(ty - cy) > 128)) continue;
        const Ground& g = w.tiles.at(k);
        uint8_t& f = g_view[k];
        f |= kKnown;
        if (g.speed != 0.f) g_viewSpeed[k] = g.speed;
#ifdef HARNESS_SHARED_OCCUPANCY
        f |= Movement::TileOccupancy::GroundFlags(g.noWalk, g.push, g.speed, g.sink, g.damage > 0);
#else
        // Line-for-line WorldTAB::RebuildBlockedMap (before any fix).
        bool isNoWalk = g.noWalk;
        if (g.speed != 0.f || g.push) isNoWalk = false;
        if (isNoWalk) f |= kBlocked;
        if (g.damage > 0) f |= kDamaging;
        if (g.sink) f |= kSink;
#endif
    }
    for (const auto& kv : w.objs) {
        const Obj& o = kv.second;
        if (o.occ || o.full || o.enemyOcc) g_view[kv.first] |= kBlocked;
        if (o.full) {
            g_view[kv.first] |= kFullOcc;
            g_fullOccKeys.push_back(kv.first);
        }
    }
}
uint8_t ViewFlags(int tx, int ty)
{
    auto it = g_view.find(Key(tx, ty));
    return it == g_view.end() ? 0 : it->second;
}

// ── Sensors ─────────────────────────────────────────────────────────────────
Movement::TileSensor::HazardMemo g_memo;
uint32_t g_mapBulletVersion = 0;

std::vector<EnemyTracker::Entry> g_snapshot;   // EnemyTracker::GetSnapshot (RefreshSnapshot fills it)

void FillDanger(DangerMap& out, float playerX, float playerY, const Settings& s)
{
    const World& w = *g_world;
    out.laneCount = 0; out.zoneCount = 0; out.enemyCount = 0;
    out.projectileSourceUnavailable = false; out.limited = false;
    out.hasLock = false; out.lockId = 0; out.lockPos = {};
    for (const Bullet& b : w.bullets) {
        if (!b.alive) continue;
        const float age = static_cast<float>(g_nowMs - b.t0);
        const float rem = b.lifeMs - age;
        if (rem <= 0.f || out.laneCount >= kMaxProjectiles) continue;
        const Vec2 live{ b.x0 + b.vx * age, b.y0 + b.vy * age };
        if (LenSq(Sub(live, { playerX, playerY })) > 16.f * 16.f) continue;
        LaneThreat& L = out.lanes[out.laneCount++];
        L = LaneThreat{};
        L.bulletId = b.id; L.ownerObjId = static_cast<uint32_t>(b.owner); L.attackerObjId = b.owner;
        L.hitHalf = b.half; L.remainingLifeMs = rem;
        L.hasLinearMotion = true; L.linearVelocity = { b.vx, b.vy };
        float t = 0.f;
        for (;;) {
            const float tt = std::min(t, rem);
            L.pointTimesMs[L.pointCount] = tt;
            L.points[L.pointCount++] = { live.x + b.vx * tt, live.y + b.vy * tt };
            if (tt >= rem) { L.tailAtShotEnd = true; break; }
            if (tt >= kLaneCoverMs || L.pointCount >= kMaxLanePoints) break;
            t += kTraceStepMs;
        }
        // UDodgeSensors SetInstantSpan (paint span = laneTiles).
        L.instantCount = 1;
        float len = 0.f;
        for (int i = 1; i < L.pointCount; ++i) {
            len += Len(Sub(L.points[i], L.points[i - 1]));
            L.instantCount = i + 1;
            if (len >= s.laneTiles) break;
        }
    }
    const int32_t lock = w.lockId;
    for (const Enemy& e : w.enemies) {
        if (e.hp <= 0) continue;
        if (LenSq(Sub({ e.x, e.y }, { playerX, playerY })) <= 16.f * 16.f && out.enemyCount < kMaxEnemies) {
            EnemyBlocker& b = out.enemies[out.enemyCount++];
            b.pos = { e.x, e.y };
            b.radius = (!e.healthBar || e.scenery) ? 0.5f : 0.8f;
            b.passiveScenery = !e.healthBar || e.scenery;
        }
#ifndef HARNESS_LOCK_LIVENESS
        if (lock != 0 && e.id == lock) { out.hasLock = true; out.lockId = e.id; out.lockPos = { e.x, e.y }; }
#endif
        // RebuildZones: enemy-centred keep-outs (hard-coded Brawler, plus learned ones where the tree has them).
#ifdef HARNESS_TREE_BURST
        EnemyHazards::Append(out, e.type, (e.hp > 0 || e.invuln) ? 1 : 0, { e.x, e.y }, { playerX, playerY },
                             (lock != 0 && e.id == lock) ? 0.f : e.shotRange);
#elif defined(HARNESS_TREE_POST70)
        EnemyHazards::Append(out, e.type, (e.hp > 0 || e.invuln) ? 1 : 0, { e.x, e.y }, { playerX, playerY });
#else
        EnemyHazards::Append(out, e.type, e.hp, { e.x, e.y }, { playerX, playerY });
#endif
    }
#ifdef HARNESS_LOCK_LIVENESS
    // Line-for-line UDodgeSensors.cpp PopulateEnemies: the lock is EnemyTracker's answer.
    const EnemyTracker::LockInfo lockInfo = EnemyTracker::ResolveLock(g_snapshot, lock);
    if (EnemyTracker::Engages(lockInfo)) {
        out.hasLock = true; out.lockId = lockInfo.id; out.lockPos = { lockInfo.x, lockInfo.y };
    }
#endif
}

void RefreshSnapshot()
{
    g_snapshot.clear();
    for (const Enemy& e : g_world->enemies) {
        EnemyTracker::Entry en{};
        en.id = e.id; en.objType = e.type; en.x = e.x; en.y = e.y; en.hp = e.hp; en.maxHp = e.maxHp;
        en.isInvulnerable = e.invuln; en.hasHealthBar = e.healthBar; en.isScenery = e.scenery;
        en.shotRangeTiles = e.shotRange;
        g_snapshot.push_back(en);
    }
}

// ── Worker (synchronous; result visible one frame after publish) ────────────
struct WorkerStats { uint32_t cycles = 0; double navMsSum = 0, navMsMax = 0, dodgeMsSum = 0, dodgeMsMax = 0;
                     uint32_t navRuns = 0; double cycleMsSum = 0, cycleMsMax = 0;
                     uint32_t squareMismatches = 0; };   // game rule: worker squares that differ from the view
WorkerStats g_worker;
struct TickStats { uint32_t n = 0; double sum = 0, max = 0; };
TickStats g_tick;

} // namespace H

ULONGLONG HarnessNowMs() { return static_cast<ULONGLONG>(H::g_nowMs); }

// ─────────────────────────────────────────────────────────────────────────────
// Stub implementations of the IL2CPP-bound surface UDodge.cpp calls
// ─────────────────────────────────────────────────────────────────────────────
namespace DodgeRuntime {
bool  EnsureResolved() { return true; }
float GetDeltaTime() { return 1.f / 60.f; }
float GetMoveSpeedMul(void*) { return 1.f; }
float GetTilesPerSec(void*) { return H::g_world->tps; }
void  Reset() {}
bool  CallMoveTo(void*, float x, float y)
{
    H::World& w = *H::g_world;
    const Vec2 from{ w.px, w.py };
    const Vec2 to{ x, y };
    // The game's MoveTo does NOT clamp distance (86ad651b LKHPPBEGNOM::DGLCONCOIBO:
    // square lookup, position set, tile/collision update, return true). Whatever
    // step the dodge commands is the step the server sees, so every commanded step
    // is measured against what the game's own speed allows this frame.
    const float allowed = H::TruthTilesPerSec(w, w.px, w.py) / 60.f;
    const float len = Len(Sub(to, from));
    if (len > allowed * 1.02f + 1e-4f) ++H::g_move.overspeed;
    if (len > 1e-4f)
        H::g_move.maxStepRatio = std::max(H::g_move.maxStepRatio,
            allowed > 1e-6f ? static_cast<double>(len / allowed) : 1e9);
    const Vec2 got = H::TruthMove(w, from, to);
    ++H::g_move.calls;
    const float wanted = Len(Sub(to, from)), achieved = Len(Sub(got, from));
    if (wanted > 1e-4f && achieved < wanted * 0.5f) { ++H::g_move.refused; H::g_move.refusedTiles += wanted - achieved; }
    w.px = got.x; w.py = got.y;
    return achieved > 1e-5f;
}
FrameMove BeginMovementFrame(void*, float, float) { return FrameMove{}; }
void EndMovementFrame(void*) {}
}

namespace DangerPlanner {
void    SetWalkGoal(float x, float y) { H::g_world->walkActive = true; H::g_world->walkX = x; H::g_world->walkY = y; }
void    ClearWalkGoal() { H::g_world->walkActive = false; }
bool    GetWalkGoal(float& x, float& y, bool& a)
{
    a = H::g_world->walkActive;
    if (!a) return false;
    x = H::g_world->walkX; y = H::g_world->walkY;
    return true;
}
void    SetEnemyLock(int32_t id) { H::g_world->lockId = id; }
void    ClearEnemyLock() { H::g_world->lockId = 0; }
int32_t GetEnemyLock() { return H::g_world->lockId; }
void    ClearFollowPlayer() {}
int32_t GetFollowPlayer() { return 0; }
}

namespace AutoAim {
bool  IsProjRangeResolved() { return true; }
float GetProjRangeTiles() { return H::g_world->weaponRange; }
}

namespace EnemyTracker {
void Tick() {}
const std::vector<Entry>& GetSnapshot() { return H::g_snapshot; }
bool ResolveObjectPos(int32_t id, float& x, float& y)
{
    for (const auto& e : H::g_world->enemies) if (e.id == id) { x = e.x; y = e.y; return true; }
    return false;
}
}

namespace WorldTAB {
bool  IsTileBlocked(int tx, int ty) { return (H::ViewFlags(tx, ty) & H::kBlocked) != 0; }
bool  IsTileFullOccupied(int tx, int ty) { return (H::ViewFlags(tx, ty) & H::kFullOcc) != 0; }
bool  IsDamagingTile(int tx, int ty) { return (H::ViewFlags(tx, ty) & H::kDamaging) != 0; }
bool  IsTileDamagingLive(int tx, int ty) { return IsDamagingTile(tx, ty); }
float GetTileSpeed(int tx, int ty)
{
    auto it = H::g_viewSpeed.find(H::Key(tx, ty));
    return it == H::g_viewSpeed.end() ? 0.f : it->second;
}
unsigned char GetTileFlags(int tx, int ty) { return H::ViewFlags(tx, ty); }
#ifdef HARNESS_NAV_FOUNDATION
void CopyTileSpeeds(int tx0, int ty0, int side, float* out)   // line-for-line WorldTAB::CopyTileSpeeds
{
    for (int y = 0; y < side; ++y)
        for (int x = 0; x < side; ++x)
            out[y * side + x] = (H::ViewFlags(tx0 + x, ty0 + y) & Movement::TileOccupancy::kTileSpeedMod)
                ? GetTileSpeed(tx0 + x, ty0 + y) : 0.f;
}
#endif
void  CopyBoxBlocked(float originX, float originY, int side, float cellTiles,
                     float playerHalfEdge, bool foldHazard, unsigned char* out)
{
    if (!out || side <= 0) return;
#ifdef HARNESS_SHARED_OCCUPANCY
    // Line-for-line WorldTAB::CopyBoxBlocked (mask per raster).
    static Movement::TileOccupancy::NearFullOccupyMask nearFull;
    Movement::TileOccupancy::PrepareRasterMask(nearFull, H::g_fullOccKeys.data(), H::g_fullOccKeys.size(),
                                               originX, originY, side, cellTiles, playerHalfEdge);
#endif
    for (int gy = 0; gy < side; ++gy) {
        for (int gx = 0; gx < side; ++gx) {
            const float cx = originX + static_cast<float>(gx) * cellTiles;
            const float cy = originY + static_cast<float>(gy) * cellTiles;
#ifdef HARNESS_SHARED_OCCUPANCY
            out[gy * side + gx] = Movement::TileOccupancy::RasterCell(
                [](int tx, int ty) { return H::ViewFlags(tx, ty); }, nearFull, cx, cy, playerHalfEdge, foldHazard);
#else
            // Line-for-line WorldTAB::CopyBoxBlocked (before any fix).
            const int x0 = static_cast<int>(std::floor(cx - playerHalfEdge));
            const int x1 = static_cast<int>(std::floor(cx + playerHalfEdge));
            const int y0 = static_cast<int>(std::floor(cy - playerHalfEdge));
            const int y1 = static_cast<int>(std::floor(cy + playerHalfEdge));
            unsigned char f = 0;
            for (int tx = x0; tx <= x1; ++tx) {
                for (int ty = y0; ty <= y1; ++ty) {
                    const uint8_t tf = H::ViewFlags(tx, ty);
                    if ((tf & H::kKnown) == 0) { f |= 0x8; continue; }
                    if (tf & H::kBlocked) { f |= 0x1; continue; }
                    if (foldHazard && (tf & H::kDamaging)) { f |= 0x2; }
                    if (tf & H::kSink)                     { f |= 0x4; }
                }
                if (f & 0x1) break;
            }
            out[gy * side + gx] = f;
#endif
        }
    }
}
}

#ifdef HARNESS_GLOBAL_NAVIGATOR
namespace Movement { namespace Nav { namespace Runtime {
namespace {
MapMemory navigationMemory;
Router navigationRouter;
uint64_t navigationEpoch = 0;
uint64_t navigationGoal = 0;
size_t capturedSquares = 0;
bool goalActive = false;
RoutePoint previousGoal;
double navigationCycle = 0;
RouteCorridor navigationResult;
std::vector<float> navigationSpeeds{1.f};
constexpr float coordinateOffset = 512.f;
}
bool Enabled()
{
    const char* selected = std::getenv("HARNESS_NAVIGATOR");
    return selected && std::strcmp(selected, "dstar") == 0;
}
void SetNavigatorText(const char*) {}
void SetMapInfoText(const char*) {}
void SetScriptGoalText(const char*) {}
void NotifySceneReset() {}
void InvalidateGoal()
{
    if (!Enabled()) return;
    navigationMemory.Reset(++navigationEpoch, 2048, 2048);
    navigationRouter = Router{};
    capturedSquares = 0;
    goalActive = false;
    navigationCycle = 0;
    navigationResult = {};
    navigationSpeeds = {1.f};
}
void Start() {}
void Stop() {}
RouteCorridor Update(RoutePoint player, RoutePoint goal, float baseSpeed, bool active)
{
    if (!Enabled()) return {};
    if (!active) { goalActive = false; return {}; }
    const RoutePoint shiftedPlayer{player.worldX + coordinateOffset, player.worldY + coordinateOffset};
    const RoutePoint shiftedGoal{goal.worldX + coordinateOffset, goal.worldY + coordinateOffset};
    if (H::g_nowMs - navigationCycle < 100.0) return navigationResult;
    navigationCycle = H::g_nowMs;
    const auto& world = *H::g_world;
    while (capturedSquares < world.streamOrder.size()) {
        const auto key = world.streamOrder[capturedSquares++];
        const auto& ground = world.tiles.at(key);
        const int column = static_cast<int16_t>(key >> 16) + static_cast<int>(coordinateOffset);
        const int row = static_cast<int16_t>(key & 0xffff) + static_cast<int>(coordinateOffset);
        const float factor = Speed::TileFactor(ground.speed);
        auto found = std::find(navigationSpeeds.begin(), navigationSpeeds.end(), factor);
        if (found == navigationSpeeds.end()) { navigationSpeeds.push_back(factor); found = navigationSpeeds.end() - 1; }
        const auto speedClass = static_cast<uint8_t>(found - navigationSpeeds.begin());
        navigationMemory.ObserveGround(navigationEpoch, column, row,
            TileOccupancy::kTileKnown | TileOccupancy::GroundFlags(ground.noWalk, ground.push, ground.speed,
                ground.sink, ground.damage > 0), speedClass);
    }
    for (const auto& entry : world.objs) {
        const auto& object = entry.second;
        const uint8_t flags = static_cast<uint8_t>((object.occ || object.full || object.enemyOcc ? TileOccupancy::kTileBlocked : 0) |
            (object.full ? TileOccupancy::kTileFullOcc : 0));
        navigationMemory.ObserveStructure(navigationEpoch, object.tx + static_cast<int>(coordinateOffset),
            object.ty + static_cast<int>(coordinateOffset),
            {StructuralState::Present, ObservationSource::CurrentSquareOccupant, static_cast<uint64_t>(entry.first) + 1, flags});
    }
    for (;;) {
        auto batch = navigationMemory.TakeChangedCells();
        navigationRouter.Apply(batch);
        if (batch.cells.empty()) break;
    }
    for (size_t speedClass = 0; speedClass < navigationSpeeds.size(); ++speedClass)
        navigationRouter.SetSpeedClass(static_cast<uint8_t>(speedClass), navigationSpeeds[speedClass]);
    navigationRouter.SetBaseSpeed(baseSpeed);
    if (!goalActive || std::hypot(goal.worldX - previousGoal.worldX, goal.worldY - previousGoal.worldY) > 2.f) {
        navigationRouter.SetGoal(navigationEpoch, ++navigationGoal, shiftedPlayer, shiftedGoal);
        previousGoal = goal;
        goalActive = true;
    } else navigationRouter.MoveStart(navigationEpoch, shiftedPlayer);
    navigationRouter.Repair(2048, std::chrono::microseconds(0));
    navigationResult = navigationRouter.Corridor();
    for (int index = 0; index < navigationResult.count; ++index) {
        navigationResult.points[index].worldX -= coordinateOffset;
        navigationResult.points[index].worldY -= coordinateOffset;
    }
    return navigationResult;
}
} } }
#endif

namespace TestTAB {
void ReadDodgePlayerStats(int32_t& hp, int32_t& maxHp, float& spd, float& tps)
{
    // Line-for-line MovementRuntime GetTilesPerSec, with the game's values supplied
    // by the modelled world: the server SPD stat, CalcMoveSpeed's square speed and
    // the live condition words. The game's own getter is not modelled (-1), so the
    // native model alone has to keep every step inside the game's speed.
    const H::World& w = *H::g_world;
    hp = 1000; maxHp = 1000; spd = static_cast<float>(H::TruthSpd(w));
    DodgeRuntime::SpeedSample s{};
    s.clientSpd = H::TruthSpd(w);
    s.tileMultiplier = H::TruthSpeedMul(w, w.px, w.py);
    s.conditionsKnown = true;
    s.cond0 = (w.slowed ? DodgeRuntime::kCondSlowed : 0u) | (w.paralyzed ? DodgeRuntime::kCondParalyzed : 0u) |
              (w.speedy ? DodgeRuntime::kCondSpeedy : 0u);
    // The game's own getter (FKALGHJIADI::GAFGPNKFMOJ) is what confirms Speedy; model it
    // for a Speedy world only, so every other scenario keeps the native model alone.
    if (w.speedy) s.gameTilesPerMs = H::TruthTilesPerSec(w, w.px, w.py) / 1000.f;
    tps = DodgeRuntime::EffectiveTilesPerSec(s);
}
#ifdef HARNESS_SHARED_OCCUPANCY
bool IsWalkPositionBlocked(float cx, float cy)
{
    return Movement::TileOccupancy::BoxBlocked(
        [](int tx, int ty) { return H::ViewFlags(tx, ty); }, cx, cy, Movement::TileOccupancy::kPlayerHalfEdge);
}
bool IsWalkCircleBlocked(float cx, float cy)
{
    return Movement::TileOccupancy::FullOccupyBlocked(
        [](int tx, int ty) { return H::ViewFlags(tx, ty); }, cx, cy);
}
#else
// Line-for-line TestTAB::IsPositionBlocked / IsCircleBlocked (noclip off).
bool IsWalkPositionBlocked(float cx, float cy)
{
    constexpr float k = 0.2285f;
    for (int tx = static_cast<int>(floorf(cx - k)); tx <= static_cast<int>(floorf(cx + k)); ++tx)
        for (int ty = static_cast<int>(floorf(cy - k)); ty <= static_cast<int>(floorf(cy + k)); ++ty)
            if (WorldTAB::IsTileBlocked(tx, ty)) return true;
    return false;
}
bool IsWalkCircleBlocked(float cx, float cy)
{
    const int tx = static_cast<int>(floorf(cx)), ty = static_cast<int>(floorf(cy));
    const float fx = cx - static_cast<float>(tx), fy = cy - static_cast<float>(ty);
    auto fo = [](int x, int y) { return WorldTAB::IsTileFullOccupied(x, y); };
    if (fx < 0.5f) {
        if (fo(tx - 1, ty)) return true;
        if      (fy < 0.5f) { if (fo(tx, ty - 1) || fo(tx - 1, ty - 1)) return true; }
        else if (fy > 0.5f) { if (fo(tx, ty + 1) || fo(tx - 1, ty + 1)) return true; }
    } else if (fx > 0.5f) {
        if (fo(tx + 1, ty)) return true;
        if      (fy < 0.5f) { if (fo(tx, ty - 1) || fo(tx + 1, ty - 1)) return true; }
        else if (fy > 0.5f) { if (fo(tx, ty + 1) || fo(tx + 1, ty + 1)) return true; }
    } else {
        if      (fy < 0.5f) { if (fo(tx, ty - 1)) return true; }
        else if (fy > 0.5f) { if (fo(tx, ty + 1)) return true; }
    }
    return false;
}
#endif
}

namespace UDodge { namespace Debug {
void Render(const DebugSnapshot& d, float, float, float, float, float, float)
{
    if (!std::getenv("HARNESS_TRACE_FRAMES")) return;
    std::fprintf(stderr, "  [frame t=%.3f] player=(%.3f,%.3f) kind=%d move=%d target=(%.3f,%.3f) navStep=(%.3f,%.3f) "
        "navWpts=%d lockTarget=(%.2f,%.2f) route=%d\n",
        (H::g_nowMs - 100000.0) / 1000.0, d.player.x, d.player.y, d.solveKind, d.overrideActive,
        d.moveTarget.x, d.moveTarget.y, d.navStepTarget.x, d.navStepTarget.y, d.navWptCount,
        d.lockTarget.x, d.lockTarget.y, d.hasRoute);
}
} }

namespace UDodge { namespace Sensors {
void RecordPacketShot(const char*) {}
void ClearPacketShots() {}
void RecordAoePacket(const char*) {}
bool IsHazardAt(float x, float y) { return Movement::TileSensor::IsHazardAt(H::g_memo, x, y); }
#if __has_include("features/movement/sensors/TileOccupancy.h")
bool WallsClear(float x, float y) { return !TestTAB::IsWalkPositionBlocked(x, y); }   // UDodgeSensors.cpp WallsClear
#endif
#ifdef HARNESS_NAV_FOUNDATION
bool StepClear(float ax, float ay, float bx, float by)   // UDodgeSensors.cpp StepClear
{
    return Movement::Collision::StepClear([](int tx, int ty) { return H::ViewFlags(tx, ty); }, ax, ay, bx, by);
}
#endif
bool CanOccupy(float worldX, float worldY, bool safeWalk)
{
    // Line-for-line UDodgeSensors.cpp Sensors::CanOccupy.
#ifdef HARNESS_NAV_FOUNDATION
    if (Movement::Collision::GetRule() == Movement::Collision::Rule::Game) {
        if (!Movement::Collision::Standable([](int tx, int ty) { return H::ViewFlags(tx, ty); }, worldX, worldY))
            return false;
        if (safeWalk && IsHazardAt(worldX, worldY)) return false;
    } else
#endif
    if (!Movement::TileSensor::CanOccupy(H::g_memo, worldX, worldY, safeWalk)) return false;
    if (!safeWalk) return true;
    constexpr float h = kUOccPlayerHalfEdge;
    return !IsHazardAt(worldX - h, worldY - h) && !IsHazardAt(worldX + h, worldY - h) &&
           !IsHazardAt(worldX - h, worldY + h) && !IsHazardAt(worldX + h, worldY + h);
}
bool ReadWorldTick(uint32_t& out) { out = static_cast<uint32_t>(H::g_nowMs / 200.0); return true; }
void BuildMap(DangerMap& out, float px, float py, const Settings& s)
{
    H::g_memo.Clear();
    H::RefreshSnapshot();
    H::FillDanger(out, px, py, s);
    H::g_mapBulletVersion = H::g_world->bulletVersion;
}
bool ReanchorMap(DangerMap& map, float px, float py, const Settings& s)
{
    if (H::g_mapBulletVersion != H::g_world->bulletVersion) return false;   // structural change → rebuild
    const uint32_t tick = map.tickId; const bool valid = map.tickValid;
    H::RefreshSnapshot();
    H::FillDanger(map, px, py, s);
    map.tickId = tick; map.tickValid = valid;
    return true;
}
} }

namespace UDodge { namespace Worker {
namespace {
Path::PlannerSnapshot* s_local = new Path::PlannerSnapshot();
Result   s_result{};
bool     s_have = false;
uint64_t s_readyFrame = 0;
uint32_t s_seq = 0;

void HarnessCycle(const Path::PlannerSnapshot& local, Result& latest)
{
#ifdef HARNESS_SHARED_WORKER_CYCLE
    Worker::RunCycle(local, latest);
#else
    // Line-for-line UDodgeWorker.cpp WorkerLoop body (before any fix).
    Path::PlanResult plan{};
    Path::Compute(local, plan);
    MapInput in{};
    in.player = local.player; in.speed = local.speed; in.stepTiles = local.moveBudget;
    in.tickId = local.tickId; in.playerOnHazard = local.playerOnHazard; in.settings = local.settings;
    in.map = &local.map;
    in.env.occFlags = local.grid.flags; in.env.occCenter = local.grid.center;
    in.env.occSide = kUPathMaxSide; in.env.occRadius = kUPathMaxRadCells; in.env.occCellTiles = kUPathCellTiles;
    Solver::Goal goal{};
    goal.active = local.goalActive; goal.pos = local.goalPos; goal.walkTo = local.goalWalkTo;
    if (goal.walkTo && plan.navFound) goal.pos = plan.navStepTarget;
    goal.fromLock = local.hasLock; goal.lockPos = local.lockPos;
    goal.maxRange = local.weaponRangeTiles; goal.innerStandoff = local.innerStandoffTiles;
    static SpacetimeDodge::State timedState;
    SpacetimeDodge::Input timedIn{};
    Timed::BuildInput(in, H::g_nowMs, 16.7f, Timed::Budget{}, timedIn);
    SpacetimeDodge::Output timedOut{};
    SpacetimeDodge::Evaluate(timedIn, timedState, timedOut);
    const Solver::TimedAdvice timed = Timed::ToAdvice(timedOut, in.player, local.moveBudget);
    CoreState solveState = local.commitment.state;
    Solver::SolveResult solve{};
    Solver::Solve(in, local.moveBudget, goal, plan, solveState, solve, timed);
    latest.plan = plan; latest.solve = solve; latest.solveGoal = goal.pos; latest.timed = timed;
    latest.solveState = solveState; latest.commitmentRevision = local.commitment.revision;
    latest.snapshotPlayer = local.player; latest.walkGoal = local.navGoal; latest.walkActive = local.goalWalkTo;
#endif
}
} // namespace

void Start() {}
void Stop() {}
uint32_t PublishSnapshot(const Path::PlannerSnapshot& snap)
{
    *s_local = snap;
    s_local->seq = ++s_seq;
#ifdef HARNESS_NAV_FOUNDATION
    // Every rule: the worker times route edges with the ground <Speed> the view holds.
    for (int y = 0; y < kUOccSquareSide; ++y)
        for (int x = 0; x < kUOccSquareSide; ++x)
            if (snap.grid.squareSpeed[y * kUOccSquareSide + x] !=
                WorldTAB::GetTileSpeed(snap.grid.squareX0 + x, snap.grid.squareY0 + y))
                ++H::g_worker.squareMismatches;
    // Under the game rule the worker must read exactly the squares the live check reads:
    // every square of the dodge copy, and of the walk-to raster when a plan was asked for.
    if (snap.collisionRule == Movement::Collision::Rule::Game) {
        namespace TO = Movement::TileOccupancy;
        const auto normal = [](uint8_t f) -> uint8_t {   // what Collision::Standable can see
            return (f & TO::kTileKnown) ? (f & (TO::kTileKnown | TO::kTileBlocked | TO::kTileFullOcc))
                                        : (f & TO::kTileFullOcc);
        };
        const Movement::Collision::RasterSquares occ{ snap.grid.squares, snap.grid.squareX0, snap.grid.squareY0, kUOccSquareSide };
        for (int y = 0; y < kUOccSquareSide; ++y)
            for (int x = 0; x < kUOccSquareSide; ++x)
                if (normal(occ(occ.tx0 + x, occ.ty0 + y)) != normal(H::ViewFlags(occ.tx0 + x, occ.ty0 + y)))
                    ++H::g_worker.squareMismatches;
        if (snap.navActive) {
            const Movement::Collision::RasterSquares nav{ snap.navGrid.flags,
                static_cast<int>(std::floor(snap.navGrid.center.x)) - kUNavRadCells,
                static_cast<int>(std::floor(snap.navGrid.center.y)) - kUNavRadCells, kUNavSide };
            for (int y = 0; y < kUNavSide; ++y)
                for (int x = 0; x < kUNavSide; ++x)
                    if (normal(nav(nav.tx0 + x, nav.ty0 + y)) != normal(H::ViewFlags(nav.tx0 + x, nav.ty0 + y)))
                        ++H::g_worker.squareMismatches;
        }
    }
#endif
    const auto t0 = std::chrono::steady_clock::now();
    s_result = Result{};
    HarnessCycle(*s_local, s_result);
    const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    H::WorkerStats& ws = H::g_worker;
    ++ws.cycles; ws.cycleMsSum += ms; ws.cycleMsMax = std::max(ws.cycleMsMax, ms);
    ws.dodgeMsSum += s_result.plan.computeDodgeMs;
    ws.dodgeMsMax = std::max(ws.dodgeMsMax, static_cast<double>(s_result.plan.computeDodgeMs));
    if (snap.navActive) {
        ++ws.navRuns; ws.navMsSum += s_result.plan.computeNavMs;
        ws.navMsMax = std::max(ws.navMsMax, static_cast<double>(s_result.plan.computeNavMs));
    }
    if (std::getenv("HARNESS_TRACE")) {
        const auto& p = s_result.plan; const auto& so = s_result.solve;
        std::fprintf(stderr, "[pub t=%.2f] player=(%.2f,%.2f) navActive=%d goalWalk=%d goal=(%.2f,%.2f) lock=%d "
            "| nav found=%d partial=%d arrived=%d wpts=%d pops=%d step=(%.2f,%.2f) "
            "| dodge found=%d partial=%d temp=%d start=%d goal=(%.2f,%.2f) step=(%.2f,%.2f) "
            "| wsolve kind=%d move=%d tgt=(%.2f,%.2f)\n",
            (H::g_nowMs - 100000.0) / 1000.0, snap.player.x, snap.player.y, snap.navActive, snap.goalWalkTo,
            snap.goalPos.x, snap.goalPos.y, snap.hasLock,
            p.navFound, p.navPartial, p.navArrived, p.navWptCount, p.navPops, p.navStepTarget.x, p.navStepTarget.y,
            p.found, p.partial, p.tempGoal, p.startIsGoal, p.goalPos.x, p.goalPos.y, p.stepTarget.x, p.stepTarget.y,
            static_cast<int>(so.kind), so.shouldMove, so.target.x, so.target.y);
        if (snap.navActive && p.navWptCount > 1) {
            std::fprintf(stderr, "    wpts:");
            for (int i = 0; i < p.navWptCount && i < 24; ++i) std::fprintf(stderr, " (%.1f,%.1f)", p.navWpts[i].x, p.navWpts[i].y);
            std::fprintf(stderr, "\n");
        }
    }
    s_have = true;
    s_readyFrame = H::g_frame + 1;
    return s_seq;
}
bool TryGetLatest(Result& out)
{
    if (!s_have || H::g_frame < s_readyFrame) return false;
    out = s_result;
    s_have = false;
    return true;
}
} }

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios
// ─────────────────────────────────────────────────────────────────────────────
namespace H {

struct Result {
    std::string name;
    bool success = false;
    double timeS = 0, pathTiles = 0, stuckS = 0, finalDist = 0, inRangeFrac = 0, firstInRangeS = -1;
    uint32_t hits = 0;
};

constexpr Ground kFloor{};
constexpr Ground kNoWalkWall{ true, false, false, 0.f, 0 };
constexpr Ground kDeepWaterSpeed{ true, true, false, 0.75f, 0 };   // "Crystal Cave Deep Water" 0x642b
constexpr Ground kDeepWaterPlain{ true, true, false, 0.f, 0 };     // "Dark Water" 0xbc
constexpr Ground kShallowWater{ false, true, false, 0.666f, 0 };   // "Shallow Water" 0x73
constexpr Ground kLava{ false, false, false, 0.f, 20 };

void ApplyUserSettings()
{
    // RE_ASSETS/configs/default.json, unified mode.
    UDodge::SetLaneTiles(2.f);
    UDodge::SetStepTiles(0.f);
    UDodge::SetHitScale(0.65f);
    UDodge::SetReactMargin(0.75f);
    UDodge::SetSafeWalk(true);
    UDodge::SetSpeedScale(true);
    UDodge::SetFieldEscape(true);
    UDodge::SetLockFollow(false);
    UDodge::SetFollowLantern(false);
    UDodge::SetAutopilot(false);
    UDodge::SetStandOnType(0);
    UDodge::SetDebugOverlay(std::getenv("HARNESS_TRACE_FRAMES") != nullptr);   // trace reads the overlay snapshot
    UDodge::SetDrawPath(false);
    UDodge::SetOrbitRange(0.f);
    UDodge::SetPlanRadius(29.f);
    UDodge::SetMoveEnvelope(true);
    if (std::getenv("HARNESS_DIAG")) UDodge::SetDiagTiming(true);   // exercise the field diagnostics
}

enum class Goal { WalkTo, Lock };

Result Run(const char* name, World& w, Goal kind, Vec2 goal, double limitS)
{
    g_world = &w;
    const int32_t lockId = w.lockId;   // OnEnter clears the lock; restored every frame below
    g_move = MoveStats{}; g_worker = WorkerStats{}; g_tick = TickStats{};
    g_nowMs = 100000.0; g_frame = 0;
    UDodge::SetEnabled(false);
    ApplyUserSettings();
    UDodge::SetEnabled(true);
    UDodge::OnEnter();   // resets walk goal / lock — set them after
    if (kind == Goal::WalkTo) DangerPlanner::SetWalkGoal(goal.x, goal.y);
    RebuildView(w);

    Result r; r.name = name;
    Vec2 prev{ w.px, w.py };
    Vec2 windowAnchor = prev; double windowStart = g_nowMs;
    const double dtMs = 1000.0 / 60.0;
    const uint64_t frames = static_cast<uint64_t>(limitS * 60.0);
    double lastViewMs = g_nowMs;
    uint64_t inRangeFrames = 0, tailFrames = 0;
    std::vector<int> hitBullets;
    for (g_frame = 1; g_frame <= frames; ++g_frame) {
        g_nowMs += dtMs;
        if (w.script) w.script(w);
        if (kind == Goal::Lock && w.lockId == 0) w.lockId = lockId;   // OnEnter cleared it
        if (g_nowMs - lastViewMs >= 100.0) { RebuildView(w); lastViewMs = g_nowMs; }
        const auto t0 = std::chrono::steady_clock::now();
        UDodge::Tick(reinterpret_cast<void*>(&w), w.px, w.py, 1.f / 60.f);
        if (std::getenv("HARNESS_TRACE_FRAMES")) UDodge::RenderDebugOverlay(0, 0, 0, 1, 0, 0);
        const double tickMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        ++g_tick.n; g_tick.sum += tickMs; g_tick.max = std::max(g_tick.max, tickMs);

        const Vec2 cur{ w.px, w.py };
        r.pathTiles += Len(Sub(cur, prev));
        prev = cur;
        if (w.watchId != 0)
            for (const Enemy& e : w.enemies)
                if (e.id == w.watchId && e.hp > 0)
                    w.watchMinDist = std::min(w.watchMinDist, Len(Sub(cur, { e.x, e.y })));
        // Hits: point player vs Chebyshev half (the production contact model).
        for (Bullet& b : w.bullets) {
            if (!b.alive) continue;
            const float age = static_cast<float>(g_nowMs - b.t0);
            if (age > b.lifeMs) { b.alive = false; continue; }
            const float bx = b.x0 + b.vx * age, by = b.y0 + b.vy * age;
            if (!TruthSquareOpen(w, FloorI(bx), FloorI(by))) { b.alive = false; continue; }   // walls stop shots
            if (std::max(std::fabs(bx - cur.x), std::fabs(by - cur.y)) < b.half) {
                ++r.hits; b.alive = false; ++w.bulletVersion;
            }
        }
        if (g_nowMs - windowStart >= 2000.0) {
            // Holding still counts as stuck only while short of the goal (walk-to not
            // arrived, or a locked target still beyond engagement range).
            bool settled = kind == Goal::WalkTo && !w.walkActive;
            if (kind == Goal::Lock)
                for (const Enemy& e : w.enemies)
                    if (e.id == lockId)
                        settled = Len(Sub(cur, { e.x, e.y })) <=
                                  std::max(kUInnerStandoffMinTiles + kUDurablePocketMargin,
                                           w.weaponRange - kUEngagementRangeInset) + kUInRangeSlack;
            if (!settled && Len(Sub(cur, windowAnchor)) < 0.5f) r.stuckS += 2.0;
            windowAnchor = cur; windowStart = g_nowMs;
        }
        if (kind == Goal::WalkTo) {
            if (!w.walkActive) { r.success = true; r.timeS = g_frame / 60.0; break; }
        } else {
            const Enemy* boss = nullptr;
            for (const Enemy& e : w.enemies) if (e.id == lockId) boss = &e;
            if (boss) {
                const float inner = std::max(kUInnerStandoffMinTiles, w.weaponRange * kUInnerStandoffFrac);
                const float outer = std::max(inner + kUDurablePocketMargin, w.weaponRange - kUEngagementRangeInset);
                const float d = Len(Sub(cur, { boss->x, boss->y }));
                const bool inRange = d <= outer + kUInRangeSlack && d >= inner - 0.25f;
                if (inRange && r.firstInRangeS < 0) r.firstInRangeS = g_frame / 60.0;
                if (g_frame > frames / 2) { ++tailFrames; if (inRange) ++inRangeFrames; }
            }
        }
    }
    r.hits += w.extraHits;
    if (kind == Goal::WalkTo) {
        r.finalDist = Len(Sub({ w.px, w.py }, goal));
        if (!r.success) r.timeS = limitS;
    } else {
        r.inRangeFrac = tailFrames ? static_cast<double>(inRangeFrames) / tailFrames : 0.0;
        r.success = r.firstInRangeS >= 0 && r.inRangeFrac >= 0.5;
        r.timeS = r.firstInRangeS;
    }
    UDodge::SetEnabled(false);
    return r;
}

void Emit(const Result& r)
{
    const double tickAvg = g_tick.n ? g_tick.sum / g_tick.n : 0;
    const double navAvg = g_worker.navRuns ? g_worker.navMsSum / g_worker.navRuns : 0;
    const double dodgeAvg = g_worker.cycles ? g_worker.dodgeMsSum / g_worker.cycles : 0;
    const double cycleAvg = g_worker.cycles ? g_worker.cycleMsSum / g_worker.cycles : 0;
    std::printf("{\"scenario\":\"%s\",\"success\":%s,\"time_s\":%.2f,\"path_tiles\":%.1f,\"final_dist\":%.2f,"
                "\"stuck_s\":%.1f,\"hits\":%u,\"in_range_frac\":%.2f,\"refused_moves\":%u,"
                "\"overspeed_moves\":%u,\"max_step_ratio\":%.3f,"
                "\"tick_ms_avg\":%.3f,\"tick_ms_max\":%.3f,\"nav_plans\":%u,\"nav_ms_avg\":%.3f,\"nav_ms_max\":%.3f,"
                "\"dodge_ms_avg\":%.3f,\"dodge_ms_max\":%.3f,\"cycle_ms_avg\":%.3f,\"cycle_ms_max\":%.3f,"
                "\"square_mismatches\":%u}\n",
                r.name.c_str(), r.success ? "true" : "false", r.timeS, r.pathTiles, r.finalDist, r.stuckS, r.hits,
                r.inRangeFrac, g_move.refused, g_move.overspeed, std::min(g_move.maxStepRatio, 999.0),
                tickAvg, g_tick.max, g_worker.navRuns, navAvg, g_worker.navMsMax,
                dodgeAvg, g_worker.dodgeMsMax, cycleAvg, g_worker.cycleMsMax, g_worker.squareMismatches);
    std::fflush(stdout);
}

void Floor(World& w, int r = 40) { w.Fill(-r, -r, r, r, kFloor); }

// (a) water body between player and goal
void ScenarioLake(const char* name, Ground water)
{
    World w; Floor(w);
    for (int y = -9; y <= 9; ++y)
        for (int x = 4; x <= 16; ++x) {
            const float ex = (x + 0.5f - 10.f) / 6.5f, ey = (y + 0.5f) / 9.5f;
            if (ex * ex + ey * ey <= 1.f) w.SetGround(x, y, water);
        }
    w.px = 0.5f; w.py = 0.5f;
    Emit(Run(name, w, Goal::WalkTo, { 20.5f, 0.5f }, 60));
}

// (a4) a river spanning the map with a ford far away: wading/swimming is shorter than the detour
void ScenarioRiver(const char* name, Ground water)
{
    World w; Floor(w);
    for (int y = -40; y <= 40; ++y)
        for (int x = 6; x <= 9; ++x)
            if (y < 30) w.SetGround(x, y, water);   // the only dry crossing is at y >= 30
    w.px = 0.5f; w.py = 0.5f;
    Emit(Run(name, w, Goal::WalkTo, { 15.5f, 0.5f }, 60));
}

// (b) tree/rock cluster: seeded OccupySquare trees + FullOccupy rocks, reachable by truth BFS
bool TruthReachable(const World& w, int sx, int sy, int gx, int gy)
{
    std::vector<std::pair<int, int>> q{ { sx, sy } };
    std::unordered_map<uint32_t, bool> seen{ { Key(sx, sy), true } };
    for (size_t i = 0; i < q.size(); ++i) {
        auto [x, y] = q[i];
        if (x == gx && y == gy) return true;
        for (auto [dx, dy] : { std::pair{1,0}, {-1,0}, {0,1}, {0,-1} }) {
            const int nx = x + dx, ny = y + dy;
            if (std::abs(nx) > 40 || std::abs(ny) > 40 || seen.count(Key(nx, ny))) continue;
            if (!TruthValid(w, nx + 0.5f, ny + 0.5f)) continue;
            seen[Key(nx, ny)] = true; q.push_back({ nx, ny });
        }
    }
    return false;
}
void ScenarioTrees(const char* name, uint32_t seed)
{
    for (uint32_t s = seed;; ++s) {
        World w; Floor(w);
        std::mt19937 rng(s);
        std::uniform_real_distribution<float> u(0.f, 1.f);
        for (int y = -8; y <= 8; ++y)
            for (int x = 3; x <= 17; ++x) {
                const float p = u(rng);
                if (p < 0.08f) w.PutObj(x, y, true);           // FullOccupy rock
                else if (p < 0.34f) w.PutObj(x, y, false);     // OccupySquare tree
            }
        w.px = 0.5f; w.py = 0.5f;
        if (!TruthValid(w, 20.5f, 0.5f) || !TruthReachable(w, 0, 0, 20, 0)) continue;
        Emit(Run(name, w, Goal::WalkTo, { 20.5f, 0.5f }, 60));
        return;
    }
}

// (c) U-shaped FullOccupy wall, player inside, goal behind the base
void ScenarioU(const char* name)
{
    World w; Floor(w);
    for (int y = -6; y <= 6; ++y) w.PutObj(8, y, true);
    for (int x = 0; x <= 8; ++x) { w.PutObj(x, -6, true); w.PutObj(x, 6, true); }
    w.px = 5.5f; w.py = 0.5f;
    Emit(Run(name, w, Goal::WalkTo, { 14.5f, 0.5f }, 60));
}

// (c2) boss lock approach around the same U from inside it
void ScenarioULock(const char* name)
{
    World w; Floor(w);
    for (int y = -6; y <= 6; ++y) w.PutObj(8, y, true);
    for (int x = 0; x <= 8; ++x) { w.PutObj(x, -6, true); w.PutObj(x, 6, true); }
    w.px = 3.5f; w.py = 0.5f;
    Enemy boss; boss.id = 900; boss.type = 0x0d50; boss.x = 20.5f; boss.y = 0.5f; boss.hp = boss.maxHp = 50000;
    w.enemies.push_back(boss);
    w.lockId = boss.id;
    Emit(Run(name, w, Goal::Lock, {}, 40));
}

// (d) locked boss firing rings (+ aimed triples when dense), optionally behind a wall segment
void ScenarioBoss(const char* name, bool wall, int ringCount, double ringMs, bool aimed)
{
    World w; Floor(w);
    if (wall) for (int y = -4; y <= 4; ++y) w.PutObj(9, y, true);
    w.px = 0.5f; w.py = 0.5f;
    Enemy boss; boss.id = 901; boss.type = 0x0d51; boss.x = 16.5f; boss.y = 0.5f; boss.hp = boss.maxHp = 50000;
    w.enemies.push_back(boss);
    w.lockId = boss.id;
    double nextRing = 100500.0, nextAimed = 100300.0;   // Run() restarts the clock at 100000 ms
    int ringPhase = 0;
    w.script = [=](World& ww) mutable {
        const Enemy& b = ww.enemies[0];
        if (g_nowMs >= nextRing) {
            nextRing += ringMs;
            const float off = (ringPhase++ % 2) ? kTwoPi / (4.f * ringCount) : 0.f;
            for (int i = 0; i < ringCount; ++i)
                ww.Fire(b.x, b.y, off + kTwoPi * i / ringCount, 5.f, 1800.f, 0.4f, b.id);
        }
        if (aimed && g_nowMs >= nextAimed) {
            nextAimed += 600;
            const float a = std::atan2(ww.py - b.y, ww.px - b.x);
            for (int k = -1; k <= 1; ++k) ww.Fire(b.x, b.y, a + k * 0.15f, 8.f, 1200.f, 0.35f, b.id);
        }
    };
    // Hits are asserted: in range for half the fight is worth nothing if it costs hits.
    Result r = Run(name, w, Goal::Lock, {}, 40);
    r.success = r.success && r.hits == 0;
    Emit(r);
}

// (e) narrow corridors with an L bend
void ScenarioCorridor(const char* name, int width, bool fullOccupyWalls)
{
    World w; Floor(w);
    // Solid block, then carve an L: east along y∈[0,width) from x=0..12, then north x∈[12,12+width) to y=12.
    auto wall = [&](int x, int y) {
        if (fullOccupyWalls) w.PutObj(x, y, true); else w.SetGround(x, y, kNoWalkWall);
    };
    for (int y = -6; y <= 18; ++y)
        for (int x = -3; x <= 18; ++x) {
            const bool legA = x >= -2 && x <= 12 + width - 1 && y >= 0 && y < width;
            const bool legB = x >= 12 && x < 12 + width && y >= 0 && y <= 16;
            if (!legA && !legB) wall(x, y);
        }
    w.px = -1.5f; w.py = 0.5f;
    Emit(Run(name, w, Goal::WalkTo, { 12.5f, 15.5f }, 60));
}

void ScenarioConnectedRooms(const char* name, int width, bool fullOccupyWalls, bool reverse,
                            bool progressive = false)
{
    World world;
    for (int tileY = -2; tileY <= 58; ++tileY) {
        for (int tileX = -2; tileX <= 62; ++tileX) {
            const bool firstRoom = tileX >= 0 && tileX <= 23 && tileY >= 0 && tileY <= 23;
            const bool secondRoom = tileX >= 36 && tileX <= 59 && tileY >= 32 && tileY <= 55;
            const bool horizontalHall = tileX >= 24 && tileX < 35 + width && tileY >= 21 && tileY < 21 + width;
            const bool verticalHall = tileX >= 35 && tileX < 35 + width && tileY >= 21 && tileY <= 35;
            world.SetGround(tileX, tileY, kFloor);
            if (!(firstRoom || secondRoom || horizontalHall || verticalHall)) {
                if (fullOccupyWalls) world.PutObj(tileX, tileY, true);
                else world.SetGround(tileX, tileY, kNoWalkWall);
            }
        }
    }
    const Vec2 first{ 1.31f, 1.69f };
    const Vec2 second{ 58.25f, 53.61f };
    const Vec2 start = reverse ? second : first;
    const Vec2 goal = reverse ? first : second;
    world.px = start.x;
    world.py = start.y;
    if (progressive) {
        world.streamOrder.clear();
        world.script = [seen = std::unordered_set<uint32_t>{}](World& current) mutable {
            const int centerX = FloorI(current.px);
            const int centerY = FloorI(current.py);
            for (int tileY = centerY - 10; tileY <= centerY + 10; ++tileY)
                for (int tileX = centerX - 10; tileX <= centerX + 10; ++tileX) {
                    const uint32_t key = Key(tileX, tileY);
                    if (current.tiles.count(key) && seen.insert(key).second)
                        current.streamOrder.push_back(key);
                }
        };
        world.script(world);
    }
    Result result = Run(name, world, Goal::WalkTo, goal, 40);
    result.success = result.success && result.hits == 0 && result.stuckS == 0 &&
                     g_move.refused == 0 && g_move.overspeed == 0;
    Emit(result);
}

void ScenarioRemoteDoorway(const char* name, bool reverse)
{
    World world;
    for (int tileY = -2; tileY <= 415; ++tileY) {
        for (int tileX = -2; tileX <= 415; ++tileX) {
            const bool firstRoom = tileX >= 0 && tileX <= 199 && tileY >= 0 && tileY <= 199;
            const bool secondRoom = tileX >= 213 && tileX <= 412 && tileY >= 210 && tileY <= 409;
            const bool horizontalHall = tileX >= 200 && tileX <= 212 && tileY >= 1 && tileY <= 2;
            const bool verticalHall = tileX >= 211 && tileX <= 212 && tileY >= 1 && tileY <= 212;
            world.SetGround(tileX, tileY,
                firstRoom || secondRoom || horizontalHall || verticalHall ? kFloor : kNoWalkWall);
        }
    }
    const Vec2 first{ 100.31f, 100.69f };
    const Vec2 second{ 313.25f, 310.61f };
    const Vec2 start = reverse ? second : first;
    world.px = start.x;
    world.py = start.y;
    Result result = Run(name, world, Goal::WalkTo, reverse ? first : second, 120);
    result.success = result.success && result.hits == 0 && result.stuckS == 0 &&
                     g_move.refused == 0 && g_move.overspeed == 0;
    Emit(result);
}

// (f) a damaging row across a 3-wide corridor (safe-walk on, only way through)
void ScenarioDamagingRow(const char* name)
{
    World w; Floor(w);
    for (int x = -3; x <= 20; ++x) { w.Fill(x, -6, x, -2, kNoWalkWall); w.Fill(x, 2, x, 6, kNoWalkWall); }
    for (int y = -1; y <= 1; ++y) w.SetGround(8, y, kLava);
    w.px = 0.5f; w.py = 0.5f;
    Emit(Run(name, w, Goal::WalkTo, { 16.5f, 0.5f }, 60));
}

// (g) a long FullOccupy wall with a single one-tile gap
void ScenarioFullOccupyGap(const char* name)
{
    World w; Floor(w);
    for (int y = -35; y <= 35; ++y) if (y != 3) w.PutObj(8, y, true);
    w.px = 0.5f; w.py = 0.5f;
    Emit(Run(name, w, Goal::WalkTo, { 16.5f, 0.5f }, 60));
}

// (h) a learned keep-out on a common mob standing in a 5-wide corridor
void ScenarioLearnedKeepout(const char* name)
{
    World w; Floor(w);
    for (int x = -3; x <= 24; ++x) { w.Fill(x, -8, x, -3, kNoWalkWall); w.Fill(x, 3, x, 8, kNoWalkWall); }
    Enemy mob; mob.id = 902; mob.type = 0x0601; mob.x = 10.5f; mob.y = 0.5f; mob.hp = mob.maxHp = 400;
    w.enemies.push_back(mob);
    w.watchId = mob.id;
    w.px = 0.5f; w.py = 0.5f;
#ifdef HARNESS_TREE_POST70
    // The mob's attack is a server AOE centred on itself with no telegraph — exactly
    // what LearnFromAoePackets classifies as an unwarned self blast (radius 3).
    EnemyHazards::EnemyRef ref{ mob.type, { mob.x, mob.y } };
    EnemyHazards::ClearLearned();
    EnemyHazards::ObserveBlast({ mob.x, mob.y }, 3.f, mob.type, &ref, 1, nullptr, 0);
#endif
    // The blast itself: whenever the player is inside its reach it lands at once.
    double nextBlast = 0.0;
    w.script = [=](World& ww) mutable {
        if (g_nowMs < nextBlast) return;
        const Enemy& e = ww.enemies[0];
        if (Len(Sub({ ww.px, ww.py }, { e.x, e.y })) > 3.f + kGameHalf) return;
        nextBlast = g_nowMs + 1000.0;
        ++ww.extraHits;
    };
    Result r = Run(name, w, Goal::WalkTo, { 20.5f, 0.5f }, 60);
#ifdef HARNESS_TREE_BURST
    // The keep-out covers the corridor's whole width, so the walk goes round the
    // walls' far end (a detour exists) and never through the blast.
    r.success = r.success && w.watchMinDist >= EnemyHazards::KeepoutRadius(mob.type) - 0.05f;
#endif
    r.success = r.success && r.hits == 0;   // Run() adds the blasts (extraHits) to r.hits
    Emit(r);
#ifdef HARNESS_TREE_POST70
    EnemyHazards::ClearLearned();
#endif
}

// (j) blockers the DLL cannot see (a missed object): a short wall of them across the
// straight route, open ground around. Only recovery from "no progress" gets past.
void ScenarioHiddenBlocker(const char* name)
{
    World w; Floor(w);
    for (int y = -3; y <= 3; ++y) { Obj o; o.tx = 8; o.ty = y; o.occ = true; w.hiddenObjs[Key(8, y)] = o; }
    w.px = 0.5f; w.py = 0.5f;
    Emit(Run(name, w, Goal::WalkTo, { 16.5f, 0.5f }, 60));
}

// (k) movement speed the game allows. The game's MoveTo does not clamp, so these
// pass only when every commanded step fits the game's own speed for that frame
// (overspeed_moves == 0, enforced for every scenario by run_scenarios.py --check).
//
// k_slowed_midwalk: Slowed lands mid-walk and lifts again. SPD ~75 base, so the
// SPD curve alone would command 2.4x what the game allows while Slowed.
void ScenarioSlowedMidWalk(const char* name)
{
    World w; Floor(w);
    w.tps = 9.6f;
    w.px = 0.5f; w.py = 0.5f;
    w.script = [](World& ww) {
        const double t = (g_nowMs - 100000.0) / 1000.0;
        ww.slowed = t >= 0.5 && t < 3.0;
    };
    Result r = Run(name, w, Goal::WalkTo, { 24.5f, 0.5f }, 30);
    r.success = r.success && g_move.overspeed == 0;
    Emit(r);
}

// k_paralyzed_midwalk: Paralyzed for a second mid-walk; the game moves nobody then.
void ScenarioParalyzedMidWalk(const char* name)
{
    World w; Floor(w);
    w.px = 0.5f; w.py = 0.5f;
    w.script = [](World& ww) {
        const double t = (g_nowMs - 100000.0) / 1000.0;
        ww.paralyzed = t >= 0.5 && t < 1.5;
    };
    Result r = Run(name, w, Goal::WalkTo, { 16.5f, 0.5f }, 30);
    r.success = r.success && g_move.overspeed == 0;
    Emit(r);
}

// k_water_midpath: a band of shallow water across the whole route.
void ScenarioWaterMidPath(const char* name)
{
    World w; Floor(w);
    w.tps = 9.6f;
    w.Fill(8, -40, 12, 40, kShallowWater);
    w.px = 0.5f; w.py = 0.5f;
    Result r = Run(name, w, Goal::WalkTo, { 20.5f, 0.5f }, 30);
    r.success = r.success && g_move.overspeed == 0;
    Emit(r);
}

// k_dodge_in_water: the player wades a shallow pool while a turret sweeps shots
// across the ford. Dodging must be planned at wading speed.
void ScenarioDodgeInWater(const char* name)
{
    World w; Floor(w);
    w.tps = 9.6f;
    w.Fill(-3, -6, 14, 6, kShallowWater);
    w.px = 0.5f; w.py = 0.5f;
    double next = 100400.0;
    int k = 0;
    w.script = [=](World& ww) mutable {
        if (g_nowMs < next) return;
        next += 700.0;
        // Shots from the north crossing the ford line, walking along it.
        const float x = 2.5f + static_cast<float>((k++ * 3) % 10);
        ww.Fire(x, -9.5f, kTwoPi / 4.f, 7.f, 2600.f, 0.4f, 950);
    };
    Enemy turret; turret.id = 950; turret.type = 0x0d52; turret.x = 6.5f; turret.y = -9.5f;
    turret.hp = turret.maxHp = 5000;
    w.enemies.push_back(turret);
    Result r = Run(name, w, Goal::WalkTo, { 12.5f, 0.5f }, 30);
    r.success = r.success && g_move.overspeed == 0;
    Emit(r);
}

// k_speedy_walk: Speedy for the whole walk, confirmed by the game's getter. Every step
// must fit the game's x1.5 speed, and the walk must actually use it.
void ScenarioSpeedyWalk(const char* name)
{
    World w; Floor(w);
    w.tps = 6.f;
    w.speedy = true;
    w.px = 0.5f; w.py = 0.5f;
    Result r = Run(name, w, Goal::WalkTo, { 24.5f, 0.5f }, 30);
    // 24 tiles at 9 tiles/s is 2.67 s; 30% slack for the start and the arrival.
    r.success = r.success && g_move.overspeed == 0 && r.timeS <= 24.0 / 9.0 * 1.3;
    Emit(r);
}

// k_slowed_water: Slowed for the whole walk across a band of shallow water. The
// game moves the player at 4 tiles/s x the water's 0.666 there; nothing faster.
void ScenarioSlowedWater(const char* name)
{
    World w; Floor(w);
    w.tps = 9.6f;
    w.slowed = true;
    w.Fill(8, -40, 12, 40, kShallowWater);
    w.px = 0.5f; w.py = 0.5f;
    Result r = Run(name, w, Goal::WalkTo, { 20.5f, 0.5f }, 30);
    r.success = r.success && g_move.overspeed == 0;
    Emit(r);
}

// k_mixed_water_land: a half-speed lake 24 tiles wide on the straight line, dry ground
// round it. Wading is 8 dry + 24 x 2 = 56 tile-seconds (5.8 s at 9.6 tiles/s); round
// the lake is about 37 tiles (3.9 s). The walk must take the dry route — arrive well
// before a wade could — and no step may outrun the ground it is on.
void ScenarioMixedWaterLand(const char* name)
{
    World w; Floor(w);
    w.tps = 9.6f;
    constexpr Ground kSlowWater{ false, true, false, 0.5f, 0 };
    w.Fill(4, -4, 27, 4, kSlowWater);
    w.px = 0.5f; w.py = 0.5f;
    Result r = Run(name, w, Goal::WalkTo, { 32.5f, 0.5f }, 30);
    r.success = r.success && g_move.overspeed == 0 && r.timeS <= 4.8;
    Emit(r);
}

// (l) walking past enemies that punish closeness, and the locked target changing state.
//
// A shotgun mob: when the player comes within its reach it fires a tight five-shot
// spread at them. At point blank the shots land before any dodge can react, so the
// only defence is not to walk into that reach while any detour exists.
void ShotgunScript(World& ww, int mobId, float reach, double& nextMs)
{
    if (g_nowMs < nextMs) return;
    for (const Enemy& e : ww.enemies) {
        if (e.id != mobId || e.hp <= 0) continue;
        if (Len(Sub({ ww.px, ww.py }, { e.x, e.y })) > reach) return;
        nextMs = g_nowMs + 400.0;
        // The client sees an enemy's shot about one server tick after it was fired,
        // already that far along its path: at point blank it lands on arrival.
        constexpr double kSeenLateMs = 200.0;
        constexpr float  kShotTps = 20.f;
        const float a = std::atan2(ww.py - e.y, ww.px - e.x);
        for (int k = -3; k <= 3; ++k) {
            ww.Fire(e.x, e.y, a + k * 0.14f, kShotTps, reach / kShotTps * 1000.f, 0.4f, e.id);
            ww.bullets.back().t0 -= kSeenLateMs;
        }
        return;
    }
}

// l_walk_past_shotgun: open ground, the straight route passes one tile from a shotgun
// mob whose shots reach 4.5 tiles. A detour exists all round.
void ScenarioWalkPastShotgun(const char* name)
{
    World w; Floor(w);
    Enemy mob; mob.id = 960; mob.type = 0x0e01; mob.x = 12.5f; mob.y = 1.5f; mob.hp = mob.maxHp = 2000;
    mob.shotRange = 4.5f;
    w.enemies.push_back(mob);
    w.watchId = mob.id;
    w.px = 0.5f; w.py = 0.5f;
    double next = 0.0;
    w.script = [=](World& ww) mutable { ShotgunScript(ww, 960, 4.5f, next); };
    Result r = Run(name, w, Goal::WalkTo, { 24.5f, 0.5f }, 40);
    // Never inside the shotgun's reach (small tolerance for the keep-out's edge).
    r.success = r.success && r.hits == 0 && w.watchMinDist >= 4.5f - 0.1f;
    std::fprintf(stderr, "%s: closest approach %.2f\n", name, w.watchMinDist);
    Emit(r);
}

// l_walk_past_bomber: a mob that blasts itself (radius 3, no telegraph) whenever the
// player is within 3 tiles, standing beside the route. Its keep-out is already learned.
void ScenarioWalkPastBomber(const char* name)
{
    World w; Floor(w);
    Enemy mob; mob.id = 961; mob.type = 0x0e02; mob.x = 12.5f; mob.y = 1.5f; mob.hp = mob.maxHp = 2000;
    w.enemies.push_back(mob);
    w.watchId = mob.id;
    w.px = 0.5f; w.py = 0.5f;
#ifdef HARNESS_TREE_POST70
    EnemyHazards::EnemyRef ref{ mob.type, { mob.x, mob.y } };
    EnemyHazards::ClearLearned();
    EnemyHazards::ObserveBlast({ mob.x, mob.y }, 3.f, mob.type, &ref, 1, nullptr, 0);
#endif
    double next = 0.0;
    w.script = [=](World& ww) mutable {
        if (g_nowMs < next) return;
        const Enemy& e = ww.enemies[0];
        const float d = Len(Sub({ ww.px, ww.py }, { e.x, e.y }));
        if (d > 3.f + kGameHalf) return;
        next = g_nowMs + 1000.0;
        ++ww.extraHits;   // the blast lands the instant it is visible
    };
    Result r = Run(name, w, Goal::WalkTo, { 24.5f, 0.5f }, 40);
    r.success = r.success && r.hits == 0 && w.watchMinDist >= 3.f + kGameHalf;
    std::fprintf(stderr, "%s: closest approach %.2f\n", name, w.watchMinDist);
    Emit(r);
#ifdef HARNESS_TREE_POST70
    EnemyHazards::ClearLearned();
#endif
}

// l_lock_boss_*: a locked boss firing rings, two shotgun adds flanking the approach.
// Mid-fight the boss either dies (removed, shots still in flight) or turns
// invulnerable and keeps firing. No hit may be taken either way.
void ScenarioLockBossChange(const char* name, bool dies)
{
    World w; Floor(w);
    w.px = 0.5f; w.py = 0.5f;
    Enemy boss; boss.id = 970; boss.type = 0x0d51; boss.x = 16.5f; boss.y = 0.5f; boss.hp = boss.maxHp = 50000;
    w.enemies.push_back(boss);
    for (int s : { -1, 1 }) {
        Enemy add; add.id = 971 + (s > 0); add.type = 0x0e01; add.x = 9.5f; add.y = 0.5f + 4.f * s;
        add.hp = add.maxHp = 1500; add.shotRange = 4.5f;
        w.enemies.push_back(add);
    }
    w.lockId = boss.id;
    double nextRing = 100500.0, nextAdd0 = 0.0, nextAdd1 = 0.0;
    int ringPhase = 0;
    w.script = [=](World& ww) mutable {
        const double t = (g_nowMs - 100000.0) / 1000.0;
        Enemy& b = ww.enemies[0];
        if (t >= 8.0) {
            if (dies) b.hp = 0;
            else b.invuln = true;
        }
        if (b.hp > 0 && g_nowMs >= nextRing) {
            nextRing += 1000.0;
            const float off = (ringPhase++ % 2) ? kTwoPi / 32.f : 0.f;
            for (int i = 0; i < 8; ++i) ww.Fire(b.x, b.y, off + kTwoPi * i / 8, 5.f, 1800.f, 0.4f, b.id);
        }
        ShotgunScript(ww, 971, 4.5f, nextAdd0);
        ShotgunScript(ww, 972, 4.5f, nextAdd1);
    };
    Result r = Run(name, w, Goal::Lock, {}, 20);
    r.success = r.hits == 0 && g_move.overspeed == 0;
    Emit(r);
}

// (m) a diagonal pinch: two blocked squares touching only at a corner, the only way
// through. With NoWalk squares the game's point test lets the player through the
// corner; with FullOccupy walls the half-tile rule does not.
enum class PinchWall { NoWalk, FullOccupy, OccupySquare };
void ScenarioDiagonalPinch(const char* name, PinchWall kind)
{
    const bool fullOccupy = kind == PinchWall::FullOccupy;
    World w; Floor(w);
    // Left region: x <= 7 plus the column x = 8 above y = 0. Right region: the column
    // x = 9 at y <= 0 plus x >= 10. Squares (8,0) and (9,1) close everything except
    // their shared corner at (9,1).
    for (int y = -40; y <= 40; ++y) {
        const bool leftWall = y <= 0, rightWall = y >= 1;
        if (kind != PinchWall::NoWalk) {
            if (leftWall) w.PutObj(8, y, fullOccupy);
            if (rightWall) w.PutObj(9, y, fullOccupy);
        } else {
            if (leftWall) w.SetGround(8, y, kNoWalkWall);
            if (rightWall) w.SetGround(9, y, kNoWalkWall);
        }
    }
    w.px = 0.5f; w.py = 0.5f;
    Result r = Run(name, w, Goal::WalkTo, { 16.5f, 0.5f }, 30);
    if (fullOccupy) {
        // The game refuses this pinch: never arriving is correct, and nothing may
        // be commanded through it.
        r.success = !r.success && w.px < 9.f;
    }
    Emit(r);
}

// z_moveto_no_clamp: the modelled game MoveTo moves exactly as far as it is told,
// however far that is (86ad651b LKHPPBEGNOM::DGLCONCOIBO has no distance clamp), and
// counts the step as overspeed. The planner alone must keep every step in speed.
void ScenarioMoveToNoClamp(const char* name)
{
    World w; Floor(w);
    w.px = 0.5f; w.py = 0.5f;
    g_world = &w;
    g_move = MoveStats{};
    const bool ok = DodgeRuntime::CallMoveTo(&w, 5.5f, 0.5f);
    Result r; r.name = name;
    r.success = ok && std::fabs(w.px - 5.5f) < 1e-3f && std::fabs(w.py - 0.5f) < 1e-3f && g_move.overspeed == 1;
    g_move = MoveStats{};   // the deliberate overspeed step is this check's input, not a planner step
    Emit(r);
}

// (i) long session: the streamed-tile list exceeds 65,536 and the player walks
// where the list is OLDEST (revisit) or NEWEST (frontier). Replicates DoRefresh's
// selection, assuming the list is append-on-stream.
void ScenarioTileList(const char* name, bool revisit)
{
    World w;
    // 300 x 300 squares streamed row by row: 90,000 entries.
    for (int y = -150; y < 150; ++y) w.Fill(-150, y, 149, y, kFloor);
    const float py = revisit ? -140.5f : 140.5f;   // oldest rows vs newest rows
    w.px = 0.5f; w.py = py;
    Emit(Run(name, w, Goal::WalkTo, { 12.5f, py }, 30));
}

// ── Micro-benchmarks (not scenarios): realm-sized costs of the pieces this work touched.
// bench_raster: the render-thread flag rebuild, and the game-thread rasters FillNavGrid
// (145x145, 1-tile cells) and FillOccGrid (49x49, half-tile cells) run once per publish.
// bench_nav: the worker nav A* on a streamed 145x145 window, open ground and a goal
// that can only be reached across damaging ground (the multi-pass case).
double NowMsHost()
{
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
}
void BuildBenchWorld(World& w, uint32_t seed)
{
    std::mt19937 rng(seed);
    std::uniform_real_distribution<float> u(0.f, 1.f);
    for (int y = -150; y < 150; ++y)
        for (int x = -150; x < 150; ++x) {
            w.SetGround(x, y, u(rng) < 0.06f ? kShallowWater : kFloor);
            const float p = u(rng);
            if (std::abs(x) < 3 && std::abs(y) < 3) continue;
            if (p < 0.04f) w.PutObj(x, y, true);
            else if (p < 0.20f) w.PutObj(x, y, false);
        }
    w.px = 0.5f; w.py = 0.5f;
}
void BenchRaster()
{
    World w; BuildBenchWorld(w, 99);
    g_world = &w;
    double t0 = NowMsHost();
    constexpr int kRebuilds = 20;
    for (int i = 0; i < kRebuilds; ++i) RebuildView(w);
    const double rebuildMs = (NowMsHost() - t0) / kRebuilds;
    static unsigned char nav[kUNavCells], occ[kUPathMaxCells];
    constexpr int kNav = 200, kOcc = 2000;
    volatile unsigned sink = 0;
    t0 = NowMsHost();
    for (int i = 0; i < kNav; ++i) {
        WorldTAB::CopyBoxBlocked(0.5f - kUNavRadCells, 0.5f - kUNavRadCells, kUNavSide, kUNavCellTiles,
                                 kUOccPlayerHalfEdge + 0.15f, true, nav);
        sink += nav[i % kUNavCells];
    }
    const double navMs = (NowMsHost() - t0) / kNav;
    t0 = NowMsHost();
    for (int i = 0; i < kOcc; ++i) {
        const float ox = 0.37f - kUPathMaxRadCells * kUPathCellTiles + (i % 7) * 0.13f;
        WorldTAB::CopyBoxBlocked(ox, ox, kUPathMaxSide, kUPathCellTiles, kUOccPlayerHalfEdge, true, occ);
        sink += occ[i % kUPathMaxCells];
    }
    const double occMs = (NowMsHost() - t0) / kOcc;
#ifdef HARNESS_NAV_FOUNDATION
    // navCollisionRule=game: the whole-tile square window FillOccGrid adds per publish.
    static unsigned char squares[kUOccSquareCells];
    t0 = NowMsHost();
    for (int i = 0; i < kOcc; ++i) {
        WorldTAB::CopyBoxBlocked(-13.5f, -13.5f, kUOccSquareSide, 1.f, 0.f, true, squares);
        sink += squares[i % kUOccSquareCells];
    }
    const double squaresMs = (NowMsHost() - t0) / kOcc;
    // Every rule: the ground <Speed> copy FillOccGrid adds per publish.
    static float speeds[kUOccSquareCells];
    t0 = NowMsHost();
    for (int i = 0; i < kOcc; ++i) {
        WorldTAB::CopyTileSpeeds(-14, -14, kUOccSquareSide, speeds);
        sink += static_cast<unsigned>(speeds[i % kUOccSquareCells]);
    }
    const double speedsMs = (NowMsHost() - t0) / kOcc;
    const char* rule = Movement::Collision::RuleName(Movement::Collision::GetRule());
#else
    const double squaresMs = 0, speedsMs = 0;
    const char* rule = "legacy";
#endif
    std::printf("{\"scenario\":\"bench_raster\",\"rule\":\"%s\",\"view_entries\":%zu,\"rebuild_ms\":%.3f,"
                "\"fill_nav_grid_ms\":%.3f,\"fill_occ_grid_ms\":%.4f,\"fill_occ_squares_ms\":%.4f,"
                "\"copy_tile_speeds_ms\":%.4f}\n",
                rule, g_view.size(), rebuildMs, navMs, occMs, squaresMs, speedsMs);
}
void BenchNav()
{
    World w; BuildBenchWorld(w, 7);
    // A lava ring around the far goal: only a route across damaging ground reaches it.
    for (int y = -12; y <= 12; ++y)
        for (int x = 48; x <= 72; ++x)
            if (std::max(std::abs(x - 60), std::abs(y)) == 10) { w.SetGround(x, y, kLava); w.objs.erase(Key(x, y)); }
    g_world = &w;
    RebuildView(w);
    static Path::PlannerSnapshot snap{};
    snap.settings.safeWalk = true;
    snap.player = { 0.5f, 0.5f };
    snap.moveBudget = 1.2f;
    snap.speed = 0.006f;
    snap.navActive = true;
    snap.navGrid.center = { 0.5f, 0.5f };
#ifdef HARNESS_NAV_FOUNDATION
    snap.collisionRule = Movement::Collision::GetRule();
    const bool gameRule = snap.collisionRule == Movement::Collision::Rule::Game;
    const char* rule = Movement::Collision::RuleName(snap.collisionRule);
#else
    const bool gameRule = false;
    const char* rule = "legacy";
#endif
    // FillNavGrid: the player box plus padding (legacy), the bare square (game).
    WorldTAB::CopyBoxBlocked(0.5f - kUNavRadCells, 0.5f - kUNavRadCells, kUNavSide, kUNavCellTiles,
                             gameRule ? 0.f : kUOccPlayerHalfEdge + 0.15f, true, snap.navGrid.flags);
    for (auto& f : snap.navGrid.flags) if (f & 0x8) f |= 0x1;
    static Path::PlanResult plan{};
    auto bench = [&](Vec2 goal, const char* label) {
        snap.navGoal = goal;
        constexpr int kRuns = 100;
        double sum = 0, mx = 0;
        int pops = 0; bool found = false, partial = false;
        for (int i = 0; i < kRuns; ++i) {
            const double t0 = NowMsHost();
            Path::Compute(snap, plan);
            const double ms = NowMsHost() - t0;
            sum += ms; mx = std::max(mx, ms);
            pops = plan.navPops; found = plan.navFound; partial = plan.navPartial;
        }
        std::printf("{\"scenario\":\"bench_nav_%s\",\"rule\":\"%s\",\"compute_ms_avg\":%.3f,\"compute_ms_max\":%.3f,"
                    "\"pops\":%d,\"found\":%d,\"partial\":%d}\n", label,
                    rule, sum / kRuns, mx, pops, found, partial);
    };
    bench({ -60.5f, 30.5f }, "open60");
    bench({ 60.5f, 0.5f }, "hazard_ring");
}

} // namespace H

int main(int argc, char** argv)
{
    const std::string only = argc > 1 ? argv[1] : "";
    const int scanMode = argc > 2 ? std::atoi(argv[2]) : 0;
#ifdef HARNESS_NAV_FOUNDATION
    if (argc > 3) Movement::Collision::SetRuleText(argv[3]);
#endif
    auto want = [&](const char* n) { return only.empty() || only == n; };
    if (only == "bench_raster") { H::BenchRaster(); return 0; }
    if (only == "bench_nav")    { H::BenchNav(); return 0; }
    if (want("a_lake_deep_speed"))  H::ScenarioLake("a_lake_deep_speed", H::kDeepWaterSpeed);
    if (want("a_lake_deep_plain"))  H::ScenarioLake("a_lake_deep_plain", H::kDeepWaterPlain);
    if (want("a_lake_shallow"))     H::ScenarioLake("a_lake_shallow", H::kShallowWater);
    if (want("a_river_deep_speed")) H::ScenarioRiver("a_river_deep_speed", H::kDeepWaterSpeed);
    if (want("a_river_shallow"))    H::ScenarioRiver("a_river_shallow", H::kShallowWater);
    if (want("b_tree_cluster"))     H::ScenarioTrees("b_tree_cluster", 7);
    if (want("b_tree_cluster2"))    H::ScenarioTrees("b_tree_cluster2", 1234);
    if (want("c_u_wall"))           H::ScenarioU("c_u_wall");
    if (want("c_u_wall_lock"))      H::ScenarioULock("c_u_wall_lock");
    if (want("d_boss_open_rings"))  H::ScenarioBoss("d_boss_open_rings", false, 8, 1000, false);
    if (want("d_boss_wall_rings"))  H::ScenarioBoss("d_boss_wall_rings", true, 8, 1000, false);
    if (want("d_boss_open_dense"))  H::ScenarioBoss("d_boss_open_dense", false, 16, 800, true);
    if (want("d_boss_wall_dense"))  H::ScenarioBoss("d_boss_wall_dense", true, 16, 800, true);
    if (want("e_corridor1_nowalk")) H::ScenarioCorridor("e_corridor1_nowalk", 1, false);
    if (want("e_corridor1_fullocc"))H::ScenarioCorridor("e_corridor1_fullocc", 1, true);
    if (want("e_corridor2_fullocc"))H::ScenarioCorridor("e_corridor2_fullocc", 2, true);
    if (want("n_rooms1_nowalk_forward")) H::ScenarioConnectedRooms("n_rooms1_nowalk_forward", 1, false, false);
    if (want("n_rooms1_nowalk_reverse")) H::ScenarioConnectedRooms("n_rooms1_nowalk_reverse", 1, false, true);
    if (want("n_rooms2_nowalk_forward")) H::ScenarioConnectedRooms("n_rooms2_nowalk_forward", 2, false, false);
    if (want("n_rooms2_nowalk_reverse")) H::ScenarioConnectedRooms("n_rooms2_nowalk_reverse", 2, false, true);
    if (want("n_rooms1_fullocc_forward")) H::ScenarioConnectedRooms("n_rooms1_fullocc_forward", 1, true, false);
    if (want("n_rooms1_fullocc_reverse")) H::ScenarioConnectedRooms("n_rooms1_fullocc_reverse", 1, true, true);
    if (want("n_rooms2_fullocc_forward")) H::ScenarioConnectedRooms("n_rooms2_fullocc_forward", 2, true, false);
    if (want("n_rooms2_fullocc_reverse")) H::ScenarioConnectedRooms("n_rooms2_fullocc_reverse", 2, true, true);
    if (want("n_rooms_reveal_forward")) H::ScenarioConnectedRooms("n_rooms_reveal_forward", 1, false, false, true);
    if (want("n_rooms_reveal_reverse")) H::ScenarioConnectedRooms("n_rooms_reveal_reverse", 1, false, true, true);
    if (want("n_rooms_remote_forward")) H::ScenarioRemoteDoorway("n_rooms_remote_forward", false);
    if (want("n_rooms_remote_reverse")) H::ScenarioRemoteDoorway("n_rooms_remote_reverse", true);
    if (want("f_damaging_row"))     H::ScenarioDamagingRow("f_damaging_row");
    if (want("g_fullocc_gap"))      H::ScenarioFullOccupyGap("g_fullocc_gap");
    if (want("h_learned_keepout"))  H::ScenarioLearnedKeepout("h_learned_keepout");
    if (want("j_hidden_blocker"))   H::ScenarioHiddenBlocker("j_hidden_blocker");
    if (want("k_slowed_midwalk"))   H::ScenarioSlowedMidWalk("k_slowed_midwalk");
    if (want("k_paralyzed_midwalk"))H::ScenarioParalyzedMidWalk("k_paralyzed_midwalk");
    if (want("k_water_midpath"))    H::ScenarioWaterMidPath("k_water_midpath");
    if (want("k_dodge_in_water"))   H::ScenarioDodgeInWater("k_dodge_in_water");
    if (want("k_speedy_walk"))      H::ScenarioSpeedyWalk("k_speedy_walk");
    if (want("k_slowed_water"))     H::ScenarioSlowedWater("k_slowed_water");
    if (want("k_mixed_water_land")) H::ScenarioMixedWaterLand("k_mixed_water_land");
    if (want("l_walk_past_shotgun"))H::ScenarioWalkPastShotgun("l_walk_past_shotgun");
    if (want("l_walk_past_bomber")) H::ScenarioWalkPastBomber("l_walk_past_bomber");
    if (want("l_lock_boss_dies"))   H::ScenarioLockBossChange("l_lock_boss_dies", true);
    if (want("l_lock_boss_invuln")) H::ScenarioLockBossChange("l_lock_boss_invuln", false);
    if (want("m_pinch_nowalk"))     H::ScenarioDiagonalPinch("m_pinch_nowalk", H::PinchWall::NoWalk);
    if (want("m_pinch_fulloccupy")) H::ScenarioDiagonalPinch("m_pinch_fulloccupy", H::PinchWall::FullOccupy);
    if (want("m_pinch_object"))     H::ScenarioDiagonalPinch("m_pinch_object", H::PinchWall::OccupySquare);
    if (want("z_moveto_no_clamp"))  H::ScenarioMoveToNoClamp("z_moveto_no_clamp");
    if (scanMode != 0) {
        H::g_tileScanMode = scanMode;
        if (want("i_tilelist_revisit"))  H::ScenarioTileList("i_tilelist_revisit", true);
        if (want("i_tilelist_frontier")) H::ScenarioTileList("i_tilelist_frontier", false);
        H::g_tileScanMode = 0;
    }
    return 0;
}
