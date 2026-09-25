#include "UDodgePartialRoute.h"
#include "UDodgeNavigation.h"
#include "UDodgePathfinder.h"
#include "UDodgeCore.h"
#include <cstdio>

using namespace UDodge;
static int checks = 0, failures = 0;
static void Check(bool ok, const char* message) {
    ++checks;
    if (!ok) { ++failures; std::fprintf(stderr, "FAIL: %s\n", message); }
}

int main() {
    // Live failure family: a nearby loot destination is initially blocked, so
    // A* sends the player toward a distant exploration frontier. Its blocker
    // clears while that partial route remains connected and moving normally.
    // This models a possible cause, not unrecorded geometry from the live map.
    static Path::PlannerSnapshot snapshot{};
    snapshot.player = {};
    snapshot.navActive = true;
    snapshot.navGoal = {2.f, 0.f};
    snapshot.moveBudget = 1.f;
    snapshot.settings.safeWalk = true;
    for (auto& flag : snapshot.navGrid.flags) flag = 0x9; // unknown outside streamed area
    for (int y = -12; y <= 12; ++y)
        for (int x = -12; x <= 12; ++x)
            snapshot.navGrid.flags[(y+kUNavRadCells)*kUNavSide+x+kUNavRadCells] = 0;
    snapshot.map.enemyCount = 1;
    snapshot.map.enemies[0].pos = snapshot.navGoal;
    snapshot.map.enemies[0].radius = .6f;
    Path::PlanResult cached{};
    Path::Compute(snapshot, cached);
    Check(cached.navFound && cached.navPartial, "temporarily blocked nearby goal creates partial route");
    Check(Len(Sub(cached.navGoalCell, snapshot.navGoal)) > 5.f,
          "partial target explores a distant frontier despite nearby goal");

    MapInput input{};
    input.map = &snapshot.map;
    input.settings = snapshot.settings;
    input.env.occFlags = snapshot.navGrid.flags;
    input.env.occSide = kUNavSide;
    input.env.occRadius = kUNavRadCells;
    input.env.occCellTiles = kUNavCellTiles;
    auto clear = [&] {
        return Navigation::PaddedPathClear(input, snapshot.player, snapshot.navGoal) &&
            !Core::EnemyPathBlocked(input, snapshot.player, snapshot.navGoal) &&
            Core::ZonePathClear(input, snapshot.player, snapshot.navGoal);
    };
    Navigation::PartialRouteRecovery recovery;
    Check(!recovery.Recheck(1000, true, snapshot.player, snapshot.navGoal, clear),
          "new partial route retains initial bounded exploration interval");
    Check(!recovery.Recheck(2000, true, snapshot.player, snapshot.navGoal, clear),
          "still blocked goal does not request another identical search");
    snapshot.map.enemyCount = 0;
    Check(!recovery.Recheck(2500, true, snapshot.player, snapshot.navGoal, clear),
          "recovery does not probe again before cooldown expires");
    const bool refresh = recovery.Recheck(3000, true, snapshot.player, snapshot.navGoal, clear);
    Check(refresh, "cleared nearby goal refreshes connected partial route before frontier arrival");
    if (refresh) Path::Compute(snapshot, cached);
    Check(cached.navFound && !cached.navPartial &&
          LenSq(Sub(cached.navGoalCell, snapshot.navGoal)) < .01f,
          "fresh A* restores actual destination instead of continuing old excursion");

    // A newly unknown destination is not a shortcut opportunity. Preserve the
    // same actual occupancy rejection used for the direct corridor check.
    const int goalIndex = kUNavRadCells*kUNavSide+kUNavRadCells+2;
    snapshot.navGrid.flags[goalIndex] = 0x9;
    recovery.Reset();
    recovery.Recheck(4000, true, snapshot.player, snapshot.navGoal, clear);
    Check(!recovery.Recheck(5000, true, snapshot.player, snapshot.navGoal, clear),
          "unknown goal cell cannot trigger direct-corridor recovery");
    Path::Compute(snapshot, cached);
    Check(cached.navFound && cached.navPartial,
          "unknown destination retains exploratory partial route");

    // Unknown or still blocked destinations keep their exploration route. A
    // complete route, distant goal or excluded combat approach is never probed.
    int probes = 0;
    auto unavailable = [&] { ++probes; return false; };
    recovery.Reset();
    bool changed = false;
    for (uint64_t t = 0; t <= 3000; ++t)
        changed = recovery.Recheck(t, true, {}, {2.f, 0.f}, unavailable) || changed;
    Check(!changed, "unavailable destination leaves cached exploration unchanged");
    Check(probes == 3, "unavailable goal probes at most once per second");
    for (uint64_t t = 4000; t <= 6000; t += 100)
        recovery.Recheck(t, false, {}, {2.f, 0.f}, unavailable);
    Check(probes == 3, "ineligible route never probes");
    for (uint64_t t = 7000; t <= 9000; t += 100)
        recovery.Recheck(t, true, {}, {100.f, 0.f}, unavailable);
    Check(probes == 3, "distant exploration target never probes");
    std::printf("Partial route recovery: %d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
