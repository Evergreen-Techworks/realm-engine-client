#pragma once

#include "MapMemory.h"
#include "Collision.h"
#include "Speed.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <limits>
#include <queue>
#include <unordered_map>
#include <vector>

namespace Movement { namespace Nav {

struct RoutePoint {
    float worldX = 0.f;
    float worldY = 0.f;
};

enum class RouteState { Idle, Repairing, Ready, Arrived, Partial, Unreachable };

// Item 3 (navigation finish plan, 2026-09-19) observability: WHY the D* capture
// has not produced a result yet, or what proved it could. Plain data, always
// filled by Runtime::Update (a handful of field copies, not a string format or
// a file write) so this costs nothing when nobody looks at it; UDodge.cpp
// decides whether to log it, gated behind the existing diag-timing flag.
enum class CaptureGuard : uint8_t {
    None,               // not currently pending
    NoMapInfo,          // the client has not bridged valid map dimensions yet (navMapInfo)
    ListUnreadable,      // the world/tile-list pointer chain did not read this tick
    AwaitingReplacement, // the D* global router's fail-closed
                          // limitation: the game reused both the world and list pointers with an
                          // equal-or-larger count, so pointer/size evidence alone cannot prove the
                          // list holds the new map. Waiting on the own-tile+ring proof instead.
};

struct CaptureDiag {
    CaptureGuard guard = CaptureGuard::None;
    uint64_t     epoch = 0;
    int32_t      squaresRead = 0;   // this epoch's incremental scan progress (Runtime's nextSquare)
    int32_t      listSize = 0;      // live List<Square>.Count read this tick
    void*        listPtr = nullptr;
    void*        worldPtr = nullptr;
    uint64_t     pendingSinceMs = 0; // GetTickCount64() when this epoch started (0 = not applicable)
    uint64_t     pendingMs = 0;      // now - pendingSinceMs: time waited so far, or time it took to
                                      // become ready on the one tick `ready` flips true
    bool         ready = false;      // capture confirmed for this epoch
    bool         fastPath = false;   // reached ready via the pre-existing pointer/shrink evidence,
                                      // not the new own-tile+ring proof (Item 3)
};

struct RouteCorridor {
    uint64_t epoch = 0;
    uint64_t goalId = 0;
    RouteState state = RouteState::Idle;
    bool requiresLocalVerification = true;
    bool capturePending = false;
    std::array<RoutePoint, 8> points{};
    int count = 0;
    CaptureDiag captureDiag{};
};

class Router {
public:
    explicit Router(size_t maxNodes = 250000) : maxNodes_(maxNodes)
    {
        speedFactors_.fill(1.f);
    }

    bool Apply(const ChangedCells& batch)
    {
        if (batch.reset) {
            if (!memory_.Reset(batch.epoch, batch.width, batch.height)) return false;
            epoch_ = batch.epoch;
            width_ = batch.width;
            height_ = batch.height;
            active_ = false;
            ClearPlan();
        } else if (batch.epoch != epoch_ || batch.width != width_ || batch.height != height_) {
            return false;
        }
        for (const auto& change : batch.cells) {
            const auto& cell = change.cell;
            memory_.ObserveGround(epoch_, change.column, change.row, cell.ground.flags, cell.ground.speedClass);
            memory_.ObserveStructure(epoch_, change.column, change.row, cell.structure);
        }
        while (!memory_.TakeChangedCells().cells.empty()) {}
        if (active_ && !batch.cells.empty()) {
            std::vector<uint32_t> affected;
            affected.reserve(batch.cells.size() * 9);
            for (const auto& change : batch.cells)
                for (int offsetY = -1; offsetY <= 1; ++offsetY)
                    for (int offsetX = -1; offsetX <= 1; ++offsetX) {
                        const int column = change.column + offsetX;
                        const int row = change.row + offsetY;
                        if (InBounds(column, row) && nodes_.find(Index(column, row)) != nodes_.end())
                            affected.push_back(Index(column, row));
                    }
            std::sort(affected.begin(), affected.end());
            affected.erase(std::unique(affected.begin(), affected.end()), affected.end());
            for (const auto index : affected) UpdateVertex(index);
            state_ = RouteState::Repairing;
        }
        return true;
    }

    bool SetGoal(uint64_t epoch, uint64_t goalId, RoutePoint start, RoutePoint goal)
    {
        if (epoch != epoch_ || !ValidPoint(start) || !ValidPoint(goal)) return false;
        start_ = start;
        goal_ = goal;
        goalId_ = goalId;
        startIndex_ = PointIndex(start);
        goalIndex_ = PointIndex(goal);
        active_ = true;
        ClearPlan();
        auto* node = EnsureNode(goalIndex_);
        if (node) {
            node->rhs = 0.f;
            Queue(goalIndex_, *node);
        }
        state_ = RouteState::Repairing;
        return true;
    }

    bool MoveStart(uint64_t epoch, RoutePoint start)
    {
        if (!active_ || epoch != epoch_ || !ValidPoint(start)) return false;
        const auto next = PointIndex(start);
        keyModifier_ += Heuristic(startIndex_, next);
        start_ = start;
        startIndex_ = next;
        state_ = RouteState::Repairing;
        return true;
    }

    bool SetSpeedClass(uint8_t speedClass, float factor)
    {
        if (!std::isfinite(factor) || factor <= 0.f || factor >= 5.f) return false;
        if (speedFactors_[speedClass] == factor) return true;
        speedFactors_[speedClass] = factor;
        maxSpeedFactor_ = *std::max_element(speedFactors_.begin(), speedFactors_.end());
        if (active_) SetGoal(epoch_, goalId_, start_, goal_);
        return true;
    }

    // safeWalk (S3.11): damaging ground is a WALL, not a 3-second surcharge. The
    // bot must never walk onto lava/venom while the user asked it not to, however
    // long the detour. Only the TARGET of an edge is refused, so a player who is
    // already standing on damaging ground can still leave it by any shortest way.
    // ENEMY STANDOFF (udodge/UDodgeStandoff.h) for the D* navigator. The discs are
    // rasterised ONCE into a flat overlay the size of the map; EdgeCost then does a
    // single array lookup, never a loop over enemies. Cores are impassable, bands
    // carry kStandoffBandCost. Cells whose class CHANGED are repaired incrementally
    // (UpdateVertex), exactly as an observed map change is — re-seeding the whole
    // plan every time a mob takes a step would never converge.
    struct StandoffDisc { float worldX = 0.f, worldY = 0.f, core = 0.f, band = 0.f; };
    static constexpr float kStandoffBandCost = 8.f;   // matches UDodge::Standoff::kNavBandCost

    bool SetStandoff(const StandoffDisc* discs, int count, float playerWorldX, float playerWorldY)
    {
        if (width_ <= 0 || height_ <= 0) return false;
        scratch_.clear();
        for (int i = 0; i < count && discs; ++i) {
            const auto& disc = discs[i];
            Stamp(disc.worldX, disc.worldY, disc.band, kBand);
            const float deltaX = playerWorldX - disc.worldX, deltaY = playerWorldY - disc.worldY;
            if (disc.core > 0.f && deltaX * deltaX + deltaY * deltaY >= disc.core * disc.core)
                Stamp(disc.worldX, disc.worldY, disc.core, kCore);
        }
        // Collapse duplicates (overlapping discs) into one entry per cell.
        std::sort(scratch_.begin(), scratch_.end(),
                  [](const Marked& a, const Marked& b) { return a.index < b.index; });
        size_t write = 0;
        for (size_t read = 0; read < scratch_.size(); ++read) {
            if (write > 0 && scratch_[write - 1].index == scratch_[read].index)
                scratch_[write - 1].bits |= scratch_[read].bits;
            else scratch_[write++] = scratch_[read];
        }
        scratch_.resize(write);
        if (scratch_ == standoff_) return true;

        // Repair only the cells whose class actually changed (a linear merge of two
        // sorted lists), then their neighbours — the same incremental path Apply
        // uses for an observed map change.
        std::vector<uint32_t> affected;
        const auto touch = [&](uint32_t index) {
            if (!active_) return;
            const int column = Column(index), row = Row(index);
            for (int offsetY = -1; offsetY <= 1; ++offsetY)
                for (int offsetX = -1; offsetX <= 1; ++offsetX)
                    if (InBounds(column + offsetX, row + offsetY) &&
                        nodes_.find(Index(column + offsetX, row + offsetY)) != nodes_.end())
                        affected.push_back(Index(column + offsetX, row + offsetY));
        };
        size_t oldAt = 0, newAt = 0;
        while (oldAt < standoff_.size() || newAt < scratch_.size()) {
            if (newAt >= scratch_.size() || (oldAt < standoff_.size() && standoff_[oldAt].index < scratch_[newAt].index))
                touch(standoff_[oldAt++].index);
            else if (oldAt >= standoff_.size() || scratch_[newAt].index < standoff_[oldAt].index)
                touch(scratch_[newAt++].index);
            else {
                if (standoff_[oldAt].bits != scratch_[newAt].bits) touch(scratch_[newAt].index);
                ++oldAt; ++newAt;
            }
        }
        standoff_ = scratch_;
        if (affected.empty()) return true;
        std::sort(affected.begin(), affected.end());
        affected.erase(std::unique(affected.begin(), affected.end()), affected.end());
        for (const auto index : affected) UpdateVertex(index);
        state_ = RouteState::Repairing;
        return true;
    }

    bool SetHazardBlocked(bool blocked)
    {
        if (hazardBlocked_ == blocked) return true;
        hazardBlocked_ = blocked;
        if (active_) SetGoal(epoch_, goalId_, start_, goal_);
        return true;
    }

    bool SetBaseSpeed(float tilesPerSec)
    {
        if (!std::isfinite(tilesPerSec) || tilesPerSec <= 0.f) return false;
        if (std::fabs(baseSpeed_ - tilesPerSec) < 0.001f) return true;
        baseSpeed_ = tilesPerSec;
        if (active_) SetGoal(epoch_, goalId_, start_, goal_);
        return true;
    }

    RouteState Repair(size_t maxExpansions = 2048, std::chrono::microseconds maxTime = std::chrono::microseconds(2000))
    {
        lastExpansions_ = 0;
        if (!active_) return state_;
        if (limited_) { BuildLimitedCorridor(); return state_; }
        const auto deadline = std::chrono::steady_clock::now() + maxTime;
        while (lastExpansions_ < maxExpansions) {
            if (maxTime.count() > 0 && lastExpansions_ > 0 && lastExpansions_ % 16 == 0 &&
                std::chrono::steady_clock::now() >= deadline) break;
            if (!DiscardStale()) return state_ = RouteState::Repairing;
            const auto startKey = CalculateKey(startIndex_);
            if ((open_.empty() || !NeedsRepair(open_.top().key, startKey)) && Equal(G(startIndex_), Rhs(startIndex_)))
                break;
            if (open_.empty()) break;
            const auto entry = open_.top();
            open_.pop();
            auto& node = nodes_.at(entry.index);
            const auto newKey = CalculateKey(entry.index);
            if (Less(entry.key, newKey)) {
                Queue(entry.index, node);
            } else if (node.g > node.rhs) {
                node.g = node.rhs;
                ++node.version;
                Neighbors(entry.index, [&](uint32_t adjacent) { UpdateVertex(adjacent); });
            } else {
                node.g = Infinity();
                ++node.version;
                UpdateVertex(entry.index);
                Neighbors(entry.index, [&](uint32_t adjacent) { UpdateVertex(adjacent); });
            }
            ++lastExpansions_;
        }
        if (!DiscardStale()) return state_ = RouteState::Repairing;
        if (limited_) { BuildLimitedCorridor(); return state_; }
        else if ((!open_.empty() && NeedsRepair(open_.top().key, CalculateKey(startIndex_))) ||
                 !Equal(G(startIndex_), Rhs(startIndex_)))
            state_ = open_.empty() ? RouteState::Unreachable : RouteState::Repairing;
        else state_ = std::isfinite(G(startIndex_)) ? RouteState::Ready : RouteState::Unreachable;
        return state_;
    }

    RouteCorridor Corridor() const
    {
        RouteCorridor result;
        result.epoch = epoch_;
        result.goalId = goalId_;
        result.state = state_;
        if (active_ && limited_) return limitedCorridor_;
        if (!active_ || state_ != RouteState::Ready) return result;
        const auto verified = [&](int column, int row) { return Flags(column, row, false); };
        if (!Collision::Standable(verified, start_.worldX, start_.worldY)) {
            result.state = RouteState::Partial;
            return result;
        }
        result.points[0] = start_;
        result.count = 1;
        uint32_t current = startIndex_;
        RoutePoint previous = start_;
        float travelled = 0.f;
        const auto center = Center(current);
        if (Distance(previous, center) > 0.05f &&
            Collision::StepClear(verified, previous.worldX, previous.worldY, center.worldX, center.worldY)) {
            result.points[result.count++] = center;
            travelled = Distance(previous, center);
            previous = center;
        }
        int previousX = 0;
        int previousY = 0;
        for (int step = 0; step < 32; ++step) {
            if (current == goalIndex_) {
                if (!Collision::StepClear(verified, previous.worldX, previous.worldY, goal_.worldX, goal_.worldY)) {
                    result.state = RouteState::Partial;
                    break;
                }
                if (Distance(start_, goal_) < 0.05f) result.state = RouteState::Arrived;
                else if (Distance(previous, goal_) > 0.001f && result.count < 8)
                    result.points[result.count++] = goal_;
                break;
            }
            uint32_t next = current;
            float best = Infinity();
            Neighbors(current, [&](uint32_t adjacent) {
                const float cost = EdgeCost(current, adjacent) + G(adjacent);
                if (cost < best || (cost == best && Heuristic(adjacent, goalIndex_) < Heuristic(next, goalIndex_))) {
                    best = cost;
                    next = adjacent;
                }
            });
            if (next == current || !std::isfinite(best) || G(next) >= G(current)) {
                result.state = RouteState::Partial;
                break;
            }
            const auto point = Center(next);
            if (!Collision::StepClear(verified, previous.worldX, previous.worldY, point.worldX, point.worldY)) {
                result.state = RouteState::Partial;
                break;
            }
            const int directionX = Column(next) - Column(current);
            const int directionY = Row(next) - Row(current);
            const float segment = Distance(previous, point);
            if (travelled + segment > 16.f) break;
            if (result.count > 1 && directionX == previousX && directionY == previousY)
                result.points[result.count - 1] = point;
            else if (result.count < 8)
                result.points[result.count++] = point;
            else break;
            previousX = directionX;
            previousY = directionY;
            travelled += segment;
            previous = point;
            current = next;
        }
        return result;
    }

    size_t LastExpansions() const { return lastExpansions_; }
    size_t NodeCount() const { return nodes_.size(); }
    size_t OpenEntryCount() const { return open_.size(); }

private:
    struct Key { float first = 0.f; float second = 0.f; };
    struct Node { float g = Infinity(); float rhs = Infinity(); uint64_t version = 0; uint32_t parent = 0; };
    struct Entry { Key key; uint32_t index; uint64_t version; };
    struct Greater {
        bool operator()(const Entry& left, const Entry& right) const
        {
            if (Less(right.key, left.key)) return true;
            if (Less(left.key, right.key)) return false;
            return left.index > right.index;
        }
    };

    static float Infinity() { return std::numeric_limits<float>::infinity(); }
    static bool Equal(float left, float right) { return left == right || std::fabs(left - right) < 0.00001f; }
    static bool Less(Key left, Key right)
    {
        return left.first < right.first || (left.first == right.first && left.second < right.second);
    }
    static bool NeedsRepair(Key candidate, Key start)
    {
        return Less(candidate, start) || std::fabs(candidate.first - start.first) < 0.0001f;
    }
    static float Distance(RoutePoint from, RoutePoint to)
    {
        return std::hypot(to.worldX - from.worldX, to.worldY - from.worldY);
    }

    bool InBounds(int column, int row) const { return column >= 0 && row >= 0 && column < width_ && row < height_; }
    bool ValidPoint(RoutePoint point) const
    {
        return std::isfinite(point.worldX) && std::isfinite(point.worldY) && point.worldX >= 0.f && point.worldY >= 0.f &&
            point.worldX < static_cast<float>(width_) && point.worldY < static_cast<float>(height_);
    }
    uint32_t Index(int column, int row) const { return static_cast<uint32_t>(row * width_ + column); }
    uint32_t PointIndex(RoutePoint point) const { return Index(static_cast<int>(point.worldX), static_cast<int>(point.worldY)); }
    int Column(uint32_t index) const { return static_cast<int>(index % static_cast<uint32_t>(width_)); }
    int Row(uint32_t index) const { return static_cast<int>(index / static_cast<uint32_t>(width_)); }
    RoutePoint Center(uint32_t index) const { return {static_cast<float>(Column(index)) + 0.5f, static_cast<float>(Row(index)) + 0.5f}; }

    template<class Consumer> void Neighbors(uint32_t index, Consumer consumer) const
    {
        const int column = Column(index);
        const int row = Row(index);
        for (int offsetY = -1; offsetY <= 1; ++offsetY)
            for (int offsetX = -1; offsetX <= 1; ++offsetX)
                if ((offsetX != 0 || offsetY != 0) && InBounds(column + offsetX, row + offsetY))
                    consumer(Index(column + offsetX, row + offsetY));
    }

    uint8_t Flags(int column, int row, bool optimistic) const
    {
        const auto cell = memory_.GetCell(column, row);
        if (!cell.inBounds) return 0;
        if (!optimistic && !(cell.ground.flags & TileOccupancy::kTileKnown)) return 0;
        uint8_t flags = cell.ground.flags | TileOccupancy::kTileKnown;
        if (cell.structure.state == StructuralState::Present) flags |= cell.structure.flags;
        return flags;
    }

    float EdgeCost(uint32_t from, uint32_t to) const
    {
        const int fromX = Column(from), fromY = Row(from);
        const int toX = Column(to), toY = Row(to);
        const auto flags = [&](int column, int row) { return Flags(column, row, true); };
        if ((flags(fromX, fromY) | flags(toX, toY)) & (TileOccupancy::kTileBlocked | TileOccupancy::kTileFullOcc))
            return Infinity();
        const bool diagonal = fromX != toX && fromY != toY;
        if (diagonal && !Collision::DiagonalStepClear(flags, fromX, fromY, toX - fromX, toY - fromY))
            return Infinity();
        const auto source = memory_.GetCell(fromX, fromY).ground;
        const auto target = memory_.GetCell(toX, toY).ground;
        if (hazardBlocked_ && (target.flags & TileOccupancy::kTileDamaging)) return Infinity();
        // ENEMY STANDOFF: one byte lookup, filled by SetStandoff.
        const uint8_t standoff = StandoffAt(to);
        if (standoff & kCore) return Infinity();
        const float sourceFactor = (source.flags & TileOccupancy::kTileKnown) ? speedFactors_[source.speedClass] : 1.f / 1.2f;
        const float targetFactor = (target.flags & TileOccupancy::kTileKnown) ? speedFactors_[target.speedClass] : 1.f / 1.2f;
        return Speed::EdgeMs(baseSpeed_ / 1000.f, sourceFactor, targetFactor, diagonal ? 1.41421356237f : 1.f) / 1000.f +
            ((target.flags & TileOccupancy::kTileDamaging) ? 3.f : 0.f) +
            ((standoff & kBand) ? kStandoffBandCost : 0.f);
    }

    float Heuristic(uint32_t from, uint32_t to) const
    {
        const float distanceX = static_cast<float>(std::abs(Column(from) - Column(to)));
        const float distanceY = static_cast<float>(std::abs(Row(from) - Row(to)));
        return (std::max(distanceX, distanceY) + 0.41421356237f * std::min(distanceX, distanceY)) / (baseSpeed_ * maxSpeedFactor_);
    }
    float G(uint32_t index) const { const auto found = nodes_.find(index); return found == nodes_.end() ? Infinity() : found->second.g; }
    float Rhs(uint32_t index) const { const auto found = nodes_.find(index); return found == nodes_.end() ? Infinity() : found->second.rhs; }
    Key CalculateKey(uint32_t index) const
    {
        const float value = std::min(G(index), Rhs(index));
        return {value + Heuristic(startIndex_, index) + keyModifier_, value};
    }
    Node* EnsureNode(uint32_t index)
    {
        const auto found = nodes_.find(index);
        if (found != nodes_.end()) return &found->second;
        if (nodes_.size() >= maxNodes_) { limited_ = true; return nullptr; }
        return &nodes_.emplace(index, Node{}).first->second;
    }
    void Queue(uint32_t index, Node& node)
    {
        ++node.version;
        if (!Equal(node.g, node.rhs)) open_.push({CalculateKey(index), index, node.version});
        if (open_.size() > maxNodes_ * 8 + 64) {
            decltype(open_) compact;
            for (const auto& stored : nodes_)
                if (!Equal(stored.second.g, stored.second.rhs))
                    compact.push({CalculateKey(stored.first), stored.first, stored.second.version});
            open_.swap(compact);
        }
    }
    void UpdateVertex(uint32_t index)
    {
        auto* node = EnsureNode(index);
        if (!node) return;
        if (index != goalIndex_) {
            node->rhs = Infinity();
            Neighbors(index, [&](uint32_t adjacent) { node->rhs = std::min(node->rhs, EdgeCost(index, adjacent) + G(adjacent)); });
        }
        Queue(index, *node);
    }
    bool DiscardStale()
    {
        size_t discarded = 0;
        while (!open_.empty()) {
            const auto& entry = open_.top();
            const auto found = nodes_.find(entry.index);
            if (found != nodes_.end() && found->second.version == entry.version) return true;
            if (discarded++ == 256) return false;
            open_.pop();
        }
        return true;
    }
    void BuildLimitedCorridor()
    {
        nodes_.clear();
        open_ = {};
        limitedCorridor_ = {};
        limitedCorridor_.epoch = epoch_;
        limitedCorridor_.goalId = goalId_;
        limitedCorridor_.state = RouteState::Partial;
        state_ = RouteState::Partial;
        const auto verified = [&](int column, int row) { return Flags(column, row, false); };
        if (!Collision::Standable(verified, start_.worldX, start_.worldY)) return;
        limitedCorridor_.points[0] = start_;
        limitedCorridor_.count = 1;
        auto* initial = EnsureNode(startIndex_);
        if (!initial) return;
        initial->g = 0.f;
        initial->parent = startIndex_;
        open_.push({{Heuristic(startIndex_, goalIndex_), 0.f}, startIndex_, 0});
        uint32_t best = startIndex_;
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(2);
        size_t expansions = 0;
        while (!open_.empty() && expansions < maxNodes_) {
            if (expansions > 0 && expansions % 16 == 0 && std::chrono::steady_clock::now() >= deadline) break;
            const auto current = open_.top();
            open_.pop();
            if (current.version != nodes_.at(current.index).version) continue;
            if (Heuristic(current.index, goalIndex_) < Heuristic(best, goalIndex_)) best = current.index;
            if (current.index == goalIndex_) break;
            Neighbors(current.index, [&](uint32_t adjacent) {
                const auto from = Center(current.index), to = Center(adjacent);
                if (!Collision::StepClear(verified, from.worldX, from.worldY, to.worldX, to.worldY)) return;
                const float cost = G(current.index) + EdgeCost(current.index, adjacent);
                if (!std::isfinite(cost) || cost >= G(adjacent)) return;
                auto* node = EnsureNode(adjacent);
                if (!node) return;
                node->g = cost;
                node->parent = current.index;
                ++node->version;
                open_.push({{cost + Heuristic(adjacent, goalIndex_), cost}, adjacent, node->version});
            });
            ++expansions;
        }
        std::vector<uint32_t> reverse;
        for (uint32_t current = best; current != startIndex_ && reverse.size() < maxNodes_;) {
            reverse.push_back(current);
            current = nodes_.at(current).parent;
        }
        float travelled = 0.f;
        RoutePoint previous = start_;
        int previousX = 0, previousY = 0;
        uint32_t previousIndex = startIndex_;
        for (auto entry = reverse.rbegin(); entry != reverse.rend(); ++entry) {
            const auto point = Center(*entry);
            const float segment = Distance(previous, point);
            if (travelled + segment > 16.f ||
                !Collision::StepClear(verified, previous.worldX, previous.worldY, point.worldX, point.worldY)) break;
            const int directionX = Column(*entry) - Column(previousIndex);
            const int directionY = Row(*entry) - Row(previousIndex);
            if (limitedCorridor_.count > 1 && directionX == previousX && directionY == previousY)
                limitedCorridor_.points[limitedCorridor_.count - 1] = point;
            else if (limitedCorridor_.count < 8)
                limitedCorridor_.points[limitedCorridor_.count++] = point;
            else break;
            travelled += segment;
            previous = point;
            previousIndex = *entry;
            previousX = directionX;
            previousY = directionY;
        }
        open_ = {};
        if (Distance(start_, goal_) < 0.05f) limitedCorridor_.state = RouteState::Arrived;
    }
    void ClearPlan()
    {
        nodes_.clear();
        open_ = {};
        keyModifier_ = 0.f;
        limited_ = false;
        lastExpansions_ = 0;
        state_ = RouteState::Idle;
    }

    MapMemory memory_;
    uint64_t epoch_ = 0, goalId_ = 0;
    int width_ = 0, height_ = 0;
    RoutePoint start_, goal_;
    uint32_t startIndex_ = 0, goalIndex_ = 0;
    bool active_ = false, limited_ = false;
    static constexpr uint8_t kCore = 0x1, kBand = 0x2;
    // The standoff overlay is a SPARSE sorted list, not a full-map byte array: a
    // 2048x2048 map would be 4 MB to allocate and rescan every cycle, while the
    // discs themselves never cover more than a few thousand cells.
    struct Marked {
        uint32_t index = 0; uint8_t bits = 0;
        bool operator==(const Marked& other) const { return index == other.index && bits == other.bits; }
    };
    std::vector<Marked> standoff_;   // sorted by index; the live overlay
    std::vector<Marked> scratch_;    // next raster, diffed against standoff_

    uint8_t StandoffAt(uint32_t index) const
    {
        const auto found = std::lower_bound(standoff_.begin(), standoff_.end(), index,
            [](const Marked& entry, uint32_t value) { return entry.index < value; });
        return (found != standoff_.end() && found->index == index) ? found->bits : static_cast<uint8_t>(0);
    }

    // Stamp one disc into `scratch_`. Bounded by the disc's own area — the whole
    // point is that this never becomes cells x enemies.
    void Stamp(float worldX, float worldY, float radius, uint8_t bit)
    {
        if (radius <= 0.f) return;
        const int centreColumn = static_cast<int>(std::floor(worldX));
        const int centreRow = static_cast<int>(std::floor(worldY));
        const int span = static_cast<int>(std::ceil(radius));
        const float radiusSquared = radius * radius;
        for (int row = centreRow - span; row <= centreRow + span; ++row)
            for (int column = centreColumn - span; column <= centreColumn + span; ++column) {
                if (!InBounds(column, row)) continue;
                const float deltaX = static_cast<float>(column) + 0.5f - worldX;
                const float deltaY = static_cast<float>(row) + 0.5f - worldY;
                if (deltaX * deltaX + deltaY * deltaY < radiusSquared)
                    scratch_.push_back(Marked{ Index(column, row), bit });
            }
    }

    bool  hazardBlocked_ = false;   // safeWalk: damaging ground is impassable
    float keyModifier_ = 0.f, maxSpeedFactor_ = 1.f, baseSpeed_ = 6.f;
    std::array<float, 256> speedFactors_;
    size_t maxNodes_, lastExpansions_ = 0;
    RouteState state_ = RouteState::Idle;
    RouteCorridor limitedCorridor_;
    std::unordered_map<uint32_t, Node> nodes_;
    std::priority_queue<Entry, std::vector<Entry>, Greater> open_;
};

} }
