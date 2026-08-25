#include "pch-il2cpp.h"
#include "AutoAbility.h"
#include "features/combat/autoaim/modes/AutoAim.h"
#include "LocalPlayer.h"
#include "game/actions/ItemUse.h"

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

ULONGLONG s_lastFireMs = 0;

} // namespace

bool IsEnabled() { return g_enabled.load(std::memory_order_relaxed); }

void Tick()
{
    if (!IsEnabled()) return;
    if (!Game::ItemUse::Ready()) return;

    const ULONGLONG now = GetTickCount64();
    const int cd = g_cooldownMs.load(std::memory_order_relaxed);
    if (now - s_lastFireMs < static_cast<ULONGLONG>(cd)) return;

    const float   curMp = LocalPlayer::GetCurMpF();
    const int32_t maxMp = LocalPlayer::GetMaxMP();
    if (maxMp <= 0 || curMp <= 0.f) return;
    const float pct = curMp / static_cast<float>(maxMp) * 100.f;
    if (pct < g_mpThresholdPct.load(std::memory_order_relaxed)) return;

    const int hk = g_hotkey.load(std::memory_order_relaxed);
    const bool targeting = g_targetingOn.load(std::memory_order_relaxed) && Game::ItemUse::TargetedAvailable();

    if (targeting) {
        // Per-class targeting — compute aim point based on mode.
        struct AimPoint { float x; float y; } target{ LocalPlayer::GetX(), LocalPlayer::GetY() };
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

        Game::ItemUse::UseTargeted(hk, target.x, target.y);
    } else {
        // Hotkey-only path (lean default).
        Game::ItemUse::UseByHotkey(hk);
    }
    s_lastFireMs = now;
}

void SetEnabled(bool on)
{
    g_enabled.store(on, std::memory_order_relaxed);
    if (on) (void)Game::ItemUse::Ready();
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
