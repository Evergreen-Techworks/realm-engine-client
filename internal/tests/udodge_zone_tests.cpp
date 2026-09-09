#include "UDodgeCore.h"
#include "UDodgeEnemyHazards.h"
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
    // Verify with the SAME contact model the solver used (Settings::pointPlayer).
    Core::Temporal::Build(map, 1.f, 0.f, in.player, kUTemporalCullTiles, context,
                          Core::ProjectilePlayerHalf(in.settings));
    Check(Core::Temporal::TimeToDanger(context, in.player, in.speed, result.target, kUDwellMs)
              == Core::Temporal::kNoDanger, "fallback avoids crossing projectile when possible");
    // No projectiles or captured bomb effects: the enemy's attack envelope
    // alone must prevent walking in, and permit incremental escape from inside.
    map = DangerMap{};
    in = MapInput{}; in.map = &map; in.speed = 0.005f; in.player = {1.5f,0.f};
    Check(EnemyHazards::Append(map,0xb2a9,1875,{},in.player), "Brawler recognised without a bomb visual");
    Check(!Core::ZonePathClear(in,{4.f,0.f},{2.9f,0.f}), "Brawler approach stays outside the largest blast");
    goal = Solver::Goal{}; goal.active=true; goal.fromLock=true; goal.pos={};
    goal.lockPos={}; goal.maxRange=3.f;
    route = Path::PlanResult{}; state = CoreState{};
    Solver::Solve(in,0.5f,goal,route,state,result);
    Check(result.shouldMove && Len(result.target)>Len(in.player),
          "Brawler blast envelope overrides melee lock and escapes in sub-radius steps");
    Check(Core::ZoneEscapePathClear(in,in.player,result.target), "Brawler escape moves outward");
    // A Brawler can chase onto the player: leaving its body may also need
    // several movement budgets. Rejecting every inside endpoint freezes escape.
    map.enemyCount=1; map.enemies[0].pos={}; map.enemies[0].radius=0.8f;
    in.player={0.1f,0.f}; state=CoreState{};
    Solver::Solve(in,0.5f,goal,route,state,result);
    Check(result.shouldMove && Len(result.target)>Len(in.player),
          "overlapping Brawler body permits incremental outward escape");
    Check(Core::EnemyEscapePathClear(in,in.player,result.target), "execution admits partial body escape");
    Check(!Core::EnemyEscapePathClear(in,{0.5f,0.f},{-1.5f,0.f}), "body escape cannot cross its centre");
    map.enemyCount=2; map.enemies[1].pos={1.4f,0.f}; map.enemies[1].radius=0.2f;
    Check(!Core::EnemyEscapePathClear(in,{0.1f,0.f},{2.5f,0.f}), "body escape cannot cross another enemy");
    in.env.canOccupy=[](float, float, bool) { return false; };
    Solver::Solve(in,0.5f,goal,route,state,result);
    Check(!result.shouldMove, "body escape never relaxes physical walls");
    map.zoneCount=0;
    Check(!EnemyHazards::Append(map,0xb2a9,0,{},in.player), "dead Brawler has no keepout");
    Check(!EnemyHazards::Append(map,123,100,{},in.player), "ordinary mob is not given an invented blast");
    Check(EnemyHazards::Append(map,0xb502,1875,{2.f,1.f},in.player)
          && map.zones[0].pos.x==2.f, "Brawler variant tracks its current position");
    // SHOWEFFECT Throw: Pos1 is the landing position (TargetObjectId is the
    // thrower). Durations <= 120 are seconds; absent durations use the effect's
    // own fallback rather than a generic 2 s countdown for a thrown bomb.
    {
        float lx = 0.f, ly = 0.f;
        Check(AoeCapturePolicy::ThrowLanding(4.5f, -2.f, lx, ly) && lx == 4.5f && ly == -2.f, "throw landing is pos1");
        Check(!AoeCapturePolicy::ThrowLanding(std::numeric_limits<float>::quiet_NaN(), 1.f, lx, ly), "non-finite throw landing is rejected");
        Check(AoeCapturePolicy::ShowEffectDurationMs(0.5f, true) == 500.f, "sub-120 duration is seconds");
        Check(AoeCapturePolicy::ShowEffectDurationMs(3000.f, true) == 3000.f, "large duration is already ms");
        Check(AoeCapturePolicy::ShowEffectDurationMs(0.f, true) == 1500.f, "thrown bomb without duration uses the throw fallback");
        Check(AoeCapturePolicy::ShowEffectDurationMs(0.f, false) == 2000.f, "other effects without duration keep the 2 s fallback");
    }
    std::puts("UDodge/AoE regression tests passed (38 cases)");
}
