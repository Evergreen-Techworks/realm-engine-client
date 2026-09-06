#pragma once

#include <cstdint>

// PJDodge — predictive auto-dodge (DodgeMode 6).
//
// Layer 1: 34 straight candidates × exact Chebyshev segment CCD against every
// threat path, AoE landing, wall and hazard tile; survival-lexicographic
// selection; intent-preservation ladder; hysteresis; command-latency lead.
// Layer 2: piecewise-heading escape search (receding horizon) when no straight
// candidate survives the whole window.
namespace PJDodge {

void SetEnabled(bool enabled);
bool IsEnabled();
void OnEnter();

// Game-update-thread tick (called from the AppEngineManager::Update detour).
void Tick(void* player, float px, float py, float dt);

// ImGui settings block (render thread, inside the Test tab).
void RenderSettings();

// World overlay (render thread).
void RenderDebugOverlay(float camX, float camY, float angle, float zoom, float cx, float cy);

// Knobs (atomic; IPC + GUI).
void  SetHorizonMs(float ms);   float GetHorizonMs();
void  SetLeadMs(float ms);      float GetLeadMs();
void  SetHitScale(float s);     float GetHitScale();
void  SetSafeWalk(bool en);     bool  GetSafeWalk();
void  SetSpeedScale(bool en);   bool  GetSpeedScale();
void  SetPredictionAccuracy(bool en); bool GetPredictionAccuracy();
void  SetDebugOverlay(bool en); bool  GetDebugOverlay();
// When on, PJDodge consumes DangerPlanner's external goal (enemy lock / follow)
// as the intent direction when no WASD input is active. The character walks
// toward the lock target while dodging; WASD always overrides.
void  SetLockFollow(bool en);   bool  GetLockFollow();

} // namespace PJDodge
