#include "pch-il2cpp.h"
#include "ProjNoclip.h"
#include "Il2CppResolver.h"
#include "RuntimeOffsets.h"
#include "core/runtime/MemRead.h"
#include "platform/hooks/Il2CppHook.h"
#include "minhook/MinHook.h"

#include <Windows.h>
#include <atomic>
#include <cstdint>

// ─────────────────────────────────────────────────────────────────────────────
// ProjNoclip — projectile wall-pass-through, matching multitool WeaponModsProjectileNoclip.
//
// Mechanism (matches sub_180007380 / sub_180007400 in multitool BinaryNinja dump):
//
//  GJFKGLJEGKO(this, x, y) — called each tick to check if the projectile at tile (x,y)
//    intersects a wall.  Internally calls IACODGNOFMH to test the tile's collision layer.
//
//  Our hooks, ordered by execution:
//    1. GJFKGLJEGKO hook pre-call: clear s_noclipApplied.
//    2. Original GJFKGLJEGKO runs → calls IACODGNOFMH internally.
//    3. IACODGNOFMH hook: call original.
//         If original returns true (wall) AND noclip is enabled AND NPMECLDKGEF is set:
//           Save EBCLNFDKKEH on this->EOKJOGFPLOA (the tile), set it to 37.
//           Set s_noclipApplied = true.
//         Return the original result unchanged (true = wall to GJFKGLJEGKO).
//    4. Original GJFKGLJEGKO now re-checks tile's EBCLNFDKKEH; layer 37 is passable → returns false.
//    5. GJFKGLJEGKO hook post-call: if s_noclipApplied, restore EBCLNFDKKEH on the saved tile.
//
// Field offsets (no ACTK shift — HBEAKBIHANL extends KJMONHENJEN directly):
//   HBEAKBIHANL.NPMECLDKGEF — bool: must be true for noclip to apply (projectile is "active").
//   KJMONHENJEN.EOKJOGFPLOA — BGAIOPJMHLO* : current tile the entity/projectile occupies.
//   BGAIOPJMHLO.EBCLNFDKKEH — int32_t (FDCIMDHOOCB__Enum): tile collision layer.
// ─────────────────────────────────────────────────────────────────────────────

namespace {

// ── Runtime field offsets (resolved once at Install time) ────────────────────
// No ACTK shift: HBEAKBIHANL and BGAIOPJMHLO are both non-LKHPPBEGNOM classes.
static uint32_t s_npmOff  = 0;   // HBEAKBIHANL.NPMECLDKGEF (bool)
static uint32_t s_eokOff  = 0;   // KJMONHENJEN.EOKJOGFPLOA (BGAIOPJMHLO*)
static uint32_t s_ebclOff = 0;   // BGAIOPJMHLO.EBCLNFDKKEH (int32_t/enum)

// Fallback offsets derived from il2cpp-types.h struct layout.
// KJMONHENJEN layout (known from resolved PosX=0x3C, ObjType=0x30):
//   ptr×4 [0x10..0x28], int32×2 [0x30,0x34], bool×3 [0x38,0x39,0x3A], pad [0x3B],
//   float PosX [0x3C], float PosY [0x40], float [0x44], bool [0x48], int32 [0x4C],
//   float [0x50], pad [0x54..0x57], BGAIOPJMHLO* [0x58]
static constexpr uint32_t kFallbackEokOff  = 0x58;
// BGAIOPJMHLO layout (known from TileX=0x38, TileY=0x3C, TileType=0x40):
//   uint16 [0x40], bool×2 [0x42,0x43], EBCLNFDKKEH int32 [0x44]
static constexpr uint32_t kFallbackEbclOff = 0x44;
// HBEAKBIHANL.NPMECLDKGEF — resolved only via IL2CPP; no reliable static fallback.

// ── Hook state (accessed only from game thread during GJFKGLJEGKO execution) ─
static bool     s_noclipApplied = false;
static int32_t  s_savedLayer    = 0;
static void*    s_savedTile     = nullptr;

// ── Method function-pointer typedefs ─────────────────────────────────────────
typedef bool (__fastcall *GJFKFn)(void* thisPtr, int32_t x, int32_t y, void* methodInfo);
typedef bool (__fastcall *IACODFn)(void* thisPtr, int32_t a, int32_t b, void* methodInfo);

static GJFKFn  g_origGJFK  = nullptr;
static IACODFn g_origIACOD = nullptr;

// ── Enabled flag ─────────────────────────────────────────────────────────────
static std::atomic<bool> s_enabled{ false };

// ── IACODGNOFMH hook ──────────────────────────────────────────────────────────
// Fires inside GJFKGLJEGKO.  If original says "wall" and noclip is on, temporarily
// set the tile's EBCLNFDKKEH to 37 so GJFKGLJEGKO's subsequent layer-check passes.
static bool __fastcall IACODGNOFMH_hook(void* thisPtr, int32_t a, int32_t b, void* methodInfo)
{
    const bool origResult = g_origIACOD(thisPtr, a, b, methodInfo);

    if (origResult && s_enabled.load(std::memory_order_relaxed) && !s_noclipApplied)
    {
        if (s_npmOff != 0 && Mem::AddrOk(thisPtr))
        {
            __try {
                const bool npm = *reinterpret_cast<bool*>(
                    reinterpret_cast<uint8_t*>(thisPtr) + s_npmOff);
                if (npm)
                {
                    void* tile = *reinterpret_cast<void**>(
                        reinterpret_cast<uint8_t*>(thisPtr) + s_eokOff);
                    if (Mem::AddrOk(tile))
                    {
                        int32_t* layerPtr = reinterpret_cast<int32_t*>(
                            reinterpret_cast<uint8_t*>(tile) + s_ebclOff);
                        s_savedLayer    = *layerPtr;
                        s_savedTile     = tile;
                        *layerPtr       = 37;
                        s_noclipApplied = true;
                    }
                }
            } __except (EXCEPTION_EXECUTE_HANDLER) {}
        }
    }

    return origResult;
}

// ── GJFKGLJEGKO hook ──────────────────────────────────────────────────────────
// Outer hook: clear the applied-flag before delegating, then restore tile layer after.
static bool __fastcall GJFKGLJEGKO_hook(void* thisPtr, int32_t x, int32_t y, void* methodInfo)
{
    s_noclipApplied = false;
    s_savedTile     = nullptr;

    const bool result = g_origGJFK(thisPtr, x, y, methodInfo);

    if (s_noclipApplied && Mem::AddrOk(s_savedTile))
    {
        __try {
            *reinterpret_cast<int32_t*>(
                reinterpret_cast<uint8_t*>(s_savedTile) + s_ebclOff) = s_savedLayer;
        } __except (EXCEPTION_EXECUTE_HANDLER) {}
        s_noclipApplied = false;
        s_savedTile     = nullptr;
    }

    return result;
}

static bool    s_installed = false;
static void*   s_gjfkTarget  = nullptr;
static void*   s_iacodTarget = nullptr;

} // namespace

namespace ProjNoclip {

void Install()
{
    if (s_installed) return;

    Il2CppClass* hbeakKlass = Resolver::GetClass("", "HBEAKBIHANL");
    if (!hbeakKlass) return;

    // Resolve GJFKGLJEGKO (2 int params).
    const MethodInfo* miGjfk = il2cpp_class_get_method_from_name(hbeakKlass, "GJFKGLJEGKO", 2);
    if (!miGjfk || !miGjfk->methodPointer) return;

    // Resolve IACODGNOFMH (2 int params).
    const MethodInfo* miIacod = il2cpp_class_get_method_from_name(hbeakKlass, "IACODGNOFMH", 2);
    if (!miIacod || !miIacod->methodPointer) return;

    // Resolve field offsets via IL2CPP (no ACTK shift for these classes).
    {
        // HBEAKBIHANL.NPMECLDKGEF (bool) — walk hierarchy to find it.
        FieldInfo* fi = nullptr;
        for (Il2CppClass* k = hbeakKlass; k && !fi; k = il2cpp_class_get_parent(k))
            fi = il2cpp_class_get_field_from_name(k, "NPMECLDKGEF");
        if (fi) s_npmOff = static_cast<uint32_t>(il2cpp_field_get_offset(fi));
    }
    {
        // KJMONHENJEN.EOKJOGFPLOA (BGAIOPJMHLO*).
        Il2CppClass* kjmonKlass = Resolver::GetClass("", "KJMONHENJEN");
        if (kjmonKlass) {
            FieldInfo* fi = il2cpp_class_get_field_from_name(kjmonKlass, "EOKJOGFPLOA");
            if (fi) s_eokOff = static_cast<uint32_t>(il2cpp_field_get_offset(fi));
        }
        if (s_eokOff == 0) s_eokOff = kFallbackEokOff;
    }
    {
        // BGAIOPJMHLO.EBCLNFDKKEH (int32/enum).
        Il2CppClass* bgaKlass = Resolver::GetClass("", "BGAIOPJMHLO");
        if (bgaKlass) {
            FieldInfo* fi = il2cpp_class_get_field_from_name(bgaKlass, "EBCLNFDKKEH");
            if (fi) s_ebclOff = static_cast<uint32_t>(il2cpp_field_get_offset(fi));
        }
        if (s_ebclOff == 0) s_ebclOff = kFallbackEbclOff;
    }

    // NPMECLDKGEF must resolve; without it we can't guard the hook safely.
    if (s_npmOff == 0) return;

    s_gjfkTarget  = reinterpret_cast<void*>(miGjfk->methodPointer);
    s_iacodTarget = reinterpret_cast<void*>(miIacod->methodPointer);

    g_origGJFK  = reinterpret_cast<GJFKFn>(s_gjfkTarget);
    g_origIACOD = reinterpret_cast<IACODFn>(s_iacodTarget);

    static bool s_mhInit = false;
    if (!s_mhInit) {
        MH_STATUS st = MH_Initialize();
        if (st != MH_OK && st != MH_ERROR_ALREADY_INITIALIZED) return;
        s_mhInit = true;
    }

    if (!Il2CppHook::InstallMinHook(s_gjfkTarget,
            reinterpret_cast<void*>(&GJFKGLJEGKO_hook),
            reinterpret_cast<void**>(&g_origGJFK), "ProjNoclip.GJFK"))
        return;

    if (!Il2CppHook::InstallMinHook(s_iacodTarget,
            reinterpret_cast<void*>(&IACODGNOFMH_hook),
            reinterpret_cast<void**>(&g_origIACOD), "ProjNoclip.IACOD")) {
        MH_DisableHook(s_gjfkTarget);
        MH_RemoveHook(s_gjfkTarget);
        return;
    }

    s_installed = true;
}

void Uninstall()
{
    if (!s_installed) return;

    s_enabled.store(false);

    if (s_iacodTarget) {
        MH_DisableHook(s_iacodTarget);
        MH_RemoveHook(s_iacodTarget);
        s_iacodTarget = nullptr;
    }
    if (s_gjfkTarget) {
        MH_DisableHook(s_gjfkTarget);
        MH_RemoveHook(s_gjfkTarget);
        s_gjfkTarget = nullptr;
    }

    g_origGJFK  = nullptr;
    g_origIACOD = nullptr;
    s_installed = false;
}

void SetEnabled(bool on) { s_enabled.store(on, std::memory_order_relaxed); }
bool IsEnabled()          { return s_enabled.load(std::memory_order_relaxed); }
bool IsInstalled()        { return s_installed; }

} // namespace ProjNoclip
