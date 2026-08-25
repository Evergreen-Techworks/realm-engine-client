#include "pch-il2cpp.h"
#include "CombatTAB.h"
#include "features/combat/autoaim/ui/FeatAutoAim.h"
#include "features/combat/autoaim/ui/FeatMagnetAim.h"
#include "features/combat/autoaim/modes/KillAura.h"
#include "features/combat/autoaim/modes/AutoFire.h"
#include "features/combat/autoaim/modes/AutoBreakWalls.h"
#include "features/projectiles/ShotOrigin.h"
#include "features/projectiles/ShotOriginHook.h"
#include "AutoNexus.h"
#include "LocalPlayer.h"
#include "ProjectileTracking.h"
#include <imgui/imgui.h>

namespace CombatTAB {

static bool g_muzzleWeaponRangeDebug = false;

bool MuzzleWeaponRangeDebugOverlayEnabled()
{
    return g_muzzleWeaponRangeDebug;
}

void Tick(bool menuVisible)
{
    FeatAutoAim::Tick(menuVisible);
    FeatMagnetAim::Tick(menuVisible);
    KillAura::Tick();
    AutoFire::Tick(menuVisible);
    AutoBreakWalls::Tick();

    const bool nexusOn = FeatAutoNexus::ConsumesLocalPlayer();

    {
        static bool s_wasConsuming = false;
        if (nexusOn && !s_wasConsuming)        LocalPlayer::AddConsumer();
        else if (!nexusOn && s_wasConsuming)   LocalPlayer::RemoveConsumer();
        s_wasConsuming = nexusOn;
    }

    if (nexusOn)
        FeatAutoNexus::Tick();
}

// AutoAbility was an experimental phase-2 feature trimmed in the production
// cleanup. The shims below keep the IpcBridge entry points alive (so legacy
// "setFeature autoAbility..." messages no-op gracefully) without re-introducing
// the dead code path.
void RefreshAutoAbilityAimVisualCache() {}
bool GetAutoAbilityAimVisual(float&, float&) { return false; }
void SetAutoAbility(bool) {}
void SetAbilityMpPct(float) {}
void SetWizardAbilityTargetMode(int) {}

void Render()
{
    ImGui::Spacing();
    ImGui::TextColored(ImVec4(1.f, 0.45f, 0.35f, 1.f), "COMBAT");
    ImGui::Separator();
    ImGui::Spacing();

    FeatAutoAim::Render();

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    FeatMagnetAim::Render();

    ImGui::Spacing();
    ImGui::TextUnformatted("Local shot spawn offset (tiles along aim)");
    const bool magnetAimOn = FeatMagnetAim::IsEnabled();
    ImGui::BeginDisabled(magnetAimOn);
    ImGui::PushItemWidth(220.f);
    float muzzle = ProjectileTracking::GetLocalPlayerMuzzleOffsetTiles();
    if (ImGui::SliderFloat("##muzzleTiles", &muzzle, 0.3f, 2.225f, "%.3f")) {
        ProjectileTracking::SetLocalPlayerMuzzleOffsetTiles(muzzle);
    }
    ImGui::PopItemWidth();
    ImGui::SameLine();
    if (ImGui::Button("Reset##muzzleTiles")) {
        ProjectileTracking::SetLocalPlayerMuzzleOffsetTiles(0.3f);
    }
    ImGui::EndDisabled();
    if (magnetAimOn)
        ImGui::TextDisabled("Manual spawn offset is overridden while Magnet Aim is enabled.");
    ImGui::TextDisabled("Killaura is independent of this: it moves the spawned bullet itself.");
    ImGui::TextDisabled("Vanilla ~0.3; at 0.3 the hook skips retargeting (no extra trig).");

    const char* originName = "?";
    switch (ShotOrigin::LastSource()) {
        case ShotOrigin::Source::Vanilla:  originName = "VANILLA";  break;
        case ShotOrigin::Source::Muzzle:   originName = "MUZZLE";   break;
        case ShotOrigin::Source::Magnet:   originName = "MAGNET";   break;
        case ShotOrigin::Source::KillAura: originName = "KILLAURA"; break;
    }
    ImGui::TextDisabled("Local spawn origin: %s", originName);

    // Killaura no longer shows up as a spawn "origin" — it moves the bullet from
    // the entity position setter instead (features/projectiles/ShotOriginHook.h).
    // rewrites is the number that matters: arms without rewrites means killaura
    // is aiming but the bullet is not being moved, so nothing takes damage.
    const ShotOriginHook::Stats ka = ShotOriginHook::GetStats();
    ImGui::TextDisabled("Killaura origin hook: %s  arms=%u rewrites=%u drops=%u",
                        ka.installed ? "INSTALLED" : (ka.refused ? "REFUSED" : "not installed"),
                        ka.arms, ka.rewrites, ka.drops);
    ImGui::Checkbox("Debug: weapon range ring + last spawn dot##muzzleDbg", &g_muzzleWeaponRangeDebug);
    ImGui::TextDisabled("Uses AutoAim range + last local SpawnProjectile world position.");

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    FeatAutoNexus::Render();

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    KillAura::RenderSettings();

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    AutoFire::RenderSettings();

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    AutoBreakWalls::RenderSettings();
}

} // namespace CombatTAB
