// Owner hypothesis, 2026-09-26 (queued after udodgeNeverStandLocked): while a
// boss lock is active, bias candidate selection toward TANGENTIAL movement
// (perpendicular to the player-to-boss radial, i.e. orbiting) over a radial
// in/out step. See UDodgeTypes.h's Settings::tangentialBias doc comment and
// docs/dodge-loop/progress.md for the measurable live prediction.
//
// Drives the real Solver::Solve() path directly, combined with
// udodgeNeverStandLocked=true so the reflex loop (where ScoreCand actually
// runs) is reached in an otherwise perfectly safe, empty map -- this isolates
// tangentialBias's own scoring term rather than confounding it with whether a
// stand is accepted (a separate, already-tested flag).
#include "UDodgeSolver.h"
#include <cstdio>
#include <cmath>
using namespace UDodge;

int main() {
    int n = 0, f = 0;
    auto ck = [&](bool x, const char* m) { ++n; if (!x) { ++f; std::printf("FAIL %s\n", m); } };

    static DangerMap map;              // empty/open map: every candidate is
                                        // equally safe, so only score terms
                                        // (goal-progress pulling radially in,
                                        // and this flag pulling tangentially)
                                        // decide the winner.
    MapInput in;
    in.map = &map;
    in.speed = .05f;
    in.player = {0.f, 0.f};

    Solver::Goal goal;
    goal.active = goal.fromLock = true;
    goal.lockPos = {5.f, 0.f};          // boss due east of the player.
    goal.pos = {5.f, 0.f};
    goal.maxRange = 0.f;                // 0 disables the range-keeping term (isolation).

    Path::PlanResult route;

    float radialDotOff = 0.f, radialDotOn = 0.f;
    for (int on = 0; on <= 1; ++on) {
        in.settings = Settings{};
        in.settings.neverStandLocked = true;   // reach the reflex loop (see file header).
        in.settings.tangentialBias = on != 0;
        CoreState state;
        Solver::SolveResult out;
        Solver::Solve(in, 1.f, goal, route, state, out);
        const float dx = out.target.x - in.player.x, dy = out.target.y - in.player.y;
        const float len = std::sqrt(dx * dx + dy * dy);
        const float radialDot = len > 1e-6f ? dx / len : 0.f;  // radial axis is (1,0) here.
        ck(out.kind == Solver::SolveKind::Safe && out.shouldMove,
           on ? "switch on: still picks a safe moving candidate" : "switch off: still picks a safe moving candidate");
        (on ? radialDotOn : radialDotOff) = radialDot;
    }

    ck(radialDotOff > 0.9f, "switch off: goal-progress pulls the pick strongly RADIAL (toward the locked boss)");
    ck(std::fabs(radialDotOn) < 0.3f, "switch on: the tangential bias pulls the pick away from radial (near-perpendicular)");
    ck(std::fabs(radialDotOn) < radialDotOff - 0.3f, "switch on measurably reduces the radial component versus switch off");

    std::printf("tangential bias: %d checks %d failures\n", n, f);
    return f ? 1 : 0;
}
