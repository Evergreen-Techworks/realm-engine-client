// Purpose: applies feature state changes on the game/runtime side once the IPC
// bridge has accepted commands and stored them in FeatureState.

// Helpful notes:
// - FeatureState is the thread-safe handoff point from IPC/control code.
// - This file talks to live gameplay systems, GUI tabs, hooks, and services.
// - ApplyOverrides is called repeatedly, so each helper caches the last applied
//   values to avoid reapplying unchanged settings every frame.
// - Hotkey polling is gated to the foreground game process before firing events.


#include "pch-il2cpp.h"
#include "FeatureRuntime.h"
#include "FeatureState.h"
#include "FloatingTextService.h"
#include "GameState.h"
#include "AutoAim.h"
#include "ProjNoclip.h"
#include "Noclip.h"
#include "gui/tabs/TestTAB.h"
#include "gui/tabs/CombatTab/CombatTAB.h"
#include "gui/tabs/CameraTAB.h"
#include "DangerPlanner.h"

#include <limits>
#include <climits>

namespace {

    void ApplyAutoAimFeatureState()
    {
        static int s_lastEnabled = -1, s_lastMode = -1;
        const int enabled = FeatureState::GetAutoAimEnabled() ? 1 : 0;
        if (enabled != s_lastEnabled) { s_lastEnabled = enabled; AutoAim::SetEnabled(enabled != 0); }
        const int aimMode = FeatureState::GetAutoAimMode();
        if (aimMode != s_lastMode) {
            s_lastMode = aimMode;
            AutoAim::AimMode resolved = AutoAim::AimMode::ClosestToPlayer;
            if (aimMode == 1)      resolved = AutoAim::AimMode::HighestHP;
            else if (aimMode == 2) resolved = AutoAim::AimMode::ClosestToMouse;
            AutoAim::SetAimMode(resolved);
        }
    }

    void ApplyProjectileNoclipFeatureState()
    {
        static int s_lastEnabled = -1;
        const int enabled = FeatureState::GetProjectileNoclipEnabled() ? 1 : 0;
        if (enabled != 0 && !ProjNoclip::IsInstalled()) ProjNoclip::Install();
        if (enabled != s_lastEnabled || ProjNoclip::IsEnabled() != (enabled != 0)) { s_lastEnabled = enabled; ProjNoclip::SetEnabled(enabled != 0); }
    }

    void ApplyAutoDodgeFeatureState()
    {
        static int s_lastMode = INT32_MIN;
        static float s_lastHorizonMs = -1.f;
        int dodgeMode = FeatureState::GetAutoDodgeMode();
        if (dodgeMode != s_lastMode) { s_lastMode = dodgeMode; TestTAB::SetDodgeModeWithEnter(static_cast<TestTAB::DodgeMode>(dodgeMode)); }
        if (dodgeMode != static_cast<int>(TestTAB::DodgeMode::Off)) DangerPlanner::TryInstall();
        float horizonMs = FeatureState::GetAutoDodgeHorizonMs();
        if (horizonMs != s_lastHorizonMs) { s_lastHorizonMs = horizonMs; TestTAB::SetDodgeLookaheadMs(horizonMs); }
    }

    void ApplyAutoAbilityFeatureState()
    {
        static int s_lastEnabled = -1, s_lastWizMode = INT32_MIN;
        static float s_lastMpPct = -1.f;
        const int enabled = FeatureState::GetAutoAbilityEnabled() ? 1 : 0;
        const float mpPct = FeatureState::GetAutoAbilityMpPct();
        const int wizMode = FeatureState::GetAutoAbilityWizardMode();
        if (enabled != s_lastEnabled) { s_lastEnabled = enabled; CombatTAB::SetAutoAbility(enabled != 0); }
        if (mpPct != s_lastMpPct) { s_lastMpPct = mpPct; CombatTAB::SetAbilityMpPct(mpPct); }
        if (wizMode != s_lastWizMode) { s_lastWizMode = wizMode; CombatTAB::SetWizardAbilityTargetMode(wizMode); }
    }

    bool IsCurrentProcessForeground()
    {
        HWND hwnd = GetForegroundWindow();
        if (!hwnd) return false;
        DWORD pid = 0;
        GetWindowThreadProcessId(hwnd, &pid);
        return pid == GetCurrentProcessId();
    }

    static bool IsHotkeyDown(int active, int vk) { return active != 0 && vk != 0 && IsCurrentProcessForeground() && ((GetAsyncKeyState(vk) & 0x8000) != 0); }

    void ApplyPlayerNoclipFeatureState()
    {
        static int s_lastEnabled = -1;
        static bool s_lastHotkeyDown = false;
        const int active = FeatureState::GetPlayerNoclipActive() ? 1 : 0;
        int enabled = active && FeatureState::GetPlayerNoclipEnabled() ? 1 : 0;
        const int vk = FeatureState::GetPlayerNoclipHotkeyVk();
        const bool hotkeyDown = IsHotkeyDown(active, vk);
        if (hotkeyDown && !s_lastHotkeyDown) {
            enabled = enabled ? 0 : 1;
            FeatureState::SetPlayerNoclipEnabled(enabled != 0);
            FeatureState::SetPendingPlayerNoclipEnabled(enabled);
        }
        s_lastHotkeyDown = hotkeyDown;
        if (enabled != s_lastEnabled) { s_lastEnabled = enabled; Noclip::SetEnabled(enabled != 0); Noclip::SetMode(enabled != 0 ? 1 : 0); }
    }

    void ApplyWalkTargetFeatureState()
    {
        static int   s_lastActive = -1;
        static float s_lastX      = std::numeric_limits<float>::quiet_NaN();
        static float s_lastY      = std::numeric_limits<float>::quiet_NaN();
        const int   walkActive = FeatureState::GetWalkTargetActive() ? 1 : 0;
        const float walkX      = FeatureState::GetWalkTargetX();
        const float walkY      = FeatureState::GetWalkTargetY();
        const bool changed = walkActive != s_lastActive || walkX != s_lastX || walkY != s_lastY;
        if (changed) {
            s_lastActive = walkActive; s_lastX = walkX; s_lastY = walkY;
            TestTAB::SetBotWalkTarget(walkX, walkY, walkActive != 0);
        }
    }

    void ApplyCameraFeatureState()
    {
        static int zoomActive = -1, angleActive = -1, centerActive = -1, angle = INT32_MIN, centered = -1;
        static float zoom = std::numeric_limits<float>::quiet_NaN();
        {
            const int active = FeatureState::GetCameraZoomActive() ? 1 : 0;
            const float value = FeatureState::GetCameraZoomValue();
            if (active != 0 && (active != zoomActive || value != zoom)) { zoomActive = active; zoom = value; CameraTAB::SetZoomValue(value); }
            else if (active == 0) zoomActive = active;
        }
        {
            const int active = FeatureState::GetCameraAngleActive() ? 1 : 0;
            const int value = FeatureState::GetCameraAngleValue();
            if (active != 0 && (active != angleActive || value != angle)) { angleActive = active; angle = value; CameraTAB::SetAngleDegrees(value); }
            else if (active == 0) angleActive = active;
        }
        {
            const int active = FeatureState::GetCameraCenteringActive() ? 1 : 0;
            const int value = FeatureState::GetCameraCentered() ? 1 : 0;
            if (active != 0 && (active != centerActive || value != centered)) { centerActive = active; centered = value; CameraTAB::SetCenteredOnPlayer(value != 0); }
            else if (active == 0) centerActive = active;
        }
    }

} // namespace

bool FeatureRuntime::PollSocketHotkeyEvent()
{
    static bool s_lastHotkeyDown = false;
    const int active = FeatureState::GetSocketHotkeyActive() ? 1 : 0;
    const int vk = FeatureState::GetSocketHotkeyVk();
    const bool hotkeyDown = IsHotkeyDown(active, vk);
    const bool shouldFire = hotkeyDown && !s_lastHotkeyDown;
    s_lastHotkeyDown = hotkeyDown;
    return shouldFire;
}

void FeatureRuntime::ApplyOverrides()
{
    ApplyPlayerNoclipFeatureState();
    if (GameState::GetLocalPtr() == nullptr) return;
    if (GameState::GetWorldMgr() == nullptr) return;
    ApplyAutoAimFeatureState(); ApplyProjectileNoclipFeatureState(); ApplyAutoDodgeFeatureState(); ApplyAutoAbilityFeatureState();
    ApplyWalkTargetFeatureState(); ApplyCameraFeatureState(); FloatingTextService::ApplyPendingPluginText();
}
