#include "UDodgeCore.h"
#include "UDodgeTrajectoryPhase.h"
#include <cstdio>

using namespace UDodge;
static int failures = 0;
static int checks = 0;
static void Check(bool ok, const char* name)
{
    ++checks;
    if (!ok) { ++failures; std::fprintf(stderr, "FAIL: %s\n", name); }
}

int main()
{
    static_assert(kMaxProjectiles >= 512, "dense volleys require the increased lane capacity");
    static DangerMap dense{};
    dense.laneCount = kMaxProjectiles;
    for (int i = 0; i < dense.laneCount; ++i) {
        auto& l = dense.lanes[i];
        l.pointCount = l.instantCount = 2;
        l.hitHalf = 0.1f;
        l.points[0] = l.points[1] = {10.f, 0.f};
        l.pointTimesMs[0] = 0.f; l.pointTimesMs[1] = 1200.f;
    }
    dense.lanes[kMaxProjectiles - 1].points[0] = dense.lanes[kMaxProjectiles - 1].points[1] = {0.f, 0.f};
    static Core::Temporal::Ctx denseCtx;
    Core::Temporal::Build(dense, 1.f, 0.f, {}, 20.f, denseCtx);
    Check(denseCtx.count == kMaxProjectiles, "temporal prediction includes all 512 admitted projectiles");
    Check(!Core::Temporal::PathClear(denseCtx, {}, 0.f, {}), "last projectile beyond old cap still blocks an unsafe stand");

    static DangerMap map{};
    Core::Temporal::Ctx ctx{};
    map.laneCount = 1;
    auto& lane = map.lanes[0];
    lane.pointCount = lane.instantCount = 2;
    lane.hitHalf = 0.05f;
    lane.tailAtShotEnd = true;
    lane.points[0] = {-3.f, 0.f};
    lane.points[1] = {3.f, 0.f};
    lane.pointTimesMs[1] = 100.f;
    Core::Temporal::Build(map, 1.f, 0.f, {}, 1.f, ctx);
    Check(ctx.count == 1, "retain shot crossing cull region between samples");
    Check(!Core::Temporal::PathClear(ctx, {}, 0.f, {}), "detect crossing shot");

    lane.pointCount = lane.instantCount = 1;
    lane.points[0] = {2.5f, 0.f};
    lane.hitHalf = 1.f;
    Core::Temporal::Build(map, 1.f, 0.f, {}, 2.f, ctx);
    Check(ctx.count == 1, "culling includes projectile hit extent");
    Check(!Core::Temporal::PathClear(ctx, {1.5f, 0.f}, 0.f, {1.5f, 0.f}), "wide shot reaches inside query region");
    lane.points[0] = {10.f, 0.f};
    Core::Temporal::Build(map, 1.f, 0.f, {}, 2.f, ctx);
    Check(ctx.count == 0, "still cull distant stationary shot");

    // Oscillation returns to the same point at BOTH 100 ms and 50 ms samples.
    // The finer source trace still records the real crossings at 25 and 75 ms.
    lane.pointCount = lane.instantCount = 5;
    lane.hitHalf = 0.05f;
    for (int i = 0; i < 5; ++i) {
        lane.points[i] = {0.f, (i % 2) ? 0.f : 2.f};
        lane.pointTimesMs[i] = i * 25.f;
    }
    Core::Temporal::Build(map, 1.f, 0.f, {}, 10.f, ctx);
    Check(ctx.count == 1 && ctx.sub[0], "detect fast motion hidden by returning endpoints");
    Check(ctx.count == 1 && ctx.speed[0] > 0.079f, "measure speed from source segments");
    Check(!Core::Temporal::PathClear(ctx, {}, 0.f, {}), "retain oscillation crossing between temporal samples");
    Check(Core::Temporal::PathClear(ctx, {6.f, 0.f}, 0.f, {6.f, 0.f}), "curve error does not block distant safe stand");

    lane.pointCount = lane.instantCount = 5;
    for (int i = 0; i < 5; ++i) {
        lane.points[i] = {0.f, 0.5f * static_cast<float>(i < 2 ? 2-i : i-2)};
        lane.pointTimesMs[i] = i * 100.f;
    }
    Core::Temporal::Build(map, 1.f, 0.f, {}, 10.f, ctx);
    Check(!ctx.sub[0], "slow curved shot keeps inexpensive march");
    Check(!Core::Temporal::ArrivalClear(ctx, {}, 0.f, 400.f), "arrival window follows slow shot through intermediate crossing");
    Check(Core::Temporal::ArrivalClear(ctx, {3.f, 0.f}, 0.f, 400.f), "safe arrival window stays clear");

    // Straight trajectories have no resampling error: the new curve bound must
    // not inflate their established timing margin.
    lane.pointCount = lane.instantCount = 2;
    lane.points[0] = {0.f, 0.f};
    lane.points[1] = {8.f, 0.f};
    lane.pointTimesMs[0] = 0.f;
    lane.pointTimesMs[1] = 800.f;
    Core::Temporal::Build(map, 1.f, 0.f, {}, 10.f, ctx);
    const float expectedPad = kUArrivalMargin + std::min(0.01f * kUPredErrMs, kUPredPadMaxTiles);
    Check(std::fabs(ctx.arrPad[0] - expectedPad) < 1e-5f, "straight-shot margin is unchanged");

    // Exercise many phases/frequencies against source vertices known to be
    // actual hits. Every vertex lies on the supplied trace; none may become
    // clear merely because it falls between temporal samples.
    bool retainedAll = true;
    for (int pattern = 0; pattern < 200; ++pattern) {
        lane.pointCount = lane.instantCount = 33;
        for (int j = 0; j < 33; ++j) {
            const float phase = pattern * 0.17f + j * (0.12f + (pattern % 23) * 0.09f);
            lane.pointTimesMs[j] = j * 25.f;
            lane.points[j] = {3.f * std::sin(phase), 2.f * std::cos(phase * 1.3f)};
        }
        Core::Temporal::Build(map, 1.f, 0.f, {}, 10.f, ctx);
        for (int j = 1; j < 33; j += 4) {
            const Vec2 p = lane.points[j];
            if (Core::Temporal::TimeToDanger(ctx, p, 0.f, p) == Core::Temporal::kNoDanger)
                retainedAll = false;
        }
    }
    Check(retainedAll, "1600 known curve hits survive temporal resampling");
    // Fractional-phase anchor for a sampled curved path: the live phase between
    // two cached samples is interpolated, not snapped to the nearer sample.
    {
        const float times[4] = {0.f, 50.f, 100.f, 150.f};
        const float xs[4]    = {0.f, 1.f, 2.f, 3.f};
        const float ys[4]    = {0.f, 0.f, 1.f, 1.f};   // a bend between samples 1 and 2
        int idx = -1; Vec2 pos{};
        Check(FractionalPathAnchor(times, xs, ys, 4, 70.f, idx, pos) && idx == 1 &&
              std::fabs(pos.x - 1.4f) < 1e-5f && std::fabs(pos.y - 0.4f) < 1e-5f,
              "fractional anchor interpolates phase inside the containing sample segment");
        Check(FractionalPathAnchor(times, xs, ys, 4, 50.f, idx, pos) && idx == 1 &&
              std::fabs(pos.x - 1.f) < 1e-5f, "fractional anchor at a sample time uses that sample as segment start");
        Check(!FractionalPathAnchor(times, xs, ys, 4, 150.f, idx, pos), "phase at the final sample has no forward segment");
        Check(!FractionalPathAnchor(times, xs, ys, 4, -1.f, idx, pos), "negative phase is rejected");
        Check(!FractionalPathAnchor(times, xs, ys, 1, 0.f, idx, pos), "a single sample cannot anchor a phase");
        const float badTimes[3] = {0.f, 100.f, 50.f};   // clock stops advancing after sample 1
        Check(!FractionalPathAnchor(badTimes, xs, ys, 3, 100.f, idx, pos), "phase inside a non-advancing segment is rejected");
    }
    // POINT-PLAYER contact model: the game's per-shot threshold T is the whole
    // hit box; the player is a point. A stationary shot 0.65 tiles away with
    // T = 0.5 clears under the point model (0.5 + 0.10 arrival margin) and is
    // blocked under the legacy padded model (0.5 + 0.2139 + 0.10).
    {
        static DangerMap pm{};
        pm.laneCount = 1;
        auto& l = pm.lanes[0];
        l = LaneThreat{};
        l.pointCount = l.instantCount = 2;
        l.hitHalf = 0.5f;
        l.points[0] = l.points[1] = {0.65f, 0.f};
        l.pointTimesMs[0] = 0.f; l.pointTimesMs[1] = 1200.f;
        Core::Temporal::Ctx pc{};
        Core::Temporal::Build(pm, 1.f, 0.f, {}, 4.f, pc, /*playerHalf=*/0.f);
        Check(pc.count == 1 && Core::Temporal::PathClear(pc, {}, 0.f, {}),
              "point-player temporal contact clears a stand just outside the shot threshold");
        Core::Temporal::Build(pm, 1.f, 0.f, {}, 4.f, pc, kUPlayerHalf);
        Check(!Core::Temporal::PathClear(pc, {}, 0.f, {}),
              "padded temporal contact still blocks the same stand when the player half is folded in");
    }
    std::printf("Temporal regression tests: %d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
