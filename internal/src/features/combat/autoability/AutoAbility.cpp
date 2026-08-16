#include "pch-il2cpp.h"
#include "AutoAbility.h"
#include "AutoAim.h"
#include "Il2CppResolver.h"
#include "LocalPlayer.h"
#include "core/runtime/MemRead.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <windows.h>

namespace AutoAbility {
namespace {

std::atomic<bool>  g_enabled         { false };
std::atomic<float> g_mpThresholdPct  { 50.f };
std::atomic<int>   g_cooldownMs      { 250 };
std::atomic<int>   g_hotkey          { 1 };
std::atomic<bool>  g_targetingOn     { false };
std::atomic<int>   g_targetMode      { 0 };  // 0=AimAtEnemy, 1=Self

// Hotkey path (lean default).
using UseInvByHotkeyFn = void(__fastcall*)(void* eqMgr, int32_t hotkey, void* methodInfo);
// Targeted path (per-class). Note Vector2 is passed by-value in the IL2CPP
// ABI — its two floats occupy two register slots on x64 Windows.
struct Vec2 { float x; float y; };
using UseInvItemFn = bool(__fastcall*)(
    void* eqMgr, void* player, int32_t slot, int32_t kind,
    Vec2 pos, bool a, bool b, void* methodInfo);

UseInvByHotkeyFn s_fnHotkey       = nullptr;
UseInvItemFn     s_fnTargeted     = nullptr;
uint32_t         s_eqMgrFieldOff  = 0;   // FKALGHJIADI.AJJJBDBNBLM offset
bool             s_resolved       = false;
ULONGLONG        s_lastFireMs     = 0;

void ResolveOnce()
{
    if (s_resolved) return;
    Resolver::Protection::safe_call([&]() {
        Il2CppClass* em = Resolver::FindClass("DecaGames.RotMG.Managers.Equipment", "EquipmentManager");
        if (!em) em = Resolver::FindClassLoose("PNBNDBIPENP");
        if (em) {
            const MethodInfo* miHk = il2cpp_class_get_method_from_name(em, "UseInventoryItemByHotkey", 1);
            if (miHk && miHk->methodPointer)
                s_fnHotkey = reinterpret_cast<UseInvByHotkeyFn>(miHk->methodPointer);
            const MethodInfo* miUse = il2cpp_class_get_method_from_name(em, "UseInventoryItem", 6);
            if (miUse && miUse->methodPointer)
                s_fnTargeted = reinterpret_cast<UseInvItemFn>(miUse->methodPointer);
        }
        Il2CppClass* fk = Resolver::FindClassLoose("FKALGHJIADI");
        if (fk) {
            FieldInfo* eqf = il2cpp_class_get_field_from_name(fk, "AJJJBDBNBLM");
            if (eqf) s_eqMgrFieldOff = static_cast<uint32_t>(il2cpp_field_get_offset(eqf));
        }
    });
    // Resolved when we have AT LEAST the hotkey path + the eq-mgr offset.
    // Targeted path is optional — if its method-info isn't found we fall
    // back to hotkey-only and the targeting toggle becomes a no-op.
    if (s_fnHotkey && s_eqMgrFieldOff) s_resolved = true;
}

} // namespace

bool IsEnabled() { return g_enabled.load(std::memory_order_relaxed); }

void Tick()
{
    if (!IsEnabled()) return;
    ResolveOnce();
    if (!s_fnHotkey || !s_eqMgrFieldOff) return;

    const ULONGLONG now = GetTickCount64();
    const int cd = g_cooldownMs.load(std::memory_order_relaxed);
    if (now - s_lastFireMs < static_cast<ULONGLONG>(cd)) return;

    const float   curMp = LocalPlayer::GetCurMpF();
    const int32_t maxMp = LocalPlayer::GetMaxMP();
    if (maxMp <= 0 || curMp <= 0.f) return;
    const float pct = curMp / static_cast<float>(maxMp) * 100.f;
    if (pct < g_mpThresholdPct.load(std::memory_order_relaxed)) return;

    void* lp = LocalPlayer::GetPtr();
    if (!lp) return;
    void* eqMgr = Mem::ReadPtr(lp, s_eqMgrFieldOff);
    if (!eqMgr) return;

    const int hk = g_hotkey.load(std::memory_order_relaxed);
    const bool targeting = g_targetingOn.load(std::memory_order_relaxed) && s_fnTargeted != nullptr;

    if (targeting) {
        // Per-class targeting — compute aim point based on mode.
        Vec2 target{ LocalPlayer::GetX(), LocalPlayer::GetY() };
        const int mode = g_targetMode.load(std::memory_order_relaxed);
        if (mode == 0) {
            // AimAtEnemy: use AutoAim's resolved target if active, else
            // fall back to self-target (safer than firing into the void).
            float ax = 0.f, ay = 0.f;
            AutoAim::GetAimTarget(ax, ay);
            if (std::isfinite(ax) && std::isfinite(ay) && (ax != 0.f || ay != 0.f)) {
                target.x = ax;
                target.y = ay;
            }
        }
        // mode 1 = Self — target stays at player position (set above)

        // UseInventoryItem signature:
        //   (eqMgr, player, slot, kind, Vector2 pos, bool ?, bool ?)
        // We use kind=0 (default), bools=false (matches game's own ability
        // press path observed in PlayerTAB's inventory-slot click).
        Resolver::Protection::safe_call([&]() {
            s_fnTargeted(eqMgr, lp, hk, 0, target, false, false, nullptr);
        });
    } else {
        // Hotkey-only path (lean default).
        Resolver::Protection::safe_call([&]() {
            s_fnHotkey(eqMgr, hk, nullptr);
        });
    }
    s_lastFireMs = now;
}

void SetEnabled(bool on)
{
    g_enabled.store(on, std::memory_order_relaxed);
    if (on) ResolveOnce();
}

void SetMpThresholdPct(float pct)
{
    if (!(pct >= 1.f))  pct = 1.f;
    if (pct > 99.f)     pct = 99.f;
    g_mpThresholdPct.store(pct, std::memory_order_relaxed);
}

void SetCooldownMs(int ms)
{
    if (ms < 100)  ms = 100;
    if (ms > 2000) ms = 2000;
    g_cooldownMs.store(ms, std::memory_order_relaxed);
}

void SetHotkey(int hotkey)
{
    if (hotkey < 0)  hotkey = 0;
    if (hotkey > 15) hotkey = 15;
    g_hotkey.store(hotkey, std::memory_order_relaxed);
}

void SetTargetingEnabled(bool on) { g_targetingOn.store(on, std::memory_order_relaxed); }
bool GetTargetingEnabled()        { return g_targetingOn.load(std::memory_order_relaxed); }

void SetTargetMode(int mode)
{
    if (mode < 0) mode = 0;
    if (mode > 1) mode = 1;
    g_targetMode.store(mode, std::memory_order_relaxed);
}
int GetTargetMode() { return g_targetMode.load(std::memory_order_relaxed); }

} // namespace AutoAbility
