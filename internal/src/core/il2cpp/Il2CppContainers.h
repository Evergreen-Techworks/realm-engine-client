#pragma once
#include <cstdint>
#include "core/runtime/MemRead.h"
// IL2CPP / .NET container memory layouts. These are runtime invariants (NOT
// game-specific offsets — do not move to RuntimeOffsets). x64 layouts.
namespace Il2CppC {
    // Dictionary<TKey,TValue> (managed): _entries ptr, _count int.
    inline constexpr uint32_t kDictEntries = 0x18;
    inline constexpr uint32_t kDictCount   = 0x20;
    // Entry<int,ptr> stride/fields inside the entries T[].
    inline constexpr uint32_t kEntryStride = 24;   // sizeof Entry<int,ptr>
    inline constexpr uint32_t kEntryHash   = 0;    // int hashCode (<0 => free)
    inline constexpr uint32_t kEntryKey    = 8;    // int key
    inline constexpr uint32_t kEntryValue  = 16;   // T value (ptr)
    // System.Array: max length header, first element.
    inline constexpr uint32_t kArrMaxLen   = 0x18;
    inline constexpr uint32_t kArrData     = 0x20;
    // List<T>: _items (T[]) ptr, _size int.
    inline constexpr uint32_t kListItems   = 0x10;
    inline constexpr uint32_t kListSize    = 0x18;
    // System.String: length int (chars follow at 0x14).
    inline constexpr uint32_t kStrLen      = 0x10;
    inline constexpr uint32_t kStrChars    = 0x14;

    // Walk a Dictionary<int, ptr>. cb(int key, void* value) per live entry.
    // maxEntries clamps a corrupt count. SEH-safe throughout.
    template<typename Cb>
    inline void WalkDict(void* dictPtr, int maxEntries, Cb cb) {
        if (!Mem::AddrOk(dictPtr)) return;
        void* entries = Mem::ReadPtr(dictPtr, kDictEntries);
        int32_t count = Mem::ReadOr<int32_t>(dictPtr, kDictCount, 0);
        if (!Mem::AddrOk(entries)) return;
        int32_t maxLen = Mem::ReadOr<int32_t>(entries, kArrMaxLen, 0);
        if (maxLen <= 0 || maxLen > 65536) maxLen = maxEntries;
        if (count  <= 0 || count  > maxLen) count  = maxLen;
        for (int32_t i = 0; i < count; ++i) {
            const void* e = reinterpret_cast<const uint8_t*>(entries)
                          + kArrData + static_cast<size_t>(i) * kEntryStride;
            if (Mem::ReadOr<int32_t>(e, kEntryHash, -1) < 0) continue;
            int32_t key   = Mem::ReadOr<int32_t>(e, kEntryKey, 0);
            void*   value = Mem::ReadPtr(e, kEntryValue);
            cb(key, value);
        }
    }

    // First `outMax` items of a List<T> of pointers into `out`; returns count.
    int ListItems(void* listPtr, void** out, int outMax);
    // Copy an IL2CPP string into a UTF-8 buffer (best effort). Returns length.
    int ReadString(void* strPtr, char* out, int outCap);
    // Copy an IL2CPP System.String into a UTF-8 buffer via WideCharToMultiByte
    // (correct for non-ASCII names). Rejects implausible lengths (len <= 0 or
    // len > 4096 -> returns 0). Always null-terminates when outCap > 0.
    // Returns bytes written (excluding the null). SEH-safe.
    int ReadStringUtf8(void* strPtr, char* out, int outCap);
}
