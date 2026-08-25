#include "pch-il2cpp.h"
#include "features/combat/autoaim/shoot/ProjNoclip.h"
#include "RuntimeOffsets.h"
#include "core/runtime/MemRead.h"
#include "platform/hooks/Il2CppHook.h"

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
        if (RuntimeOffsets::Hbeak_NoclipGuard != 0 && Mem::AddrOk(thisPtr))
        {
            __try {
                const bool npm = *reinterpret_cast<bool*>(
                    reinterpret_cast<uint8_t*>(thisPtr) + RuntimeOffsets::Hbeak_NoclipGuard);  // raw-access-ok: hot-loop __try field sweep; shared-SEH save/restore must abort atomically
                if (npm)
                {
                    void* tile = *reinterpret_cast<void**>(
                        reinterpret_cast<uint8_t*>(thisPtr) + RuntimeOffsets::KJ_TileRef);  // raw-access-ok: hot-loop __try field sweep; shared-SEH save/restore must abort atomically
                    if (Mem::AddrOk(tile))
                    {
                        int32_t* layerPtr = reinterpret_cast<int32_t*>(
                            reinterpret_cast<uint8_t*>(tile) + RuntimeOffsets::Sq_Layer);  // raw-access-ok: hot-loop __try field sweep; shared-SEH save/restore must abort atomically
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
                reinterpret_cast<uint8_t*>(s_savedTile) + RuntimeOffsets::Sq_Layer) = s_savedLayer;  // raw-access-ok: hot-loop __try field sweep; shared-SEH save/restore must abort atomically
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

    // Resolve GJFKGLJEGKO (2 int params).
    const MethodInfo* miGjfk = Il2CppHook::ResolveMethodCached("HBEAKBIHANL", "GJFKGLJEGKO", 2, false, "");
    if (!miGjfk) return;

    // Resolve IACODGNOFMH (2 int params).
    const MethodInfo* miIacod = Il2CppHook::ResolveMethodCached("HBEAKBIHANL", "IACODGNOFMH", 2, false, "");
    if (!miIacod) return;

    // NPMECLDKGEF must resolve; without it we can't guard the hook safely.
    if (RuntimeOffsets::Hbeak_NoclipGuard == 0) return;

    s_gjfkTarget  = reinterpret_cast<void*>(miGjfk->methodPointer);
    s_iacodTarget = reinterpret_cast<void*>(miIacod->methodPointer);

    g_origGJFK  = reinterpret_cast<GJFKFn>(s_gjfkTarget);
    g_origIACOD = reinterpret_cast<IACODFn>(s_iacodTarget);

    if (!Il2CppHook::EnsureRuntime("ProjNoclip")) return;

    if (!Il2CppHook::InstallMinHook(s_gjfkTarget,
            reinterpret_cast<void*>(&GJFKGLJEGKO_hook),
            reinterpret_cast<void**>(&g_origGJFK), "ProjNoclip.GJFK"))
        return;

    if (!Il2CppHook::InstallMinHook(s_iacodTarget,
            reinterpret_cast<void*>(&IACODGNOFMH_hook),
            reinterpret_cast<void**>(&g_origIACOD), "ProjNoclip.IACOD")) {
        Il2CppHook::UninstallMinHook(s_gjfkTarget, "ProjNoclip.GJFK");
        return;
    }

    s_installed = true;
}

void Uninstall()
{
    if (!s_installed) return;

    s_enabled.store(false);

    Il2CppHook::UninstallMinHook(s_iacodTarget, "ProjNoclip.IACOD");
    Il2CppHook::UninstallMinHook(s_gjfkTarget,  "ProjNoclip.GJFK");

    g_origGJFK  = nullptr;
    g_origIACOD = nullptr;
    s_installed = false;
}

void SetEnabled(bool on) { s_enabled.store(on, std::memory_order_relaxed); }
bool IsEnabled()          { return s_enabled.load(std::memory_order_relaxed); }
bool IsInstalled()        { return s_installed; }

} // namespace ProjNoclip
