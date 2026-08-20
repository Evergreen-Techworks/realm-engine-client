#include "pch-il2cpp.h"
#include "UDodgeSolver.h"
#include "UDodgeCore.h"
#include "UDodgePathfinder.h"

#include <algorithm>
#include <cmath>

namespace UDodge { namespace Solver {
namespace {

// The solver's HARD safety constraint is Core::PointSafety / Core::PointSafe,
// which fold the player half-extent (kUPlayerHalf) into every bullet hit region
// and active-zone radius. That is the divergence fix (plan 64): without it a
// point the solver calls "safe" could still sit ~0.21 tiles inside the server's
// hit square and the player gets clipped. Assert the constant is live so this
// dependency is explicit at the solver boundary.
static_assert(kUPlayerHalf > 0.f, "safety test must include the player half-extent");

// ── Reachable candidate set (tiny, ≤ ~1.9 tiles) ────────────────────────────
// The stand point plus polar rings at 0.34/0.67/1.0 of the move budget over
// K headings, plus (when a goal exists) the goal-direction point clamped to the
// budget. K = 24 ≈ 15° resolution; three rings resolve any gap the player can
// physically fit through inside one tick's reach.
constexpr int   kSolveAngles = 32;
constexpr int   kSolveRings   = 4;
constexpr float kRingFrac[kSolveRings] = { 0.25f, 0.5f, 0.75f, 1.0f };
// stand + rings + goal-direction point + pocket-direction point.
constexpr int   kMaxCandidates = 1 + kSolveRings * kSolveAngles + 2;   // 131

struct Cand {
    Vec2  pos{};
    Vec2  dir{};        // unit(pos − player); {} for the stand point
    float moveDist = 0.f;
    float clr = 0.f;    // Core::PointSafety at pos
    bool  occOk = false;
    bool  safe = false; // occOk && clr >= kULatencyPad
    bool  stand = false;
};

// Aggregate incoming-threat direction: normalized sum of (player − lane.anchor)
// over lanes. The `perp` objective term rewards a lateral sidestep ACROSS this
// flow (a RePP-style dodge, not a straight retreat). Zero when no lanes exist.
Vec2 FlowDir(const MapInput& in)
{
    if (!in.map) return {};
    Vec2 sum{};
    for (int i = 0; i < in.map->laneCount; ++i) {
        const LaneThreat& L = in.map->lanes[i];
        if (L.pointCount <= 0) continue;
        sum = Add(sum, Normalize(Sub(in.player, L.points[0])));
    }
    return Normalize(sum);
}

// Smart-direction score over the SAFE set only (safety already guaranteed for
// every candidate scored here, so these terms only choose AMONG safe points and
// can never trade safety away). Baked weights (kSolve*), NO user sliders.
float ScoreCand(const Cand& c, Vec2 player, const Goal& goal,
                Vec2 flow, Vec2 prevDir, float b)
{
    float score = 0.f;

    // Continuity — reward continuing the last committed heading (kills jitter).
    // The stand point (dir {}) scores 0 here.
    if (LenSq(c.dir) > 1e-6f && LenSq(prevDir) > 1e-6f)
        score += kSolveCommitW * std::max(0.f, Dot(c.dir, prevDir));

    // Advance toward the goal, but fade the pull to zero as the point approaches
    // the safety floor so near danger the dodge never chases the orbit line.
    if (goal.active) {
        const float progress = Len(Sub(player, goal.pos)) - Len(Sub(c.pos, goal.pos));
        const float ramp = std::clamp((c.clr - kULatencyPad) / kUScoreStyleBand, 0.f, 1.f);
        score += kSolveGoalW * progress * ramp;
    }

    // RePP-style perpendicular sidestep: reward moving ACROSS the incoming
    // stream, PENALIZE moving along its axis — both fleeing straight back and
    // charging straight in. (1 − 2|par|): +1 lateral, −1 radial. This is what
    // stops it from preferring a backpedal over a left/right sidestep.
    if (LenSq(flow) > 1e-6f && LenSq(c.dir) > 1e-6f) {
        const float par = Dot(c.dir, flow);
        score += kSolvePerpW * (1.f - 2.f * std::fabs(par));
    }

    // Minimal disruption — prefer the nearest safe point.
    score -= kSolveMoveW * c.moveDist / std::max(b, 1e-3f);

    // Gentle comfort tiebreak, capped so it never dominates.
    score += kSolveClearW * std::min(c.clr, kSolveClearComfort);

    // Stay in shooting range: penalize a dodge point that sits OUTSIDE the boss
    // weapon range, so we dodge inward/laterally and keep our range instead of
    // fleeing outward. Only when locked (goal.fromLock) with a real range.
    if (goal.fromLock && goal.maxRange > 0.f) {
        const float distToBoss = Len(Sub(c.pos, goal.lockPos));
        if (distToBoss > goal.maxRange)
            score -= kSolveOutRangeW * (distToBoss - goal.maxRange);
    }

    // Stand bias: when standing still is safe and nothing is clearly better,
    // hold (minimal disruption) instead of twitching off a safe stand.
    if (c.stand) score += kSolveStandBias;

    return score;
}

int BuildCandidates(const MapInput& in, float b, const Goal& goal,
                    bool pocketFound, Vec2 pocketPos, Cand* out)
{
    const Vec2 player = in.player;
    int n = 0;

    // Stand point.
    out[n].pos = player;
    out[n].dir = {};
    out[n].moveDist = 0.f;
    out[n].stand = true;
    ++n;

    // Polar rings.
    for (int ri = 0; ri < kSolveRings; ++ri) {
        const float r = b * kRingFrac[ri];
        for (int k = 0; k < kSolveAngles; ++k) {
            const float ang = kTwoPi * static_cast<float>(k) / static_cast<float>(kSolveAngles);
            const Vec2 dir{ std::cos(ang), std::sin(ang) };
            out[n].pos = Add(player, Mul(dir, r));
            out[n].dir = dir;
            out[n].moveDist = r;
            ++n;
        }
    }

    // Goal-direction point clamped to the budget.
    if (goal.active) {
        const Vec2 to = Sub(goal.pos, player);
        const float d = Len(to);
        if (d > 1e-4f) {
            const float r = std::min(d, b);
            const Vec2 dir = Mul(to, 1.f / d);
            out[n].pos = Add(player, Mul(dir, r));
            out[n].dir = dir;
            out[n].moveDist = r;
            ++n;
        }
    }

    // Pocket-direction point clamped to the budget — the exact reachable step
    // toward the nearest durable lookahead pocket, so the immediate solve always
    // has a candidate pointing straight at the gap (the rings only resolve to
    // ~15°). This is how a multi-tile pocket is approached one budget at a time.
    if (pocketFound) {
        const Vec2 to = Sub(pocketPos, player);
        const float d = Len(to);
        if (d > 1e-4f) {
            const float r = std::min(d, b);
            const Vec2 dir = Mul(to, 1.f / d);
            out[n].pos = Add(player, Mul(dir, r));
            out[n].dir = dir;
            out[n].moveDist = r;
            ++n;
        }
    }
    return n;
}

// True when p sits inside any enemy body (+ the player half-extent). Running
// over an enemy is NEVER acceptable, so this is a HARD exclusion (treated like a
// wall — removed from occupiable), not a soft score. Applies to the safe set AND
// the least-bad fallback, so even when surrounded the solver never routes onto a
// mob. The boss orbit sits at weapon range, far outside any body, so this never
// conflicts with staying in range.
bool EnemyBlocked(const MapInput& in, Vec2 p)
{
    if (!in.map) return false;
    for (int i = 0; i < in.map->enemyCount; ++i) {
        const EnemyBlocker& e = in.map->enemies[i];
        if (Len(Sub(p, e.pos)) < e.radius + kUPlayerHalf) return true;
    }
    return false;
}

// Evaluate occupancy + server-accurate clearance for every candidate.
void Evaluate(const MapInput& in, Cand* c, int n)
{
    for (int i = 0; i < n; ++i) {
        const bool walkable = !in.env.canOccupy ||
                     in.env.canOccupy(c[i].pos.x, c[i].pos.y, in.settings.safeWalk);
        c[i].occOk = walkable && !EnemyBlocked(in, c[i].pos);
        c[i].clr = Core::PointSafety(in, c[i].pos);
        c[i].safe = c[i].occOk && c[i].clr >= kULatencyPad;
    }
}

// ── Temporal lookahead: nearest pocket that is safe over the next N ticks ────
// The static test above (PointSafety ≥ margin) treats a lane as dangerous over
// its WHOLE forward path — correct but over-conservative, since it can't thread
// a gap in TIME. The temporal layer instead asks: given where every bullet is
// GOING (its traced trajectory, times and all), is the player's along-path
// position clear AT THE MOMENT the player is actually there? This threads
// time-gaps the static test forbids while keeping a comfort margin so a
// slightly-off prediction can't clip the player.

constexpr int kUTemporalSamples = kUTemporalSteps + 1;   // includes t = 0

// Per-tick temporal context: for each RELEVANT lane, the bullet's predicted
// position at each march sample time, plus its effective hit half. Built once
// per Solve from the lane polylines (no re-prediction); read many times by the
// pocket search. Fixed-size — no per-tick heap.
struct TempCtx {
    int   count = 0;
    Vec2  pos[kMaxProjectiles][kUTemporalSamples];   // bullet position at t = k·stepMs
    float half[kMaxProjectiles];                     // hitHalf·scale + kUPlayerHalf
};

// Sample one lane's bullet position at each march time by interpolating its
// spacetime polyline (points + pointTimesMs). Monotone cursor over the polyline
// as t increases → O(points + samples). Beyond the traced horizon the position
// clamps to the last traced point (conservative — never invents "safe").
void SampleLaneOverTime(const LaneThreat& L, Vec2* outPos)
{
    const int cnt = L.pointCount;
    if (cnt <= 0) { for (int k = 0; k < kUTemporalSamples; ++k) outPos[k] = Vec2{}; return; }
    if (cnt == 1) { for (int k = 0; k < kUTemporalSamples; ++k) outPos[k] = L.points[0]; return; }

    int seg = 0;
    for (int k = 0; k < kUTemporalSamples; ++k) {
        const float t = static_cast<float>(k) * kUTemporalStepMs;
        while (seg + 1 < cnt - 1 && t > L.pointTimesMs[seg + 1]) ++seg;
        const float t0 = L.pointTimesMs[seg];
        const float t1 = L.pointTimesMs[seg + 1];
        if (t <= t0)       outPos[k] = L.points[seg];
        else if (t >= t1)  outPos[k] = L.points[seg + 1];   // clamp at path end
        else {
            const float f = (t - t0) / std::max(t1 - t0, 1e-3f);
            outPos[k] = Add(L.points[seg], Mul(Sub(L.points[seg + 1], L.points[seg]), f));
        }
    }
}

// Build the temporal context: predict every lane's future positions once, and
// cull lanes whose whole traced path stays outside the pocket-search region
// (far / receding shots contribute nothing to a pocket within kULookaheadTiles).
void BuildTempCtx(const MapInput& in, TempCtx& ctx)
{
    ctx.count = 0;
    if (!in.map) return;
    const float hitScale = std::clamp(in.settings.hitScale, 0.25f, 2.5f);
    const float cull = kUTemporalCullTiles;
    for (int i = 0; i < in.map->laneCount && ctx.count < kMaxProjectiles; ++i) {
        const LaneThreat& L = in.map->lanes[i];
        if (L.pointCount <= 0) continue;
        Vec2 samples[kUTemporalSamples];
        SampleLaneOverTime(L, samples);
        float minD = kHugeClearance;
        for (int k = 0; k < kUTemporalSamples; ++k)
            minD = std::min(minD, Len(Sub(samples[k], in.player)));
        if (minD > cull) continue;                       // far/receding — irrelevant to nearby pockets
        const int idx = ctx.count++;
        for (int k = 0; k < kUTemporalSamples; ++k) ctx.pos[idx][k] = samples[k];
        ctx.half[idx] = std::clamp(L.hitHalf, 0.05f, 2.5f) * hitScale + kUPlayerHalf;
    }
}

// TIME-parameterized clearance test. The player walks STRAIGHT from its live
// position toward P at its own speed, arriving at tArrive, then holds at P. March
// time over the horizon: at each step check the player's position against every
// relevant bullet's SWEPT segment over that step (swept, so a fast bullet cannot
// tunnel between samples). Clear at every step ⇒ the whole path to P — and
// holding there — dodges the moving bullets, with kUPocketMargin of slack.
bool TemporalPathClear(const MapInput& in, const TempCtx& ctx, Vec2 P)
{
    const Vec2  player = in.player;
    const Vec2  to = Sub(P, player);
    const float dist = Len(to);
    const Vec2  dir = dist > 1e-4f ? Mul(to, 1.f / dist) : Vec2{};
    const float v = in.speed;   // tiles/ms
    const float tArrive = (v > 1e-6f) ? dist / v : (dist > 1e-4f ? kHugeClearance : 0.f);

    for (int li = 0; li < ctx.count; ++li) {
        const float half = ctx.half[li] + kUPocketMargin;
        for (int k = 0; k < kUTemporalSteps; ++k) {
            const float t = static_cast<float>(k) * kUTemporalStepMs;
            const Vec2 pp = (t >= tArrive) ? P : Add(player, Mul(dir, v * t));
            const Vec2 b0 = ctx.pos[li][k];
            const Vec2 b1 = ctx.pos[li][k + 1];
            if (MinChebOnSegment(b0.x - pp.x, b0.y - pp.y,
                                 b1.x - pp.x, b1.y - pp.y) <= half) return false;
        }
        // Final sample (t = horizon): player is holding at P by now.
        const float tEnd = static_cast<float>(kUTemporalSteps) * kUTemporalStepMs;
        const Vec2 ppEnd = (tEnd >= tArrive) ? P : Add(player, Mul(dir, v * tEnd));
        const Vec2 bEnd = ctx.pos[li][kUTemporalSteps];
        if (Cheb(bEnd.x - ppEnd.x, bEnd.y - ppEnd.y) <= half) return false;
    }
    return true;
}

// A durable TEMPORAL pocket: occupiable, off enemy bodies, and temporally clear
// (path + hold) over the horizon. For the STAND point we additionally require it
// be spatially safe RIGHT NOW (the conservative floor: never "hold" on a spot a
// bullet is currently inside), so temporal only ever makes us hold LESS, never
// more, than the instantaneous safety guarantees.
bool IsDurablePocketTemporal(const MapInput& in, const TempCtx& ctx, Vec2 p, bool isStand)
{
    const bool walkable = !in.env.canOccupy ||
                 in.env.canOccupy(p.x, p.y, in.settings.safeWalk);
    if (!walkable) return false;
    if (EnemyBlocked(in, p)) return false;
    if (isStand && Core::PointSafety(in, p) < kULatencyPad) return false;   // safe-now floor
    return TemporalPathClear(in, ctx, p);
}

} // namespace

void Solve(const MapInput& in, float moveBudgetTiles, const Goal& goal,
           const Path::PlanResult& route, CoreState& state, SolveResult& out)
{
    out = SolveResult{};
    if (!in.map) { out.kind = SolveKind::Hold; return; }

    const float b = std::max(moveBudgetTiles, 1e-3f);

    // ── Temporal lookahead: nearest pocket safe over the next N ticks ────────
    // Predict every relevant bullet's trajectory (reusing the traced polyline),
    // then find the nearest cell where the STRAIGHT walk to it — and holding
    // there — dodges the moving bullets in TIME. This threads gaps the static
    // whole-path test cannot, and it drives the pre-positioning below.
    TempCtx ctx;
    BuildTempCtx(in, ctx);
    out.tempLanes = static_cast<uint8_t>(std::min(ctx.count, 255));

    // ── HOLD gate: is the current spot a DURABLE temporal pocket? ────────────
    // Safe right now AND no bullet will sweep through it over the horizon. If a
    // wall is closing (a bullet WILL arrive) the stand is not durable, so we plan
    // a route out instead of waiting. This is the immediate-reflex floor for the
    // stand: temporal only ever makes us hold LESS than instantaneous safety.
    const bool standDurable = IsDurablePocketTemporal(in, ctx, in.player, true);

    // ── Grid route from the WORKER thread (lookahead direction / goal bias) ──
    // The bounded grid Dijkstra that routes AROUND obstacles to the nearest
    // durable-safe cell (with radius expansion + in-range-disk gating) runs
    // ASYNC on the worker; here we only CONSUME its latest plain-data result. It
    // supersedes the straight-line pocket search for choosing the lookahead
    // target, but it is advisory: the immediate micro-dodge below stays the hard
    // safety floor and re-validates the actual step taken temporally, so a stale
    // route can never cost us a hit. When the worker is cold / the route is too
    // stale the caller passes found=false and this is a pure immediate dodge.
    const bool lockedDisk = goal.fromLock && goal.maxRange > 0.f;
    out.inRangeDisk = lockedDisk;
    out.outOfRange  = route.outOfRange;

    // Route diagnostics (target selection is the grid route, not the ring pocket).
    const bool  pocketFound = route.found;
    const Vec2  pocketPos   = route.stepTarget;   // reflex candidate + fallback bias point
    out.pocketDist    = route.found ? route.goalDist : 0.f;
    out.routeWaypoints = static_cast<uint8_t>(std::min(route.waypoints, 255));
    out.routeExpanded  = route.expanded;
    out.routePops      = static_cast<uint16_t>(std::min(route.pops, 65535));
    out.routeRadius    = static_cast<uint8_t>(std::min(route.radiusCells, 255));

    Cand cands[kMaxCandidates];
    const int n = BuildCandidates(in, b, goal, pocketFound, pocketPos, cands);
    Evaluate(in, cands, n);

    // ── Hold ONLY when the current spot is a DURABLE temporal pocket ─────────
    // The ONE exception: a boss lock drifted OUTSIDE weapon range repositions inward.
    if (standDurable) {
        bool repositionInward = false;
        if (goal.fromLock && goal.maxRange > 0.f)
            repositionInward = Len(Sub(in.player, goal.lockPos)) > goal.maxRange;
        if (!repositionInward) {
            out.kind = SolveKind::Hold;
            out.target = in.player;
            out.clearance = cands[0].clr;
            out.shouldMove = false;
            state.lastMoveDir = {};   // fresh commitment when the next dodge starts
            return;
        }
    }

    // ── Pre-position: step along the grid route toward the safe area ─────────
    // The stand is not durable but a route to a safe area exists. Step ≈ one
    // budget along the route (the curve around the obstacle the straight-line
    // solver cannot make). The IMMEDIATE FLOOR: validate the actual step taken
    // with the temporal check — if the straight step to stepTarget would eat a
    // shot in TIME, reject it and fall through to the conservative spatial reflex
    // so the route never costs us a hit. Occupancy is hard (walls/enemies).
    if (route.found && !standDurable) {
        const Vec2  to = Sub(route.stepTarget, in.player);
        const float d = Len(to);
        if (d > 1e-4f) {
            const Vec2  dir = Mul(to, 1.f / d);
            const float r = std::min(d, b);
            const Vec2  target = Add(in.player, Mul(dir, r));
            const bool  walkable = !in.env.canOccupy ||
                         in.env.canOccupy(target.x, target.y, in.settings.safeWalk);
            if (walkable && !EnemyBlocked(in, target) &&
                TemporalPathClear(in, ctx, target)) {   // immediate-step temporal floor
                out.kind = SolveKind::Safe;
                out.target = target;
                out.clearance = Core::PointSafety(in, target);   // spatial clr (may be <0 — time-threaded)
                out.shouldMove = true;
                out.prePosition = true;
                out.followedRoute = true;
                state.lastMoveDir = dir;
                return;
            }
        }
    }

    // ── Conservative reflex: choose AMONG the spatially-SAFE reachable cells ──
    // The instantaneous lane-based floor, unchanged. Runs when the stand is not
    // durable and no temporal pocket is reachable this tick (or a wall blocks the
    // straight path) — never gets less safe than the pre-temporal build.
    const Vec2 flow = FlowDir(in);
    const Vec2 prevDir = state.lastMoveDir;
    int best = -1;
    float bestScore = -kHugeClearance;
    for (int i = 0; i < n; ++i) {
        if (!cands[i].safe) continue;
        const float s = ScoreCand(cands[i], in.player, goal, flow, prevDir, b);
        if (best < 0 || s > bestScore) {
            bestScore = s;
            best = i;
        }
    }

    if (best >= 0) {
        const Cand& w = cands[best];
        out.target = w.pos;
        out.clearance = w.clr;
        if (w.stand || w.moveDist <= 1e-4f) {
            out.kind = SolveKind::Hold;
            out.shouldMove = false;
        } else {
            out.kind = SolveKind::Safe;
            out.shouldMove = true;
            state.lastMoveDir = w.dir;
        }
        return;
    }

    // ── Fallback: no safe reachable cell — least-bad, biased toward the gap ──
    // Maximize clearance (max-min-clearance) but bias the step toward the durable
    // pocket so we head for the gap, not a dead end. Clearance still leads so we
    // never step into materially worse danger just to chase the pocket.
    const float standClr = Core::PointSafety(in, in.player);
    const float playerToPocket = pocketFound ? Len(Sub(in.player, pocketPos)) : 0.f;
    int best2 = -1;
    float best2Val = -kHugeClearance;
    for (int i = 0; i < n; ++i) {
        if (!cands[i].occOk) continue;
        float val = cands[i].clr;
        if (pocketFound) {
            const float prog = playerToPocket - Len(Sub(cands[i].pos, pocketPos));
            val += kSolveFallbackPocketW * prog;
        }
        if (val > best2Val) { best2Val = val; best2 = i; }
    }

    if (best2 >= 0) {
        const Cand& w = cands[best2];
        // Move only if it actually helps: strictly higher clearance than standing,
        // OR it steps toward the route's gap without dropping clearance meaningfully.
        const float progToward = pocketFound
            ? playerToPocket - Len(Sub(w.pos, pocketPos)) : 0.f;
        const bool helps = w.clr > standClr + 1e-3f ||
                           (pocketFound && progToward > 1e-3f &&
                            w.clr >= standClr - kUPocketMargin);
        if (helps && w.moveDist > 1e-4f) {
            out.kind = SolveKind::Fallback;
            out.target = w.pos;
            out.clearance = w.clr;
            out.shouldMove = true;
            out.prePosition = pocketFound && !standDurable;
            out.followedRoute = pocketFound && route.waypoints > 2;
            if (LenSq(w.dir) > 1e-6f) state.lastMoveDir = w.dir;
            return;
        }
    }

    // Nowhere reachable improves on standing still → hold and say so honestly.
    out.kind = SolveKind::Surrounded;
    out.target = in.player;
    out.clearance = standClr;
    out.shouldMove = false;
}

} } // namespace UDodge::Solver
