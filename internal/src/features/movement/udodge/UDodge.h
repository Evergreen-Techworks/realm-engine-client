#pragma once

#include <cstdint>

// UDodge — unified auto-dodge (DodgeMode 7).
//
// PJDodge's predictive core (exact Chebyshev CCD, intent ladder, hysteresis,
// command-latency lead) with RePP's terrain-aware field escape and goal layer
// (boss-lock orbit at weapon range, opt-in stand-on-object walking) bolted
// where PJDodge was blind.
namespace UDodge {

struct DiagView {
    bool  enabled = false;
    int   decision = 0;
    float playerX = 0.f, playerY = 0.f;
    bool  overrideActive = false;
    float velXPerSec = 0.f, velYPerSec = 0.f;
    int   candidate = 0;
    float speedScale = 1.f;
    int   threatCount = 0;
    float standClearanceTiles = 0.f;   // ≤ 0 = danger covers current position; -1 sentinel unused
    int   lanes = 0, zones = 0, enemies = 0;
    uint32_t tickId = 0;               // NewTick stamp of the current map
    bool  tickValid = false;           // false = tick source unreadable (rebuild-every-frame mode)
    bool  fieldActive = false;
    bool  hasLockTarget = false;
    float lockX = 0.f, lockY = 0.f;
};

void SetEnabled(bool enabled);
bool IsEnabled();
void OnEnter();
void Tick(void* player, float px, float py, float dt);   // game-update thread
void RenderSettings();                                    // render thread (Test tab)
void RenderDebugOverlay(float camX, float camY, float angle, float zoom, float cx, float cy);
DiagView GetDiagView();

// Knobs (atomics; IPC + GUI). Clamps: laneTiles [2,16], stepTiles
// {0 | [0.4,3]}, hitScale [0.25,2.5], standOnType any int, mode {0,1}.
void  SetLaneTiles(float t);          float GetLaneTiles();
void  SetStepTiles(float t);          float GetStepTiles();
void  SetHitScale(float s);           float GetHitScale();
    void  SetReactMargin(float m);        float GetReactMargin();
void  SetSafeWalk(bool en);           bool  GetSafeWalk();
void  SetSpeedScale(bool en);         bool  GetSpeedScale();
void  SetFieldEscape(bool en);        bool  GetFieldEscape();
void  SetDebugOverlay(bool en);       bool  GetDebugOverlay();
void  SetLockFollow(bool en);         bool  GetLockFollow();
void  SetFollowLantern(bool en);      bool  GetFollowLantern();
void  SetAutopilot(bool en);          bool  GetAutopilot();   // auto-lock highest-maxHp enemy
void  SetStandOnType(int t);          int   GetStandOnType();
void  SetOrbitRange(float t);         float GetOrbitRange();   // tiles; 0 = auto
void  SetPlanRadius(float cells);     float GetPlanRadius();   // grid cells [8,40]
void  SetDrawPath(bool en);           bool  GetDrawPath();     // route overlay

} // namespace UDodge
