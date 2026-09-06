#include "pch-il2cpp.h"
#include "features/combat/autoaim/ui/FeatMagnetAim.h"

#include <imgui/imgui.h>

namespace CombatTAB {
namespace FeatMagnetAim {

static bool  s_enabled = false;
static constexpr float kVisualOffsetTiles = 2.0f;

void Tick(bool /*menuOpen*/)
{
}

bool IsEnabled()
{
    return s_enabled;
}

float GetVisualOffsetTiles()
{
    return kVisualOffsetTiles;
}

void Render()
{
    ImGui::TextColored(ImVec4(0.5f, 0.95f, 0.65f, 1.f), "MAGNET AIM");
    ImGui::Spacing();

    ImGui::Checkbox("Enable##magnetAimEnable", &s_enabled);
    ImGui::TextDisabled("Internal-only visual path for local player projectiles.");
    ImGui::TextDisabled("Moves the local SpawnProjectile origin %.1f tiles toward the AutoAim target when one exists.", static_cast<double>(kVisualOffsetTiles));
    ImGui::TextDisabled("Fallback when no AutoAim target exists: %.1f tiles along the fired angle.", static_cast<double>(kVisualOffsetTiles));
}

} // namespace FeatMagnetAim
} // namespace CombatTAB
