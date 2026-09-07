#include "UDodgeCore.h"
#include "UDodgeSolver.h"
#include "UDodgePathfinder.h"
#include "../src/features/movement/dodge/AoeCapturePolicy.h"
#include <limits>
#include <cstdio>
#include <cstdlib>

using namespace UDodge;

static void Check(bool condition, const char* name)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", name);
        std::exit(1);
    }
}

int main()
{
    static DangerMap map{};
    MapInput in{};
    in.map = &map;
    map.zoneCount = 1;
    map.zones[0].pos = {0.f, 0.f};
    map.zones[0].radius = 0.3f;
    map.zones[0].active = true;
    Check(Core::ZonePathClear(in, {0.f, 0.f}, {2.f, 0.f}), "escape single blast");
    Check(!Core::ZonePathClear(in, {0.f, 0.f}, {0.1f, 0.f}), "destination remains inside blast");
    Check(!Core::ZonePathClear(in, {-2.f, 0.f}, {2.f, 0.f}), "cross blast with clear endpoints");

    map.zoneCount = 2;
    map.zones[1].pos = {1.f, 0.f};
    map.zones[1].radius = 0.2f;
    map.zones[1].active = true;
    Check(!Core::ZonePathClear(in, {0.f, 0.f}, {2.f, 0.f}), "escape must not cross second blast");
    Check(Core::ZonePathClear(in, {0.f, 0.f}, {-2.f, 0.f}), "escape away from second blast");
    map.zones[1].active = false;
    Check(Core::ZonePathClear(in, {0.f, 0.f}, {2.f, 0.f}), "pending blast remains soft");
    map.zones[1].active = true;
    map.zones[1].pos = {0.1f, 0.f};
    Check(Core::ZonePathClear(in, {0.f, 0.f}, {2.f, 0.f}), "escape overlapping blasts containing start");
    map.zoneCount = 0;
    Check(Core::ZonePathClear(in, {0.f, 0.f}, {2.f, 0.f}), "empty map");
    map.zoneCount = 1;
    map.zones[0].radius = 3.f;
    Check(Core::ZoneEscapePathClear(in, {1.f, 0.f}, {2.f, 0.f}), "partial outward escape from large bomb");
    Check(!Core::ZoneEscapePathClear(in, {1.f, 0.f}, {-4.f, 0.f}), "escape must not cross bomb centre");
    Check(Core::ZoneEscapePathClear(in, {0.f, 0.f}, {1.f, 0.f}), "escape from exact centre");
    map.zoneCount = 2;
    map.zones[1].pos = {2.f, 0.f};
    Check(!Core::ZoneEscapePathClear(in, {0.f, 0.f}, {4.f, 0.f}), "emergency escape must not enter second bomb");

    Check(AoeCapturePolicy::DurationMs(50.f) == 50.f, "preserve 50 ms flight");
    Check(AoeCapturePolicy::DurationMs(100.f) == 100.f, "preserve 100 ms flight");
    Check(AoeCapturePolicy::DurationMs(0.f) == 3000.f, "invalid duration fallback");
    Check(AoeCapturePolicy::DurationMs(std::numeric_limits<float>::quiet_NaN()) == 3000.f,
          "nonfinite duration fallback");
    Check(AoeCapturePolicy::ResolveOwner(false, 2, 0) == 0, "throwable ID cannot establish friendly ownership");
    Check(AoeCapturePolicy::ResolveOwner(false, 2, 1) == 1, "enemy at throwable origin");
    Check(AoeCapturePolicy::ResolveOwner(false, 0, 2) == 0, "nearby prop cannot establish friendly ownership");
    Check(AoeCapturePolicy::ResolveOwner(true, 2, 1) == 2, "known friendly source remains friendly");
    Check(AoeCapturePolicy::ResolveOwner(true, 0, 0) == 0, "failed ownership read remains unknown");
    const float coordinates[2] = {12.5f, -3.25f};
    int64_t packed = 0;
    std::memcpy(&packed, coordinates, sizeof(packed));
    float x = 0.f, y = 0.f;
    Check(AoeCapturePolicy::DecodePosition(packed, x, y) && x == coordinates[0] && y == coordinates[1],
          "initializer position decoding");
    // Force the real solver into fallback: no one-tick endpoint exits this
    // large bomb. A crossing bullet must not be traded for endpoint clearance.
    map.zoneCount = 1;
    in.player = {1.f, 0.f};
    in.speed = 0.005f;
    map.laneCount = 1;
    auto& lane = map.lanes[0];
    lane.pointCount = lane.instantCount = 2;
    lane.points[0] = {1.85f, 1.f};
    lane.points[1] = {1.85f, -1.f};
    lane.pointTimesMs[0] = 0.f;
    lane.pointTimesMs[1] = 200.f;
    lane.hitHalf = 0.05f;
    lane.tailAtShotEnd = true;
    Solver::Goal goal{};
    goal.active = true;
    goal.pos = {5.f, 0.f};
    Path::PlanResult route{};
    CoreState state{};
    Solver::SolveResult result{};
    Solver::Solve(in, 1.f, goal, route, state, result);
    Check(result.kind == Solver::SolveKind::Fallback && result.shouldMove, "large bomb still permits escape progress");
    Check(Core::ZoneEscapePathClear(in, in.player, result.target), "solver escape moves outward");
    Core::Temporal::Ctx context{};
    Core::Temporal::Build(map, 1.f, 0.f, in.player, kUTemporalCullTiles, context);
    Check(Core::Temporal::TimeToDanger(context, in.player, in.speed, result.target, kUDwellMs)
              == Core::Temporal::kNoDanger, "fallback avoids crossing projectile when possible");
    std::puts("UDodge/AoE regression tests passed (25 cases)");
}
