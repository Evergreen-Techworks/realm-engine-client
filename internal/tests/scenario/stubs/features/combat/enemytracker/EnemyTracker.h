#pragma once
#include <cstdint>
#include <vector>
namespace EnemyTracker {
struct Entry {
    int32_t id;
    int32_t objType;
    float   x, y;
    int32_t hp, maxHp;
    float   vx, vy;
    bool    isInvulnerable;
    bool    hasHealthBar;
    bool    isScenery;
    float   shotRangeTiles;
    void*   ptr;
};
void Tick();
const std::vector<Entry>& GetSnapshot();
bool ResolveObjectPos(int32_t id, float& outX, float& outY);
}
