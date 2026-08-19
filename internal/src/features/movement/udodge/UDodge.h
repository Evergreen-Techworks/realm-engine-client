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
    float earliestImpactMs = 0.f;
    int   projectiles = 0, aoes = 0, enemies = 0;
    bool  fieldActive = false;
    bool  hasLockTarget = false;
    float lockX = 0.f, lockY = 0.f;
    bool  predEnabled = false;
    int   predCalibrated = 0;
    float predClockErrMs = 0.f, predModelErrTiles = 0.f, predModelMaxTiles = 0.f;
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
// Deprecated no-ops — the time dimension was removed (plans 44-48). These
// survive only until plan 48 deletes their IPC keys from the registry.
void  SetHorizonMs(float);
void  SetLeadMs(float);
void  SetPredictionAccuracy(bool);
void  SetLaneTiles(float t);          float GetLaneTiles();
void  SetStepTiles(float t);          float GetStepTiles();
void  SetHitScale(float s);           float GetHitScale();
void  SetSafeWalk(bool en);           bool  GetSafeWalk();
void  SetSpeedScale(bool en);         bool  GetSpeedScale();
void  SetFieldEscape(bool en);        bool  GetFieldEscape();
void  SetDebugOverlay(bool en);       bool  GetDebugOverlay();
void  SetMode(int mode);              int   GetMode();       // 0=Assist 1=Autopilot
void  SetLockFollow(bool en);         bool  GetLockFollow();
void  SetFollowLantern(bool en);      bool  GetFollowLantern();
void  SetStandOnType(int t);          int   GetStandOnType();

} // namespace UDodge
