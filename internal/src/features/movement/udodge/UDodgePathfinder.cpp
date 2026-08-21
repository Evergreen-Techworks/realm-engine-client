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
// g(cell) IS THE ARRIVAL TIME (ms) along the route — the Dijkstra cost is TIME,
// not distance (speed-aware / time-expanded search).
float   s_cost[kUPathMaxCells];   // best known ARRIVAL TIME (ms) at the cell
int     s_prev[kUPathMaxCells];   // predecessor cell index (path reconstruction)
uint8_t s_done[kUPathMaxCells];   // 1 = finalized (popped) this pass
uint8_t s_eval[kUPathMaxCells];   // 0 = unevaluated, 1 = blocked, 2 = open
uint8_t s_goal[kUPathMaxCells];   // 1 = durable-safe goal cell (open + PointSafety ≥ margin + disk gate)
float   s_safe[kUPathMaxCells];   // cached spatial Core::PointSafety (goal test + partial-route metric)
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

// ── Arrival-time temporal prediction (REUSES the plan-64 solver model) ───────
// The immediate layer (UDodgeSolver TempCtx/TemporalPathClear) predicts each
// bullet's position over a bounded horizon from the plain lane polyline
// (points[] + pointTimesMs[]) and checks a swept segment so a fast bullet cannot
// tunnel between samples. The pathfinder re-implements that same model here (the
// solver's copy lives in an anonymous namespace; the worker cannot include it and
// must stay pure plain-data) to answer: is a cell SAFE AT ITS ARRIVAL TIME?
constexpr int   kTSamples   = kUTemporalSteps + 1;                 // 6 samples incl. t=0
constexpr float kTHorizonMs = kUTemporalSteps * kUTemporalStepMs;  // 500 ms bounded horizon

// Culled temporal context: for each RELEVANT lane, the bullet's predicted position
// at each march sample (0..horizon in kUTemporalStepMs steps) and its effective hit
// half. Built ONCE per Compute; read per candidate edge. Worker-thread scratch.
int   s_tcCount = 0;
Vec2  s_tcPos[kMaxProjectiles][kTSamples];
float s_tcHalf[kMaxProjectiles];

// Sample one lane's bullet position at each march time by interpolating its
// spacetime polyline (points + pointTimesMs). Beyond the traced horizon the
// position clamps to the last traced point (conservative — never invents "safe").
void SampleLaneOverTime(const LaneThreat& L, Vec2* outPos)
{
    const int cnt = L.pointCount;
    if (cnt <= 0) { for (int k = 0; k < kTSamples; ++k) outPos[k] = Vec2{}; return; }
    if (cnt == 1) { for (int k = 0; k < kTSamples; ++k) outPos[k] = L.points[0]; return; }

    int seg = 0;
    for (int k = 0; k < kTSamples; ++k) {
        const float t = static_cast<float>(k) * kUTemporalStepMs;
        while (seg + 1 < cnt - 1 && t > L.pointTimesMs[seg + 1]) ++seg;
        const float t0 = L.pointTimesMs[seg];
        const float t1 = L.pointTimesMs[seg + 1];
        if (t <= t0)       outPos[k] = L.points[seg];
        else if (t >= t1)  outPos[k] = L.points[seg + 1];     // clamp at path end
        else {
            const float f = (t - t0) / std::max(t1 - t0, 1e-3f);
            outPos[k] = Add(L.points[seg], Mul(Sub(L.points[seg + 1], L.points[seg]), f));
        }
    }
}

// Predict every lane once and CULL lanes whose whole traced path stays outside the
// search window (they can never intersect any reachable cell). The window reaches
// kUPathMaxRadCells cells; a lane matters only if it passes within that extent
// (+ margin) of the player over the horizon.
void BuildTempCtx(const PlannerSnapshot& s)
{
    s_tcCount = 0;
    const DangerMap& m = s.map;
    const float hitScale = std::clamp(s.settings.hitScale, 0.25f, 2.5f);
    const float cull = kUPathMaxRadCells * kUPathCellTiles + kUTemporalCullTiles;
    for (int i = 0; i < m.laneCount && s_tcCount < kMaxProjectiles; ++i) {
        const LaneThreat& L = m.lanes[i];
        if (L.pointCount <= 0) continue;
        Vec2 samples[kTSamples];
        SampleLaneOverTime(L, samples);
        float minD = kHugeClearance;
        for (int k = 0; k < kTSamples; ++k)
            minD = std::min(minD, Len(Sub(samples[k], s.player)));
        if (minD > cull) continue;                       // far/receding — irrelevant to the window
        const int idx = s_tcCount++;
        for (int k = 0; k < kTSamples; ++k) s_tcPos[idx][k] = samples[k];
        s_tcHalf[idx] = std::clamp(L.hitHalf, 0.05f, 2.5f) * hitScale + kUPlayerHalf;
    }
}

// Bullet position at arbitrary time t (ms), interpolated within the fixed march
// grid. Clamped to [0, horizon]: beyond the horizon we hold the last sample
// (conservative — the pattern is assumed frozen where prediction runs out).
Vec2 BulletPosAt(int li, float tMs)
{
    if (tMs <= 0.f)          return s_tcPos[li][0];
    if (tMs >= kTHorizonMs)  return s_tcPos[li][kUTemporalSteps];
    const float g = tMs / kUTemporalStepMs;
    const int   k = static_cast<int>(g);
    const float f = g - static_cast<float>(k);
    return Add(s_tcPos[li][k], Mul(Sub(s_tcPos[li][k + 1], s_tcPos[li][k]), f));
}

// ARRIVAL-TIME SAFETY: the player walks A→B, leaving A at tA and arriving B at tB.
// Over that interval each bullet sweeps from BulletPosAt(tA) to BulletPosAt(tB);
// the swept-segment min-Chebyshev to the destination cell B (treating the player
// as at B — conservative) must exceed the effective hit half + kUPocketMargin, or
// a bullet is at B when the player is there. Swept (not endpoint-only) so a fast
// bullet cannot tunnel across B between the two arrival times. Reuses the exact
// swept test the immediate temporal layer uses.
bool ArrivalClear(Vec2 B, float tA, float tB)
{
    for (int li = 0; li < s_tcCount; ++li) {
        const float half = s_tcHalf[li] + kUPocketMargin;
        const Vec2  b0 = BulletPosAt(li, tA);
        const Vec2  b1 = BulletPosAt(li, tB);
        if (MinChebOnSegment(b0.x - B.x, b0.y - B.y,
                             b1.x - B.x, b1.y - B.y) <= half) return false;
    }
    return true;
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

struct Ctx {
    const PlannerSnapshot* s = nullptr;
    MapInput mi{};            // .env NULL, .map aliases the plain snapshot copy — plain-data only
    bool  diskActive = false;
    Vec2  diskCenter{};
    float diskLimit = 0.f;    // weaponRange + slack
    float timePerTile = 0.f;  // ms to cross one tile at the player's speed (edge-cost scale)
};

// Lazily classify a cell the first time Dijkstra reaches it. Records occupancy,
// the spatial PointSafety (used ONLY for the durable-goal test and the partial
// best-safety metric — NOT as a traversal penalty; traversal is gated in TIME by
// ArrivalClear, so a cell a bullet's forward path merely crosses is still
// traversable if the bullet is not there when the player arrives), and whether the
// cell is a durable-safe goal (PointSafety ≥ margin, inside the disk when locked).
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
    s_safe[idx] = safety;
    bool goalOk = safety >= kUPocketMargin;
    if (goalOk && c.diskActive)
        goalOk = Len(Sub(w, c.diskCenter)) <= c.diskLimit;
    s_goal[idx] = goalOk ? 1 : 0;
    s_eval[idx] = 2;
}

constexpr int kDx[8] = { 1, -1, 0,  0, 1,  1, -1, -1 };
constexpr int kDy[8] = { 0,  0, 1, -1, 1, -1,  1, -1 };

// Minimum spatial-safety improvement (tiles) over the start position for a cell to
// qualify as the target of a PARTIAL route when no durable pocket is time-reachable
// — avoids emitting a route for a negligibly-safer cell. Baked (no user setting).
constexpr float kPartialGainTiles = 0.15f;

// One TIME-EXPANDED Dijkstra pass bounded to a window of `curRad` cells (Chebyshev)
// around the center. The cost is ARRIVAL TIME (ms): edge A→B costs
// dist(A,B) × timePerTile, so g(cell) is when the player reaches it moving at real
// speed. A neighbour is relaxed only if it is SAFE AT ITS ARRIVAL TIME (ArrivalClear
// over [g(A), g(B)]) — the route can never require standing where a bullet is. The
// search prefers the durable goal reachable SOONEST (min arrival time). It also
// tracks the safest reachable-in-time non-goal cell (partialIdx/partialSafety) for
// graceful degradation. Returns the goal cell index (or -1); adds pops.
int SearchPass(const Ctx& c, int curRad, int& pops,
               int& partialIdx, float& partialSafety, float startSafety)
{
    for (int i = 0; i < kUPathMaxCells; ++i) {
        s_cost[i] = kHugeClearance; s_prev[i] = -1; s_done[i] = 0; s_eval[i] = 0;
    }
    HeapClear();
    partialIdx = -1;
    partialSafety = startSafety + kPartialGainTiles;   // only a MEANINGFULLY safer cell qualifies

    const Vec2 center = c.s->grid.center;
    const int start = Idx(kR, kR);
    // The start (player cell) is always expandable, even if a wall/enemy sample
    // lands on it momentarily — treat it as open ground so the search can leave.
    s_eval[start] = 2; s_safe[start] = startSafety; s_goal[start] = 0;
    s_cost[start] = 0.f;                                // arrival time at the start = 0
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
            break;                                 // durable-safe cell reached SOONEST — early exit
        }
        // Track the safest reachable-in-time cell for the graceful-degradation route.
        if (cur != start && s_eval[cur] == 2 && s_safe[cur] > partialSafety) {
            partialSafety = s_safe[cur];
            partialIdx    = cur;
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
            // Edge cost is TIME: how long the player takes to cross this edge.
            const float tB = s_cost[cur] + stepDist * c.timePerTile;
            // SPEED-AWARE GATE: only walk into B if the player, arriving at tB
            // (having left cur at s_cost[cur]), is clear of every bullet there.
            const Vec2 wB = CellWorld(center, nx, ny);
            if (!ArrivalClear(wB, s_cost[cur], tB)) continue;
            if (tB < s_cost[ni]) {
                s_cost[ni] = tB;
                s_prev[ni] = cur;
                HeapPush(tB, ni);
            }
        }
    }
    return found;
}

// Run the expanding time-expanded search and, on success, reconstruct the route
// into `out`. diskActive gates GOAL cells to the weapon-range disk. When no durable
// pocket is time-reachable, degrades to a partial route toward the safest
// reachable-in-time cell (out.partial). `startSafety` = PointSafety at the player.
void RunSearch(const PlannerSnapshot& s, bool diskActive, float startSafety, PlanResult& out)
{
    Ctx c;
    c.s = &s;
    c.mi.player   = s.player;
    c.mi.settings = s.settings;
    c.mi.map      = &s.map;     // plain-data alias; .env stays NULL
    c.diskActive  = diskActive;
    c.diskCenter  = s.lockPos;
    c.diskLimit   = s.weaponRangeTiles + kUInRangeSlack;
    // PLAYER SPEED enters here: moveBudget = tiles per server tick = speed ×
    // kServerTickSec, so tiles/ms = moveBudget / (kServerTickSec × 1000) and the
    // time to cross one tile is its reciprocal. This is the edge-cost scale that
    // turns the distance grid into an ARRIVAL-TIME grid.
    c.timePerTile = kServerTickSec * 1000.f / std::max(s.moveBudget, 1e-3f);

    int rad = kUPathBaseRadCells;
    int goal = -1;
    int usedRad = rad;
    bool expanded = false;
    int   partialIdx = -1;
    float partialSafety = 0.f;
    for (;;) {
        goal = SearchPass(c, rad, out.pops, partialIdx, partialSafety, startSafety);
        usedRad = rad;
        if (goal >= 0) break;
        if (rad >= kUPathMaxRadCells) break;
        rad = std::min(rad + kUPathRadStepCells, kUPathMaxRadCells);
        expanded = true;
    }
    out.radiusCells = usedRad;
    out.expanded    = expanded;

    // GRACEFUL DEGRADATION: no durable pocket reachable in time → head to the
    // safest reachable-in-time cell instead (the arrays hold the last, widest pass).
    const bool isPartial = (goal < 0);
    const int  target    = isPartial ? partialIdx : goal;
    if (target < 0) { out.found = false; return; }   // nothing better than standing — pure reflex

    // Reconstruct the route (target → start), then reverse into forward order.
    const Vec2 center = s.grid.center;
    int n = 0;
    for (int cc = target; cc >= 0 && n < kUPathMaxCells; cc = s_prev[cc]) {
        s_path[n++] = cc;
        if (cc == Idx(kR, kR)) break;   // reached the start cell
    }
    for (int i = 0, j = n - 1; i < j; ++i, --j) std::swap(s_path[i], s_path[j]);

    out.found       = true;
    out.partial     = isPartial;
    out.goalArriveMs = s_cost[target];   // predicted arrival TIME along the route (ms)
    out.waypoints   = n;
    out.goalPos     = CellWorld(center, target % kS, target / kS);

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
}

} // namespace

void Compute(const PlannerSnapshot& in, PlanResult& out)
{
    out = PlanResult{};
    out.forSeq = in.seq;

    // Is the player cell itself already a durable-safe goal? (Cheap short-circuit
    // — no route needed; the game thread decides whether to hold.)
    MapInput mi{};
    mi.player = in.player; mi.settings = in.settings; mi.map = &in.map;
    const float startSafety = Core::PointSafety(mi, in.player);
    {
        bool startGoal = startSafety >= kUPocketMargin;
        if (startGoal && in.hasLock && in.weaponRangeTiles > 0.f)
            startGoal = Len(Sub(in.player, in.lockPos)) <= in.weaponRangeTiles + kUInRangeSlack;
        if (startGoal) { out.startIsGoal = true; return; }
    }

    // Predict every relevant bullet's trajectory ONCE (culled to the window) so the
    // arrival-time safety gate is cheap per candidate edge. Plain-data — reuses the
    // lane pointTimesMs already in the snapshot's DangerMap copy; no IL2CPP.
    BuildTempCtx(in);

    // IN-RANGE DISK: locked boss gates GOAL cells to the weapon-range disk so the
    // route keeps the boss hittable. Safety OVERRIDES range: if no in-range durable
    // pocket is time-reachable, re-search UNCONSTRAINED (leave range to dodge,
    // return once clear); failing that, degrade to a partial route toward safety.
    const bool disk = in.hasLock && in.weaponRangeTiles > 0.f;

    PlanResult primary{};
    primary.forSeq = in.seq;
    RunSearch(in, disk, startSafety, primary);
    if (primary.found && !primary.partial) {          // durable in-range pocket, time-feasible
        primary.tempLanes = s_tcCount;
        out = primary;
        return;
    }

    if (disk) {
        PlanResult unc{};
        unc.forSeq = in.seq;
        RunSearch(in, false, startSafety, unc);
        if (unc.found && !unc.partial) {              // durable pocket only outside range
            unc.outOfRange = true;
            unc.tempLanes  = s_tcCount;
            out = unc;
            return;
        }
        // No durable pocket anywhere → prefer the unconstrained partial (it explores
        // the wider manifold), else the in-range partial, else pure reflex.
        if (unc.found)          { unc.tempLanes = s_tcCount;     out = unc;     return; }
        if (primary.found)      { primary.tempLanes = s_tcCount; out = primary; return; }
        out.tempLanes = s_tcCount;
        return;
    }

    // Unlocked: primary is a durable-goal (handled above) or a partial route / nothing.
    primary.tempLanes = s_tcCount;
    out = primary;
}

} } // namespace UDodge::Path
