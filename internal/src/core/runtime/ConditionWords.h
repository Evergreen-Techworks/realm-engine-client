#pragma once
// MapObject condition words (COHCKAPOLCA) — pure helpers, no game memory, so the
// host test suite exercises them.
//
// What the game does (86ad651b):
//   • LKHPPBEGNOM..ctor allocates the field as `new Int32[3]` (not 2).
//   • Every condition check reads element 0 for bits 0-31 and element 1 for bits
//     32 and up, with 32-bit batches: IsSlowed tests word0 & 0x8, and the check
//     for bit 63 tests word1 & 0x80000000.
#include <cstdint>

namespace RuntimeConditions {

constexpr int32_t kMinWords = 2;   // bits 0-63 need two words
constexpr int32_t kMaxWords = 8;   // a far longer "array" is some other object

// Combine the first two words into one 64-bit mask: word 1 carries bits 32-63.
inline uint64_t Combine(uint32_t word0, uint32_t word1)
{
    return static_cast<uint64_t>(word0) | (static_cast<uint64_t>(word1) << 32);
}

// Shape of an IL2CPP array header read at a candidate conditions offset:
// {klass, monitor, bounds, max_length}. `pinnedKlass` is the array class seen on
// the first validated read (0 before that); once pinned, any other class is not
// the conditions array, which keeps a garbage read from ever validating.
inline bool ArrayShapeOk(uintptr_t klass, uintptr_t bounds, int32_t maxLen, uintptr_t pinnedKlass)
{
    if (klass < 0x10000 || klass > 0x7FFFFFFFFFFFULL) return false;
    if (bounds != 0) return false;
    if (maxLen < kMinWords || maxLen > kMaxWords) return false;
    return pinnedKlass == 0 || klass == pinnedKlass;
}

} // namespace RuntimeConditions
