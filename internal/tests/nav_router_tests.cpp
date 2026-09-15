#include "features/movement/nav/Router.h"

#include <cstdio>
#include <cstdlib>

namespace Nav = Movement::Nav;
namespace Tiles = Movement::TileOccupancy;

namespace {
int checks = 0;
void Check(bool condition, const char* name)
{
    ++checks;
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", name);
        std::exit(1);
    }
}

void Transfer(Nav::MapMemory& memory, Nav::Router& router)
{
    for (;;) {
        auto batch = memory.TakeChangedCells();
        Check(router.Apply(batch), "router accepts a current ordered map batch");
        if (batch.cells.empty()) break;
    }
}

void Ground(Nav::MapMemory& memory, uint64_t epoch, int column, int row, uint8_t flags = 0, uint8_t speedClass = 0)
{
    memory.ObserveGround(epoch, column, row, Tiles::kTileKnown | flags, speedClass);
    memory.ObserveStructure(epoch, column, row,
        {Nav::StructuralState::ConfirmedEmpty, Nav::ObservationSource::CurrentSquareOccupant, 0, 0});
}

Nav::RouteState Repair(Nav::Router& router)
{
    auto state = Nav::RouteState::Repairing;
    for (int cycle = 0; cycle < 1000 && state == Nav::RouteState::Repairing; ++cycle)
        state = router.Repair(2048);
    Check(state != Nav::RouteState::Repairing, "bounded repairs converge");
    return state;
}

void RemoteOpening(bool south)
{
    Nav::MapMemory memory;
    Nav::Router router;
    memory.Reset(1, 256, 512);
    for (int row = 0; row < 512; ++row)
        for (int column = 0; column < 256; ++column)
            Ground(memory, 1, column, row, column == 120 && (south ? row <= 350 : row >= 50) ? Tiles::kTileBlocked : 0);
    Transfer(memory, router);
    Check(router.SetGoal(1, 1, {100.5f, 200.5f}, {140.5f, 200.5f}), "accept whole-map point goal");
    Check(Repair(router) == Nav::RouteState::Ready, "global route finds opening beyond 128 tiles");
    auto corridor = router.Corridor();
    Check(corridor.count >= 2 && corridor.count <= 8, "publish a bounded global corridor");
    Check(south ? corridor.points[1].worldY > 200.5f : corridor.points[1].worldY < 200.5f,
          "first corridor heads toward the only known opening");
    int steps = 0;
    while (corridor.state != Nav::RouteState::Arrived && steps++ < 100) {
        Check(corridor.count >= 2, "connected global route never ends at a local dead end");
        const auto next = corridor.points[corridor.count - 1];
        Check(router.MoveStart(1, next), "advance start without rebuilding global plan");
        Repair(router);
        corridor = router.Corridor();
    }
    Check(corridor.state == Nav::RouteState::Arrived, "global route reaches distant known connected destination");
}

void UnknownFrontier()
{
    Nav::MapMemory memory;
    Nav::Router router;
    memory.Reset(2, 12, 5);
    for (int row = 0; row < 5; ++row)
        for (int column = 0; column < 4; ++column)
            Ground(memory, 2, column, row);
    Transfer(memory, router);
    router.SetGoal(2, 3, {1.5f, 2.5f}, {10.5f, 2.5f});
    Repair(router);
    const auto frontier = router.Corridor();
    Check(frontier.state == Nav::RouteState::Partial && frontier.count >= 2,
          "optimistic unknown search publishes only a known reachable frontier");
    for (int index = 0; index < frontier.count; ++index)
        Check(frontier.points[index].worldX < 4.f, "executable corridor never enters unknown ground");
    for (int row = 0; row < 5; ++row)
        for (int column = 4; column < 12; ++column)
            Ground(memory, 2, column, row, column == 6 && row != 4 ? Tiles::kTileBlocked : 0);
    Transfer(memory, router);
    Check(Repair(router) == Nav::RouteState::Ready, "revealed wall repairs incident edges");
    const auto repaired = router.Corridor();
    Check(repaired.state == Nav::RouteState::Ready && repaired.count >= 3,
          "repair routes around the revealed wall");
}

void DoorRepairAndEpoch()
{
    Nav::MapMemory memory;
    Nav::Router router;
    memory.Reset(3, 15, 5);
    for (int row = 0; row < 5; ++row)
        for (int column = 0; column < 15; ++column)
            Ground(memory, 3, column, row, row != 2 ? Tiles::kTileBlocked : 0);
    Transfer(memory, router);
    router.SetGoal(3, 4, {1.5f, 2.5f}, {13.5f, 2.5f});
    Check(Repair(router) == Nav::RouteState::Ready, "open hallway routes");
    memory.ObserveStructure(3, 7, 2,
        {Nav::StructuralState::Present, Nav::ObservationSource::CurrentSquareOccupant, 11, Tiles::kTileBlocked});
    Transfer(memory, router);
    Check(Repair(router) == Nav::RouteState::Unreachable, "closed door invalidates the old route");
    memory.ObserveStructure(3, 7, 2,
        {Nav::StructuralState::ConfirmedEmpty, Nav::ObservationSource::CurrentSquareOccupant, 0, 0});
    Transfer(memory, router);
    Check(Repair(router) == Nav::RouteState::Ready, "authoritative door removal repairs the route");
    for (int iteration = 0; iteration < 20; ++iteration) {
        memory.ObserveStructure(3, 7, 2,
            {Nav::StructuralState::Present, Nav::ObservationSource::CurrentSquareOccupant, 11,
             static_cast<uint8_t>(iteration % 2 == 0 ? Tiles::kTileBlocked : 0)});
        Transfer(memory, router);
        Check(Repair(router) == (iteration % 2 == 0 ? Nav::RouteState::Unreachable : Nav::RouteState::Ready),
              "repeated door changes keep incremental routing correct");
        Check(router.OpenEntryCount() <= 250000 * 8 + 64, "repeated repairs retain a bounded lazy heap");
    }
    const auto oldCorridor = router.Corridor();
    memory.Reset(4, 15, 5);
    const auto reset = memory.TakeChangedCells();
    Check(router.Apply(reset), "same-size instance resets router");
    Check(router.Corridor().count == 0 && router.Corridor().epoch == 4,
          "new epoch cannot publish the previous corridor");
    Check(oldCorridor.epoch == 3 && oldCorridor.goalId == 4, "corridors identify their instance and goal");
    Check(!router.MoveStart(3, {2.5f, 2.5f}) && !router.SetGoal(3, 5, {1.5f, 2.5f}, {13.5f, 2.5f}),
          "old-epoch requests cannot revive a route");
}

void BudgetAndSpeed()
{
    Nav::MapMemory memory;
    Nav::Router router;
    memory.Reset(5, 20, 20);
    for (int row = 0; row < 20; ++row)
        for (int column = 0; column < 20; ++column)
            Ground(memory, 5, column, row, row == 10 && column > 2 && column < 17 ? Tiles::kTileSpeedMod : 0,
                   row == 10 && column > 2 && column < 17 ? 1 : 0);
    Transfer(memory, router);
    router.SetSpeedClass(1, 0.1f);
    router.SetGoal(5, 6, {1.5f, 10.5f}, {18.5f, 10.5f});
    Check(router.Repair(1) == Nav::RouteState::Repairing && router.LastExpansions() <= 1,
          "repair respects its expansion budget");
    Repair(router);
    const auto corridor = router.Corridor();
    bool leavesSlowRow = false;
    for (int index = 0; index < corridor.count; ++index)
        leavesSlowRow |= corridor.points[index].worldY != 10.5f;
    Check(corridor.count > 2 && leavesSlowRow,
          "travel-time costs prefer faster land around slow ground");
    Nav::Router capped(8);
    memory.Reset(6, 20, 20);
    for (int row = 0; row < 20; ++row)
        for (int column = 0; column < 20; ++column)
            Ground(memory, 6, column, row);
    Transfer(memory, capped);
    capped.SetGoal(6, 7, {1.5f, 1.5f}, {18.5f, 18.5f});
    Check(Repair(capped) == Nav::RouteState::Partial && capped.NodeCount() <= 8,
          "node limit bounds allocations and reports partial instead of unreachable");
    Check(capped.Corridor().count >= 2, "node cap publishes a reachable advancing frontier");
}

void StructuralUnknownIsAdvisory()
{
    Nav::MapMemory memory;
    Nav::Router router;
    memory.Reset(8, 8, 3);
    for (int row = 0; row < 3; ++row)
        for (int column = 0; column < 8; ++column)
            memory.ObserveGround(8, column, row, Tiles::kTileKnown, 0);
    Transfer(memory, router);
    router.SetGoal(8, 9, {1.5f, 1.5f}, {6.5f, 1.5f});
    Repair(router);
    const auto corridor = router.Corridor();
    Check(corridor.count >= 2 && corridor.requiresLocalVerification,
          "structurally unknown ground produces advisory corridors requiring the live veto");
    Check(memory.GetCell(3, 1).structure.state == Nav::StructuralState::Unknown,
          "router optimism does not invent confirmed empty observations");
}
}

int main()
{
    RemoteOpening(true);
    RemoteOpening(false);
    UnknownFrontier();
    DoorRepairAndEpoch();
    BudgetAndSpeed();
    StructuralUnknownIsAdvisory();
    std::printf("Global router tests: %d checks, 0 failures\n", checks);
}
