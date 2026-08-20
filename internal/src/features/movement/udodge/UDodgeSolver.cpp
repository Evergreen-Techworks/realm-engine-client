#include "pch-il2cpp.h"
#include "UDodgeSolver.h"
#include "UDodgeCore.h"

#include <algorithm>
#include <cmath>

namespace UDodge { namespace Solver {
namespace {

// ── Reachable candidate set (tiny, ≤ ~1.9 tiles) ────────────────────────────
// The stand point plus polar rings at 0.34/0.67/1.0 of the move budget over
// K headings, plus (when a goal exists) the goal-direction point clamped to the
// budget. K = 24 ≈ 15° resolution; three rings resolve any gap the player can
// physically fit through inside one tick's reach.
constexpr int   kSolveAngles = 24;
constexpr int   kSolveRings   = 3;
constexpr float kRingFrac[kSolveRings] = { 0.34f, 0.67f, 1.0f };
// stand + rings + goal-direction point.
constexpr int   kMaxCandidates = 1 + kSolveRings * kSolveAngles + 1;   // 74

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

    // RePP-style perpendicular sidestep tiebreak (component of dir ⟂ to flow).
    if (LenSq(flow) > 1e-6f && LenSq(c.dir) > 1e-6f) {
        const float par = Dot(c.dir, flow);
        const float perp = std::sqrt(std::max(0.f, 1.f - par * par));
        score += kSolvePerpW * perp;
    }

    // Minimal disruption — prefer the nearest safe point.
    score -= kSolveMoveW * c.moveDist / std::max(b, 1e-3f);

    // Gentle comfort tiebreak, capped so it never dominates.
    score += kSolveClearW * std::min(c.clr, kSolveClearComfort);

    // Stand bias: when standing still is safe and nothing is clearly better,
    // hold (minimal disruption) instead of twitching off a safe stand.
    if (c.stand) score += kSolveStandBias;

    return score;
}

int BuildCandidates(const MapInput& in, float b, const Goal& goal, Cand* out)
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
    return n;
}

// Evaluate occupancy + server-accurate clearance for every candidate.
void Evaluate(const MapInput& in, Cand* c, int n)
{
    for (int i = 0; i < n; ++i) {
        c[i].occOk = !in.env.canOccupy ||
                     in.env.canOccupy(c[i].pos.x, c[i].pos.y, in.settings.safeWalk);
        c[i].clr = Core::PointSafety(in, c[i].pos);
        c[i].safe = c[i].occOk && c[i].clr >= kULatencyPad;
    }
}

} // namespace

void Solve(const MapInput& in, float moveBudgetTiles, const Goal& goal,
           CoreState& state, SolveResult& out)
{
    out = SolveResult{};
    if (!in.map) { out.kind = SolveKind::Hold; return; }

    const float b = std::max(moveBudgetTiles, 1e-3f);

    Cand cands[kMaxCandidates];
    const int n = BuildCandidates(in, b, goal, cands);
    Evaluate(in, cands, n);

    // ── Hard constraint met: choose AMONG the safe points by smart direction ─
    // Safety is already guaranteed for every safe candidate; the objective only
    // ranks them (continuity + goal + sidestep + minimal-move + comfort + stand
    // bias). argmax over the safe set → Safe (or Hold if the stand point wins).
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

    // ── Fallback: no safe reachable cell — least-bad (max-min-clearance) ─────
    const float standClr = Core::PointSafety(in, in.player);
    int bestClr = -1;
    float bestClrVal = -kHugeClearance;
    for (int i = 0; i < n; ++i) {
        if (!cands[i].occOk) continue;
        if (cands[i].clr > bestClrVal) {
            bestClrVal = cands[i].clr;
            bestClr = i;
        }
    }

    // Nowhere reachable improves on standing still → hold and say so honestly.
    if (bestClr < 0 || bestClrVal <= standClr) {
        out.kind = SolveKind::Surrounded;
        out.target = in.player;
        out.clearance = standClr;
        out.shouldMove = false;
        return;
    }

    const Cand& w = cands[bestClr];
    out.kind = SolveKind::Fallback;
    out.target = w.pos;
    out.clearance = w.clr;
    out.shouldMove = true;
    if (LenSq(w.dir) > 1e-6f) state.lastMoveDir = w.dir;
}

} } // namespace UDodge::Solver
