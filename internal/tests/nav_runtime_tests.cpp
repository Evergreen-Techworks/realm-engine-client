#include "features/movement/nav/Runtime.h"
#include "RuntimeOffsets.h"
#include "core/il2cpp/Il2CppContainers.h"

#include <array>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>

namespace Nav = Movement::Nav;
namespace Runtime = Nav::Runtime;
#ifdef NAV_RUNTIME_TEST_TIMING
namespace Movement { namespace Nav { namespace Runtime { float TestMaximumCycleMs(); float TestPercentileMs(bool repair); } } }
#endif

namespace {
void* world = nullptr;
int checks = 0;
float commandedX = 0.f, commandedY = 0.f;
bool commandedActive = false;
std::mutex statusMutex;
std::vector<std::string> statuses;
uint64_t statusGoal = 0;

void Check(bool condition, const char* name)
{
    ++checks;
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", name);
        Runtime::Stop();
        std::exit(1);
    }
}

template<class Value> void Write(void* base, size_t offset, Value value)
{
    std::memcpy(static_cast<uint8_t*>(base) + offset, &value, sizeof(value));
}

struct Scene {
    std::array<uint8_t, 32> worldBytes{}, list{};
    std::array<uint8_t, 256> floorProps{}, wallProps{};
    std::array<uint8_t, 64> occupant{}, objectProps{};
    std::vector<std::array<uint8_t, 128>> squares;
    std::vector<uint8_t> entries;

    Scene(int width = 15, int height = 5, bool open = false)
        : squares(static_cast<size_t>(width * height)), entries(32 + squares.size() * sizeof(void*))
    {
        Write(worldBytes.data(), RuntimeOffsets::WM_TileList, static_cast<void*>(list.data()));
        Write(list.data(), Il2CppC::kListItems, static_cast<void*>(entries.data()));
        Write(list.data(), Il2CppC::kListSize, static_cast<int32_t>(squares.size()));
        Write(entries.data(), Il2CppC::kArrMaxLen, static_cast<int32_t>(squares.size()));
        Write(wallProps.data(), RuntimeOffsets::TP_NoWalk, static_cast<const void*>("true"));
        Write(occupant.data(), RuntimeOffsets::ObjProps, static_cast<void*>(objectProps.data()));
        Write(occupant.data(), RuntimeOffsets::KJ_DictObjectId, int32_t{42});
        Write(objectProps.data(), RuntimeOffsets::OP_IsStatic, true);
        Write(objectProps.data(), RuntimeOffsets::OP_OccupySq, true);
        for (int row = 0; row < height; ++row)
            for (int column = 0; column < width; ++column) {
                const size_t index = static_cast<size_t>(row * width + column);
                auto* square = squares[index].data();
                Write(entries.data(), Il2CppC::kArrData + index * sizeof(void*), static_cast<void*>(square));
                Write(square, RuntimeOffsets::TileX, column);
                Write(square, RuntimeOffsets::TileY, row);
                Write(square, RuntimeOffsets::TileType, static_cast<uint16_t>(open || row == 2 ? 100 : 101));
                Write(square, RuntimeOffsets::TileProps, static_cast<void*>(open || row == 2 ? floorProps.data() : wallProps.data()));
            }
    }
    void Door(bool present)
    {
        Write(squares[37].data(), RuntimeOffsets::Sq_Cover, present ? static_cast<void*>(occupant.data()) : nullptr);
    }
};

Nav::RouteCorridor Await(Nav::RouteState expected, Nav::RoutePoint goal = {13.5f, 2.5f})
{
    Nav::RouteCorridor result;
    for (int iteration = 0; iteration < 250; ++iteration) {
        result = Runtime::Update({1.5f, 2.5f}, goal, 6.f, true);
        if (result.state == expected) return result;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    Check(false, "runtime reaches the expected route state within 2.5 seconds");
    return result;
}
}

namespace GameState { void* GetWorldMgr() { return world; } }
namespace FeatureState {
void SetWalkTarget(float worldX, float worldY, bool active)
{
    commandedX = worldX;
    commandedY = worldY;
    commandedActive = active;
}
}
void IpcBridge_EmitNavStatus(const char*, uint64_t identity, uint64_t, const char* state, const char* reason)
{
    std::lock_guard<std::mutex> lock(statusMutex);
    statusGoal = identity;
    statuses.emplace_back(std::string(state) + ":" + reason);
}

int main()
{
    Check(!Runtime::Enabled(), "global navigator defaults to legacy");
    Runtime::SetScriptGoalText("17,13.5,2.5");
    Check(commandedActive && commandedX == 13.5f && commandedY == 2.5f,
          "atomic script goal retains legacy walk target behavior");
    Runtime::SetScriptGoalText("18,nan,2.5");
    Check(commandedX == 13.5f, "malformed atomic intent does not overwrite a goal");
    Scene first;
    Write(first.entries.data(), Il2CppC::kArrData, static_cast<void*>(nullptr));
    Write(first.entries.data(), Il2CppC::kArrData + 32 * sizeof(void*), static_cast<void*>(nullptr));
    world = first.worldBytes.data();
    Runtime::SetMapInfoText("15,5");
    Runtime::SetNavigatorText("dstar");
    Runtime::SetScriptGoalText("19,13.5,2.5");
    Runtime::Start();
    Check(Await(Nav::RouteState::Partial).count >= 1,
          "unreadable first square does not starve later received terrain");
    Write(first.entries.data(), Il2CppC::kArrData, static_cast<void*>(first.squares[0].data()));
    Write(first.entries.data(), Il2CppC::kArrData + 32 * sizeof(void*), static_cast<void*>(first.squares[32].data()));
    const auto route = Await(Nav::RouteState::Ready);
    Check(route.goalId == 19 && route.count >= 2 && route.requiresLocalVerification,
          "game-thread received-square capture feeds a correlated advisory worker corridor");
    Runtime::SetMapInfoText("99999999999999999999999999999999999,5");
    Check(Runtime::Update({1.5f, 2.5f}, {13.5f, 2.5f}, 6.f, true).epoch == route.epoch,
          "overflowing map dimensions fail closed without resetting the map");
    Runtime::SetNavigatorText("dstar");
    Check(Await(Nav::RouteState::Ready).goalId == 19, "same-value navigator sync does not invalidate a goal");
    Runtime::SetScriptGoalText("19,13.5,2.5");
    Check(Await(Nav::RouteState::Ready).goalId == 19, "repeated script intent retains request correlation");
    first.Door(true);
    Await(Nav::RouteState::Unreachable);
    first.Door(false);
    for (int iteration = 0; iteration < 80; ++iteration) {
        Runtime::Update({1.5f, 2.5f}, {13.5f, 2.5f}, 6.f, true);
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    Check(Await(Nav::RouteState::Unreachable).count == 0, "null occupant cannot erase a retained closed door");
    Write(first.objectProps.data(), RuntimeOffsets::OP_OccupySq, false);
    Write(first.occupant.data(), RuntimeOffsets::KJ_DictObjectId, int32_t{43});
    first.Door(true);
    Check(Await(Nav::RouteState::Ready).count >= 2, "positively observed open replacement repairs a retained door");
    Runtime::NotifySceneReset();
    Runtime::SetMapInfoText("15,5");
    Runtime::SetScriptGoalText("20,13.5,2.5");
    const auto waiting = Runtime::Update({1.5f, 2.5f}, {13.5f, 2.5f}, 6.f, true);
    Check(waiting.count == 0 && waiting.epoch != route.epoch,
          "same-size map reset refuses stale corridors and old scene tiles");
    Scene second;
    world = second.worldBytes.data();
    const auto newRoute = Await(Nav::RouteState::Ready);
    Check(newRoute.goalId == 20 && newRoute.epoch != route.epoch && newRoute.count >= 2,
          "replacement scene rehydrates into the new map epoch");
    Runtime::SetScriptGoalText("21,2.5,2.5");
    Check(Await(Nav::RouteState::Ready, {2.5f, 2.5f}).goalId == 21,
          "new goal cannot reuse a previous-goal corridor");
    Runtime::Update({2.3f, 2.5f}, {2.5f, 2.5f}, 6.f, false);
    Check(statusGoal == 21 && statuses.back() == "arrived:",
          "arrival is published when the movement owner clears active before the runtime update");
    Runtime::Stop();
    Runtime::Start();
    Check(Await(Nav::RouteState::Ready, {2.5f, 2.5f}).count >= 2,
          "mode restart rehydrates the current scene without inventing a map transition");
    Runtime::SetScriptGoalText("22,13.5,2.5");
    Runtime::NotifySceneReset();
    Check(statusGoal == 22 && statuses.back() == "unreachable:map_changed",
          "reset invalidates the exact script request even before its first game-thread update");
    Runtime::SetNavigatorText("legacy");
    Check(Runtime::Update({1.5f, 2.5f}, {13.5f, 2.5f}, 6.f, true).count == 0,
          "legacy toggle does not consume global corridors");
    Runtime::SetScriptGoalText("23,13.5,2.5");
    Runtime::Update({1.5f, 2.5f}, {13.5f, 2.5f}, 6.f, true);
    Runtime::Update({13.3f, 2.5f}, {13.5f, 2.5f}, 6.f, false);
    Check(statusGoal == 23 && statuses.back() == "arrived:",
          "legacy travel also terminates correlated client intent without enabling global routing");
    Runtime::Stop();
    Scene large(418, 418, true);
    world = large.worldBytes.data();
    Runtime::SetMapInfoText("418,418");
    Runtime::SetNavigatorText("dstar");
    Runtime::SetScriptGoalText("9007199254740991,400.5,400.5");
    Runtime::Start();
    Nav::RouteCorridor largeRoute;
    for (int iteration = 0; iteration < 1500; ++iteration) {
        largeRoute = Runtime::Update({1.5f, 2.5f}, {400.5f, 400.5f}, 6.f, true);
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        if (iteration > 1000 && largeRoute.state == Nav::RouteState::Ready) break;
    }
    Check(largeRoute.state == Nav::RouteState::Ready && largeRoute.goalId == 9007199254740991ULL,
          "174724 received squares feed bounded runtime batches without losing distant cells or large request IDs");
    Runtime::Stop();
#ifdef NAV_RUNTIME_TEST_TIMING
    std::printf("Navigation runtime measured maximum worker cycle: %.3f ms (75 and 174724-square fixtures)\n", Runtime::TestMaximumCycleMs());
    std::printf("Navigation runtime p95 cycle: %.3f ms, repair: %.3f ms\n", Runtime::TestPercentileMs(false), Runtime::TestPercentileMs(true));
#endif
    std::printf("Navigation runtime tests: %d checks, 0 failures\n", checks);
}
