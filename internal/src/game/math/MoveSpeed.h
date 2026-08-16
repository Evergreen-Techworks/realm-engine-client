#pragma once
#include <algorithm>
// Flash-parity movement speed. tilesPerSec = 4 + 5.6 * (spd / 75).
namespace GameMath {
    inline float TilesPerSecFromSpd(float spd) { return 4.0f + 5.6f * (spd / 75.0f); }
    inline float SpdFromTilesPerSec(float tps) {
        return std::clamp((tps - 4.0f) / 5.6f * 75.0f, 0.0f, 120.0f);
    }
}
