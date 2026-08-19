#include "pch-il2cpp.h"
#include "game/actions/ItemUse.h"
#include "Il2CppHook.h"
#include "Il2CppResolver.h"
#include "LocalPlayer.h"
#include "core/runtime/MemRead.h"
#include "core/runtime/RuntimeOffsets.h"

#include <cstdint>

namespace Game { namespace ItemUse {
namespace {

// Hotkey path (lean default).
using UseInvByHotkeyFn = void(__fastcall*)(void* eqMgr, int32_t hotkey, void* methodInfo);
// Targeted path (per-class). Note Vector2 is passed by-value in the IL2CPP
// ABI — its two floats occupy two register slots on x64 Windows.
struct Vec2 { float x; float y; };
using UseInvItemFn = bool(__fastcall*)(
    void* eqMgr, void* player, int32_t slot, int32_t kind,
    Vec2 pos, bool a, bool b, void* methodInfo);

UseInvByHotkeyFn s_fnHotkey   = nullptr;
UseInvItemFn     s_fnTargeted = nullptr;
bool             s_resolved   = false;

void ResolveOnce()
{
    if (s_resolved) return;

    // Try real class name first, fall back to BeeByte-obfuscated name.
    const MethodInfo* miHk = Il2CppHook::ResolveMethodCached(
        "EquipmentManager", "UseInventoryItemByHotkey", 1,
        false, "DecaGames.RotMG.Managers.Equipment");
    if (!miHk) miHk = Il2CppHook::ResolveMethodCached(
        "PNBNDBIPENP", "UseInventoryItemByHotkey", 1);
    if (miHk)
        s_fnHotkey = reinterpret_cast<UseInvByHotkeyFn>(miHk->methodPointer);

    const MethodInfo* miUse = Il2CppHook::ResolveMethodCached(
        "EquipmentManager", "UseInventoryItem", 6,
        false, "DecaGames.RotMG.Managers.Equipment");
    if (!miUse) miUse = Il2CppHook::ResolveMethodCached(
        "PNBNDBIPENP", "UseInventoryItem", 6);
    if (miUse)
        s_fnTargeted = reinterpret_cast<UseInvItemFn>(miUse->methodPointer);

    // Resolved when we have AT LEAST the hotkey path. Targeted path is
    // optional — if its method-info isn't found consumers fall back to
    // hotkey-only. The eq-mgr pointer comes from the self-healing registry
    // (RuntimeOffsets::PlayerEquipMgr) and is re-read per call.
    if (s_fnHotkey) s_resolved = true;
}

// Local player + EquipmentManager pointer, re-read per call (both can go
// stale across world transitions). Either output may be null on failure.
void ReadPlayerAndEqMgr(void*& outLp, void*& outEqMgr)
{
    outLp    = LocalPlayer::GetPtr();
    outEqMgr = nullptr;
    if (!outLp) return;
    outEqMgr = Mem::ReadPtr(outLp, RuntimeOffsets::PlayerEquipMgr);
}

} // namespace

bool Ready()
{
    ResolveOnce();
    if (!s_fnHotkey) return false;
    void* lp = nullptr; void* eqMgr = nullptr;
    ReadPlayerAndEqMgr(lp, eqMgr);
    return eqMgr != nullptr;
}

bool UseByHotkey(int hotkey)
{
    ResolveOnce();
    if (!s_fnHotkey) return false;
    void* lp = nullptr; void* eqMgr = nullptr;
    ReadPlayerAndEqMgr(lp, eqMgr);
    if (!eqMgr) return false;
    Resolver::Protection::safe_call([&]() {
        s_fnHotkey(eqMgr, hotkey, nullptr);
    });
    return true;
}

bool TargetedAvailable()
{
    ResolveOnce();
    return s_fnTargeted != nullptr;
}

bool UseTargeted(int slot, float x, float y)
{
    ResolveOnce();
    if (!s_fnTargeted) return false;
    void* lp = nullptr; void* eqMgr = nullptr;
    ReadPlayerAndEqMgr(lp, eqMgr);
    if (!lp || !eqMgr) return false;

    const Vec2 target{ x, y };
    // UseInventoryItem signature:
    //   (eqMgr, player, slot, kind, Vector2 pos, bool ?, bool ?)
    // We use kind=0 (default), bools=false (matches game's own ability
    // press path observed in PlayerTAB's inventory-slot click).
    Resolver::Protection::safe_call([&]() {
        s_fnTargeted(eqMgr, lp, slot, 0, target, false, false, nullptr);
    });
    return true;
}

}} // namespace Game::ItemUse
