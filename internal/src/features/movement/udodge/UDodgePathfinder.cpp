#include "pch-il2cpp.h"
#include "UDodgePathfinder.h"
#include "UDodgeCore.h"   // Core::PointSafety — the cheap per-cell danger (plain-data)

#include <algorithm>
#include <cmath>

// UDodge grid pathfinder (plan 65) — WORKER-THREAD compute.
//
// ─────────────────────────────────────────────────────────────────────────────
// IL2CPP-FREE ZONE. Nothing here may call il2cpp_*, read a game object, or
// dereference an Env function pointer. Compute operates ONLY on the plain-data
// PlannerSnapshot: occupancy comes from snap.grid (the game thread rasterized it),
// danger from Core::PointSafety over the plain snap.map, enemy bodies from
// snap.map.enemies. It builds a local MapInput whose `.env` is left NULL — proof
// no host probe is reachable — and whose `.map` aliases only the plain snapshot
// copy. Static scratch is safe: Compute runs on the single worker thread only.
// ─────────────────────────────────────────────────────────────────────────────
namespace UDodge { namespace Path {
namespace {

// ── Fixed scratch (worker thread only — never re-entered) ────────────────────
float   s_cost[kUPathMaxCells];   // best known cost to reach the cell
int     s_prev[kUPathMaxCells];   // predecessor cell index (path reconstruction)
uint8_t s_done[kUPathMaxCells];   // 1 = finalized (popped) this pass
uint8_t s_eval[kUPathMaxCells];   // 0 = unevaluated, 1 = blocked, 2 = open
uint8_t s_goal[kUPathMaxCells];   // 1 = durable-safe goal cell (open + PointSafety ≥ margin + disk gate)
float   s_pen[kUPathMaxCells];    // danger penalty added when ENTERING the cell
int     s_path[kUPathMaxCells];   // reconstructed route (forward order: [0] = start)

// Binary min-heap of (cost, cellIndex). Lazy Dijkstra: a cell may be pushed
// several times; the done-check on pop discards stale entries. Fixed capacity —
// a push that would overflow is dropped (bounded frontier; a route is still found
// via entries already queued).
float   s_heapCost[kUPathHeapCap];
int     s_heapIdx[kUPathHeapCap];
int     s_heapN = 0;

void HeapClear() { s_heapN = 0; }

void HeapPush(float cost, int idx)
{
    if (s_heapN >= kUPathHeapCap) return;   // bounded frontier — drop on overflow
    int i = s_heapN++;
    s_heapCost[i] = cost; s_heapIdx[i] = idx;
    while (i > 0) {
        const int p = (i - 1) / 2;
        if (s_heapCost[p] <= s_heapCost[i]) break;
        std::swap(s_heapCost[p], s_heapCost[i]);
        std::swap(s_heapIdx[p],  s_heapIdx[i]);
        i = p;
    }
}

bool HeapPop(float& cost, int& idx)
{
    if (s_heapN <= 0) return false;
    cost = s_heapCost[0]; idx = s_heapIdx[0];
    const int last = --s_heapN;
    s_heapCost[0] = s_heapCost[last]; s_heapIdx[0] = s_heapIdx[last];
    int i = 0;
    for (;;) {
        const int l = 2 * i + 1, r = 2 * i + 2;
        int m = i;
        if (l < s_heapN && s_heapCost[l] < s_heapCost[m]) m = l;
        if (r < s_heapN && s_heapCost[r] < s_heapCost[m]) m = r;
        if (m == i) break;
        std::swap(s_heapCost[m], s_heapCost[i]);
        std::swap(s_heapIdx[m],  s_heapIdx[i]);
        i = m;
    }
    return true;
}

constexpr int kR = kUPathMaxRadCells;   // center cell coordinate
constexpr int kS = kUPathMaxSide;       // grid side length

int  Idx(int gx, int gy) { return gy * kS + gx; }

Vec2 CellWorld(Vec2 center, int gx, int gy)
{
    return { center.x + static_cast<float>(gx - kR) * kUPathCellTiles,
             center.y + static_cast<float>(gy - kR) * kUPathCellTiles };
}

// Occupancy from the plain rasterized grid ALONE (no Env). Blocked = wall bit, or
// hazard bit when safeWalk is on (mirrors Sensors::CanOccupy(x,y,safeWalk) so the
// worker route and the game-thread pre-position walkability check agree).
bool GridBlocked(const OccGrid& g, bool safeWalk, int gx, int gy)
{
    if (gx < 0 || gx >= kS || gy < 0 || gy >= kS) return true;
    const uint8_t f = g.flags[gy * kS + gx];
    if (f & 0x1) return true;
    if (safeWalk && (f & 0x2)) return true;
    return false;
}

// A cell sits inside an enemy body (+ player half-extent) — a HARD no-go. Read
// from the plain snapshot enemy list (no IL2CPP).
bool EnemyBlockedLocal(const DangerMap& m, Vec2 p)
{
    for (int i = 0; i < m.enemyCount; ++i) {
        const EnemyBlocker& e = m.enemies[i];
        if (Len(Sub(p, e.pos)) < e.radius + kUPlayerHalf) return true;
    }
    return false;
}

float DangerPenalty(float safety)
{
    if (safety >= kUPocketMargin) return 0.f;         // durable-safe — free to traverse
    float pen = (kUPocketMargin - safety) * kUPathDangerW;
    if (safety < 0.f) pen += kUPathHitPenalty;        // inside the server hit region — strongly avoid
    return pen;
}

struct Ctx {
    const PlannerSnapshot* s = nullptr;
    MapInput mi{};            // .env NULL, .map aliases the plain snapshot copy — plain-data only
    bool  diskActive = false;
    Vec2  diskCenter{};
    float diskLimit = 0.f;    // weaponRange + slack
};

// Lazily classify a cell the first time Dijkstra reaches it. The whole per-cell
// cost is CHEAP spatial PointSafety — no temporal march.
void EvalCell(const Ctx& c, int idx, int gx, int gy)
{
    if (s_eval[idx]) return;
    const Vec2 w = CellWorld(c.s->grid.center, gx, gy);
    if (GridBlocked(c.s->grid, c.s->settings.safeWalk, gx, gy) ||
        EnemyBlockedLocal(c.s->map, w)) {
        s_eval[idx] = 1;
        return;
    }
    const float safety = Core::PointSafety(c.mi, w);
    s_pen[idx] = DangerPenalty(safety);
    bool goalOk = safety >= kUPocketMargin;
    if (goalOk && c.diskActive)
        goalOk = Len(Sub(w, c.diskCenter)) <= c.diskLimit;
    s_goal[idx] = goalOk ? 1 : 0;
    s_eval[idx] = 2;
}

constexpr int kDx[8] = { 1, -1, 0,  0, 1,  1, -1, -1 };
constexpr int kDy[8] = { 0,  0, 1, -1, 1, -1,  1, -1 };

// One Dijkstra pass bounded to a window of `curRad` cells (Chebyshev) around the
// center. Returns the goal cell index (or -1). Adds finalized cells to `pops`.
int SearchPass(const Ctx& c, int curRad, int& pops)
{
    for (int i = 0; i < kUPathMaxCells; ++i) {
        s_cost[i] = kHugeClearance; s_prev[i] = -1; s_done[i] = 0; s_eval[i] = 0;
    }
    HeapClear();

    const int start = Idx(kR, kR);
    // The start (player cell) is always expandable, even if a wall/enemy sample
    // lands on it momentarily — treat it as open ground so the search can leave.
    s_eval[start] = 2; s_pen[start] = 0.f; s_goal[start] = 0;
    s_cost[start] = 0.f;
    HeapPush(0.f, start);

    int found = -1;
    float cost; int cur;
    while (HeapPop(cost, cur)) {
        if (s_done[cur]) continue;                 // stale heap entry
        s_done[cur] = 1;
        ++pops;

        const int cgx = cur % kS, cgy = cur / kS;

        if (cur != start && s_eval[cur] == 2 && s_goal[cur]) {
            found = cur;
            break;                                 // nearest durable-safe cell — early exit
        }

        for (int k = 0; k < 8; ++k) {
            const int nx = cgx + kDx[k], ny = cgy + kDy[k];
            // Bound the frontier to this pass's window (radius expansion re-runs
            // with a larger curRad over the SAME fixed grid).
            if (std::max(std::abs(nx - kR), std::abs(ny - kR)) > curRad) continue;
            const int ni = Idx(nx, ny);
            if (s_done[ni]) continue;
            EvalCell(c, ni, nx, ny);
            if (s_eval[ni] == 1) continue;         // blocked — never route through it
            if (kDx[k] != 0 && kDy[k] != 0) {
                // No diagonal corner-cutting: both orthogonal neighbours must be
                // occupiable, else the route clips a wall corner the game refuses.
                const int ox = Idx(cgx + kDx[k], cgy);
                const int oy = Idx(cgx, cgy + kDy[k]);
                EvalCell(c, ox, cgx + kDx[k], cgy);
                EvalCell(c, oy, cgx, cgy + kDy[k]);
                if (s_eval[ox] == 1 || s_eval[oy] == 1) continue;
            }
            const float stepDist = (kDx[k] != 0 && kDy[k] != 0)
                                       ? kUPathCellTiles * kUPathRoot2 : kUPathCellTiles;
            const float nc = s_cost[cur] + stepDist + s_pen[ni];
            if (nc < s_cost[ni]) {
                s_cost[ni] = nc;
                s_prev[ni] = cur;
                HeapPush(nc, ni);
            }
        }
    }
    return found;
}

// Run the expanding search and, on success, reconstruct the route into `out`.
// diskActive gates goal cells to the weapon-range disk.
bool RunSearch(const PlannerSnapshot& s, bool diskActive, PlanResult& out)
{
    Ctx c;
    c.s = &s;
    c.mi.player   = s.player;
    c.mi.settings = s.settings;
    c.mi.map      = &s.map;     // plain-data alias; .env stays NULL
    c.diskActive  = diskActive;
    c.diskCenter  = s.lockPos;
    c.diskLimit   = s.weaponRangeTiles + kUInRangeSlack;

    int rad = kUPathBaseRadCells;
    int goal = -1;
    int usedRad = rad;
    bool expanded = false;
    for (;;) {
        goal = SearchPass(c, rad, out.pops);
        usedRad = rad;
        if (goal >= 0) break;
        if (rad >= kUPathMaxRadCells) break;
        rad = std::min(rad + kUPathRadStepCells, kUPathMaxRadCells);
        expanded = true;
    }
    out.radiusCells = usedRad;
    out.expanded    = expanded;
    if (goal < 0) return false;

    // Reconstruct the route (goal → start), then reverse into forward order.
    const Vec2 center = s.grid.center;
    int n = 0;
    for (int cc = goal; cc >= 0 && n < kUPathMaxCells; cc = s_prev[cc]) {
        s_path[n++] = cc;
        if (cc == Idx(kR, kR)) break;   // reached the start cell
    }
    for (int i = 0, j = n - 1; i < j; ++i, --j) std::swap(s_path[i], s_path[j]);

    out.found     = true;
    out.waypoints = n;
    out.goalPos   = CellWorld(center, goal % kS, goal / kS);

    // Copy the route polyline (world coords) for the debug overlay — bounded to
    // kMaxPathPoints. Cheap plain-data; the solver never reads it.
    out.wptCount = std::min(n, kMaxPathPoints);
    for (int i = 0; i < out.wptCount; ++i)
        out.wpts[i] = CellWorld(center, s_path[i] % kS, s_path[i] / kS);

    // Place the immediate steering target ~one budget along the route so the
    // straight per-tick drive approximates the curve. Accumulate the arc-length.
    const float b = std::max(s.moveBudget, 1e-3f);
    Vec2  cur = center;
    Vec2  stepTarget = out.goalPos;   // default (short route: head straight to goal)
    float acc = 0.f;
    bool  stepSet = false;
    for (int i = 1; i < n; ++i) {
        const Vec2 w = CellWorld(center, s_path[i] % kS, s_path[i] / kS);
        const float seg = Len(Sub(w, cur));
        if (!stepSet && acc + seg >= b) {
            const float rem = b - acc;
            const Vec2 dir = Normalize(Sub(w, cur));
            stepTarget = LenSq(dir) > 1e-6f ? Add(cur, Mul(dir, rem)) : w;
            stepSet = true;
        }
        acc += seg;
        cur = w;
    }
    out.goalDist   = acc;
    out.stepTarget = stepTarget;
    out.stepDir    = Normalize(Sub(stepTarget, center));
    if (LenSq(out.stepDir) < 1e-6f) out.found = false;   // degenerate first step — no usable route
    return out.found;
}

} // namespace

void Compute(const PlannerSnapshot& in, PlanResult& out)
{
    out = PlanResult{};
    out.forSeq = in.seq;

    // Is the player cell itself already a durable-safe goal? (Cheap short-circuit
    // — no route needed; the game thread decides whether to hold.)
    {
        MapInput mi{};
        mi.player = in.player; mi.settings = in.settings; mi.map = &in.map;
        const float safety = Core::PointSafety(mi, in.player);
        bool startGoal = safety >= kUPocketMargin;
        if (startGoal && in.hasLock && in.weaponRangeTiles > 0.f)
            startGoal = Len(Sub(in.player, in.lockPos)) <= in.weaponRangeTiles + kUInRangeSlack;
        if (startGoal) { out.startIsGoal = true; return; }
    }

    // IN-RANGE DISK: locked boss gates goal cells to the weapon-range disk so the
    // route keeps the boss hittable. Safety OVERRIDES: if no in-range safe cell
    // exists, re-search UNCONSTRAINED (leave range to dodge, return once clear).
    const bool disk = in.hasLock && in.weaponRangeTiles > 0.f;
    if (RunSearch(in, disk, out)) return;
    if (disk) {
        PlanResult unconstrained{};
        unconstrained.forSeq = in.seq;
        if (RunSearch(in, false, unconstrained)) {
            unconstrained.outOfRange = true;
            out = unconstrained;
        }
    }
}

} } // namespace UDodge::Path
