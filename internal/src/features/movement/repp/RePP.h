#pragma once

namespace RePP {

void SetEnabled(bool enabled);
bool IsEnabled();
void OnEnter();
void Tick(void* player, float px, float py, float dt);
void RenderSettings();
void RenderDebugOverlay(float camX, float camY, float angle, float zoom, float cx, float cy);

// M0 knobs (stored only; NO movement behavior yet):
void  SetReactWindowMs(float ms);   float GetReactWindowMs();   // default 650, clamp [100,2500]
void  SetMaxMoveTiles(float tiles); float GetMaxMoveTiles();    // default 1.0, clamp [0.2,4]
void  SetHitScale(float s);         float GetHitScale();        // default 1.0, clamp [0.5,2]
void  SetDangerWeight(float v);     float GetDangerWeight();    // default 2.0, clamp [0,5]
void  SetMode(int mode);            int   GetMode();            // 0=Assist (default), 1=Autopilot
void  SetAvoidHazards(bool en);     bool  GetAvoidHazards();    // default true
void  SetDebugOverlay(bool en);     bool  GetDebugOverlay();    // default true
void  SetFollowLantern(bool en);    bool  GetFollowLantern();   // Autopilot stand-on scan (default OFF, perf)
void  SetStandOnType(int t);        int   GetStandOnType();     // Autopilot stand-on objType (0=off)

} // namespace RePP
