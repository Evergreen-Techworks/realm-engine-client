#pragma once
#include <cstdint>

// AutoBreakWalls — when nav wedges against a breakable wall on the route, pin
// killaura onto it and hold autofire until it dies, then release. Pure
// orchestration: no game bindings, no hooks, no nav mutation. Ticked from
// CombatTAB::Tick on the render thread.
namespace AutoBreakWalls {

void Tick();

void SetEnabled(bool on);          bool  IsEnabled();          // default OFF
void SetProbeTiles(float t);       float GetProbeTiles();      // clamp [0.5, 6], default 2.5
void SetTimeoutMs(int ms);         int   GetTimeoutMs();       // clamp [1000, 30000], default 6000

struct Diag {
    bool     enabled     = false;
    bool     navWedged   = false;
    int32_t  targetId    = 0;      // 0 = not engaged
    int32_t  targetHp    = 0;
    uint32_t engagedMs   = 0;
    uint32_t engagements = 0;
    char     lastRelease[24] = {}; // "killed" | "timeout" | "gone" | "unwedged" | "disabled"
};
Diag GetDiag();

void RenderSettings();   // render thread

} // namespace AutoBreakWalls
