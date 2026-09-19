#include "pch-il2cpp.h"
#include "Runtime.h"
#include "GameState.h"
#include "RuntimeOffsets.h"
#include "FeatureState.h"
#include "core/runtime/MemRead.h"
#include "core/il2cpp/Il2CppContainers.h"

#include <atomic>
#include <condition_variable>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>

void IpcBridge_EmitNavStatus(const char* goalKind, uint64_t goalId, uint64_t generation,
                           const char* state, const char* reason);

namespace Movement { namespace Nav { namespace Runtime {
namespace {
struct Session {
    uint64_t epoch = 1;
    uint64_t revision = 1;
    uint64_t scriptId = 0;
    RoutePoint scriptGoal;
    int width = 0, height = 0;
};
struct Request {
    uint64_t epoch = 0, revision = 0, goalId = 0;
    RoutePoint player, goal;
    float baseSpeed = 6.f;
    bool active = false;
    bool hazardBlocked = false;   // safeWalk: damaging ground is a wall for the D* router
    // ENEMY STANDOFF discs, carried with the request so one cycle plans against
    // one set (the same reason the planner policy rides the dodge snapshot).
    std::array<Router::StandoffDisc, 48> standoff{};
    int standoffCount = 0;
};
struct Result {
    RouteCorridor corridor;
    uint64_t revision = 0;
    uint64_t publishedMs = 0;
};
struct Delivery {
    ChangedCells changes;
    std::array<float, 256> speedFactors;
    Request request;
};

std::mutex standoffMutex;
std::array<Router::StandoffDisc, 48> standoffDiscs{};
int standoffCount = 0;

std::atomic<bool> enabled{false};
std::atomic<bool> resetCapture{true};
std::atomic<uint64_t> epoch{1};
std::mutex sessionMutex;
Session session;
std::mutex workerMutex;
std::condition_variable workerWake;
std::thread worker;
#ifdef NAV_RUNTIME_TEST_TIMING
std::atomic<float> maximumCycleMs{0.f};
std::vector<float> cycleSamples;
std::vector<float> repairSamples;
#endif
bool stopping = false;
std::deque<Delivery> deliveries;
Result latest;

MapMemory captured;
uint64_t capturedEpoch = 0;
uint64_t observedSessionEpoch = 0;
void* lastWorld = nullptr;
void* lastList = nullptr;
int32_t lastSize = 0;
bool awaitingReplacement = false;
size_t nextSquare = 0;
std::deque<size_t> retrySquares;
size_t localCursor = 0;
uint64_t lastLocalMs = 0;
std::unordered_map<uint32_t, size_t> squareIndices;
std::unordered_map<uint16_t, GroundCell> groundTypes;
std::array<float, 256> capturedSpeeds;
size_t speedCount = 1;
uint64_t lastPublishMs = 0;
Request currentRequest;
uint64_t lastSessionRevision = 0;
uint64_t requestRevision = 0;
uint64_t nativeGoalId = uint64_t{1} << 50;
RoutePoint progressAnchor;
uint64_t progressSinceMs = 0;
uint64_t lastStatusGoal = 0;
uint64_t lastStatusEpoch = 0;
std::string lastReason;
RouteState lastStatus = RouteState::Idle;

bool ReadText(void* base, uint32_t offset, char* output, int capacity)
{
    void* value = nullptr;
    if (!Mem::TryRead(base, offset, value)) return false;
    output[0] = '\0';
    return value == nullptr || (Mem::AddrOk(value) && Il2CppC::ReadString(value, output, capacity) > 0);
}

bool GroundAt(void* square, uint16_t type, GroundCell& result)
{
    const auto known = groundTypes.find(type);
    if (known != groundTypes.end()) { result = known->second; return true; }
    void* props = nullptr;
    void* noWalk = nullptr;
    void* push = nullptr;
    void* sink = nullptr;
    void* sinking = nullptr;
    char speedText[32], damageText[32];
    if (!Mem::TryRead(square, RuntimeOffsets::TileProps, props) || !Mem::AddrOk(props) ||
        !Mem::TryRead(props, RuntimeOffsets::TP_NoWalk, noWalk) ||
        !Mem::TryRead(props, RuntimeOffsets::TP_Push, push) ||
        !Mem::TryRead(props, RuntimeOffsets::TP_Sink, sink) ||
        !Mem::TryRead(props, RuntimeOffsets::TP_Sinking, sinking) ||
        !ReadText(props, RuntimeOffsets::TP_Speed, speedText, sizeof(speedText)) ||
        !ReadText(props, RuntimeOffsets::TP_MaxDmg, damageText, sizeof(damageText))) return false;
    const float speed = Speed::TileFactor(std::strtof(speedText, nullptr));
    size_t speedClass = 0;
    while (speedClass < speedCount && capturedSpeeds[speedClass] != speed) ++speedClass;
    if (speedClass == speedCount) {
        if (speedCount == capturedSpeeds.size()) return false;
        capturedSpeeds[speedCount++] = speed;
    }
    result.flags = TileOccupancy::kTileKnown | TileOccupancy::GroundFlags(noWalk != nullptr,
        push != nullptr, speed, sink != nullptr || sinking != nullptr, std::strtol(damageText, nullptr, 10) > 0);
    if (type == 0x1aa1) result.flags |= TileOccupancy::kTileBlocked;
    result.speedClass = static_cast<uint8_t>(speedClass);
    groundTypes.emplace(type, result);
    return true;
}

bool CaptureSquare(const uint8_t* entries, size_t index, const Session& current)
{
    void* square = nullptr;
    int32_t column = 0, row = 0;
    uint16_t type = 255;
    if (!Mem::TryRead(entries + index * sizeof(void*), 0, square) || !Mem::AddrOk(square) ||
        !Mem::TryRead(square, RuntimeOffsets::TileX, column) ||
        !Mem::TryRead(square, RuntimeOffsets::TileY, row) ||
        !Mem::TryRead(square, RuntimeOffsets::TileType, type)) return false;
    if (column < 0 || row < 0 || column >= current.width || row >= current.height || type == 255) return false;
    GroundCell ground;
    if (!GroundAt(square, type, ground)) return false;
    captured.ObserveGround(current.epoch, column, row, ground.flags, ground.speedClass);
    squareIndices[static_cast<uint32_t>(row * current.width + column)] = index;
    void* occupant = nullptr;
    void* props = nullptr;
    bool isStatic = false, occupy = false, full = false, enemyOccupy = false;
    int32_t identity = 0;
    if (Mem::TryRead(square, RuntimeOffsets::Sq_Cover, occupant) && Mem::AddrOk(occupant) &&
        Mem::TryRead(occupant, RuntimeOffsets::ObjProps, props) && Mem::AddrOk(props) &&
        Mem::TryRead(props, RuntimeOffsets::OP_IsStatic, isStatic) && isStatic &&
        Mem::TryRead(props, RuntimeOffsets::OP_OccupySq, occupy) &&
        Mem::TryRead(props, RuntimeOffsets::OP_FullOcc, full) &&
        Mem::TryRead(props, RuntimeOffsets::OP_EnemyOcc, enemyOccupy) &&
        Mem::TryRead(occupant, RuntimeOffsets::KJ_DictObjectId, identity) && identity >= 0) {
        const uint8_t flags = static_cast<uint8_t>((occupy || full || enemyOccupy ? TileOccupancy::kTileBlocked : 0) |
            (full ? TileOccupancy::kTileFullOcc : 0));
        captured.ObserveStructure(current.epoch, column, row,
            {StructuralState::Present, ObservationSource::CurrentSquareOccupant, static_cast<uint64_t>(identity), flags});
    }
    return true;
}

bool Capture(const Session& current, RoutePoint player, uint64_t now)
{
    if (current.width <= 0 || current.height <= 0) return false;
    void* world = GameState::GetWorldMgr();
    void* list = nullptr;
    void* items = nullptr;
    int32_t size = 0, capacity = 0;
    if (!world || !Mem::TryRead(world, RuntimeOffsets::WM_TileList, list) || !Mem::AddrOk(list) ||
        !Mem::TryRead(list, Il2CppC::kListItems, items) || !Mem::AddrOk(items) ||
        !Mem::TryRead(list, Il2CppC::kListSize, size) ||
        !Mem::TryRead(items, Il2CppC::kArrMaxLen, capacity) ||
        size < 0 || size > current.width * current.height || size > capacity) return false;
    if (capturedEpoch != current.epoch) {
        awaitingReplacement = observedSessionEpoch != current.epoch && lastList != nullptr &&
            list == lastList && world == lastWorld && size >= lastSize;
        if (!captured.Reset(current.epoch, current.width, current.height)) return false;
        capturedEpoch = current.epoch;
        observedSessionEpoch = current.epoch;
        nextSquare = 0;
        retrySquares.clear();
        squareIndices.clear();
        groundTypes.clear();
        capturedSpeeds.fill(1.f);
        speedCount = 1;
    }
    if (awaitingReplacement) {
        if (list == lastList && world == lastWorld && size >= lastSize) return false;
        awaitingReplacement = false;
    }
    if (lastList != list || lastWorld != world || size < lastSize) {
        nextSquare = 0;
        retrySquares.clear();
        squareIndices.clear();
    }
    lastWorld = world;
    lastList = list;
    lastSize = size;
    const auto* entries = static_cast<const uint8_t*>(items) + Il2CppC::kArrData;
    const auto stop = std::min(static_cast<size_t>(size), nextSquare + 512);
    const auto retries = std::min<size_t>(64, retrySquares.size());
    for (size_t retry = 0; retry < retries; ++retry) {
        const auto index = retrySquares.front();
        retrySquares.pop_front();
        if (index < static_cast<size_t>(size) && !CaptureSquare(entries, index, current)) retrySquares.push_back(index);
    }
    while (nextSquare < stop) {
        if (!CaptureSquare(entries, nextSquare, current)) retrySquares.push_back(nextSquare);
        ++nextSquare;
    }
    if (now - lastLocalMs >= 100) {
        lastLocalMs = now;
        for (size_t scanned = 0; scanned < 256; ++scanned) {
            const int column = static_cast<int>(std::floor(player.worldX)) + static_cast<int>(localCursor % 33) - 16;
            const int row = static_cast<int>(std::floor(player.worldY)) + static_cast<int>(localCursor / 33) - 16;
            localCursor = (localCursor + 1) % (33 * 33);
            if (column < 0 || row < 0 || column >= current.width || row >= current.height) continue;
            const auto found = squareIndices.find(static_cast<uint32_t>(row * current.width + column));
            if (found != squareIndices.end() && found->second < static_cast<size_t>(size))
                CaptureSquare(entries, found->second, current);
        }
    }
    return true;
}

void Work()
{
    Router router;
    Request request;
    uint64_t acceptedRevision = 0;
    auto nextCycle = std::chrono::steady_clock::now();
    for (;;) {
        std::deque<Delivery> received;
        {
            std::unique_lock<std::mutex> lock(workerMutex);
            workerWake.wait_until(lock, nextCycle, [] { return stopping; });
            if (stopping) return;
            received.swap(deliveries);
        }
        nextCycle = std::chrono::steady_clock::now() + std::chrono::milliseconds(100);
#ifdef NAV_RUNTIME_TEST_TIMING
        const auto cycleStart = std::chrono::steady_clock::now();
#endif
        for (const auto& delivery : received) {
            if (delivery.request.epoch != epoch.load(std::memory_order_acquire)) continue;
            if (!router.Apply(delivery.changes)) continue;
            for (size_t speedClass = 0; speedClass < delivery.speedFactors.size(); ++speedClass)
                router.SetSpeedClass(static_cast<uint8_t>(speedClass), delivery.speedFactors[speedClass]);
            request = delivery.request;
        }
        if (!Enabled() || !request.active || request.epoch != epoch.load(std::memory_order_acquire)) continue;
        router.SetBaseSpeed(request.baseSpeed);
        router.SetHazardBlocked(request.hazardBlocked);
        router.SetStandoff(request.standoff.data(), request.standoffCount,
                           request.player.worldX, request.player.worldY);
        if (acceptedRevision != request.revision) {
            if (!router.SetGoal(request.epoch, request.goalId, request.player, request.goal)) continue;
            acceptedRevision = request.revision;
        } else router.MoveStart(request.epoch, request.player);
#ifdef NAV_RUNTIME_TEST_TIMING
        const auto repairStart = std::chrono::steady_clock::now();
#endif
        router.Repair(2048, std::chrono::microseconds(1800));
        Result result{router.Corridor(), request.revision, GetTickCount64()};
#ifdef NAV_RUNTIME_TEST_TIMING
        const float cycleMs = std::chrono::duration<float, std::milli>(std::chrono::steady_clock::now() - cycleStart).count();
        maximumCycleMs.store(std::max(maximumCycleMs.load(), cycleMs));
        cycleSamples.push_back(cycleMs);
        repairSamples.push_back(std::chrono::duration<float, std::milli>(std::chrono::steady_clock::now() - repairStart).count());
#endif
        std::lock_guard<std::mutex> lock(workerMutex);
        if (request.epoch == epoch.load(std::memory_order_acquire)) latest = result;
    }
}

void Emit(RouteState state, const char* reason, const Request& request)
{
    if (lastStatusGoal == request.goalId && lastStatusEpoch == request.epoch && lastStatus == state && lastReason == reason) return;
    lastStatusGoal = request.goalId;
    lastStatusEpoch = request.epoch;
    lastStatus = state;
    lastReason = reason;
    const char* name = state == RouteState::Arrived ? "arrived" : state == RouteState::Partial ? "partial" :
        state == RouteState::Unreachable ? "unreachable" : "routing";
    IpcBridge_EmitNavStatus("point", request.goalId, request.epoch, name, reason);
}
}

void SetNavigatorText(const char* value)
{
    const bool next = value && std::strcmp(value, "dstar") == 0;
    if (enabled.exchange(next, std::memory_order_acq_rel) != next) InvalidateGoal();
}
bool Enabled() { return enabled.load(std::memory_order_acquire); }
#ifdef NAV_RUNTIME_TEST_TIMING
float TestMaximumCycleMs() { return maximumCycleMs.load(); }
float TestPercentileMs(bool repair)
{
    auto samples = repair ? repairSamples : cycleSamples;
    if (samples.empty()) return 0.f;
    std::sort(samples.begin(), samples.end());
    return samples[static_cast<size_t>((samples.size() - 1) * 0.95f)];
}
#endif

void NotifySceneReset()
{
    uint64_t identity = 0, generation = 0;
    {
        std::lock_guard<std::mutex> lock(sessionMutex);
        identity = session.scriptId;
        generation = session.epoch;
        session.epoch = epoch.fetch_add(1, std::memory_order_acq_rel) + 1;
        ++session.revision;
        session.width = session.height = 0;
        session.scriptId = 0;
    }
    if (identity != 0) IpcBridge_EmitNavStatus("point", identity, generation, "unreachable", "map_changed");
}

void SetMapInfoText(const char* value)
{
    if (value && std::strcmp(value, "0,0") == 0) { NotifySceneReset(); return; }
    if (!value || value[0] < '0' || value[0] > '9') return;
    errno = 0;
    char* afterWidth = nullptr;
    const auto width = std::strtoul(value, &afterWidth, 10);
    if (errno == ERANGE || width == 0 || width > 2048 || *afterWidth != ',') return;
    const char* heightText = afterWidth + 1;
    if (*heightText < '0' || *heightText > '9') return;
    char* afterHeight = nullptr;
    const auto height = std::strtoul(heightText, &afterHeight, 10);
    if (errno == ERANGE || height == 0 || height > 2048 || *afterHeight != '\0') return;
    NotifySceneReset();
    std::lock_guard<std::mutex> lock(sessionMutex);
    session.width = static_cast<int>(width);
    session.height = static_cast<int>(height);
}

void SetScriptGoalText(const char* value)
{
    if (!value || *value < '0' || *value > '9') return;
    errno = 0;
    char* afterIdentity = nullptr;
    const auto identity = std::strtoull(value, &afterIdentity, 10);
    if (errno == ERANGE || identity == 0 || identity > 9007199254740991ULL || *afterIdentity != ',') return;
    char* afterX = nullptr;
    const float worldX = std::strtof(afterIdentity + 1, &afterX);
    if (errno == ERANGE || afterX == afterIdentity + 1 || *afterX != ',' || !std::isfinite(worldX)) return;
    char* afterY = nullptr;
    const float worldY = std::strtof(afterX + 1, &afterY);
    if (errno == ERANGE || afterY == afterX + 1 || *afterY != '\0' || !std::isfinite(worldY)) return;
    {
        std::lock_guard<std::mutex> lock(sessionMutex);
        if (session.scriptId != identity || session.scriptGoal.worldX != worldX || session.scriptGoal.worldY != worldY)
            ++session.revision;
        session.scriptId = identity;
        session.scriptGoal = {worldX, worldY};
    }
    FeatureState::SetWalkTarget(worldX, worldY, true);
}

void InvalidateGoal()
{
    uint64_t identity = 0, generation = 0;
    {
        std::lock_guard<std::mutex> lock(sessionMutex);
        ++session.revision;
        identity = session.scriptId;
        generation = session.epoch;
        session.scriptId = 0;
    }
    if (identity != 0) IpcBridge_EmitNavStatus("point", identity, generation, "unreachable", "map_changed");
}

void Start()
{
    std::lock_guard<std::mutex> lock(workerMutex);
    if (worker.joinable()) return;
    stopping = false;
    worker = std::thread(Work);
}
void Stop()
{
    {
        std::lock_guard<std::mutex> lock(workerMutex);
        stopping = true;
    }
    workerWake.notify_all();
    if (worker.joinable()) worker.join();
    std::lock_guard<std::mutex> lock(workerMutex);
    deliveries.clear();
    latest = {};
    resetCapture.store(true, std::memory_order_release);
}

void SetStandoff(const Router::StandoffDisc* discs, int count)
{
    std::lock_guard<std::mutex> lock(standoffMutex);
    standoffCount = 0;
    if (!discs || count <= 0) return;
    standoffCount = std::min(count, static_cast<int>(standoffDiscs.size()));
    for (int i = 0; i < standoffCount; ++i) standoffDiscs[i] = discs[i];
}

RouteCorridor Update(RoutePoint player, RoutePoint goal, float baseSpeed, bool active,
                     bool hazardBlocked)
{
    RouteCorridor output;
    if (resetCapture.exchange(false, std::memory_order_acq_rel)) {
        capturedEpoch = 0;
        captured = {};
        currentRequest = {};
        lastPublishMs = 0;
    }
    const uint64_t now = GetTickCount64();
    Session current;
    {
        std::unique_lock<std::mutex> lock(sessionMutex, std::try_to_lock);
        if (!lock.owns_lock()) return output;
        current = session;
    }
    if (currentRequest.active && currentRequest.epoch != current.epoch)
        Emit(RouteState::Unreachable, "map_changed", currentRequest);
    else if (currentRequest.active && !active) {
        const bool arrived = std::hypot(player.worldX - currentRequest.goal.worldX,
            player.worldY - currentRequest.goal.worldY) <= 0.85f;
        Emit(arrived ? RouteState::Arrived : RouteState::Unreachable, arrived ? "" : "cancelled", currentRequest);
    }
    const bool changed = currentRequest.epoch != current.epoch || lastSessionRevision != current.revision ||
        std::hypot(currentRequest.goal.worldX - goal.worldX, currentRequest.goal.worldY - goal.worldY) > 2.f ||
        currentRequest.active != active;
    if (changed) {
        const bool scriptMatches = current.scriptId != 0 &&
            std::hypot(current.scriptGoal.worldX - goal.worldX, current.scriptGoal.worldY - goal.worldY) < 0.1f;
        currentRequest = {current.epoch, ++requestRevision, scriptMatches ? current.scriptId : ++nativeGoalId,
                          player, goal, baseSpeed, active};
        lastSessionRevision = current.revision;
        progressAnchor = player;
        progressSinceMs = now;
    }
    currentRequest.player = player;
    currentRequest.baseSpeed = baseSpeed;
    currentRequest.hazardBlocked = hazardBlocked;
    {
        std::lock_guard<std::mutex> lock(standoffMutex);
        currentRequest.standoff = standoffDiscs;
        currentRequest.standoffCount = standoffCount;
    }
    output.epoch = current.epoch;
    output.goalId = currentRequest.goalId;
    output.state = active ? RouteState::Repairing : RouteState::Idle;
    if (!Enabled()) return output;
    if (!Capture(current, player, now)) {
        output.state = active ? RouteState::Partial : RouteState::Idle;
        output.capturePending = active;
        if (active) Emit(RouteState::Partial, "map_pending", currentRequest);
        return output;
    }
    if (now - lastPublishMs >= 100) {
        std::unique_lock<std::mutex> lock(workerMutex, std::try_to_lock);
        if (lock.owns_lock() && deliveries.size() < 4) {
            deliveries.push_back({captured.TakeChangedCells(2048), capturedSpeeds, currentRequest});
            lastPublishMs = now;
        }
    }
    Result result;
    {
        std::unique_lock<std::mutex> lock(workerMutex, std::try_to_lock);
        if (lock.owns_lock()) result = latest;
    }
    if (active && result.revision == currentRequest.revision && result.corridor.epoch == current.epoch &&
        result.corridor.goalId == currentRequest.goalId && now - result.publishedMs <= 300)
        output = result.corridor;
    if (std::hypot(player.worldX - progressAnchor.worldX, player.worldY - progressAnchor.worldY) >= 0.25f ||
        baseSpeed <= 0.f || output.state == RouteState::Repairing || output.count < 2) {
        progressAnchor = player;
        progressSinceMs = now;
    }
    if (active) {
        if (std::hypot(player.worldX - goal.worldX, player.worldY - goal.worldY) <= 0.5f)
            output.state = RouteState::Arrived;
        else if (baseSpeed > 0.f && now - progressSinceMs >= 10000) {
            output.state = RouteState::Unreachable;
            output.count = 0;
        }
        Emit(output.state, output.state == RouteState::Unreachable ? "unreachable" :
             output.state == RouteState::Partial ? "frontier_or_retained_structure" : "", currentRequest);
    }
    return output;
}

} } }
