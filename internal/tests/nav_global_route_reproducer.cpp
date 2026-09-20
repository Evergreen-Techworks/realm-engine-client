#include "UDodgePathfinder.h"
#include <cmath>
#include <cstdio>
#include <cstring>
using namespace UDodge;
int main(int argc, char** argv) {
    static Path::PlannerSnapshot snapshot{};
    static Path::PlanResult result{};
    snapshot.navActive = true;
    snapshot.moveBudget = 1.2f;
    snapshot.speed = 0.006f;
    snapshot.collisionRule = Movement::Collision::Rule::Game;
    snapshot.player = {100.5f, 200.5f};
    snapshot.navGrid.center = snapshot.player;
    snapshot.navGoal = {140.5f, 200.5f};
    for (int row = 0; row < kUNavSide; ++row)
        for (int column = 0; column < kUNavSide; ++column) {
            const int worldX = 100 + column - kUNavRadCells;
            snapshot.navGrid.flags[row * kUNavSide + column] = worldX == 120 ? 1 : 0;
        }
    Path::Compute(snapshot, result);
    std::printf("all known local grid: found=%d partial=%d goal=(%.1f,%.1f) step=(%.2f,%.2f) waypoints=%d pops=%d\n",
        result.navFound, result.navPartial, result.navGoalCell.x, result.navGoalCell.y,
        result.navStepTarget.x, result.navStepTarget.y, result.navWptCount, result.navPops);
    for (int index = 0; index < result.navWptCount; ++index)
        std::printf("waypoint %d=(%.1f,%.1f)\n", index, result.navWpts[index].x, result.navWpts[index].y);
    const auto fullMapFlags = [](int tileX, int tileY) -> uint8_t {
        if (tileX < 0 || tileX >= 256 || tileY < 0 || tileY >= 512) return 0;
        return Movement::TileOccupancy::kTileKnown |
            ((tileX == 120 && tileY <= 280) ? Movement::TileOccupancy::kTileBlocked : 0);
    };
    const bool knownSouthernRoute =
        Movement::Collision::StepClear(fullMapFlags, 100.5f, 200.5f, 100.5f, 281.5f) &&
        Movement::Collision::StepClear(fullMapFlags, 100.5f, 281.5f, 140.5f, 281.5f) &&
        Movement::Collision::StepClear(fullMapFlags, 140.5f, 281.5f, 140.5f, 200.5f);
    const bool headsAwayFromOnlyOpening = result.navGoalCell.y < snapshot.player.y;
    std::printf("known complete map: southern route StepClear=%d; local partial heads north=%d\n",
        knownSouthernRoute, headsAwayFromOnlyOpening);
    if (!knownSouthernRoute) return 2;
    const bool documentLimitation = argc == 2 && std::strcmp(argv[1], "--document-current-limitation") == 0;
    if (documentLimitation) return result.navFound && result.navPartial && headsAwayFromOnlyOpening ? 0 : 1;
    if (headsAwayFromOnlyOpening) {
        std::fprintf(stderr, "FAIL: route must use the only known opening south of the wall\n");
        return 1;
    }
    return result.navFound ? 0 : 1;
}
