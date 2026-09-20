#include "features/movement/nav/MapMemory.h"

#include <cstdio>
#include <cstdlib>
#include <limits>
#include <type_traits>

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

Nav::StructuralObservation Present(uint64_t identity, uint8_t flags)
{
    return {Nav::StructuralState::Present, Nav::ObservationSource::CurrentSquareOccupant,
            identity, flags};
}

Nav::StructuralObservation Empty()
{
    return {Nav::StructuralState::ConfirmedEmpty, Nav::ObservationSource::CurrentSquareOccupant,
            0, 0};
}

void RetainsDistantGround()
{
    Nav::MapMemory memory;
    Check(memory.Reset(1, 512, 512), "initialize a map session");
    Check(memory.ObserveGround(1, 4, 8, Tiles::kTileKnown | Tiles::kTileSink | Tiles::kTileSpeedMod, 7),
          "receive slow ground");
    Check(memory.ObserveGround(1, 450, 470, Tiles::kTileKnown, 0), "receive distant ground");
    const auto distant = memory.GetCell(4, 8);
    Check(distant.ground.flags == (Tiles::kTileKnown | Tiles::kTileSink | Tiles::kTileSpeedMod) &&
          distant.ground.speedClass == 7, "ground and speed survive observations beyond 128 tiles");
    Check(memory.GetCell(120, 160).ground.flags == 0, "unobserved ground stays unknown");
    Check(!memory.ObserveGround(1, 120, 160, 0, 0), "a failed ground read cannot establish knowledge");
    Check(!memory.ObserveGround(1, 4, 8, 0, 0), "a failed read cannot erase previous ground");
    Check(memory.GetCell(4, 8).ground.speedClass == 7, "leaving visibility retains slow ground");
    Check(memory.GetCell(4, 8).structure.state == Nav::StructuralState::Unknown,
          "known ground is not proof of structural absence");
    for (int row = 0; row < 257; ++row)
        for (int column = 0; column < 257; ++column)
            memory.ObserveGround(1, column, row, Tiles::kTileKnown, 0);
    Check(memory.GetCell(0, 0).ground.flags == Tiles::kTileKnown &&
          memory.GetCell(256, 256).ground.flags == Tiles::kTileKnown &&
          memory.GetCell(450, 470).ground.flags == Tiles::kTileKnown,
          "more than 65536 received squares never evict older terrain");
}

void EpochLifecycle()
{
    Nav::MapMemory memory;
    Check(memory.Reset(10, 32, 32), "first instance epoch");
    memory.ObserveGround(10, 5, 6, Tiles::kTileKnown, 4);
    memory.ObserveStructure(10, 5, 6, Present(100, Tiles::kTileBlocked));
    const auto oldBatch = memory.TakeChangedCells();
    Check(oldBatch.epoch == 10 && oldBatch.reset && oldBatch.cells.size() == 1,
          "a detached batch carries its instance epoch and reset");
    memory.ObserveGround(10, 7, 8, Tiles::kTileKnown, 0);
    Check(memory.Reset(11, 32, 32), "same-name same-size new instance resets by epoch");
    const auto cell = memory.GetCell(5, 6);
    Check(cell.ground.flags == 0 && cell.structure.state == Nav::StructuralState::Unknown,
          "new instance clears both ground and structural memory");
    Check(!memory.ObserveGround(10, 5, 6, Tiles::kTileKnown, 4) &&
          !memory.ObserveStructure(10, 5, 6, Present(100, Tiles::kTileBlocked)),
          "delayed old-instance observations cannot repopulate the new instance");
    Check(!memory.Reset(10, 32, 32) && !memory.Reset(11, 32, 32),
          "stale or reused reset epochs are rejected");
    const auto resetBatch = memory.TakeChangedCells();
    Check(resetBatch.epoch == 11 && resetBatch.reset && resetBatch.cells.empty(),
          "reset discards queued old-instance cells and publishes even without new ground");
    Check(oldBatch.epoch == 10 && oldBatch.cells[0].cell.ground.speedClass == 4,
          "detached plain-data batches are unchanged by later resets");
    Check(!memory.TakeChangedCells().reset, "reset is emitted once per epoch");
}

void MutableStructures()
{
    Nav::MapMemory memory;
    memory.Reset(1, 32, 32);
    memory.ObserveGround(1, 10, 11, Tiles::kTileKnown | Tiles::kTileBlocked, 3);
    Check(memory.ObserveStructure(1, 10, 11, Present(40, Tiles::kTileBlocked | Tiles::kTileFullOcc)),
          "observe a closed FullOccupy door");
    Check(memory.GetCell(10, 11).ground.flags == (Tiles::kTileKnown | Tiles::kTileBlocked),
          "structural FullOccupy never contaminates retained ground");
    Check(memory.ObserveGround(1, 10, 11, Tiles::kTileKnown, 6), "ground may change below a door");
    Check(memory.GetCell(10, 11).structure.identity == 40, "ground replacement does not erase a door");
    Check(!memory.ObserveStructure(1, 10, 11, {}), "unknown observation cannot clear a closed door");
    auto unverifiedEmpty = Empty();
    unverifiedEmpty.source = Nav::ObservationSource::Unverified;
    Check(!memory.ObserveStructure(1, 10, 11, unverifiedEmpty),
          "stream-out or unverified null cannot clear a door");
    auto movingEnemy = Present(99, Tiles::kTileBlocked);
    movingEnemy.source = Nav::ObservationSource::TransientEntity;
    Check(!memory.ObserveStructure(1, 2, 3, movingEnemy) &&
          memory.GetCell(2, 3).structure.state == Nav::StructuralState::Unknown,
          "moving enemies do not become permanent walls");
    Check(memory.GetCell(10, 11).structure.identity == 40, "failed reads retain the last known structure");
    Check(memory.ObserveStructure(1, 10, 11, Present(40, 0)), "same door opens with new flags");
    Check(memory.GetCell(10, 11).structure.state == Nav::StructuralState::Present &&
          memory.GetCell(10, 11).structure.flags == 0, "open object is distinct from confirmed absence");
    Check(memory.ObserveStructure(1, 10, 11, Present(40, Tiles::kTileBlocked)), "same door closes again");
    Check(memory.ObserveStructure(1, 10, 11, Empty()), "authoritative square absence clears a destroyed door");
    Check(memory.GetCell(10, 11).structure.state == Nav::StructuralState::ConfirmedEmpty &&
          memory.GetCell(10, 11).structure.identity == 0 &&
          memory.GetCell(10, 11).ground.speedClass == 6, "removal preserves ground and explicit absence");
    Check(memory.ObserveStructure(1, 10, 11, Present(41, Tiles::kTileBlocked)), "recreate a new door");
    Check(memory.ObserveStructure(1, 10, 11, Present(42, Tiles::kTileBlocked)),
          "same-flags replacement still updates object identity");
    Check(memory.GetCell(10, 11).structure.identity == 42, "replacement identity is retained");
    Check(memory.ObserveStructure(1, 3, 4, Empty()) && memory.GetCell(3, 4).ground.flags == 0,
          "structural absence does not invent ground knowledge");
}

void ChangedCells()
{
    Nav::MapMemory memory;
    memory.Reset(9, 20, 20);
    memory.TakeChangedCells();
    Check(memory.ObserveGround(9, 1, 2, Tiles::kTileKnown, 0), "first observation changes a cell");
    Check(!memory.ObserveGround(9, 1, 2, Tiles::kTileKnown, 0), "identical ground produces no change");
    memory.ObserveStructure(9, 1, 2, Present(42, Tiles::kTileBlocked));
    Check(!memory.ObserveStructure(9, 1, 2, Present(42, Tiles::kTileBlocked)),
          "identical structure produces no change");
    memory.ObserveGround(9, 1, 2, Tiles::kTileKnown | Tiles::kTileSpeedMod, 8);
    memory.ObserveGround(9, 5, 6, Tiles::kTileKnown, 0);
    const auto first = memory.TakeChangedCells(1);
    Check(first.epoch == 9 && first.width == 20 && first.height == 20 && !first.reset,
          "changed batch contains map dimensions and epoch");
    Check(first.cells.size() == 1 && first.cells[0].column == 1 && first.cells[0].row == 2 &&
          first.cells[0].cell.ground.speedClass == 8 && first.cells[0].cell.structure.identity == 42,
          "coalesce each dirty cell into a complete latest plain-data observation");
    const auto second = memory.TakeChangedCells(1);
    Check(second.cells.size() == 1 && second.cells[0].column == 5 && second.cells[0].row == 6,
          "bounded drain retains unconsumed cells");
    Check(memory.TakeChangedCells().cells.empty(), "draining clears the pending changes");
    Check(memory.ObserveStructure(9, 1, 2, Empty()), "a consumed cell can become dirty again");
    const auto removed = memory.TakeChangedCells();
    Check(removed.cells.size() == 1 && removed.cells[0].cell.structure.state == Nav::StructuralState::ConfirmedEmpty,
          "changed record includes authoritative structural removal");
    Check(first.cells[0].cell.structure.identity == 42, "detached batches never alias live structures");
    Check(!memory.ObserveStructure(9, 1, 2, Empty()) && memory.TakeChangedCells().cells.empty(),
          "identical confirmed absence produces no delta");
}

void BoundsAndStorage()
{
    static_assert(sizeof(Nav::GroundCell) == 2, "two bytes per ground square");
    static_assert(std::is_trivially_copyable<Nav::ChangedCell>::value, "worker records contain only plain data");
    Nav::MapMemory memory;
    Check(!memory.GetCell(0, 0).inBounds && !memory.ObserveGround(0, 0, 0, Tiles::kTileKnown, 0),
          "an uninitialized memory cannot accept observations");
    Check(!memory.Reset(0, 10, 10) && !memory.Reset(1, 0, 10) && !memory.Reset(1, 10, -1) &&
          !memory.Reset(1, 2049, 1) && !memory.Reset(1, 1, std::numeric_limits<int>::max()),
          "invalid epoch and dimensions are rejected before allocation");
    Check(memory.Reset(1, 2048, 2048), "maximum map dimensions are supported");
    Check(memory.ObserveGround(1, 2047, 2047, Tiles::kTileKnown, 255), "maximum cell retains a full speed class");
    Check(!memory.ObserveGround(1, -1, 0, Tiles::kTileKnown, 0) &&
          !memory.ObserveGround(1, 2048, 0, Tiles::kTileKnown, 0) &&
          !memory.ObserveStructure(1, 0, 2048, Empty()), "out-of-bounds writes are rejected");
    Check(!memory.GetCell(-1, 0).inBounds && !memory.GetCell(0, 2048).inBounds,
          "out-of-bounds queries never alias received squares");
    Check(!memory.ObserveGround(1, 0, 0, Tiles::kTileKnown | Tiles::kTileFullOcc, 0),
          "object occupancy cannot be persisted through the ground interface");
    Check(!memory.ObserveStructure(1, 0, 0, Present(10, Tiles::kTileDamaging)),
          "temporary damage hazards cannot be persisted through the structure interface");
    Check(!memory.Reset(2, 4096, 4096) && memory.GetCell(2047, 2047).ground.speedClass == 255,
          "invalid reset preserves the current map");
    Check(memory.Reset(2, 1, 1) && memory.GetCell(0, 0).ground.flags == 0 &&
          !memory.GetCell(2047, 2047).inBounds, "resizing clears old cells without coordinate aliasing");
}
}

int main()
{
    RetainsDistantGround();
    EpochLifecycle();
    MutableStructures();
    ChangedCells();
    BoundsAndStorage();
    std::printf("Map memory tests: %d checks, 0 failures\n", checks);
}
