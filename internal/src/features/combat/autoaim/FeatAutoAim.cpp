#include "pch-il2cpp.h"
#include "FeatAutoAim.h"
#include "AutoAim.h"
#include "ProjNoclip.h"
#include "IpcBridge.h"
#include <imgui/imgui.h>

namespace CombatTAB {
namespace FeatAutoAim {

// Multitool registry AutoAimMode: 0 closest, 1 highest HP, 2 mouse (ExaltKitGUI.SettingsControl).
static bool  s_aimEnabled           = false;
static int   s_aimMode              = 0;
static bool  s_noclipEnabled        = false;
static bool  s_shootInvulnerable    = false;
static bool  s_prioritizeBosses     = false;
static bool  s_ignoreWalls          = true;
static bool  s_reverseCultStaff     = true;
static bool  s_offsetColossusSword  = false;
static bool  s_shootWhileStealthed  = true;
static bool  s_mouseBoundingOn      = true;
static float s_mouseBoundingRange   = 2.f;
static float s_rangeLeadBias        = 1.f;

void Tick(bool /*menuOpen*/)
{
    s_aimEnabled    = IpcBridge_GetAutoAimEnabled();
    s_aimMode       = IpcBridge_GetAutoAimMode();
    s_noclipEnabled = ProjNoclip::IsEnabled();

    s_shootInvulnerable   = AutoAim::IsShootInvulnerable();
    s_prioritizeBosses    = AutoAim::IsPrioritizeBosses();
    s_ignoreWalls         = AutoAim::IsIgnoreWalls();
    s_reverseCultStaff    = AutoAim::IsReverseCultStaff();
    s_offsetColossusSword = AutoAim::IsOffsetColossusSword();
    s_shootWhileStealthed = AutoAim::IsShootWhileStealthed();
    s_mouseBoundingOn     = AutoAim::IsMouseBoundingEnabled();
    s_mouseBoundingRange  = AutoAim::GetMouseBoundingRange();
    s_rangeLeadBias       = AutoAim::GetRangeLeadBias();

    if (!ProjNoclip::IsInstalled())
        ProjNoclip::Install();
}

void Render()
{
    ImGui::TextColored(ImVec4(0.5f, 0.95f, 0.65f, 1.f), "AUTO AIM");
    ImGui::Spacing();

    if (ImGui::Checkbox("Enable##aaEnable", &s_aimEnabled))
        IpcBridge_SetAutoAimEnabled(s_aimEnabled);

    ImGui::Spacing();
    ImGui::TextDisabled("Aim mode (Multitool AutoAimMode)");
    if (ImGui::RadioButton("Closest to player##aaMode0", s_aimMode == 0)) {
        s_aimMode = 0;
        IpcBridge_SetAutoAimMode(0);
        AutoAim::SetAimMode(AutoAim::AimMode::ClosestToPlayer);
    }
    if (ImGui::RadioButton("Highest HP##aaMode1", s_aimMode == 1)) {
        s_aimMode = 1;
        IpcBridge_SetAutoAimMode(1);
        AutoAim::SetAimMode(AutoAim::AimMode::HighestHP);
    }
    if (ImGui::RadioButton("Closest to mouse##aaMode2", s_aimMode == 2)) {
        s_aimMode = 2;
        IpcBridge_SetAutoAimMode(2);
        AutoAim::SetAimMode(AutoAim::AimMode::ClosestToMouse);
    }

    ImGui::Spacing();
    ImGui::TextDisabled("Targeting filters");
    if (ImGui::Checkbox("Shoot invulnerable##aaShootInv", &s_shootInvulnerable))
        AutoAim::SetShootInvulnerable(s_shootInvulnerable);
    ImGui::SameLine();
    ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Aims at invulnerable enemies (XML <Invincible/>). They stay below\nregular enemies in priority so non-invuln targets are still picked first.");

    if (ImGui::Checkbox("Prioritize bosses##aaBossOnly", &s_prioritizeBosses))
        AutoAim::SetPrioritizeBosses(s_prioritizeBosses);
    ImGui::SameLine();
    ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Quest/boss targets are aimed at first. If no boss is in range,\nregular enemies become valid targets (they are no longer skipped).");

    if (ImGui::Checkbox("Ignore walls / no-HP-bar##aaIgnoreWalls", &s_ignoreWalls))
        AutoAim::SetIgnoreWalls(s_ignoreWalls);
    ImGui::SameLine();
    ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Multitool AutoAimIgnoreWalls: skip destructible walls and similar\n(ObjectProperties.noHealthBar).");

    ImGui::Spacing();
    ImGui::TextDisabled("Weapon-specific (Multitool)");
    if (ImGui::Checkbox("Reverse Cult Staff##aaRevCult", &s_reverseCultStaff))
        AutoAim::SetReverseCultStaff(s_reverseCultStaff);
    ImGui::SameLine();
    ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Staff of Unholy Sacrifice: add 180\xc2\xb0 to aim (Cultist Fire Shot).");

    if (ImGui::Checkbox("Offset Colossus Sword##aaColOff", &s_offsetColossusSword))
        AutoAim::SetOffsetColossusSword(s_offsetColossusSword);
    ImGui::SameLine();
    ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Sword of the Colossus: reserved \xe2\x80\x94 exact offset not yet extracted from Multitool DLL.");

    if (ImGui::Checkbox("Shoot while stealthed##aaStealthShoot", &s_shootWhileStealthed))
        AutoAim::SetShootWhileStealthed(s_shootWhileStealthed);
    ImGui::SameLine();
    ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Multitool AutoAimShootWhileStealthed: when off, auto-aim does nothing while Invisible.");

    ImGui::Spacing();
    ImGui::TextDisabled("Mouse distance (closest-to-mouse)");
    if (ImGui::Checkbox("Clamp search to mouse radius##aaMouseBound", &s_mouseBoundingOn))
        AutoAim::SetMouseBoundingEnabled(s_mouseBoundingOn);
    ImGui::BeginDisabled(!s_mouseBoundingOn || s_aimMode != 2);
    ImGui::PushItemWidth(180.f);
    if (ImGui::SliderFloat("AutoAimMouseDist (tiles)##aaMouseBoundR", &s_mouseBoundingRange, 1.f, 15.f, "%.2f"))
        AutoAim::SetMouseBoundingRange(s_mouseBoundingRange);
    ImGui::PopItemWidth();
    ImGui::EndDisabled();

    ImGui::Spacing();
    ImGui::TextDisabled("Range lead bias");
    ImGui::PushItemWidth(180.f);
    if (ImGui::SliderFloat("AutoAimRangeLead (tiles)##aaRangeLead", &s_rangeLeadBias, 0.f, 5.f, "%.2f"))
        AutoAim::SetRangeLeadBias(s_rangeLeadBias);
    ImGui::PopItemWidth();
    ImGui::SameLine();
    ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Extra tiles added to weapon range for aim decisions.\nStarts facing/leading enemies before your shots can connect.");

    if (s_aimEnabled) {
        ImGui::Indent();

        ImGui::Spacing();
        if (AutoAim::HasTarget()) {
            float tx = 0.f, ty = 0.f;
            AutoAim::GetAimTarget(tx, ty);
            ImGui::TextColored(ImVec4(0.4f, 1.f, 0.5f, 1.f),
                "Target: %.2f, %.2f  (id %d)", static_cast<double>(tx), static_cast<double>(ty),
                AutoAim::GetAimFocusEnemyId());
        } else {
            ImGui::TextDisabled("No target");
        }

        {
            const float spd   = AutoAim::GetProjSpeedRaw();
            const float life  = AutoAim::GetProjLifetimeMs();
            const float range = AutoAim::GetProjRangeTiles();
            if (spd > 0.f || life > 0.f) {
                ImGui::TextDisabled("Proj: speed %.0f  life %.0fms  range %.2f tiles",
                    static_cast<double>(spd),
                    static_cast<double>(life),
                    static_cast<double>(range));
            }
        }

        ImGui::Unindent();
    }

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    ImGui::TextColored(ImVec4(0.5f, 0.95f, 0.65f, 1.f), "PROJECTILE NOCLIP");
    ImGui::TextWrapped(
        "Temporarily sets the current tile's collision layer to 37 when the "
        "wall-check fires, causing projectiles to pass through walls. "
        "Matches multitool WeaponModsProjectileNoclip behaviour exactly.");
    ImGui::Spacing();

    if (!ProjNoclip::IsInstalled()) {
        ImGui::TextColored(ImVec4(1.f, 0.6f, 0.2f, 1.f),
            "Hooks not installed \xe2\x80\x94 waiting for IL2CPP class resolution.");
    }

    if (ImGui::Checkbox("Enable proj noclip##pnEnable", &s_noclipEnabled))
        ProjNoclip::SetEnabled(s_noclipEnabled);

    if (ProjNoclip::IsInstalled() && ProjNoclip::IsEnabled()) {
        ImGui::TextColored(ImVec4(0.4f, 1.f, 0.5f, 1.f), "Active");
    } else if (ProjNoclip::IsInstalled()) {
        ImGui::TextDisabled("Inactive");
    }
}

} // namespace FeatAutoAim
} // namespace CombatTAB
