#pragma once
#include "UDodgeTypes.h"

namespace UDodge { namespace Sensors {

// Build the per-frame snapshot (game-update thread only).
void Build(Snapshot& out, float playerX, float playerY, const Settings& settings);

// Host environment probes (match the Env fn-pointer signatures).
bool IsHazardAt(float worldX, float worldY);
bool CanOccupy(float worldX, float worldY, bool safeWalk);

} } // namespace UDodge::Sensors
