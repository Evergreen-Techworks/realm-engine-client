#include "pch-il2cpp.h"
#include "UDodgeSolver.h"
#include "UDodgeCore.h"

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
                Vec2 flow, Vec2 prevDir, float b,
                bool prePosition, bool pocketFound, Vec2 pocketPos)
{
    float score = 0.f;

    // Continuity — reward continuing the last committed heading (kills jitter).
    // The stand point (dir {}) scores 0 here. Applies in both modes.
    if (LenSq(c.dir) > 1e-6f && LenSq(prevDir) > 1e-6f)
        score += kSolveCommitW * std::max(0.f, Dot(c.dir, prevDir));

    // RePP-style perpendicular sidestep tiebreak (component of dir ⟂ to flow).
    if (LenSq(flow) > 1e-6f && LenSq(c.dir) > 1e-6f) {
        const float par = Dot(c.dir, flow);
        const float perp = std::sqrt(std::max(0.f, 1.f - par * par));
        score += kSolvePerpW * perp;
    }

    // Gentle comfort tiebreak, capped so it never dominates. Both modes.
    score += kSolveClearW * std::min(c.clr, kSolveClearComfort);

    if (prePosition && pocketFound) {
        // ── Pre-position mode: the current spot is only momentarily safe (a wall
        // is closing), so the objective is to ADVANCE toward the durable pocket.
        // This term does NOT fade near danger (unlike the orbit goal below) — the
        // pocket is safe by construction, so heading for it is always correct.
        const float progress = Len(Sub(player, pocketPos)) - Len(Sub(c.pos, pocketPos));
        score += kSolvePocketW * progress;
        // Only a light reach penalty — reaching the gap is the point — and NO
        // stand bias (holding on a non-durable spot is exactly what we avoid).
        score -= kSolveMoveW * 0.25f * c.moveDist / std::max(b, 1e-3f);
        return score;
    }

    // ── Standard mode: rank durable-safe options (orbit / minimal disruption). ─
    // Advance toward the goal, but fade the pull to zero as the point approaches
    // the safety floor so near danger the dodge never chases the orbit line.
    if (goal.active) {
        const float progress = Len(Sub(player, goal.pos)) - Len(Sub(c.pos, goal.pos));
        const float ramp = std::clamp((c.clr - kULatencyPad) / kUScoreStyleBand, 0.f, 1.f);
        score += kSolveGoalW * progress * ramp;
    }

    // Minimal disruption — prefer the nearest safe point.
    score -= kSolveMoveW * c.moveDist / std::max(b, 1e-3f);

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

// ── Lookahead: nearest durable-safe pocket ──────────────────────────────────
struct Pocket {
    bool  found = false;
    Vec2  pos{};
    float dist = 0.f;   // reach distance from the player to the pocket
};

// A DURABLE-safe pocket. Core::PointSafety is the min, over every lane, of
// Cheb-to-lane − (bulletHalf·scale + kUPlayerHalf); a lane is the bullet's LIVE
// position followed by its WHOLE remaining travel path as geometry, so a point
// with PointSafety ≥ margin is clear of every bullet's entire future path, not
// just its instantaneous position — no bullet will ever pass through it. On top
// of that hard-safety floor we require kUPocketMargin of comfort, occupiable
// ground, and no enemy body. (Active zones already subtract into PointSafety.)
bool IsDurablePocket(const MapInput& in, Vec2 p)
{
    const bool walkable = !in.env.canOccupy ||
                 in.env.canOccupy(p.x, p.y, in.settings.safeWalk);
    if (!walkable) return false;
    if (EnemyBlocked(in, p)) return false;
    return Core::PointSafety(in, p) >= kUPocketMargin;
}

// Search a horizon LARGER than one tick's move budget for the NEAREST durable
// pocket. Concentric rings outward (nearest-first) with early-out at the first
// ring that contains one; among that ring's pockets, tie-break toward the goal
// (and, when a boss is locked, toward the in-weapon-range side). The stand
// point is tested first — if the current spot is already durable it is the
// nearest possible pocket (dist 0), which the caller reads as "HOLD".
//
// Cost is bounded and tick-gated: at most kUPocketRings×kUPocketAngles (288)
// PointSafety evals, and it early-exits the instant a nearer ring yields a
// pocket — typically far fewer. That is a few thousand cheap Cheb ops at 5 Hz.
Pocket FindNearestPocket(const MapInput& in, const Goal& goal)
{
    Pocket best;
    const Vec2 player = in.player;

    if (IsDurablePocket(in, player)) {
        best.found = true; best.pos = player; best.dist = 0.f;
        return best;
    }

    const float step = kULookaheadTiles / static_cast<float>(kUPocketRings);
    for (int ri = 1; ri <= kUPocketRings; ++ri) {
        const float r = step * static_cast<float>(ri);
        bool  ringHit = false;
        float ringBestTie = -kHugeClearance;
        Vec2  ringBestPos{};
        for (int k = 0; k < kUPocketAngles; ++k) {
            const float ang = kTwoPi * static_cast<float>(k) / static_cast<float>(kUPocketAngles);
            const Vec2 p = Add(player, Vec2{ std::cos(ang) * r, std::sin(ang) * r });
            if (!IsDurablePocket(in, p)) continue;
            // Tie-break within the ring: advance toward the goal, and (locked)
            // keep the pocket inside weapon range so we don't flee out of range.
            float tie = 0.f;
            if (goal.active)
                tie += Len(Sub(player, goal.pos)) - Len(Sub(p, goal.pos));
            if (goal.fromLock && goal.maxRange > 0.f) {
                const float distToBoss = Len(Sub(p, goal.lockPos));
                if (distToBoss > goal.maxRange)
                    tie -= kSolveOutRangeW * (distToBoss - goal.maxRange);
            }
            if (!ringHit || tie > ringBestTie) {
                ringHit = true; ringBestTie = tie; ringBestPos = p;
            }
        }
        if (ringHit) {
            best.found = true; best.pos = ringBestPos; best.dist = r;
            return best;   // nearest ring with a pocket wins
        }
    }
    return best;   // no durable pocket within the horizon
}

} // namespace

void Solve(const MapInput& in, float moveBudgetTiles, const Goal& goal,
           CoreState& state, SolveResult& out)
{
    out = SolveResult{};
    if (!in.map) { out.kind = SolveKind::Hold; return; }

    const float b = std::max(moveBudgetTiles, 1e-3f);

    // ── Lookahead: nearest durable-safe pocket over a horizon > one tick ─────
    // Because lanes encode each bullet's whole forward path, a point clear of
    // all lanes by margin is durably safe. Find the nearest such pocket and let
    // it drive the immediate solve so we pre-position INTO the gap before the
    // wall closes, rather than greedily picking the safest cell reachable NOW.
    const Pocket pocket = FindNearestPocket(in, goal);
    const bool standDurable = pocket.found && pocket.dist <= 1e-4f;
    out.pocketDist = pocket.found ? pocket.dist : 0.f;

    Cand cands[kMaxCandidates];
    const int n = BuildCandidates(in, b, goal, pocket.found, pocket.pos, cands);
    Evaluate(in, cands, n);

    // ── Hold ONLY when the current spot is itself a DURABLE pocket ───────────
    // Momentary safety is not enough: if a lane's forward path already crosses
    // the stand (a wall closing) it is not durable, so we pre-position toward
    // the pocket below instead of waiting to be threatened. When the stand IS a
    // durable pocket with comfortable margin we hold (no jitter) and do not
    // fight the player's own WASD. The ONE exception: a boss lock that drifted
    // OUTSIDE weapon range repositions inward to get back into shooting range.
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

    // Pre-positioning: the stand is not a durable pocket but a reachable one
    // exists — steer the immediate pick toward it (the pocket becomes the goal
    // the per-tick solve advances toward, one budget at a time).
    const bool prePosition = pocket.found && !standDurable;

    // ── Hard constraint met: choose AMONG the safe points by smart direction ─
    // Safety is a hard filter (every scored candidate is provably safe); the
    // objective only ranks them. In pre-position mode the ranking maximizes
    // progress toward the durable pocket; otherwise it is the standard
    // continuity + orbit-goal + minimal-move + comfort + stand-bias ranking.
    const Vec2 flow = FlowDir(in);
    const Vec2 prevDir = state.lastMoveDir;
    int best = -1;
    float bestScore = -kHugeClearance;
    for (int i = 0; i < n; ++i) {
        if (!cands[i].safe) continue;
        const float s = ScoreCand(cands[i], in.player, goal, flow, prevDir, b,
                                  prePosition, pocket.found, pocket.pos);
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
            // Only the safe stand beats every reachable step — no safe progress
            // toward the pocket is possible this tick, so hold and re-solve next
            // tick when the bullets (and thus the reachable safe cells) shift.
            out.kind = SolveKind::Hold;
            out.shouldMove = false;
        } else {
            out.kind = SolveKind::Safe;
            out.shouldMove = true;
            out.prePosition = prePosition;
            state.lastMoveDir = w.dir;
        }
        return;
    }

    // ── Fallback: no safe reachable cell — least-bad, biased toward the gap ──
    // Maximize clearance (max-min-clearance) but bias the step toward the durable
    // pocket so we head for the gap, not a dead end. Clearance still leads so we
    // never step into materially worse danger just to chase the pocket.
    const float standClr = Core::PointSafety(in, in.player);
    const float playerToPocket = pocket.found ? Len(Sub(in.player, pocket.pos)) : 0.f;
    int best2 = -1;
    float best2Val = -kHugeClearance;
    for (int i = 0; i < n; ++i) {
        if (!cands[i].occOk) continue;
        float val = cands[i].clr;
        if (pocket.found) {
            const float prog = playerToPocket - Len(Sub(cands[i].pos, pocket.pos));
            val += kSolveFallbackPocketW * prog;
        }
        if (val > best2Val) { best2Val = val; best2 = i; }
    }

    if (best2 >= 0) {
        const Cand& w = cands[best2];
        // Move only if it actually helps: strictly higher clearance than standing,
        // OR it steps toward the pocket without dropping clearance meaningfully.
        const float progToward = pocket.found
            ? playerToPocket - Len(Sub(w.pos, pocket.pos)) : 0.f;
        const bool helps = w.clr > standClr + 1e-3f ||
                           (pocket.found && progToward > 1e-3f &&
                            w.clr >= standClr - kUPocketMargin);
        if (helps && w.moveDist > 1e-4f) {
            out.kind = SolveKind::Fallback;
            out.target = w.pos;
            out.clearance = w.clr;
            out.shouldMove = true;
            out.prePosition = prePosition;
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
