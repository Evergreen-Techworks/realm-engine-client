#pragma once
#include <cstdint>
namespace TestTAB {
// The mode numbers the feature command carries (gui/tabs/TestTAB.h). The harness only
// ever runs the unified engine; UDodge's decision telemetry prints the mode.
enum class DodgeMode : int { Off = 0, XDodge = 1, RolloutGrid = 2, RolloutQuad = 3,
                             ZDodge = 4, RePP = 5, PJDodge = 6, UDodge = 7 };
DodgeMode GetDodgeMode();
void ReadDodgePlayerStats(int32_t& hp, int32_t& maxHp, float& spd, float& tilesPerSec);
bool IsWalkPositionBlocked(float cx, float cy);
bool IsWalkCircleBlocked(float cx, float cy);
}
