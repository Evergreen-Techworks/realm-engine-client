#include "pch-il2cpp.h"

#include "features/combat/autoaim/modes/AutoFire.h"
#include "features/combat/autoaim/shoot/ShootRuntime.h"
#include "BootGate.h"
#include "GameState.h"
#include "LocalPlayer.h"
#include "keybinds.h"
#include "DbgFileLog.h"
#include <imgui/imgui.h>

#include <Windows.h>
#include <atomic>
#include <cstdint>
#include <vector>

namespace {

// ── Settings (relaxed atomics — written from the IPC/UI threads, read here) ───
static std::atomic<bool> s_enabled{ false };
static std::atomic<int>  s_hotkeyVk{ 0 };
static std::atomic<int>  s_slot{ 0 };
static std::atomic<bool> s_autoEngage{ false };

// ── Diagnostics (render-thread writes, UI reads) ─────────────────────────────
static std::atomic<bool>     s_diagResolved{ false };
static std::atomic<bool>     s_diagGated{ false };
static std::atomic<bool>     s_diagEngaged{ false };
static std::atomic<bool>     s_diagCanShoot{ false };
static std::atomic<uint32_t> s_shotsSent{ 0 };
static std::atomic<uint32_t> s_framesEngaged{ 0 };

// ── Render-thread-only bookkeeping ───────────────────────────────────────────
static uint64_t  s_frame            = 0;   // monotonic Tick counter (one per Present)
static uint64_t  s_lastAttemptFrame = ~0ull;
static ULONGLONG s_lastGateLogMs    = 0;
static ULONGLONG s_lastBindLogMs    = 0;
static ULONGLONG s_lastAliveLogMs   = 0;
static int       s_lastEngaged      = -1;  // -1 = no edge observed yet

// Same three lines as FeatureRuntime's anonymous-namespace
// IsCurrentProcessForeground (features/runtime/FeatureRuntime.cpp:88-94).
// Duplicated deliberately rather than widening FeatureRuntime's public surface.
static bool IsCurrentProcessForeground()
{
    HWND hwnd = GetForegroundWindow();
    if (!hwnd) return false;
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    return pid == GetCurrentProcessId();
}

// Transition-only edge logging. Never called per-frame while the state holds,
// so the trace gets exactly one line per press and one per release.
static void SetEngaged(bool engaged, const char* reason)
{
    s_diagEngaged.store(engaged, std::memory_order_relaxed);
    if (!engaged) s_diagCanShoot.store(false, std::memory_order_relaxed);

    const int now = engaged ? 1 : 0;
    if (s_lastEngaged == now) return;
    s_lastEngaged = now;
    if (engaged) {
        DBG_FILE_LOG("[AutoFire] ENGAGED vk=" << s_hotkeyVk.load(std::memory_order_relaxed)
                     << " auto=" << (s_autoEngage.load(std::memory_order_relaxed) ? 1 : 0)
                     << " slot=" << s_slot.load(std::memory_order_relaxed));
    } else {
        DBG_FILE_LOG("[AutoFire] disengaged reason=" << (reason ? reason : "unknown")
                     << " shots=" << s_shotsSent.load(std::memory_order_relaxed));
    }
}

// AutoFire owns no hook, so this heartbeat is the only proof it is running.
static void LogAlive()
{
    const ULONGLONG now = GetTickCount64();
    if (now - s_lastAliveLogMs < 30000ULL) return;
    s_lastAliveLogMs = now;
    DBG_FILE_LOG("[AutoFire] alive engaged=" << (s_diagEngaged.load(std::memory_order_relaxed) ? 1 : 0)
                 << " resolved=" << (s_diagResolved.load(std::memory_order_relaxed) ? 1 : 0)
                 << " shots=" << s_shotsSent.load(std::memory_order_relaxed));
}

} // namespace

namespace AutoFire {

void Tick(bool menuOpen)
{
    ++s_frame;

    if (!s_enabled.load(std::memory_order_relaxed)) {
        s_autoEngage.store(false, std::memory_order_relaxed);
        s_diagGated.store(false, std::memory_order_relaxed);
        SetEngaged(false, "disabled");
        return;
    }

    LogAlive();

    if (!BootGate::FeatureAllowed("AutoFire")) {
        s_diagGated.store(true, std::memory_order_relaxed);
        SetEngaged(false, "bootgate");
        const ULONGLONG now = GetTickCount64();
        if (now - s_lastGateLogMs >= 30000ULL) {
            s_lastGateLogMs = now;
            DBG_FILE_LOG("[AutoFire] blocked by BootGate (stale anchors) — not firing");
        }
        return;
    }
    s_diagGated.store(false, std::memory_order_relaxed);

    const bool resolved = ShootRuntime::EnsureResolved();
    s_diagResolved.store(resolved, std::memory_order_relaxed);
    if (!resolved) {
        SetEngaged(false, "unresolved");
        const ULONGLONG now = GetTickCount64();
        if (now - s_lastBindLogMs >= 30000ULL) {
            s_lastBindLogMs = now;
            DBG_FILE_LOG("[AutoFire] shoot methods not bound yet — not firing");
        }
        return;
    }

    const bool autoEngaged = s_autoEngage.load(std::memory_order_relaxed);
    const int  vk          = s_hotkeyVk.load(std::memory_order_relaxed);
    bool engaged = autoEngaged
                || (vk != 0
                    && IsCurrentProcessForeground()
                    && (GetAsyncKeyState(vk) & 0x8000) != 0);

    // Never fire off a keystroke the player is typing into the menu. An
    // auto-engage (plan 89) is programmatic, so it is not affected.
    if (menuOpen && !autoEngaged) engaged = false;

    if (!engaged) {
        SetEngaged(false, menuOpen ? "menu-open" : "key-up");
        return;
    }

    SetEngaged(true, nullptr);
    s_framesEngaged.fetch_add(1, std::memory_order_relaxed);

    void* player = GameState::GetLocalPtr();
    if (!player) { SetEngaged(false, "no-local"); return; }
    if (LocalPlayer::GetHP() <= 0) { SetEngaged(false, "dead"); return; }

    // At most one shoot attempt per Present frame. A frame counter, not a
    // wall-clock timer — the game's own outCanShoot gate sets the cadence.
    if (s_frame == s_lastAttemptFrame) return;
    s_lastAttemptFrame = s_frame;

    float angle    = 0.f;
    bool  canShoot = false;
    if (!ShootRuntime::TryComputeShootAngle(player, static_cast<uint8_t>(s_slot.load(std::memory_order_relaxed)),
                                            angle, canShoot))
        return;

    s_diagCanShoot.store(canShoot, std::memory_order_relaxed);
    if (!canShoot) return;   // the game said no — never force it

    if (!ShootRuntime::CallShootWithAngle(player, angle)) return;
    s_shotsSent.fetch_add(1, std::memory_order_relaxed);
}

void SetEnabled(bool on)
{
    s_enabled.store(on, std::memory_order_relaxed);
    if (!on) s_autoEngage.store(false, std::memory_order_relaxed);
}
bool IsEnabled() { return s_enabled.load(std::memory_order_relaxed); }

void SetHotkeyVk(int vk) { s_hotkeyVk.store(vk, std::memory_order_relaxed); }
int  GetHotkeyVk()       { return s_hotkeyVk.load(std::memory_order_relaxed); }

void SetSlot(int slot)
{
    if (slot < 0) slot = 0;
    if (slot > 3) slot = 3;
    s_slot.store(slot, std::memory_order_relaxed);
}
int GetSlot() { return s_slot.load(std::memory_order_relaxed); }

void SetAutoEngage(bool on) { s_autoEngage.store(on, std::memory_order_relaxed); }
bool IsAutoEngaged()        { return s_autoEngage.load(std::memory_order_relaxed); }

Diag GetDiag()
{
    Diag d;
    d.resolved      = s_diagResolved.load(std::memory_order_relaxed);
    d.gated         = s_diagGated.load(std::memory_order_relaxed);
    d.engaged       = s_diagEngaged.load(std::memory_order_relaxed);
    d.lastCanShoot  = s_diagCanShoot.load(std::memory_order_relaxed);
    d.shotsSent     = s_shotsSent.load(std::memory_order_relaxed);
    d.framesEngaged = s_framesEngaged.load(std::memory_order_relaxed);
    return d;
}

void RenderSettings()
{
    ImGui::TextColored(ImVec4(1.f, 0.75f, 0.35f, 1.f), "AUTOFIRE");
    ImGui::Spacing();

    bool on = IsEnabled();
    if (ImGui::Checkbox("Enable##afEnable", &on))
        SetEnabled(on);
    ImGui::SameLine(); ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Hold the bound key to fire continuously. Drives the game's own shoot\nentry, so its rate limit / MP / silence checks all still apply.");

    ImGui::Spacing();
    ImGui::PushItemWidth(180.f);

    // Hotkey picker — same key table the menu toggle uses (core/config/keybinds.h).
    const std::vector<uint8_t> keys = KeyBinds::GetValidKeys();
    const int  vk      = GetHotkeyVk();
    const char* vkName = (vk == 0) ? "NONE" : KeyBinds::ToString(static_cast<uint8_t>(vk));
    if (ImGui::BeginCombo("Hotkey##afHotkey", vkName)) {
        if (ImGui::Selectable("NONE", vk == 0)) SetHotkeyVk(0);
        for (const uint8_t k : keys) {
            const bool sel = (static_cast<int>(k) == vk);
            if (ImGui::Selectable(KeyBinds::ToString(k), sel)) SetHotkeyVk(static_cast<int>(k));
            if (sel) ImGui::SetItemDefaultFocus();
        }
        ImGui::EndCombo();
    }
    ImGui::SameLine(); ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Unbound (NONE) never fires.");

    int slot = GetSlot();
    if (ImGui::InputInt("Weapon slot##afSlot", &slot))
        SetSlot(slot);
    ImGui::SameLine(); ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Diagnostic: the slot index passed to the game's ComputeShootAngle.\n0 is the weapon slot in every observed build; 0..3 for correction\nwithout a rebuild.");

    ImGui::PopItemWidth();

    ImGui::Spacing();
    const Diag d = GetDiag();
    ImGui::TextDisabled("resolved=%d gated=%d engaged=%d canShoot=%d shots=%u",
                        d.resolved ? 1 : 0, d.gated ? 1 : 0,
                        d.engaged ? 1 : 0, d.lastCanShoot ? 1 : 0,
                        d.shotsSent);
}

} // namespace AutoFire
