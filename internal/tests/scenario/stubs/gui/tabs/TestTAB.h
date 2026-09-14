#pragma once
#include <cstdint>
namespace TestTAB {
void ReadDodgePlayerStats(int32_t& hp, int32_t& maxHp, float& spd, float& tilesPerSec);
bool IsWalkPositionBlocked(float cx, float cy);
bool IsWalkCircleBlocked(float cx, float cy);
}
