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

    // ── Hard constraint: prefer a provably-safe reachable point ──────────────
    // Safety-only objective for now: among safe candidates pick the one nearest
    // the player (minimal disruption). The stand point (moveDist 0) therefore
    // wins whenever standing still is safe → Hold.
    int best = -1;
    float bestMove = kHugeClearance;
    for (int i = 0; i < n; ++i) {
        if (!cands[i].safe) continue;
        if (best < 0 || cands[i].moveDist < bestMove) {
            best = i;
            bestMove = cands[i].moveDist;
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
