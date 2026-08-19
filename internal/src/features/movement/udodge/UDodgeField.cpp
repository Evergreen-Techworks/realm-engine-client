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

} } // namespace UDodge::Field
