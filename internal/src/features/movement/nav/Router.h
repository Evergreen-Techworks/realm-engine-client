#pragma once

#include "MapMemory.h"
#include "Collision.h"
#include "Speed.h"

#include <array>
#include <chrono>
#include <cmath>
#include <limits>
#include <queue>
#include <unordered_map>

namespace Movement { namespace Nav {

struct RoutePoint {
    float worldX = 0.f;
    float worldY = 0.f;
};

enum class RouteState { Idle, Repairing, Ready, Arrived, Partial, Unreachable };

struct RouteCorridor {
    uint64_t epoch = 0;
    uint64_t goalId = 0;
    RouteState state = RouteState::Idle;
    bool requiresLocalVerification = true;
    std::array<RoutePoint, 8> points{};
    int count = 0;
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
            for (const auto& change : batch.cells)
                for (int offsetY = -1; offsetY <= 1; ++offsetY)
                    for (int offsetX = -1; offsetX <= 1; ++offsetX) {
                        const int column = change.column + offsetX;
                        const int row = change.row + offsetY;
                        if (InBounds(column, row) && nodes_.find(Index(column, row)) != nodes_.end())
                            UpdateVertex(Index(column, row));
                    }
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

    bool SetBaseSpeed(float tilesPerSec)
    {
        if (!std::isfinite(tilesPerSec) || tilesPerSec <= 0.f) return false;
        if (std::fabs(baseSpeed_ - tilesPerSec) < 0.001f) return true;
        baseSpeed_ = tilesPerSec;
        if (active_) SetGoal(epoch_, goalId_, start_, goal_);
        return true;
    }

    RouteState Repair(size_t maxExpansions = 2048)
    {
        lastExpansions_ = 0;
        if (!active_) return state_;
        if (limited_) { BuildLimitedCorridor(); return state_; }
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(2);
        while (lastExpansions_ < maxExpansions) {
            if (lastExpansions_ > 0 && lastExpansions_ % 16 == 0 && std::chrono::steady_clock::now() >= deadline) break;
            DiscardStale();
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
        DiscardStale();
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
        const float sourceFactor = (source.flags & TileOccupancy::kTileKnown) ? speedFactors_[source.speedClass] : 1.f / 1.2f;
        const float targetFactor = (target.flags & TileOccupancy::kTileKnown) ? speedFactors_[target.speedClass] : 1.f / 1.2f;
        return Speed::EdgeMs(baseSpeed_ / 1000.f, sourceFactor, targetFactor, diagonal ? 1.41421356237f : 1.f) / 1000.f +
            ((target.flags & TileOccupancy::kTileDamaging) ? 3.f : 0.f);
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
    void DiscardStale()
    {
        while (!open_.empty()) {
            const auto& entry = open_.top();
            const auto found = nodes_.find(entry.index);
            if (found != nodes_.end() && found->second.version == entry.version) break;
            open_.pop();
        }
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
    float keyModifier_ = 0.f, maxSpeedFactor_ = 1.f, baseSpeed_ = 6.f;
    std::array<float, 256> speedFactors_;
    size_t maxNodes_, lastExpansions_ = 0;
    RouteState state_ = RouteState::Idle;
    RouteCorridor limitedCorridor_;
    std::unordered_map<uint32_t, Node> nodes_;
    std::priority_queue<Entry, std::vector<Entry>, Greater> open_;
};

} }
