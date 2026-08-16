#pragma once
#include <cstdint>
// SEH-safe raw-memory helpers for reading IL2CPP object fields by byte offset.
// This is the raw-offset counterpart to RuntimeOffsets::ReadField<T> (which is
// keyed on FieldInfo*). Every consumer that today writes
// `*reinterpret_cast<T*>(base + off)` should use Mem::TryRead / Mem::ReadOr.
namespace Mem {

    // Canonical user-mode pointer sanity check. Replaces every local AddrOk /
    // AddrValid. Range is the majority behavior in the tree (see divergence).
    inline bool AddrOk(const void* p) {
        const uintptr_t a = reinterpret_cast<uintptr_t>(p);
        return a > 0x10000 && a < 0x7FFFFFFFFFFFULL;
    }

    // SEH-safe read of a T at (base + off). Returns false and leaves `out`
    // untouched on null base or access violation.
    template<typename T>
    inline bool TryRead(const void* base, uint32_t off, T& out) {
        if (!AddrOk(base)) return false;
        __try {
            out = *reinterpret_cast<const T*>(
                reinterpret_cast<const uint8_t*>(base) + off);
            return true;
        } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
    }

    // SEH-safe read returning `fallback` on failure.
    template<typename T>
    inline T ReadOr(const void* base, uint32_t off, T fallback) {
        T v; return TryRead(base, off, v) ? v : fallback;
    }

    // SEH-safe pointer-field read (the `*(void**)(base+off)` idiom). Returns
    // nullptr on failure; the returned pointer is itself AddrOk-validated.
    inline void* ReadPtr(const void* base, uint32_t off) {
        void* p = nullptr;
        if (!TryRead(base, off, p)) return nullptr;
        return AddrOk(p) ? p : nullptr;
    }
}
