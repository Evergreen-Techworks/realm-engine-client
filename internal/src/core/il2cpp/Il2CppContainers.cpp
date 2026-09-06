#include "pch-il2cpp.h"

#include "core/il2cpp/Il2CppContainers.h"

// Non-template container helpers. WalkDict lives inline in the header; these two
// need a bounded loop / a UTF-16→8 narrowing, so they live here. Every field
// access goes through Mem:: so each read is individually SEH-safe (matching the
// per-read safety model the hand-rolled walkers used).
namespace Il2CppC {

    // Copy up to `outMax` pointer elements of a List<T> (_items T[] / _size int)
    // into `out`. Clamps a corrupt size against the backing array's max length.
    // Returns the number of elements written.
    int ListItems(void* listPtr, void** out, int outMax) {
        if (!Mem::AddrOk(listPtr) || out == nullptr || outMax <= 0) return 0;
        void* items = Mem::ReadPtr(listPtr, kListItems);
        int32_t size = Mem::ReadOr<int32_t>(listPtr, kListSize, 0);
        if (!Mem::AddrOk(items) || size <= 0) return 0;
        int32_t maxLen = Mem::ReadOr<int32_t>(items, kArrMaxLen, 0);
        if (maxLen <= 0 || maxLen > 65536) maxLen = size;
        if (size > maxLen) size = maxLen;
        if (size > outMax) size = outMax;
        int n = 0;
        for (int32_t i = 0; i < size; ++i) {
            const void* slot = reinterpret_cast<const uint8_t*>(items)
                             + kArrData + static_cast<size_t>(i) * sizeof(void*);
            out[n++] = Mem::ReadPtr(slot, 0);
        }
        return n;
    }

    // Copy an IL2CPP System.String into a UTF-8 buffer (best effort — the low
    // byte of each UTF-16 unit, ASCII-safe). Always null-terminates when there
    // is room. Returns the number of characters written (excluding the null).
    int ReadString(void* strPtr, char* out, int outCap) {
        if (!Mem::AddrOk(strPtr) || out == nullptr || outCap <= 0) return 0;
        int32_t len = Mem::ReadOr<int32_t>(strPtr, kStrLen, 0);
        if (len <= 0) { out[0] = '\0'; return 0; }
        if (len > outCap - 1) len = outCap - 1;
        const uint8_t* chars = reinterpret_cast<const uint8_t*>(strPtr) + kStrChars;
        int n = 0;
        for (int32_t i = 0; i < len; ++i) {
            uint16_t ch = Mem::ReadOr<uint16_t>(chars + static_cast<size_t>(i) * 2u, 0, 0);
            out[n++] = static_cast<char>(ch & 0x7F);
        }
        out[n] = '\0';
        return n;
    }

    // Copy an IL2CPP System.String into a UTF-8 buffer via WideCharToMultiByte
    // (correct for non-ASCII names). Rejects implausible lengths instead of
    // truncating. Returns the number of bytes written (excluding the null).
    int ReadStringUtf8(void* strPtr, char* out, int outCap) {
        if (!Mem::AddrOk(strPtr) || out == nullptr || outCap <= 0) return 0;
        out[0] = '\0';
        int32_t len = Mem::ReadOr<int32_t>(strPtr, kStrLen, 0);
        if (len <= 0 || len > 4096) return 0;
        // Copy UTF-16 units under SEH, then convert.
        wchar_t wbuf[512];
        int n = (len < 511) ? len : 511;
        const uint8_t* chars = reinterpret_cast<const uint8_t*>(strPtr) + kStrChars;
        for (int i = 0; i < n; ++i) {
            uint16_t ch = Mem::ReadOr<uint16_t>(chars + static_cast<size_t>(i) * 2u, 0, 0);
            wbuf[i] = static_cast<wchar_t>(ch);
        }
        int written = WideCharToMultiByte(CP_UTF8, 0, wbuf, n, out, outCap - 1,
                                          nullptr, nullptr);
        if (written < 0) written = 0;
        out[written] = '\0';
        return written;
    }
}
