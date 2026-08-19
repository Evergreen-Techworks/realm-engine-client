#include "pch-il2cpp.h"
#include "UDodgePlanner.h"

#include <algorithm>
#include <cmath>

// ─────────────────────────────────────────────────────────────────────────────
// Threading note (Stage C1 verification — plan 58, Step 1; extended for D1/60, D2/61):
//   The weapon range that feeds the orbit goal policy comes from AutoAim::GetProjRangeTiles()
//   / IsProjRangeResolved(), which are thin inline reads of a cached, static
//   plain-data WeaponProfile (AutoAim.h:85-86 → WeaponCalibrator::GetProfile(),
//   WeaponProfile.cpp:130 returns `static WeaponProfile s_profile`). That profile
//   is populated on the game thread by WeaponCalibrator::Tick / OnProjectileSpawn;
//   the getters themselves touch no live IL2CPP object. They are therefore safe to
//   call on the game thread and their resolved value is captured (as a plain float)
//   into PlannerSnapshot::weaponRangeTiles before this pure Compute runs.
//
//   The whole-window Dijkstra below reads ONLY plain data: the rasterized OccGrid
//   (uint8 wall/hazard bits, filled on the game thread) and the plain DangerMap
//   (LaneThreat/ZoneThreat — Vec2/scalars only). No IL2CPP handle, void*, or Env
//   function pointer crosses the PlannerSnapshot/PlanResult boundary. Compute is
//   the WORKER thread's whole job — it never touches live world memory.
// ─────────────────────────────────────────────────────────────────────────────

namespace UDodge { namespace Planner {
namespace {

// Cost weights ported from UDodgeField.cpp:15-19 (same routing character), plus a
// heavy active-zone cost so a boxed goal stays reachable (traversable, never blocked).
constexpr float kHazardCost     = 40.f;   // discourage routing through hazard ground
constexpr float kZoneCost       = 25.f;   // pending-zone cells cost more
constexpr float kLaneCost       = 60.f;   // danger-lane cells cost more
constexpr float kActiveZoneCost = 120.f;  // active zone: heavy, but still traversable
constexpr float kRoot2          = 1.41421356f;
constexpr float kInf            = 3.402823466e+38f;
constexpr int   kGoalNudgeRing  = 8;      // search radius (cells) for a clear goal cell
constexpr float kOrbitBand      = 1.0f;   // ± tolerance (tiles) around the desired standoff
constexpr float kOrbitLead      = 0.9f;   // tangential lead of the in-band orbit goal

int Idx(int gx, int gy) { return gy * kPlanGridSize + gx; }

int ClampInt(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

Vec2 CellWorld(Vec2 center, int gx, int gy)
{
    return { center.x + static_cast<float>(gx - kPlanGridRadius) * kPlanCellTiles,
             center.y + static_cast<float>(gy - kPlanGridRadius) * kPlanCellTiles };
}

bool IsWall(const OccGrid& g, int idx)   { return (g.flags[idx] & 0x1) != 0; }
bool IsHazard(const OccGrid& g, int idx) { return (g.flags[idx] & 0x2) != 0; }

// Min over the lane polyline of Chebyshev distance from p (local copy — the field
// helper has internal linkage in its own TU; this reads the PLAIN DangerMap only).
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

// Plain-data port of Core::PointClear (UDodgeCore.cpp:351): on standable ground
// (not a wall), outside every danger lane (Chebyshev > hitHalf × hitScale) and
// outside every ACTIVE zone. Pending zones are cost-only (do NOT block); enemy
// bodies are deliberately not checked. Reads only in.grid / in.map.
bool CellClear(const PlannerSnapshot& in, int idx, Vec2 cellWorld, float hitScale)
{
    if (IsWall(in.grid, idx)) return false;
    for (int i = 0; i < in.map.laneCount; ++i) {
        const LaneThreat& L = in.map.lanes[i];
        const float half = std::clamp(L.hitHalf, 0.05f, 2.5f) * hitScale;
        if (LaneDistCheb(L, cellWorld) <= half) return false;
    }
    for (int i = 0; i < in.map.zoneCount; ++i) {
        const ZoneThreat& z = in.map.zones[i];
        if (z.active && Len(Sub(z.pos, cellWorld)) <= z.radius) return false;
    }
    return true;
}

// Per-cell traversal penalty (ported cost loop from UDodgeField.cpp:122-133,
// reading the PLAIN in.map). Active zones and lanes are heavy but TRAVERSABLE so a
// boxed goal is still reachable; only walls block (handled by the neighbour scan).
float CellPenalty(const PlannerSnapshot& in, int idx, Vec2 cellWorld, float hitScale)
{
    float penalty = 0.f;
    if (in.settings.safeWalk && IsHazard(in.grid, idx)) penalty += kHazardCost;
    for (int zi = 0; zi < in.map.zoneCount; ++zi) {
        const ZoneThreat& z = in.map.zones[zi];
        if (Len(Sub(z.pos, cellWorld)) < z.radius) {
            penalty += z.active ? kActiveZoneCost : kZoneCost;
            break;
        }
    }
    for (int li = 0; li < in.map.laneCount; ++li) {
        const LaneThreat& L = in.map.lanes[li];
        const float half = std::clamp(L.hitHalf, 0.05f, 2.5f) * hitScale;
        if (LaneDistCheb(L, cellWorld) <= half) { penalty += kLaneCost; break; }
    }
    return penalty;
}

// Desired standoff distance (tiles): the user's orbitRange when set (>0), else the
// resolved weapon range × 0.85 (plan-58 auto default). Clamped to a sane band.
float DesiredStandoff(const PlannerSnapshot& in)
{
    const float manual = in.settings.orbitRange;
    const float d = (manual > 0.f) ? manual
                                   : std::clamp(in.weaponRangeTiles, 2.f, 16.f) * 0.85f;
    return std::clamp(d, 1.5f, 16.f);
}

// Map a world position to its grid cell, clamped to the window.
int CellOf(Vec2 center, float wx, float wy, int axis /*0=x,1=y*/)
{
    const float c = (axis == 0) ? center.x : center.y;
    const float w = (axis == 0) ? wx : wy;
    return ClampInt(static_cast<int>(std::lround((w - c) / kPlanCellTiles)) + kPlanGridRadius,
                    0, kPlanGridSize - 1);
}

// Compute the ORBIT GOAL POSITION (plan 61) with range bands and a persistent orbit
// sign (block-flip hysteresis). `sign` is a worker-local static carried across calls:
//   • dist outside [desired ± band]  → goal = standoff point on the boss↔player line
//     at `desired` (closes in when far, backs out when too close — same point either way).
//   • in-band                        → goal = tangential point on the desired-radius
//     circle, led along the current orbit `sign`. If that goal cell is blocked
//     (wall / lane / active zone), FLIP the sign once and retake it; otherwise HOLD
//     the sign so the orbit heading does not flip frame-to-frame.
Vec2 OrbitGoalPos(const PlannerSnapshot& in, Vec2 center, float desired,
                  int& sign, float hitScale)
{
    const Vec2  toBoss = Sub(in.lockPos, in.player);
    const float dist   = Len(toBoss);
    if (dist < 1e-3f) return in.lockPos;               // on top of the boss → degenerate
    const Vec2 dir = Mul(toBoss, 1.f / dist);          // unit player→boss

    if (dist > desired + kOrbitBand || dist < desired - kOrbitBand)
        return Sub(in.lockPos, Mul(dir, desired));     // standoff point at `desired`

    // In-band: pick the tangential orbit goal, flipping the sign only if it is blocked.
    for (int attempt = 0; attempt < 2; ++attempt) {
        const Vec2 tangent = (sign > 0) ? Vec2{ -dir.y, dir.x } : Vec2{ dir.y, -dir.x };
        const Vec2 radialOut = Mul(dir, -1.f);         // boss→player
        const Vec2 onCircle  = Normalize(Add(radialOut, Mul(tangent, kOrbitLead)));
        const Vec2 g = Add(in.lockPos, Mul(onCircle, desired));
        const int gx = CellOf(center, g.x, g.y, 0);
        const int gy = CellOf(center, g.x, g.y, 1);
        if (CellClear(in, Idx(gx, gy), CellWorld(center, gx, gy), hitScale))
            return g;
        sign = -sign;                                  // blocked → flip once and retry
    }
    // Both signs blocked: keep the (now-restored) sign's goal; Dijkstra decides reach.
    const Vec2 tangent   = (sign > 0) ? Vec2{ -dir.y, dir.x } : Vec2{ dir.y, -dir.x };
    const Vec2 onCircle  = Normalize(Add(Mul(dir, -1.f), Mul(tangent, kOrbitLead)));
    return Add(in.lockPos, Mul(onCircle, desired));
}

} // namespace

void Compute(const PlannerSnapshot& in, PlanResult& out)
{
    out = PlanResult{};
    out.forSeq = in.seq;

    if (!in.hasLock) return;   // no goal → clear path, firstDir {}

    out.hasGoal = true;

    const Vec2  center   = in.grid.center;   // = player (grid center)
    const Vec2  player   = in.player;
    const float hitScale = std::clamp(in.settings.hitScale, 0.25f, 2.5f);

    // ── Boss-fight goal policy (plan 61): range bands + persistent orbit sign. ──
    // s_orbitSign lives on the WORKER thread only (Compute's single caller — plan 59),
    // so no cross-thread state is introduced. OrbitGoalPos flips it only when blocked.
    static int s_orbitSign = +1;
    const float desired   = DesiredStandoff(in);
    const Vec2  goalWorld = OrbitGoalPos(in, center, desired, s_orbitSign, hitScale);
    out.goalPos = goalWorld;

    // Orbit fallback direction (used when the route is degenerate / unreachable): head
    // straight at the orbit goal, or tangentially if the goal collapses onto the player.
    Vec2 orbitDir = Normalize(Sub(goalWorld, player));
    if (LenSq(orbitDir) < 1e-6f) {
        const Vec2 toBoss = Sub(in.lockPos, player);
        const float d = Len(toBoss);
        if (d > 1e-3f) {
            const Vec2 dir = Mul(toBoss, 1.f / d);
            orbitDir = (s_orbitSign > 0) ? Vec2{ -dir.y, dir.x } : Vec2{ dir.y, -dir.x };
        }
    }

    // ── Goal cell: map the goal world pos into the grid, clamp to the window. ──
    int ggx = CellOf(center, goalWorld.x, goalWorld.y, 0);
    int ggy = CellOf(center, goalWorld.x, goalWorld.y, 1);

    // The goal cell itself must be clear (plain-data PointClear). If the clamped cell
    // is blocked (wall / lane / active zone), nudge to the nearest clear cell in a
    // small ring — keeps the route terminating on a standable cell near the target.
    if (!CellClear(in, Idx(ggx, ggy), CellWorld(center, ggx, ggy), hitScale)) {
        bool found = false;
        for (int r = 1; r <= kGoalNudgeRing && !found; ++r) {
            for (int dy = -r; dy <= r && !found; ++dy) {
                for (int dx = -r; dx <= r && !found; ++dx) {
                    if (std::max(std::abs(dx), std::abs(dy)) != r) continue;  // ring only
                    const int nx = ggx + dx, ny = ggy + dy;
                    if (nx < 0 || nx >= kPlanGridSize || ny < 0 || ny >= kPlanGridSize) continue;
                    if (CellClear(in, Idx(nx, ny), CellWorld(center, nx, ny), hitScale)) {
                        ggx = nx; ggy = ny; found = true;
                    }
                }
            }
        }
        // If nothing clear nearby, keep the clamped cell — Dijkstra decides reachability.
    }

    const int start   = Idx(kPlanGridRadius, kPlanGridRadius);
    const int goalIdx = Idx(ggx, ggy);

    // Degenerate: goal rounds onto the player cell → nothing to route, orbit.
    if (goalIdx == start) {
        out.firstDir = orbitDir;
        return;
    }

    // ── Dijkstra over the plain grid (linear-scan, ported from UDodgeField.cpp). ──
    // Static scratch: Worker::WorkerLoop is the ONLY caller of Compute (single worker
    // thread — verified plan 59), so this is never shared across threads and needs no
    // per-call allocation. It holds no IL2CPP data — pure plain-data ints/floats.
    static float s_cost[kPlanGridCells];
    static int   s_prev[kPlanGridCells];
    static bool  s_done[kPlanGridCells];
    for (int i = 0; i < kPlanGridCells; ++i) {
        s_cost[i] = kInf; s_prev[i] = -1; s_done[i] = false;
    }
    s_cost[start] = 0.f;

    static constexpr int kDx[8] = { 1, -1, 0,  0, 1,  1, -1, -1 };
    static constexpr int kDy[8] = { 0,  0, 1, -1, 1, -1,  1, -1 };

    bool reached = false;
    for (int iter = 0; iter < kPlanGridCells; ++iter) {
        // Pop the lowest-cost unfinished cell (linear scan — matches Field; the
        // search early-exits when the goal cell is finalized).
        int cur = -1;
        float best = kInf;
        for (int i = 0; i < kPlanGridCells; ++i)
            if (!s_done[i] && s_cost[i] < best) { best = s_cost[i]; cur = i; }
        if (cur < 0) break;
        s_done[cur] = true;
        if (cur == goalIdx) { reached = true; break; }

        const int cgx = cur % kPlanGridSize, cgy = cur / kPlanGridSize;
        for (int k = 0; k < 8; ++k) {
            const int nx = cgx + kDx[k], ny = cgy + kDy[k];
            if (nx < 0 || nx >= kPlanGridSize || ny < 0 || ny >= kPlanGridSize) continue;
            const int ni = Idx(nx, ny);
            if (s_done[ni]) continue;
            if (IsWall(in.grid, ni)) continue;   // never route through a wall
            if (kDx[k] != 0 && kDy[k] != 0) {
                // No corner-cutting (UDodgeField.cpp:113-120): a diagonal is valid
                // only if BOTH orthogonal cells it passes between are open.
                if (IsWall(in.grid, Idx(cgx + kDx[k], cgy)) ||
                    IsWall(in.grid, Idx(cgx, cgy + kDy[k]))) continue;
            }
            const Vec2 nw = CellWorld(center, nx, ny);
            const float stepDist = (kDx[k] != 0 && kDy[k] != 0) ? kPlanCellTiles * kRoot2 : kPlanCellTiles;
            const float nc = s_cost[cur] + stepDist + CellPenalty(in, ni, nw, hitScale);
            if (nc < s_cost[ni]) {
                s_cost[ni] = nc;
                s_prev[ni] = cur;
            }
        }
    }

    if (!reached) {           // goal unreachable (walled off) → orbit fallback
        out.firstDir = orbitDir;
        return;
    }

    // ── Reconstruct the cell chain goal → start, count length. ────────────────
    int chainLen = 0;
    for (int c = goalIdx; c != -1; c = s_prev[c]) {
        ++chainLen;
        if (c == start) break;
    }
    if (chainLen <= 1) {      // goal == start (shouldn't happen — guarded above)
        out.firstDir = orbitDir;
        return;
    }

    // Fill a forward (start → goal) index chain, then downsample to ≤ kMaxPathPoints.
    static int s_chain[kPlanGridCells];
    int n = 0;
    for (int c = goalIdx; c != -1 && n < kPlanGridCells; c = s_prev[c]) {
        s_chain[n++] = c;
        if (c == start) break;
    }
    // s_chain currently holds goal..start; reverse in place to start..goal.
    for (int i = 0, j = n - 1; i < j; ++i, --j) { int t = s_chain[i]; s_chain[i] = s_chain[j]; s_chain[j] = t; }

    // Downsample: always keep the first (player) and last (goal) points.
    int outCount = 0;
    if (n <= kMaxPathPoints) {
        for (int i = 0; i < n; ++i) {
            const int c = s_chain[i];
            out.path[outCount++] = CellWorld(center, c % kPlanGridSize, c / kPlanGridSize);
        }
    } else {
        const int last = kMaxPathPoints - 1;
        for (int s = 0; s < kMaxPathPoints; ++s) {
            int i = (s == last) ? (n - 1)
                                : static_cast<int>((static_cast<int64_t>(s) * (n - 1)) / last);
            const int c = s_chain[i];
            out.path[outCount++] = CellWorld(center, c % kPlanGridSize, c / kPlanGridSize);
        }
    }
    out.pathCount = outCount;

    // First-step direction from the second path point; fall back to orbit if degenerate.
    out.firstDir = (outCount >= 2) ? Normalize(Sub(out.path[1], player)) : orbitDir;
    if (LenSq(out.firstDir) < 1e-6f) out.firstDir = orbitDir;
}

} } // namespace UDodge::Planner
