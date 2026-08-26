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
uint8_t s_tgoal[kUPathMaxCells];  // 1 = SECOND-CLASS temporal goal (finding F): not a spatial durable
                                  // pocket, but ArrivalClear over [arrival, arrival + kUDwellMs).
                                  // Only written for cells the pass actually tested (see SearchPass).
uint8_t s_pend[kUPathMaxCells];   // 1 = this cell sits inside a PENDING (telegraphed, unarmed) AoE disc
                                  // — cost-only, never a block; taints it as a goal (finding G-2)
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

// The grid cell the player currently occupies. When the grid is boss-centered
// (locked) the player is OFFSET from the center cell, so the search must start
// here — not at (kR,kR). Clamped into the grid. Chebyshev offset (cells) from the
// center is also returned so RunSearch can open its window wide enough to include
// the start on the first pass.
int PlayerCell(Vec2 player, Vec2 center, int& outChebCells)
{
    int gx = static_cast<int>(std::lround((player.x - center.x) / kUPathCellTiles)) + kR;
    int gy = static_cast<int>(std::lround((player.y - center.y) / kUPathCellTiles)) + kR;
    gx = std::clamp(gx, 0, kS - 1);
    gy = std::clamp(gy, 0, kS - 1);
    outChebCells = std::max(std::abs(gx - kR), std::abs(gy - kR));
    return Idx(gx, gy);
}

// The grid cell a WORLD position maps to, WITHOUT clamping — returns -1 when the
// position falls outside the fixed grid. Used to locate the previously-committed
// goal cell for plan-76 goal hysteresis (a prev goal outside this window is simply
// not carried forward this pass).
int GoalCellExact(Vec2 center, Vec2 p)
{
    const int gx = static_cast<int>(std::lround((p.x - center.x) / kUPathCellTiles)) + kR;
    const int gy = static_cast<int>(std::lround((p.y - center.y) / kUPathCellTiles)) + kR;
    if (gx < 0 || gx >= kS || gy < 0 || gy >= kS) return -1;
    return Idx(gx, gy);
}

// ── Arrival-time temporal prediction (shared Core::Temporal — plan 72) ───────
// The immediate solver and this worker pathfinder share ONE arrival-time
// bullet-prediction model (Core::Temporal in UDodgeCore): sample each lane's
// spacetime polyline over the bounded horizon and swept-check a candidate cell
// against every relevant bullet at its arrival time. The context is built once
// per Compute and read per candidate edge; worker-thread scratch (Compute runs
// single-threaded). Culled relative to the GRID CENTER (the boss when locked,
// else the player) so a lane threatening the far side of the disk survives even
// though it is far from the player — see plan 72 divergence note.
Core::Temporal::Ctx s_tctx;

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

// A cell sits inside an ACTIVE AoE disc — a HARD no-go of the same class as a
// wall. The traversal gate (ArrivalClear) is LANE-ONLY: Core::Temporal::Ctx has no
// zone storage, and s_safe (which does subtract active zones) feeds only the
// durable-goal test and the partial-route metric — never edge relaxation. So
// without this the route happily walks the player straight through a live blast
// disc and the comment on EvalCell claiming traversal is "gated in TIME" was
// simply not true for zones.
//
// EXCEPT a disc the PLAYER IS ALREADY STANDING IN. Blocking those would wall the
// player inside the blast — every neighbour of the start cell blocked, no route
// out at all — which is the same starvation Core::ZonePathClear's escape hatch
// exists to avoid, so the rule matches it: escape is allowed, entry is not.
//
// Free: called once per cell, memoized behind s_eval, and zoneCount is 0 in most
// rooms (bounded by kMaxAoes).
bool ZoneBlockedLocal(const DangerMap& m, Vec2 player, Vec2 p)
{
    for (int i = 0; i < m.zoneCount; ++i) {
        const ZoneThreat& z = m.zones[i];
        if (!z.active) continue;                                          // pending = cost-only
        const float r = z.radius + kUPlayerHalf;
        if (Len(Sub(p, z.pos)) >= r) continue;                            // cell outside this disc
        if (Len(Sub(player, z.pos)) < r) continue;                        // we are IN it — escaping
        return true;
    }
    return false;
}

// A cell sits inside a PENDING (telegraphed, not-yet-landed) AoE disc. Finding
// G-2: five places in this engine document pending zones as "cost-only (soft)"
// and NO cost term ever existed — nothing anywhere read a pending zone, so a
// telegraphed bomb 1.2 s out was FULLY INVISIBLE and the planner would commit to
// its dead centre as a durable pocket, then have to flee when it armed (churn,
// and a wasted route). This is that missing term's predicate. It is NEVER a
// block: it only TAINTS a cell as a goal, and a tainted goal is still taken when
// no clean one turns up inside kUPathPendingDetourMs (see SearchPass).
bool PendingZoneLocal(const DangerMap& m, Vec2 p)
{
    for (int i = 0; i < m.zoneCount; ++i) {
        const ZoneThreat& z = m.zones[i];
        if (z.active) continue;                                   // armed discs are the HARD case
        if (Len(Sub(p, z.pos)) < z.radius + kUPlayerHalf) return true;
    }
    return false;
}

struct Ctx {
    const PlannerSnapshot* s = nullptr;
    MapInput mi{};            // .env NULL, .map aliases the plain snapshot copy — plain-data only
    bool  diskActive = false;
    Vec2  diskCenter{};
    float diskLimit = 0.f;    // weaponRange + slack (annulus OUTER radius)
    float diskInner = 0.f;    // annulus INNER radius (0 = no inner gate). GOAL-only: cells inside
                              // this radius are rejected as goals but stay traversable.
    float timePerTile = 0.f;  // ms to cross one tile at the player's REAL speed (edge-cost scale;
                              // PlannerSnapshot::speed — finding K)
    int   prevGoalCell = -1;  // last tick's committed goal cell (plan 76 goal hysteresis; -1 = none/off-grid)
};

// ANNULUS gate: a valid GOAL cell keeps the boss hittable (≤ diskLimit) AND is
// not point-blank (≥ diskInner). Gates only the GOAL sets (s_goal / the temporal
// goal below) — the cell stays open/traversable regardless, so a player inside
// the inner ring can always route outward and is never trapped against the boss.
bool GoalGateOk(const Ctx& c, Vec2 w)
{
    if (!c.diskActive) return true;
    const float dB = Len(Sub(w, c.diskCenter));
    return dB <= c.diskLimit && dB >= c.diskInner;
}

// Lazily classify a cell the first time Dijkstra reaches it. Records occupancy,
// the spatial PointSafety (used ONLY for the durable-goal test and the partial
// best-safety metric — NOT as a traversal penalty; BULLET traversal is gated in
// TIME by ArrivalClear, so a cell a bullet's forward path merely crosses is still
// traversable if the bullet is not there when the player arrives), and whether the
// cell is a durable-safe goal (PointSafety ≥ margin, inside the disk when locked).
// ACTIVE AoE discs are the exception to the time gate: they do not move, so there
// is nothing to thread and ArrivalClear cannot see them anyway — they are blocked
// here, alongside walls and enemy bodies (see ZoneBlockedLocal).
void EvalCell(const Ctx& c, int idx, int gx, int gy)
{
    if (s_eval[idx]) return;
    const Vec2 w = CellWorld(c.s->grid.center, gx, gy);
    if (GridBlocked(c.s->grid, c.s->settings.safeWalk, gx, gy) ||
        EnemyBlockedLocal(c.s->map, w) ||
        ZoneBlockedLocal(c.s->map, c.mi.player, w)) {
        s_eval[idx] = 1;
        return;
    }
    const float safety = Core::PointSafety(c.mi, w);
    s_safe[idx] = safety;
    s_goal[idx] = (safety >= kUDurablePocketMargin && GoalGateOk(c, w)) ? 1 : 0;
    s_tgoal[idx] = 0;                                  // set lazily, only if the pass tests it
    s_pend[idx] = PendingZoneLocal(c.s->map, w) ? 1 : 0;
    s_eval[idx] = 2;
}

constexpr int kDx[8] = { 1, -1, 0,  0, 1,  1, -1, -1 };
constexpr int kDy[8] = { 0,  0, 1, -1, 1, -1,  1, -1 };

// Minimum spatial-safety improvement (tiles) over the start position for a cell to
// qualify as the target of a PARTIAL route when no durable pocket is time-reachable
// — avoids emitting a route for a negligibly-safer cell. Baked (no user setting).
constexpr float kPartialGainTiles = 0.15f;

// ── BOUNDED WAIT EDGE (finding F) ───────────────────────────────────────────
// How many consecutive kUTemporalStepMs slices the player may STAND at world
// position `w` starting at time `t` — the "let the wall pass" pause the pure
// arrival-time Dijkstra has no self-edge to express. Capped at
// kUPathMaxWaitSlices (200 ms = one server tick = one replan period; see the
// constant for why longer is meaningless) and refused once the window would run
// past Core::Temporal::kHorizonMs, where the prediction is a conservative freeze
// and there is nothing left to wait out.
//
// An ACTIVE AoE disc is a hard refusal: Core::Temporal is lane-only (Ctx has no
// zone storage), so ArrivalClear would happily certify standing dead-centre in a
// live blast. Cells inside an active disc are already blocked by EvalCell — but
// the START cell is force-opened so the player can always escape one, and
// "waiting" inside the bomb you are standing in is precisely what must not
// happen. Pending discs stay cost-only here (they never block; see
// PendingZoneLocal / the goal taint).
int ClearWaitSlices(const Ctx& c, Vec2 w, float t)
{
    if (!Core::ZoneClear(c.mi, w)) return 0;   // never wait inside a live blast
    int n = 0;
    for (; n < kUPathMaxWaitSlices; ++n) {
        const float t0 = t + static_cast<float>(n) * kUTemporalStepMs;
        const float t1 = t0 + kUTemporalStepMs;
        if (t1 > Core::Temporal::kHorizonMs) break;   // past the horizon: nothing to wait out
        if (!Core::Temporal::ArrivalClear(s_tctx, w, t0, t1)) break;
    }
    return n;
}

// One TIME-EXPANDED Dijkstra pass bounded to a window of `curRad` cells (Chebyshev)
// around the center. The cost is ARRIVAL TIME (ms): edge A→B costs
// dist(A,B) × timePerTile, so g(cell) is when the player reaches it moving at real
// speed. A neighbour is relaxed only if it is SAFE AT ITS ARRIVAL TIME (ArrivalClear
// over [g(A), g(B)]) — the route can never require standing where a bullet is. The
// search prefers the durable goal reachable SOONEST (min arrival time). It also
// tracks the safest reachable-in-time non-goal cell (partialIdx/partialSafety) for
// graceful degradation. Returns the SPATIAL durable goal cell index (or -1); adds pops.
//
// Three additions (findings F and G-2), all strictly second-class to the spatial
// durable goal this returns:
//   • WAIT EDGE — when the direct relaxation cur→ni would arrive into a bullet, the
//     search retries departing up to kUPathMaxWaitSlices slices later (the stand at
//     `cur` itself gated by ClearWaitSlices). Dijkstra records only the EARLIEST
//     arrival per cell, so a delayed arrival is recorded ONLY where no earlier one
//     exists — a wait creates a route, it never replaces a faster one.
//   • TEMPORAL GOAL — `tempGoalIdx` is the soonest-reached cell that is merely
//     ArrivalClear over [arrival, arrival + kUDwellMs). RunSearch consumes it ONLY
//     when this returns -1, i.e. no spatial pocket exists anywhere in the window.
//   • PENDING TAINT — a goal cell inside a telegraphed (unarmed) disc does not end
//     the search immediately; it is held while the search looks up to
//     kUPathPendingDetourMs further for a clean one, then used anyway if none turns up.
int SearchPass(const Ctx& c, int curRad, int start, int& pops,
               int& partialIdx, float& partialSafety, float startSafety,
               int& prevGoalIdx, float& prevGoalMs,
               int& tempGoalIdx, float& tempGoalMs)
{
    for (int i = 0; i < kUPathMaxCells; ++i) {
        s_cost[i] = kHugeClearance; s_prev[i] = -1; s_done[i] = 0; s_eval[i] = 0;
    }
    HeapClear();
    partialIdx = -1;
    partialSafety = startSafety + kPartialGainTiles;   // only a MEANINGFULLY safer cell qualifies
    prevGoalIdx = -1;                                   // plan 76: prev goal cell, once reached-in-time
    prevGoalMs  = 0.f;                                  // ...and its arrival time along this route
    tempGoalIdx = -1;                                   // finding F: second-class temporal goal
    tempGoalMs  = 0.f;                                  // ...and its arrival time along this route

    const Vec2 center = c.s->grid.center;
    // The start (player cell) is always expandable, even if a wall/enemy sample
    // lands on it momentarily — treat it as open ground so the search can leave.
    s_eval[start] = 2; s_safe[start] = startSafety; s_goal[start] = 0;
    s_tgoal[start] = 0; s_pend[start] = 0;
    s_cost[start] = 0.f;                                // arrival time at the start = 0
    HeapPush(0.f, start);

    int found = -1;
    float foundCost = 0.f;
    bool  foundPending = false;   // finding G-2: the incumbent goal sits in a telegraphed disc
    float cost; int cur;
    while (HeapPop(cost, cur)) {
        if (s_done[cur]) continue;                 // stale heap entry
        s_done[cur] = 1;
        ++pops;

        const int cgx = cur % kS, cgy = cur / kS;

        // Plan 76 goal hysteresis: the moment Dijkstra finalizes the previously-
        // committed goal cell, record its arrival TIME along this route. It must be
        // reachable-in-time to count (an unreachable prev goal is never popped, so it
        // stays -1 and is dropped) — RunSearch then decides whether to keep it.
        if (cur != start && s_eval[cur] == 2 && cur == c.prevGoalCell) {
            prevGoalIdx = cur;
            prevGoalMs  = cost;
        }

        if (cur != start && s_eval[cur] == 2 && s_goal[cur]) {
            if (found < 0) { found = cur; foundCost = cost; foundPending = s_pend[cur] != 0; }
            else if (foundPending && !s_pend[cur]) {
                // FINDING G-2: the incumbent goal sits in a telegraphed (unarmed)
                // disc and this one does not. A pending zone is COST-ONLY and must
                // never block, so it did not stop the incumbent being recorded — but
                // a clean cell reached inside the detour budget is strictly better
                // than committing to the centre of a bomb we would have to flee.
                found = cur; foundCost = cost; foundPending = false;
            }
            // Normally exit at the soonest durable goal. But keep popping when
            // (a) a previous goal is being tracked for hysteresis — its arrival may
            // still be within kURouteGoalHystMs — or (b) the goal we have is
            // pending-tainted and the detour budget has not run out yet.
            if ((c.prevGoalCell < 0 || prevGoalIdx >= 0) && !foundPending) break;
        }
        // Once the best goal is known, stop as soon as no unpopped cell can still
        // improve on it (Dijkstra pops in increasing time): the prev goal's
        // hysteresis window, or — for a pending-tainted goal — the detour budget we
        // are willing to spend to reach a clean one instead.
        if (found >= 0) {
            const float budget = foundPending
                ? std::max(kURouteGoalHystMs, kUPathPendingDetourMs) : kURouteGoalHystMs;
            if (cost > foundCost + budget) break;
        }

        // ── SECOND-CLASS TEMPORAL GOAL (finding F) ──────────────────────────
        // The spatial goal test above is PointSafety ≥ kUDurablePocketMargin — the
        // whole-lane-forever test, i.e. a cell no traced bullet path ever crosses.
        // In a dense shot wall that set is EMPTY, every route degraded to `partial`
        // and pulled toward open space, while the solver's Temporal::PathClear was
        // meanwhile happy to thread the very gap the route refused to plan into:
        // the two halves of the two-rate MPC were using OPPOSITE criteria for the
        // same cell. So record the soonest cell that is merely clear over its own
        // arrival + dwell window. It is consumed ONLY when no spatial pocket exists
        // (RunSearch), so the durable pocket still wins whenever one is available.
        //
        // Cost: at most ONE extra ArrivalClear per pop, and only until the first
        // such cell is found (plus a re-test of the previously-committed goal, for
        // hysteresis). It never delays the break above, so it adds no pops.
        if (cur != start && s_eval[cur] == 2 && !s_goal[cur] &&
            (tempGoalIdx < 0 || cur == c.prevGoalCell)) {
            const Vec2 wc = CellWorld(center, cgx, cgy);
            // kUDwellMs, not the bare replan period: it is already this engine's
            // calibrated answer to "how long past arrival must a spot stay clear"
            // (the arrival tick plus a full replan quantum of slack), and it is the
            // stricter of the two. Core::ZoneClear because Temporal is lane-blind —
            // without it a cell dead-centre in a live blast reads perfectly clear.
            if (GoalGateOk(c, wc) && Core::ZoneClear(c.mi, wc) &&
                Core::Temporal::ArrivalClear(s_tctx, wc, cost, cost + kUDwellMs)) {
                s_tgoal[cur] = 1;
                if (tempGoalIdx < 0) { tempGoalIdx = cur; tempGoalMs = cost; }
            }
        }

        // Track the safest reachable-in-time cell for the graceful-degradation route.
        if (cur != start && s_eval[cur] == 2 && s_safe[cur] > partialSafety) {
            partialSafety = s_safe[cur];
            partialIdx    = cur;
        }

        // Wait budget at THIS cell, computed at most once per pop and only if some
        // neighbour actually needs it (finding F). -1 = not computed yet.
        int waitSlices = -1;

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
            float tArr = tB;
            if (!Core::Temporal::ArrivalClear(s_tctx, wB, s_cost[cur], tB)) {
                // ── BOUNDED WAIT EDGE (finding F) ───────────────────────────
                // Leaving NOW walks into a bullet. Try leaving one or two temporal
                // slices later instead — "stand here, let the wall pass, then go".
                // The stand itself must be clear over the whole pause (ClearWaitSlices,
                // which also refuses to pause inside a live blast or past the
                // prediction horizon), and the delayed arrival must pass the SAME
                // gate. Hard-capped at kUPathMaxWaitSlices, so this is at most
                // kUPathMaxWaitSlices extra ArrivalClear calls on an edge that has
                // ALREADY failed — a passing edge costs exactly what it did before.
                if (waitSlices < 0)
                    waitSlices = ClearWaitSlices(c, CellWorld(center, cgx, cgy), s_cost[cur]);
                int w = 1;
                for (; w <= waitSlices; ++w) {
                    const float d = static_cast<float>(w) * kUTemporalStepMs;
                    if (Core::Temporal::ArrivalClear(s_tctx, wB, s_cost[cur] + d, tB + d)) break;
                }
                if (w > waitSlices) continue;   // no admissible departure delay — edge stays blocked
                tArr = tB + static_cast<float>(w) * kUTemporalStepMs;
            }
            // Dijkstra keeps only the EARLIEST arrival, so a waited (later) arrival
            // is recorded only where nothing reached this cell sooner: the wait can
            // OPEN a route that did not exist, never lengthen one that did.
            //
            // HOW THE PAUSE ACTUALLY HAPPENS. The reconstructed polyline carries no
            // "hold here" marker — s_prev/s_path are cells, not a schedule — and the
            // step target is placed by ARC LENGTH along it, so the solver will not
            // literally stand still on command. It does not need to: the game thread
            // re-validates every step it takes with Temporal::PathClear, so while the
            // gap is still shut it simply declines the pre-position step and holds,
            // then walks the moment the lane clears. The wait edge's job is to make
            // the route EXIST so the player is aimed at the gap instead of being
            // dragged toward open space; the pause is produced by the safety floor.
            // goalArriveMs does include the wait, so the arrival time stays honest.
            if (tArr < s_cost[ni]) {
                s_cost[ni] = tArr;
                s_prev[ni] = cur;
                HeapPush(tArr, ni);
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
    c.diskInner   = s.innerStandoffTiles;   // annulus inner radius (goal-only gate)
    // PLAYER SPEED enters here — the edge-cost scale that turns the distance grid
    // into an ARRIVAL-TIME grid. FINDING K: this used to be derived from
    // moveBudget (= in.stepTiles), which equals speed × kServerTickSec ONLY while
    // the "Step distance" slider is on auto AND the auto clamp [0.4, 3.0] does not
    // bind (tps < 2 under heavy Slowed, or tps > 15). Set the slider or hit the
    // clamp and the pathfinder planned arrival times at a FICTIONAL speed while
    // the solver validated the very same step at the real one — cells admitted
    // here and rejected there (churn), or a route step validated against an
    // optimistic arrival. Now both halves read the one real speed. moveBudget
    // stays purely a step-LENGTH knob (it places the lookahead anchor below).
    // speed == 0 means the game's tiles-per-second was unreadable this tick; fall
    // back to the old moveBudget derivation rather than dividing by zero.
    c.timePerTile = (s.speed > 1e-6f)
                        ? 1.f / s.speed
                        : kServerTickSec * 1000.f / std::max(s.moveBudget, 1e-3f);
    // Plan 76: locate last tick's committed goal cell (off-grid → -1 → no hysteresis).
    c.prevGoalCell = s.prevGoalValid ? GoalCellExact(s.grid.center, s.prevGoalPos) : -1;

    // Start from the player's cell (may be offset from the grid center when the
    // grid is boss-centered). Open the initial window wide enough to contain the
    // player so the search can leave it on the first pass.
    int startCheb = 0;
    const int start = PlayerCell(s.player, s.grid.center, startCheb);

    int rad = std::min(std::max(kUPathBaseRadCells, startCheb + kUPathRadStepCells),
                       kUPathMaxRadCells);
    int goal = -1;
    int usedRad = rad;
    bool expanded = (rad > kUPathBaseRadCells);
    int   partialIdx = -1;
    float partialSafety = 0.f;
    int   prevGoalIdx = -1;   // plan 76: prev goal cell reached-in-time this pass (else -1)
    float prevGoalMs  = 0.f;  // ...its arrival time along the route (ms)
    int   tempGoalIdx = -1;   // finding F: second-class temporal goal from the last (widest) pass
    float tempGoalMs  = 0.f;  // ...its arrival time along the route (ms)
    for (;;) {
        goal = SearchPass(c, rad, start, out.pops, partialIdx, partialSafety, startSafety,
                          prevGoalIdx, prevGoalMs, tempGoalIdx, tempGoalMs);
        usedRad = rad;
        if (goal >= 0) break;
        // A temporal goal deliberately does NOT stop the expansion (finding F): the
        // window keeps growing so a real SPATIAL pocket further out still wins. That
        // also means it adds no pops — the pass already ran to exhaustion whenever
        // no spatial pocket existed (the `partial` path).
        if (rad >= kUPathMaxRadCells) break;
        rad = std::min(rad + kUPathRadStepCells, kUPathMaxRadCells);
        expanded = true;
    }
    out.radiusCells = usedRad;
    out.expanded    = expanded;

    // GRACEFUL DEGRADATION (the arrays hold the last, widest pass), in order:
    //   1. the SPATIAL durable pocket, whenever one is time-reachable;
    //   2. else the SECOND-CLASS TEMPORAL goal (finding F) — a cell that is clear
    //      over its arrival + dwell window. This is what stops a dense shot wall
    //      collapsing every route to `partial` while the solver's temporal layer
    //      was perfectly willing to thread the same gap;
    //   3. else the safest reachable-in-time cell (partial, unchanged).
    const bool isTempGoal = (goal < 0 && tempGoalIdx >= 0);
    const bool isPartial  = (goal < 0 && tempGoalIdx < 0);
    int        target     = (goal >= 0) ? goal : (isTempGoal ? tempGoalIdx : partialIdx);
    if (target < 0) { out.found = false; return; }   // nothing better than standing — pure reflex

    // Reconstruct the route (target → start), then reverse into forward order.
    const Vec2 center = s.grid.center;

    // ── Plan-commitment / goal hysteresis (plan 76) ──────────────────────────
    // Among EQUALLY-SAFE options, prefer last tick's committed goal so the planner
    // stops re-selecting a different near-equal pocket every tick. Applies ONLY when
    // the prev goal was reachable-in-time THIS pass (else prevGoalIdx == -1 and it is
    // dropped) — commitment is a tiebreak, never a safety override.
    if (prevGoalIdx >= 0 && prevGoalIdx != target) {
        if (goal >= 0) {
            // Durable goal: keep the old goal only if it is STILL a valid durable
            // in-annulus goal AND arrives within kURouteGoalHystMs of the new best.
            if (s_goal[prevGoalIdx] && prevGoalMs <= s_cost[goal] + kURouteGoalHystMs)
                target = prevGoalIdx;
        } else if (isTempGoal) {
            // Temporal goal: same rule against the temporal-goal set. SearchPass
            // re-tests the previously-committed cell every pass even after it has a
            // temporal goal, so s_tgoal[prevGoalIdx] is a fresh answer, not a stale
            // one — a prev goal that stopped being arrival-clear is dropped at once.
            if (s_tgoal[prevGoalIdx] && prevGoalMs <= tempGoalMs + kURouteGoalHystMs)
                target = prevGoalIdx;
        } else {
            // Partial route: keep last tick's target unless the new safest reachable
            // cell is MEANINGFULLY better — ≥ kPartialGainTiles safer OR
            // ≥ kURouteGoalHystTiles closer to the player. Otherwise hold (no flip-flop).
            const Vec2  oldW  = CellWorld(center, prevGoalIdx % kS, prevGoalIdx / kS);
            const Vec2  newW  = CellWorld(center, partialIdx  % kS, partialIdx  / kS);
            const bool  safer = partialSafety >= s_safe[prevGoalIdx] + kPartialGainTiles;
            const bool  closer = Len(Sub(s.player, newW)) <=
                                 Len(Sub(s.player, oldW)) - kURouteGoalHystTiles;
            if (!safer && !closer)
                target = prevGoalIdx;
        }
    }
    int n = 0;
    for (int cc = target; cc >= 0 && n < kUPathMaxCells; cc = s_prev[cc]) {
        s_path[n++] = cc;
        if (cc == start) break;   // reached the player's start cell
    }
    for (int i = 0, j = n - 1; i < j; ++i, --j) std::swap(s_path[i], s_path[j]);

    out.found       = true;
    out.partial     = isPartial;
    out.tempGoal    = isTempGoal;
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
    // The walk starts from the PLAYER (route[0] = the player's start cell, which may
    // be offset from the boss-centered grid's center).
    const float b = std::max(s.moveBudget, 1e-3f);
    const float lookahead = b * kUStepLookaheadBudgets;   // place the anchor a few budgets ahead
    Vec2  cur = s.player;
    Vec2  stepTarget = out.goalPos;   // default (short route: head straight to goal)
    float acc = 0.f;
    bool  stepSet = false;
    for (int i = 1; i < n; ++i) {
        const Vec2 w = CellWorld(center, s_path[i] % kS, s_path[i] / kS);
        const float seg = Len(Sub(w, cur));
        if (!stepSet && acc + seg >= lookahead) {
            const float rem = lookahead - acc;
            const Vec2 dir = Normalize(Sub(w, cur));
            stepTarget = LenSq(dir) > 1e-6f ? Add(cur, Mul(dir, rem)) : w;
            stepSet = true;
        }
        acc += seg;
        cur = w;
    }
    out.goalDist   = acc;
    out.stepTarget = stepTarget;
    out.stepDir    = Normalize(Sub(stepTarget, s.player));
    if (LenSq(out.stepDir) < 1e-6f) out.found = false;   // degenerate first step — no usable route
}

// ─────────────────────────────────────────────────────────────────────────────
// NAVIGATION A* (Shift+Click walk-to). SEPARATE from the dodge Dijkstra above:
// larger 1-tile grid, goal-directed (octile heuristic straight at the clicked
// spot), no temporal/danger axis — walls (nav grid bit0) and enemy bodies are the
// only obstacles; bullets are left to the game-thread micro-dodge floor. Worker
// thread only; its own fixed scratch (Compute runs single-threaded).
// ─────────────────────────────────────────────────────────────────────────────
constexpr int kNR = kUNavRadCells;   // center cell coordinate (player)
constexpr int kNS = kUNavSide;       // nav grid side length

int  NavIdx(int gx, int gy) { return gy * kNS + gx; }

Vec2 NavCellWorld(Vec2 center, int gx, int gy)
{
    return { center.x + static_cast<float>(gx - kNR) * kUNavCellTiles,
             center.y + static_cast<float>(gy - kNR) * kUNavCellTiles };
}

float   s_navG[kUNavCells];       // best g (path cost, tiles) to the cell
int     s_navPrev[kUNavCells];    // predecessor cell (path reconstruction)
uint8_t s_navClosed[kUNavCells];  // 1 = finalized (popped)
uint8_t s_navSeen[kUNavCells];    // 1 = g/prev initialized this run
float   s_navHeapCost[kUNavHeapCap];
int     s_navHeapIdx[kUNavHeapCap];
int     s_navHeapN = 0;

void NavHeapClear() { s_navHeapN = 0; }
void NavHeapPush(float cost, int idx)
{
    if (s_navHeapN >= kUNavHeapCap) return;
    int i = s_navHeapN++;
    s_navHeapCost[i] = cost; s_navHeapIdx[i] = idx;
    while (i > 0) {
        const int p = (i - 1) / 2;
        if (s_navHeapCost[p] <= s_navHeapCost[i]) break;
        std::swap(s_navHeapCost[p], s_navHeapCost[i]);
        std::swap(s_navHeapIdx[p],  s_navHeapIdx[i]);
        i = p;
    }
}
bool NavHeapPop(float& cost, int& idx)
{
    if (s_navHeapN <= 0) return false;
    cost = s_navHeapCost[0]; idx = s_navHeapIdx[0];
    const int last = --s_navHeapN;
    s_navHeapCost[0] = s_navHeapCost[last]; s_navHeapIdx[0] = s_navHeapIdx[last];
    int i = 0;
    for (;;) {
        const int l = 2 * i + 1, r = 2 * i + 2;
        int m = i;
        if (l < s_navHeapN && s_navHeapCost[l] < s_navHeapCost[m]) m = l;
        if (r < s_navHeapN && s_navHeapCost[r] < s_navHeapCost[m]) m = r;
        if (m == i) break;
        std::swap(s_navHeapCost[m], s_navHeapCost[i]);
        std::swap(s_navHeapIdx[m],  s_navHeapIdx[i]);
        i = m;
    }
    return true;
}

// A nav cell is blocked by a wall (grid bit0) or an enemy body. The player's OWN
// cell (start) is never treated as blocked so we can always route out of one.
bool NavBlocked(const PlannerSnapshot& in, int gx, int gy, bool isStart)
{
    if (gx < 0 || gx >= kNS || gy < 0 || gy >= kNS) return true;
    if (isStart) return false;
    if (in.navGrid.flags[NavIdx(gx, gy)] & 0x1) return true;
    return EnemyBlockedLocal(in.map, NavCellWorld(in.navGrid.center, gx, gy));
}

float NavOctile(int ax, int ay, int bx, int by)
{
    const int dx = std::abs(ax - bx), dy = std::abs(ay - by);
    return static_cast<float>(std::max(dx, dy)) +
           (kUPathRoot2 - 1.f) * static_cast<float>(std::min(dx, dy));
}

// Goal-directed A* over the nav grid toward navGoal. If the goal cell is outside
// the window or unreachable, the route heads to the reachable cell with the lowest
// octile distance to the goal (partial). Fills out.nav* only.
void ComputeNav(const PlannerSnapshot& in, PlanResult& out)
{
    const Vec2 center = in.navGrid.center;

    // Goal cell (clamped into the window → partial when the click is far).
    const float gxf = (in.navGoal.x - center.x) / kUNavCellTiles + kNR;
    const float gyf = (in.navGoal.y - center.y) / kUNavCellTiles + kNR;
    int rawGx = static_cast<int>(std::lround(gxf));
    int rawGy = static_cast<int>(std::lround(gyf));
    const bool goalInWindow = rawGx >= 0 && rawGx < kNS && rawGy >= 0 && rawGy < kNS;
    const int  goalGx = std::clamp(rawGx, 0, kNS - 1);
    const int  goalGy = std::clamp(rawGy, 0, kNS - 1);

    // Start from the PLAYER's cell, not the grid center. The nav grid is refill-
    // gated (rasterized only every kUNavRefillTiles of movement), so its center can
    // be many tiles stale relative to the live player — starting at the center would
    // anchor the route behind the player and the step target would point the wrong
    // way (the route draws but the player won't follow it). Derive the player's cell
    // from the live player vs the grid's (possibly stale) center, clamped in-window.
    int startGx = static_cast<int>(std::lround((in.player.x - center.x) / kUNavCellTiles)) + kNR;
    int startGy = static_cast<int>(std::lround((in.player.y - center.y) / kUNavCellTiles)) + kNR;
    startGx = std::clamp(startGx, 0, kNS - 1);
    startGy = std::clamp(startGy, 0, kNS - 1);
    const int start = NavIdx(startGx, startGy);

    NavHeapClear();
    // MUST reset the visited/closed scratch every run: these are static, single-
    // worker-thread arrays, and stale 'closed'/'seen' flags left over from the
    // PREVIOUS plan make almost every cell look already-visited on the 2nd+ call —
    // the search then can't expand (navPops=1) and beelines into walls. (g/prev are
    // only read once seen is set, so they need no clear.) ~21k bytes each; cheap.
    std::fill(std::begin(s_navSeen),   std::end(s_navSeen),   static_cast<uint8_t>(0));
    std::fill(std::begin(s_navClosed), std::end(s_navClosed), static_cast<uint8_t>(0));
    s_navSeen[start] = 1; s_navG[start] = 0.f; s_navPrev[start] = -1; s_navClosed[start] = 0;
    NavHeapPush(NavOctile(startGx, startGy, goalGx, goalGy), start);

    int   bestCell = start;                 // closest-to-goal free cell reached (partial fallback)
    float bestH    = NavOctile(startGx, startGy, goalGx, goalGy);
    // Frontier partial: among reached cells that sit on the WINDOW EDGE (where the
    // reachable area continues past the search bound toward unexplored space), the
    // one nearest the goal. Heading here walks the player ALONG a wall/coast toward
    // an opening as the window re-centers — instead of jamming into the interior
    // dead-end closest to the goal (min-h over ALL cells), which is what stuck us on
    // walls and made it take the long way. Falls back to bestCell only when the
    // reachable area is fully enclosed (no edge reached).
    int   bestFrontier = -1;
    float bestFrontierH = 1e30f;
    int   pops     = 0;
    bool  reached  = false;
    const int goalIdx = NavIdx(goalGx, goalGy);

    float popCost; int cur;
    while (NavHeapPop(popCost, cur)) {
        if (s_navClosed[cur]) continue;
        s_navClosed[cur] = 1;
        ++pops;
        const int cgx = cur % kNS, cgy = cur / kNS;
        const float h = NavOctile(cgx, cgy, goalGx, goalGy);
        if (h < bestH) { bestH = h; bestCell = cur; }
        if (cur != start && (cgx == 0 || cgx == kNS - 1 || cgy == 0 || cgy == kNS - 1) &&
            h < bestFrontierH) { bestFrontierH = h; bestFrontier = cur; }
        if (cur == goalIdx) { reached = true; break; }

        for (int d = 0; d < 8; ++d) {
            const int nx = cgx + kDx[d], ny = cgy + kDy[d];
            if (NavBlocked(in, nx, ny, false)) continue;
            // No diagonal corner-cutting: both shared orthogonal cells must be open.
            if (kDx[d] != 0 && kDy[d] != 0) {
                if (NavBlocked(in, cgx + kDx[d], cgy, false) ||
                    NavBlocked(in, cgx, cgy + kDy[d], false)) continue;
            }
            const int   nidx = NavIdx(nx, ny);
            if (s_navClosed[nidx]) continue;
            float step = (kDx[d] != 0 && kDy[d] != 0) ? kUPathRoot2 : 1.f;
            // Hazard (bit1: water/lava) is a SOFT cost, not a wall — route around it
            // when a dry path exists, but still traverse it when that's the only way
            // out (so a hazard-floored arena never boxes the planner in).
            if (in.navGrid.flags[nidx] & 0x2) step += kUNavHazardCost;
            const float ng   = s_navG[cur] + step;
            if (!s_navSeen[nidx] || ng < s_navG[nidx]) {
                s_navSeen[nidx] = 1; s_navClosed[nidx] = 0;
                s_navG[nidx] = ng; s_navPrev[nidx] = cur;
                NavHeapPush(ng + NavOctile(nx, ny, goalGx, goalGy), nidx);
            }
        }
    }

    out.navPops = pops;
    // Prefer the frontier (edge) cell for a partial route so we route AROUND walls
    // toward an opening; only fall back to the closest-interior cell when nothing
    // reached the window edge (a fully enclosed pocket).
    const int partialTarget = (bestFrontier >= 0) ? bestFrontier : bestCell;
    const int target = reached ? goalIdx : partialTarget;
    if (target == start) {                  // already at the goal cell (or boxed in at start)
        out.navFound   = true;
        out.navArrived = reached && goalInWindow;
        out.navGoalCell = NavCellWorld(center, target % kNS, target / kNS);
        out.navStepTarget = in.navGoal;     // nothing to walk — hand back the raw goal
        out.navWptCount = 1; out.navWpts[0] = in.player;
        return;
    }

    // Reconstruct backward target→start, then reverse into world waypoints.
    static int s_navChain[kUNavCells];   // worker-thread scratch (single-threaded)
    int len = 0;
    for (int c = target; c != -1 && len < kUNavCells; c = s_navPrev[c])
        s_navChain[len++] = c;
    if (len < 2) return;                    // no usable route

    // Forward order [0]=start; collinear-reduce to turn points, cap at kMaxNavWpts.
    out.navWpts[0] = in.player;
    int wn = 1;
    int prevGx = s_navChain[len - 1] % kNS, prevGy = s_navChain[len - 1] / kNS;
    int lastDx = 0, lastDy = 0;
    for (int i = len - 2; i >= 0 && wn < kMaxNavWpts; --i) {
        const int gx = s_navChain[i] % kNS, gy = s_navChain[i] / kNS;
        const int dx = (gx > prevGx) - (gx < prevGx);
        const int dy = (gy > prevGy) - (gy < prevGy);
        const bool turn = (dx != lastDx || dy != lastDy);
        const bool last = (i == 0);
        if (turn || last) out.navWpts[wn++] = NavCellWorld(center, gx, gy);
        lastDx = dx; lastDy = dy; prevGx = gx; prevGy = gy;
    }
    out.navWptCount = wn;
    out.navFound    = true;
    out.navPartial  = !reached || !goalInWindow;
    out.navArrived  = false;
    out.navGoalCell = NavCellWorld(center, target % kNS, target / kNS);

    // Steering target: ~one move budget ahead along the polyline (smooth straight
    // drive that approximates the corridor; the driver re-plans each tick).
    const float b = std::max(in.moveBudget, 1.f) * kUNavLookaheadBudgets;
    Vec2  cur2 = in.player;
    Vec2  stepT = out.navWpts[wn - 1];      // default: the far end
    float acc = 0.f; bool set = false;
    for (int i = 1; i < wn; ++i) {
        const Vec2 w = out.navWpts[i];
        const float seg = Len(Sub(w, cur2));
        if (!set && acc + seg >= b) {
            const float rem = b - acc;
            const Vec2 dir = Normalize(Sub(w, cur2));
            stepT = LenSq(dir) > 1e-6f ? Add(cur2, Mul(dir, rem)) : w;
            set = true; break;
        }
        acc += seg; cur2 = w;
    }
    out.navStepTarget = stepT;
}

} // namespace

// The dodge grid Dijkstra (durable-safe pocket search). Fills only the dodge
// fields of `out`; the nav A* below fills the nav fields on top and is never
// overwritten by this. Extracted so the walk-to route is produced even when the
// player is already safe (the startIsGoal short-circuit returns early here).
static void ComputeDodge(const PlannerSnapshot& in, PlanResult& out)
{
    // Is the player cell itself already a durable-safe goal? (Cheap short-circuit
    // — no route needed; the game thread decides whether to hold.)
    MapInput mi{};
    mi.player = in.player; mi.settings = in.settings; mi.map = &in.map;
    const float startSafety = Core::PointSafety(mi, in.player);
    {
        bool startGoal = startSafety >= kUDurablePocketMargin;
        if (startGoal && in.hasLock && in.weaponRangeTiles > 0.f) {
            // ANNULUS short-circuit: a player standing point-blank (inside the inner
            // ring) must NOT count as "already at goal" — it has to route outward.
            // The cell stays traversable, so RunSearch will find an outward goal.
            const float dB = Len(Sub(in.player, in.lockPos));
            startGoal = dB <= in.weaponRangeTiles + kUInRangeSlack
                     && dB >= in.innerStandoffTiles;
        }
        if (startGoal) { out.startIsGoal = true; return; }
    }

    // Predict every relevant bullet's trajectory ONCE (culled to the window) so the
    // arrival-time safety gate is cheap per candidate edge. Plain-data — reuses the
    // lane pointTimesMs already in the snapshot's DangerMap copy; no IL2CPP. Culled
    // relative to the grid center (window extent + margin) — see plan 72.
    Core::Temporal::Build(in.map, in.settings.hitScale, in.grid.center,
                          kUPathMaxRadCells * kUPathCellTiles + kUTemporalCullTiles,
                          s_tctx);

    // IN-RANGE DISK: locked boss gates GOAL cells to the weapon-range disk so the
    // route keeps the boss hittable. Safety OVERRIDES range: if no in-range durable
    // pocket is time-reachable, re-search UNCONSTRAINED (leave range to dodge,
    // return once clear); failing that, degrade to a partial route toward safety.
    const bool disk = in.hasLock && in.weaponRangeTiles > 0.f;

    // A SPATIAL durable pocket outranks everything, in range or out; only then does
    // the second-class TEMPORAL goal (finding F) get a say, and only then a partial
    // route. Keeping that order here is what makes "the spatial pocket must still
    // win when one is available" true across BOTH searches, not just within one.
    const auto spatialGoal = [](const PlanResult& r) {
        return r.found && !r.partial && !r.tempGoal;
    };

    PlanResult primary{};
    primary.forSeq = in.seq;
    RunSearch(in, disk, startSafety, primary);
    if (spatialGoal(primary)) {                       // durable in-range pocket, time-feasible
        primary.tempLanes = s_tctx.count;
        out = primary;
        return;
    }

    if (disk) {
        PlanResult unc{};
        unc.forSeq = in.seq;
        RunSearch(in, false, startSafety, unc);
        if (spatialGoal(unc)) {                       // durable pocket only outside range
            unc.outOfRange = true;
            unc.tempLanes  = s_tctx.count;
            out = unc;
            return;
        }
        // No SPATIAL pocket anywhere. Next best is a temporal goal — in range first
        // (it keeps the boss hittable), then outside range.
        if (primary.found && primary.tempGoal) { primary.tempLanes = s_tctx.count; out = primary; return; }
        if (unc.found && unc.tempGoal) {
            unc.outOfRange = true;
            unc.tempLanes  = s_tctx.count;
            out = unc;
            return;
        }
        // Nothing but partials → prefer the unconstrained one (it explores the wider
        // manifold), else the in-range partial, else pure reflex.
        if (unc.found)          { unc.tempLanes = s_tctx.count;     out = unc;     return; }
        if (primary.found)      { primary.tempLanes = s_tctx.count; out = primary; return; }
        out.tempLanes = s_tctx.count;
        return;
    }

    // Unlocked: primary is a spatial goal (handled above), a temporal goal, a
    // partial route, or nothing.
    primary.tempLanes = s_tctx.count;
    out = primary;
}

// Public entry: the dodge Dijkstra then (when a walk-to is active) the nav A*.
// Nav runs AFTER and writes only the nav fields, so it survives ComputeDodge's
// internal `out = ...` overwrites — and it runs even when ComputeDodge short-
// circuits on startIsGoal (a safe player still needs to walk toward the click).
void Compute(const PlannerSnapshot& in, PlanResult& out)
{
    out = PlanResult{};
    out.forSeq = in.seq;

    LARGE_INTEGER f; QueryPerformanceFrequency(&f);
    const double invFreqMs = 1000.0 / double(f.QuadPart);

    LARGE_INTEGER d0, d1;
    QueryPerformanceCounter(&d0);
    ComputeDodge(in, out);
    QueryPerformanceCounter(&d1);
    out.computeDodgeMs = float(double(d1.QuadPart - d0.QuadPart) * invFreqMs);

    if (in.navActive) {
        LARGE_INTEGER n0, n1;
        QueryPerformanceCounter(&n0);
        ComputeNav(in, out);
        QueryPerformanceCounter(&n1);
        out.computeNavMs = float(double(n1.QuadPart - n0.QuadPart) * invFreqMs);
    }
}

} } // namespace UDodge::Path
