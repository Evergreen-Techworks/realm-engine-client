#pragma once

#include "features/movement/sensors/TileOccupancy.h"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <unordered_map>
#include <vector>

namespace Movement { namespace Nav {

struct GroundCell {
    uint8_t flags = 0;
    uint8_t speedClass = 0;
};

static_assert(sizeof(GroundCell) == 2, "ground storage must remain two bytes per square");

enum class StructuralState : uint8_t { Unknown, ConfirmedEmpty, Present };
enum class ObservationSource : uint8_t { Unverified, CurrentSquareOccupant, TransientEntity };

struct StructuralObservation {
    StructuralState state = StructuralState::Unknown;
    ObservationSource source = ObservationSource::Unverified;
    uint64_t identity = 0;
    uint8_t flags = 0;
};

struct MapCell {
    bool inBounds = false;
    GroundCell ground;
    StructuralObservation structure;
};

struct ChangedCell {
    int column = 0;
    int row = 0;
    MapCell cell;
};

struct ChangedCells {
    uint64_t epoch = 0;
    int width = 0;
    int height = 0;
    bool reset = false;
    std::vector<ChangedCell> cells;
};

class MapMemory {
public:
    static constexpr int kMaxDimension = 2048;

    bool Reset(uint64_t epoch, int width, int height)
    {
        if (epoch <= epoch_ || width <= 0 || height <= 0 ||
            width > kMaxDimension || height > kMaxDimension)
            return false;
        const auto count = static_cast<size_t>(width) * static_cast<size_t>(height);
        std::vector<GroundCell> ground(count);
        std::vector<bool> structureObserved(count, false);
        std::vector<bool> dirty(count, false);
        ground_.swap(ground);
        structureObserved_.swap(structureObserved);
        dirty_.swap(dirty);
        structures_.clear();
        changed_.clear();
        epoch_ = epoch;
        width_ = width;
        height_ = height;
        resetPending_ = true;
        return true;
    }

    bool ObserveGround(uint64_t epoch, int column, int row, uint8_t flags, uint8_t speedClass)
    {
        constexpr uint8_t allowed = TileOccupancy::kTileKnown | TileOccupancy::kTileBlocked |
            TileOccupancy::kTileDamaging | TileOccupancy::kTileSink | TileOccupancy::kTileSpeedMod;
        if (!Accepts(epoch, column, row) || !(flags & TileOccupancy::kTileKnown) ||
            (flags & ~allowed) != 0)
            return false;
        const auto index = Index(column, row);
        auto& ground = ground_[index];
        if (ground.flags == flags && ground.speedClass == speedClass)
            return false;
        ground = {flags, speedClass};
        MarkChanged(index);
        return true;
    }

    bool ObserveStructure(uint64_t epoch, int column, int row, const StructuralObservation& observation)
    {
        constexpr uint8_t allowed = TileOccupancy::kTileBlocked | TileOccupancy::kTileFullOcc;
        if (!Accepts(epoch, column, row) || observation.source != ObservationSource::CurrentSquareOccupant ||
            (observation.state != StructuralState::Present && observation.state != StructuralState::ConfirmedEmpty) ||
            (observation.flags & ~allowed) != 0 ||
            (observation.state == StructuralState::ConfirmedEmpty && (observation.identity != 0 || observation.flags != 0)))
            return false;
        const auto index = Index(column, row);
        const auto previous = structures_.find(index);
        if (observation.state == StructuralState::ConfirmedEmpty) {
            if (structureObserved_[index] && previous == structures_.end())
                return false;
            structures_.erase(index);
        } else {
            if (previous != structures_.end() && previous->second.identity == observation.identity &&
                previous->second.flags == observation.flags)
                return false;
            structures_[index] = observation;
        }
        structureObserved_[index] = true;
        MarkChanged(index);
        return true;
    }

    MapCell GetCell(int column, int row) const
    {
        if (!InBounds(column, row)) return {};
        const auto index = Index(column, row);
        MapCell result;
        result.inBounds = true;
        result.ground = ground_[index];
        const auto structure = structures_.find(index);
        if (structure != structures_.end())
            result.structure = structure->second;
        else if (structureObserved_[index])
            result.structure = {StructuralState::ConfirmedEmpty, ObservationSource::CurrentSquareOccupant, 0, 0};
        return result;
    }

    ChangedCells TakeChangedCells(size_t maxCells = 4096)
    {
        ChangedCells result;
        result.epoch = epoch_;
        result.width = width_;
        result.height = height_;
        result.reset = resetPending_;
        const auto count = std::min(maxCells, changed_.size());
        result.cells.reserve(count);
        for (size_t entry = 0; entry < count; ++entry) {
            const auto index = changed_.front();
            const auto column = static_cast<int>(index % static_cast<uint32_t>(width_));
            const auto row = static_cast<int>(index / static_cast<uint32_t>(width_));
            result.cells.push_back({column, row, GetCell(column, row)});
            changed_.pop_front();
            dirty_[index] = false;
        }
        resetPending_ = false;
        return result;
    }

private:
    bool InBounds(int column, int row) const
    {
        return column >= 0 && row >= 0 && column < width_ && row < height_;
    }

    bool Accepts(uint64_t epoch, int column, int row) const
    {
        return epoch == epoch_ && InBounds(column, row);
    }

    uint32_t Index(int column, int row) const
    {
        return static_cast<uint32_t>(row) * static_cast<uint32_t>(width_) + static_cast<uint32_t>(column);
    }

    void MarkChanged(uint32_t index)
    {
        if (dirty_[index]) return;
        changed_.push_back(index);
        dirty_[index] = true;
    }

    uint64_t epoch_ = 0;
    int width_ = 0;
    int height_ = 0;
    bool resetPending_ = false;
    std::vector<GroundCell> ground_;
    std::vector<bool> structureObserved_;
    std::vector<bool> dirty_;
    std::unordered_map<uint32_t, StructuralObservation> structures_;
    std::deque<uint32_t> changed_;
};

} }
