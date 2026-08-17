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

    // Page-protection validity check via VirtualQuery — stricter and costlier
    // than AddrOk (an actual committed, readable/writable page rather than a
    // numeric-range guess). Use only where the extra syscall is warranted (e.g.
    // validating a hand-walked local pointer before an SEH read); AddrOk is the
    // hot-path default. Relies on <windows.h> from the PCH.
    inline bool PageReadable(const void* p) {
        if (!p) return false;
        MEMORY_BASIC_INFORMATION mbi{};
        if (VirtualQuery(p, &mbi, sizeof(mbi)) == 0)
            return false;
        return (mbi.State == MEM_COMMIT)
            && (mbi.Protect
                & (PAGE_READWRITE | PAGE_EXECUTE_READWRITE | PAGE_READONLY | PAGE_EXECUTE_READ));
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

    // SEH-safe typed write. Returns false (writes nothing) if base+off is not a
    // plausible committed address. Mirror of TryRead — the ONE write primitive so
    // feature/gui code never open-codes *reinterpret_cast<T*>(p+off) = v.
    template <typename T>
    inline bool TryWrite(void* base, uint32_t off, const T& val) {
        if (!AddrOk(base)) return false;
        __try { *reinterpret_cast<T*>(reinterpret_cast<uint8_t*>(base) + off) = val; return true; }
        __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
    }

    // SEH-safe pointer-field read (the `*(void**)(base+off)` idiom). Returns
    // nullptr on failure; the returned pointer is itself AddrOk-validated.
    inline void* ReadPtr(const void* base, uint32_t off) {
        void* p = nullptr;
        if (!TryRead(base, off, p)) return nullptr;
        return AddrOk(p) ? p : nullptr;
    }
}
