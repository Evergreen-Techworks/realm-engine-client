#include "pch-il2cpp.h"
#include "FeatAutoAim.h"
#include "AutoAim.h"
#include "ProjNoclip.h"
#include "FeatureState.h"
#include <imgui/imgui.h>
#include <cstdio>
#include <cstdlib>

namespace CombatTAB {
namespace FeatAutoAim {

static bool  s_aimEnabled          = false;
static int   s_aimMode             = 0;
static bool  s_noclipEnabled       = false;
static bool  s_shootInvulnerable   = false;
static bool  s_prioritizeBosses    = false;
static bool  s_ignoreWalls         = true;
static bool  s_ignoreScenery       = true;
static bool  s_reverseCultStaff    = true;
static bool  s_offsetColossusSword = false;
static bool  s_shootWhileStealthed = true;
static bool  s_mouseBoundingOn     = true;
static float s_mouseBoundingRange  = 2.f;
static float s_rangeLeadBias       = 1.f;

// Phase-skip list — editable in the UI; stored as a fixed-capacity array of raw ints.
static constexpr int kMaxSkipTypes = 16;
static int32_t s_skipTypes[kMaxSkipTypes] = {};
static int     s_skipCount = 0;
static char    s_skipInputBuf[32] = {};

void Tick(bool /*menuOpen*/)
{
    s_aimEnabled   = FeatureState::GetAutoAimEnabled();
    s_aimMode      = FeatureState::GetAutoAimMode();
    s_noclipEnabled = ProjNoclip::IsEnabled();

    s_shootInvulnerable   = AutoAim::IsShootInvulnerable();
    s_prioritizeBosses    = AutoAim::IsPrioritizeBosses();
    s_ignoreWalls         = AutoAim::IsIgnoreWalls();
    s_ignoreScenery       = AutoAim::IsIgnoreScenery();
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
        FeatureState::SetAutoAimEnabled(s_aimEnabled);

    ImGui::Spacing();
    ImGui::TextDisabled("Aim mode");

    if (ImGui::RadioButton("Closest to player##aaMode0", s_aimMode == 0)) {
        s_aimMode = 0; FeatureState::SetAutoAimMode(0);
        AutoAim::SetAimMode(TargetSelector::Mode::ClosestToPlayer);
    }
    if (ImGui::RadioButton("Highest HP##aaMode1", s_aimMode == 1)) {
        s_aimMode = 1; FeatureState::SetAutoAimMode(1);
        AutoAim::SetAimMode(TargetSelector::Mode::HighestHP);
    }
    if (ImGui::RadioButton("Closest to mouse##aaMode2", s_aimMode == 2)) {
        s_aimMode = 2; FeatureState::SetAutoAimMode(2);
        AutoAim::SetAimMode(TargetSelector::Mode::ClosestToMouse);
    }
    if (ImGui::RadioButton("Locked target##aaMode3", s_aimMode == 3)) {
        s_aimMode = 3; FeatureState::SetAutoAimMode(3);
        AutoAim::SetAimMode(TargetSelector::Mode::Locked);
    }
    if (s_aimMode == 3) {
        ImGui::Indent();
        const int32_t lockedId = AutoAim::GetAimFocusEnemyId();
        if (lockedId > 0)
            ImGui::TextColored(ImVec4(0.4f, 1.f, 0.5f, 1.f), "Locked on id %d", lockedId);
        else
            ImGui::TextDisabled("No lock — aim at an enemy while in another mode first");
        if (ImGui::Button("Lock current target##aaLock")) {
            const int32_t cur = AutoAim::GetAimFocusEnemyId();
            if (cur > 0) AutoAim::SetLockTarget(cur);
        }
        if (ImGui::Button("Clear lock##aaClearLock")) {
            AutoAim::SetLockTarget(-1);
            AutoAim::SetAimMode(TargetSelector::Mode::ClosestToPlayer);
            s_aimMode = 0;
        }
        ImGui::Unindent();
    }

    ImGui::Spacing();
    ImGui::TextDisabled("Targeting filters");

    if (ImGui::Checkbox("Shoot invulnerable##aaShootInv", &s_shootInvulnerable))
        AutoAim::SetShootInvulnerable(s_shootInvulnerable);
    ImGui::SameLine(); ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Aims at invulnerable enemies (XML <Invincible/>). They stay below\nregular enemies in priority so non-invuln targets are still picked first.");

    if (ImGui::Checkbox("Prioritize bosses##aaBossOnly", &s_prioritizeBosses))
        AutoAim::SetPrioritizeBosses(s_prioritizeBosses);
    ImGui::SameLine(); ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Quest/boss targets are aimed at first. If no boss is in range,\nregular enemies become valid targets.");

    if (ImGui::Checkbox("Ignore walls / no-HP-bar##aaIgnoreWalls", &s_ignoreWalls))
        AutoAim::SetIgnoreWalls(s_ignoreWalls);
    if (ImGui::Checkbox("Ignore walls / breakables##aaIgnoreScenery", &s_ignoreScenery))
        AutoAim::SetIgnoreScenery(s_ignoreScenery);
    ImGui::SameLine(); ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Skip destructible walls and similar (ObjectProperties.noHealthBar).");

    ImGui::Spacing();
    ImGui::TextDisabled("Phase skip (e.g. O3 invulnerable phases)");
    ImGui::TextWrapped("Object type IDs skipped regardless of invulnerability flags.");

    for (int i = 0; i < s_skipCount; ++i) {
        char lbl[32];
        snprintf(lbl, sizeof(lbl), "%d##skip%d", s_skipTypes[i], i);
        ImGui::Bullet(); ImGui::SameLine();
        ImGui::Text("%d", s_skipTypes[i]); ImGui::SameLine();
        snprintf(lbl, sizeof(lbl), "X##skipRm%d", i);
        if (ImGui::SmallButton(lbl)) {
            for (int j = i; j < s_skipCount - 1; ++j) s_skipTypes[j] = s_skipTypes[j + 1];
            --s_skipCount;
            AutoAim::SetPhaseSkipTypes(s_skipCount > 0 ? s_skipTypes : nullptr, s_skipCount);
        }
    }
    if (s_skipCount < kMaxSkipTypes) {
        ImGui::PushItemWidth(120.f);
        ImGui::InputText("##skipInput", s_skipInputBuf, sizeof(s_skipInputBuf),
                         ImGuiInputTextFlags_CharsDecimal);
        ImGui::PopItemWidth();
        ImGui::SameLine();
        if (ImGui::SmallButton("Add##skipAdd")) {
            const int32_t v = static_cast<int32_t>(atoi(s_skipInputBuf));
            if (v > 0) {
                s_skipTypes[s_skipCount++] = v;
                AutoAim::SetPhaseSkipTypes(s_skipTypes, s_skipCount);
                s_skipInputBuf[0] = '\0';
            }
        }
    }

    ImGui::Spacing();
    ImGui::TextDisabled("Weapon-specific");
    if (ImGui::Checkbox("Reverse Cult Staff##aaRevCult", &s_reverseCultStaff))
        AutoAim::SetReverseCultStaff(s_reverseCultStaff);
    ImGui::SameLine(); ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Staff of Unholy Sacrifice: add 180\xc2\xb0 to aim (Cultist Fire Shot).");

    if (ImGui::Checkbox("Offset Colossus Sword##aaColOff", &s_offsetColossusSword))
        AutoAim::SetOffsetColossusSword(s_offsetColossusSword);
    ImGui::SameLine(); ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Sword of the Colossus: reserved \xe2\x80\x94 exact offset not yet extracted.");

    if (ImGui::Checkbox("Shoot while stealthed##aaStealthShoot", &s_shootWhileStealthed))
        AutoAim::SetShootWhileStealthed(s_shootWhileStealthed);
    ImGui::SameLine(); ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("When off, auto-aim does nothing while Invisible.");

    ImGui::Spacing();
    ImGui::TextDisabled("Mouse distance (closest-to-mouse)");
    if (ImGui::Checkbox("Clamp search to mouse radius##aaMouseBound", &s_mouseBoundingOn))
        AutoAim::SetMouseBoundingEnabled(s_mouseBoundingOn);
    ImGui::BeginDisabled(!s_mouseBoundingOn || s_aimMode != 2);
    ImGui::PushItemWidth(180.f);
    if (ImGui::SliderFloat("Mouse radius (tiles)##aaMouseBoundR", &s_mouseBoundingRange, 1.f, 15.f, "%.2f"))
        AutoAim::SetMouseBoundingRange(s_mouseBoundingRange);
    ImGui::PopItemWidth();
    ImGui::EndDisabled();

    ImGui::Spacing();
    ImGui::TextDisabled("Range lead bias");
    ImGui::PushItemWidth(180.f);
    if (ImGui::SliderFloat("Lead bias (tiles)##aaRangeLead", &s_rangeLeadBias, 0.f, 5.f, "%.2f"))
        AutoAim::SetRangeLeadBias(s_rangeLeadBias);
    ImGui::PopItemWidth();
    ImGui::SameLine(); ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Extra tiles added to weapon range for aim decisions.\nStarts facing/leading enemies before your shots can connect.");

    if (s_aimEnabled) {
        ImGui::Indent();
        ImGui::Spacing();
        if (AutoAim::HasTarget()) {
            float tx = 0.f, ty = 0.f;
            AutoAim::GetAimTarget(tx, ty);
            ImGui::TextColored(ImVec4(0.4f, 1.f, 0.5f, 1.f),
                "Target: %.2f, %.2f  (id %d)",
                static_cast<double>(tx), static_cast<double>(ty),
                AutoAim::GetAimFocusEnemyId());
        } else {
            ImGui::TextDisabled("No target");
        }
        const WeaponProfile& wp = AutoAim::GetWeaponProfile();
        if (wp.speedRaw > 0.f || wp.lifetimeMs > 0.f) {
            ImGui::TextDisabled("Proj: speed %.0f  life %.0fms  range %.2f tiles",
                static_cast<double>(wp.speedRaw),
                static_cast<double>(wp.lifetimeMs),
                static_cast<double>(wp.rangeTiles));
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

    if (!ProjNoclip::IsInstalled())
        ImGui::TextColored(ImVec4(1.f, 0.6f, 0.2f, 1.f),
            "Hooks not installed \xe2\x80\x94 waiting for IL2CPP class resolution.");

    if (ImGui::Checkbox("Enable proj noclip##pnEnable", &s_noclipEnabled))
        ProjNoclip::SetEnabled(s_noclipEnabled);

    if (ProjNoclip::IsInstalled() && ProjNoclip::IsEnabled())
        ImGui::TextColored(ImVec4(0.4f, 1.f, 0.5f, 1.f), "Active");
    else if (ProjNoclip::IsInstalled())
        ImGui::TextDisabled("Inactive");
}

} // namespace FeatAutoAim
} // namespace CombatTAB
