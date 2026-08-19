#include "pch-il2cpp.h"
#include "UDodgeField.h"
#include "UDodgeCore.h"   // Core::PointDwellClear — the goal probe

#include <algorithm>
#include <cmath>

namespace UDodge { namespace Field {
namespace {

constexpr int   kRad        = 10;            // cells from centre (±5 tiles)
constexpr int   kSize       = kRad * 2 + 1;  // 21
constexpr int   kCells      = kSize * kSize; // 441
constexpr float kCellTiles  = 0.5f;          // cell size in tiles
constexpr float kHazardCost = 40.f;          // discourage routing through hazard ground
constexpr float kZoneCost   = 25.f;          // pending-zone cells cost more (plan 46)
constexpr float kLaneCost   = 60.f;          // danger-lane cells cost more (plan 46)
constexpr float kHoldMs     = 250.f;         // goal must be safe to stand this long
constexpr float kRoot2      = 1.41421356f;
constexpr float kInf        = 3.402823466e+38f;

int Idx(int gx, int gy) { return gy * kSize + gx; }

// Dijkstra scratch. The dodge runs only on the game-update thread, so static
// reuse is safe and keeps the search allocation-free.
float s_cost[kCells];
float s_dist[kCells];
int   s_prev[kCells];
bool  s_done[kCells];

// Scratch for the instantaneous overload (plan 46) — no arrival distances.
float s_mCost[kCells];
int   s_mPrev[kCells];
bool  s_mDone[kCells];

Vec2 CellWorld(Vec2 player, int gx, int gy)
{
    return { player.x + static_cast<float>(gx - kRad) * kCellTiles,
             player.y + static_cast<float>(gy - kRad) * kCellTiles };
}

// Walls only — pass safeWalk=false so hazard does not read as a wall; hazard
// keeps its cost-penalty role in the step relaxation below.
bool IsWall(const CoreInput& in, float x, float y)
{
    return !in.env.canOccupy || !in.env.canOccupy(x, y, false);
}

bool IsHazard(const CoreInput& in, float x, float y)
{
    return in.env.isHazard && in.env.isHazard(x, y);
}

// MapInput flavors for the instantaneous overload (plan 46).
bool IsWall(const MapInput& in, float x, float y)
{
    return !in.env.canOccupy || !in.env.canOccupy(x, y, false);
}

bool IsHazard(const MapInput& in, float x, float y)
{
    return in.env.isHazard && in.env.isHazard(x, y);
}

// Min over the lane polyline of Chebyshev distance from p (local copy — the
// core's helper has internal linkage in its own TU).
float LaneDistCheb(const LaneThreat& L, Vec2 p)
{
    if (L.pointCount <= 0) return kHugeClearance;
    if (L.pointCount == 1) return Cheb(L.points[0].x - p.x, L.points[0].y - p.y);
    float best = kHugeClearance;
    for (int j = 0; j + 1 < L.pointCount; ++j) {
        const Vec2 a = L.points[j];
        const Vec2 b = L.points[j + 1];
        best = std::min(best, MinChebOnSegment(a.x - p.x, a.y - p.y,
                                               b.x - p.x, b.y - p.y));
    }
    return best;
}

} // namespace

EscapeResult FindEscape(const CoreInput& in, float speedTilesPerMs)
{
    EscapeResult res{};
    const Vec2 player = in.player;
    const float speed = speedTilesPerMs;

    for (int i = 0; i < kCells; ++i) {
        s_cost[i] = kInf; s_dist[i] = kInf; s_prev[i] = -1; s_done[i] = false;
    }

    const int start = Idx(kRad, kRad);
    s_cost[start] = 0.f;
    s_dist[start] = 0.f;

    static constexpr int kDx[8] = { 1, -1, 0,  0, 1,  1, -1, -1 };
    static constexpr int kDy[8] = { 0,  0, 1, -1, 1, -1,  1, -1 };

    int goal = -1;
    for (int iter = 0; iter < kCells; ++iter) {
        // Pop the lowest-cost unfinished cell (linear scan — the grid is small
        // and the loop early-exits at the first goal, so this stays cheap).
        int cur = -1;
        float best = kInf;
        for (int i = 0; i < kCells; ++i)
            if (!s_done[i] && s_cost[i] < best) { best = s_cost[i]; cur = i; }
        if (cur < 0) break;
        s_done[cur] = true;

        const int cgx = cur % kSize, cgy = cur / kSize;
        const float arrivalMs = s_dist[cur] / speed;

        // Goal = a non-start cell we can safely stand on for the hold window.
        if (cur != start &&
            Core::PointDwellClear(in, CellWorld(player, cgx, cgy), arrivalMs, kHoldMs)) {
            goal = cur;
            break;
        }

        for (int k = 0; k < 8; ++k) {
            const int nx = cgx + kDx[k], ny = cgy + kDy[k];
            if (nx < 0 || nx >= kSize || ny < 0 || ny >= kSize) continue;
            const int ni = Idx(nx, ny);
            if (s_done[ni]) continue;
            const Vec2 nw = CellWorld(player, nx, ny);
            if (IsWall(in, nw.x, nw.y)) continue;   // never route through a wall
            if (kDx[k] != 0 && kDy[k] != 0) {
                // No corner-cutting: a diagonal step is only valid if BOTH
                // orthogonal cells it passes between are open, else the route
                // would clip a wall corner the game would refuse / wall-slide.
                const Vec2 ox = CellWorld(player, cgx + kDx[k], cgy);
                const Vec2 oy = CellWorld(player, cgx, cgy + kDy[k]);
                if (IsWall(in, ox.x, ox.y) || IsWall(in, oy.x, oy.y)) continue;
            }
            const float stepDist = (kDx[k] != 0 && kDy[k] != 0) ? kCellTiles * kRoot2 : kCellTiles;
            float penalty = 0.f;
            if (in.settings.safeWalk && IsHazard(in, nw.x, nw.y)) penalty += kHazardCost;
            const float nc = s_cost[cur] + stepDist + penalty;
            if (nc < s_cost[ni]) {
                s_cost[ni] = nc;
                s_dist[ni] = s_dist[cur] + stepDist;
                s_prev[ni] = cur;
            }
        }
    }

    if (goal < 0) return res;

    // Reconstruct back to the cell adjacent to the start; that is the first step.
    int step = goal;
    while (s_prev[step] != start && s_prev[step] != -1) step = s_prev[step];
    const int sgx = step % kSize, sgy = step / kSize;
    const Vec2 stepWorld = CellWorld(player, sgx, sgy);

    // Guard the immediate move: the first step itself must be safe to stand on
    // right now, else defer to the caller's least-bad fallback.
    const float stepArrMs = s_dist[step] / speed;
    if (!Core::PointDwellClear(in, stepWorld, stepArrMs, 0.f)) return res;

    res.found = true;
    res.target = stepWorld;
    res.firstDir = Normalize(Sub(stepWorld, player));
    return res;
}

// Instantaneous overload (plan 46): same grid and wall rules, but the goal is
// pure spatial — the first popped cell the player could stand on RIGHT NOW.
// Danger is EXPENSIVE but traversable (only walls block): transit through a
// lane or pending zone may be the only way out of a boxed-in room, so it
// costs extra instead of blocking; the endpoint itself must be clear.
EscapeResult FindEscape(const MapInput& in)
{
    EscapeResult res{};
    if (!in.map) return res;
    const Vec2 player = in.player;
    const float hitScale = std::clamp(in.settings.hitScale, 0.25f, 2.5f);

    for (int i = 0; i < kCells; ++i) {
        s_mCost[i] = kInf; s_mPrev[i] = -1; s_mDone[i] = false;
    }

    const int start = Idx(kRad, kRad);
    s_mCost[start] = 0.f;

    static constexpr int kDx[8] = { 1, -1, 0,  0, 1,  1, -1, -1 };
    static constexpr int kDy[8] = { 0,  0, 1, -1, 1, -1,  1, -1 };

    int goal = -1;
    for (int iter = 0; iter < kCells; ++iter) {
        // Pop the lowest-cost unfinished cell (linear scan — the grid is small
        // and the loop early-exits at the first goal, so this stays cheap).
        int cur = -1;
        float best = kInf;
        for (int i = 0; i < kCells; ++i)
            if (!s_mDone[i] && s_mCost[i] < best) { best = s_mCost[i]; cur = i; }
        if (cur < 0) break;
        s_mDone[cur] = true;

        const int cgx = cur % kSize, cgy = cur / kSize;

        // Goal = a non-start cell the player could stand on right now.
        if (cur != start && Core::PointClear(in, CellWorld(player, cgx, cgy))) {
            goal = cur;
            break;
        }

        for (int k = 0; k < 8; ++k) {
            const int nx = cgx + kDx[k], ny = cgy + kDy[k];
            if (nx < 0 || nx >= kSize || ny < 0 || ny >= kSize) continue;
            const int ni = Idx(nx, ny);
            if (s_mDone[ni]) continue;
            const Vec2 nw = CellWorld(player, nx, ny);
            if (IsWall(in, nw.x, nw.y)) continue;   // never route through a wall
            if (kDx[k] != 0 && kDy[k] != 0) {
                // No corner-cutting: a diagonal step is only valid if BOTH
                // orthogonal cells it passes between are open, else the route
                // would clip a wall corner the game would refuse / wall-slide.
                const Vec2 ox = CellWorld(player, cgx + kDx[k], cgy);
                const Vec2 oy = CellWorld(player, cgx, cgy + kDy[k]);
                if (IsWall(in, ox.x, ox.y) || IsWall(in, oy.x, oy.y)) continue;
            }
            const float stepDist = (kDx[k] != 0 && kDy[k] != 0) ? kCellTiles * kRoot2 : kCellTiles;
            float penalty = 0.f;
            if (in.settings.safeWalk && IsHazard(in, nw.x, nw.y)) penalty += kHazardCost;
            // Pending zones and danger lanes: cost, never a block.
            for (int zi = 0; zi < in.map->zoneCount; ++zi) {
                const ZoneThreat& z = in.map->zones[zi];
                if (!z.active && Len(Sub(z.pos, nw)) < z.radius) { penalty += kZoneCost; break; }
            }
            for (int li = 0; li < in.map->laneCount; ++li) {
                const LaneThreat& L = in.map->lanes[li];
                const float half = std::clamp(L.hitHalf, 0.05f, 2.5f) * hitScale;
                if (LaneDistCheb(L, nw) <= half) { penalty += kLaneCost; break; }
            }
            const float nc = s_mCost[cur] + stepDist + penalty;
            if (nc < s_mCost[ni]) {
                s_mCost[ni] = nc;
                s_mPrev[ni] = cur;
            }
        }
    }

    if (goal < 0) return res;

    // Reconstruct back to the cell adjacent to the start; that is the first step.
    int step = goal;
    while (s_mPrev[step] != start && s_mPrev[step] != -1) step = s_mPrev[step];
    const int sgx = step % kSize, sgy = step / kSize;
    const Vec2 stepWorld = CellWorld(player, sgx, sgy);

    // Guard the immediate move: the first step itself must be clear right now,
    // else defer to the caller's least-bad fallback.
    if (!Core::PointClear(in, stepWorld)) return res;

    res.found = true;
    res.target = stepWorld;
    res.firstDir = Normalize(Sub(stepWorld, player));
    return res;
}

} } // namespace UDodge::Field
