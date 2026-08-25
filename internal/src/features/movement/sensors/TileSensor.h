#pragma once

#include <cmath>
#include <cstdint>

// Movement::TileSensor — the tile-probing primitives every dodge mode needs.
//
// Before this header, UDodgeSensors / PJDodgeSensors / ReppSensors /
// ZDodgeSensors each carried their own copy of the tile-key packing, the
// finiteness guards, the per-tick hazard memo, and the hazard/wall probes. Two
// of those copies were byte-identical; one used std::unordered_map instead of
// the open-addressed table; one had no finiteness guard at all. This is the one
// home.
//
// OWNERSHIP: the memo is NOT a global. Each module owns a HazardMemo instance
// and clears it at exactly the point it cleared its old static — so clear
// timing, and therefore behavior, is unchanged.
//
// THREADING: HazardMemo is not synchronized. It is game-update-thread-only,
// exactly like the statics it replaces. UDodge's worker thread does NOT call
// these (UDodgePathfinder documents that the game thread pre-fills the grid) —
// keep it that way.
//
// HOT PATH: every function here is called hundreds of times per frame by the
// planners. Everything except the three probe functions is header-inline; the
// probes are out-of-line because they call into WorldTAB / TestTAB.
namespace Movement { namespace TileSensor {

// Pack a signed tile coordinate pair into one 32-bit memo key. Wraps via
// uint16_t exactly as every prior copy did — negative coordinates alias into
// the high half, which is fine for a per-tick memo.
inline uint32_t TileKey(int tx, int ty)
{
    return (static_cast<uint32_t>(static_cast<uint16_t>(tx)) << 16) |
            static_cast<uint32_t>(static_cast<uint16_t>(ty));
}

inline bool IsFinite(float v) { return std::isfinite(v); }
inline bool IsFinitePoint(float x, float y) { return IsFinite(x) && IsFinite(y); }

inline float DistSq(float ax, float ay, float bx, float by)
{
    const float dx = ax - bx, dy = ay - by;
    return dx * dx + dy * dy;
}

// Fixed-size open-addressed hazard memo. 512 slots, power of two, linear probe.
// No heap allocation, ever — that is why this is not a std::unordered_map.
// Saturates at 512 distinct tiles per tick: past that Insert gives up and the
// extra tiles simply fall through to a live probe each time (same answer, more
// calls).
class HazardMemo {
public:
    HazardMemo() { Clear(); }

    void Clear()
    {
        for (uint32_t i = 0; i < kSlots; ++i)
            e_[i].key = kEmpty;
    }

    bool Find(uint32_t key, uint8_t& outValue) const
    {
        uint32_t idx = key & kMask;
        for (uint32_t probe = 0; probe < kSlots; ++probe) {
            const Entry& e = e_[idx];
            if (e.key == key) { outValue = e.value; return true; }
            if (e.key == kEmpty) return false;
            idx = (idx + 1) & kMask;
        }
        return false;
    }

    void Insert(uint32_t key, uint8_t value)
    {
        uint32_t idx = key & kMask;
        for (uint32_t probe = 0; probe < kSlots; ++probe) {
            Entry& e = e_[idx];
            if (e.key == kEmpty || e.key == key) {
                e.key = key; e.value = value;
                return;
            }
            idx = (idx + 1) & kMask;
        }
    }

private:
    static constexpr uint32_t kSlots = 512;      // power of 2
    static constexpr uint32_t kMask  = kSlots - 1;
    static constexpr uint32_t kEmpty = 0xFFFFFFFFu;
    struct Entry { uint32_t key; uint8_t value; };
    Entry e_[kSlots];
};

// Damaging-ground probe, memoized per tile in `memo`. Non-finite -> false
// (matches every prior copy: an unknown point is NOT reported as a hazard).
bool IsHazardAt(HazardMemo& memo, float worldX, float worldY);

// Wall probe. Non-finite -> true (blocked). This is ReppSensors::IsWallAt's
// polarity; CanOccupy below answers the opposite question.
bool IsWallAt(float worldX, float worldY);

// Occupancy: not a wall, and (when safeWalk) not damaging ground.
// Non-finite -> false (cannot occupy).
bool CanOccupy(HazardMemo& memo, float worldX, float worldY, bool safeWalk);

} } // namespace Movement::TileSensor
