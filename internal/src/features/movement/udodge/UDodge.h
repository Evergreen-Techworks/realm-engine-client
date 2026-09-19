#pragma once

#include <cstdint>

#include "features/movement/contact/Contact.h"
#include "features/movement/udodge/UDodgeStandoff.h"

// UDodge — unified auto-dodge (DodgeMode 7).
//
// PJDodge's predictive core (exact Chebyshev CCD, intent ladder, hysteresis,
// command-latency lead) with RePP's terrain-aware field escape and goal layer
// (boss-lock orbit at weapon range, opt-in stand-on-object walking) bolted
// where PJDodge was blind.
namespace UDodge {

// Last-resort signal for AutoNexus (plan 77). Reflects the most recent solve on
// the game thread. "Exposed" = udodge could NOT place the player fully safe this
// tick: the stand is covered (clearance <= latency pad) AND the solve did not find
// a safe reachable cell (kind is Fallback or Surrounded). When enabled and NOT
// exposed, udodge is handling it — AutoNexus should defer and suppress its own
// projectile firing. Thread: written on the game thread at the end of each Tick,
// read from AutoNexus's poll thread; a plain atomic snapshot (no lock — consumed
// conservatively as a hint). `tickId` advances once per Tick so the consumer can
// detect a stalled/hitched game thread and fall back to the predictive nexus.
struct SafetyState {
    bool     enabled        = false;   // udodge active
    bool     exposed        = false;   // udodge failed to fully cover the player this tick
    float    standClearance = 1e9f;    // server-accurate clearance at the player (tiles)
    uint32_t tickId         = 0;       // freshness / staleness guard for the consumer
    float    moveVx         = 0.f;     // udodge's committed next-move velocity (tiles/ms);
    float    moveVy         = 0.f;     // 0 = holding. AutoNexus predicts the player along this.
    bool     serverAnchorValid = false;
    float    serverX = 0.f, serverY = 0.f; // last position emitted in outbound MOVE
};
SafetyState GetSafetyState();

// Nav wedge signal (plan 89). Published from the walk-to stuck detector inside
// Tick(): `wedged` is true on a frame where the follower is `blocked` (its next
// route step is not clear — set immediately, no delay) or `stalled` (under 0.25
// tiles of progress for 500 ms, Navigation::Progress), and false again once
// neither holds, or when walk-to ends. A locked-target approach never sets it. Written
// on the game thread at the end of each Tick, read by auto-break-walls on the
// render thread — a plain atomic snapshot, consumed as a hint (never a lock).
struct NavWedge {
    bool     walkActive = false;
    bool     wedged     = false;
    float    goalX = 0.f, goalY = 0.f;
    float    playerX = 0.f, playerY = 0.f;
    uint32_t stampMs = 0;    // GetTickCount64() low 32 bits, updated every Tick
};
NavWedge GetNavWedge();

void SetEnabled(bool enabled);
bool IsEnabled();
void OnEnter();
void Tick(void* player, float px, float py, float dt);   // game-update thread
void RenderSettings();                                    // render thread (Test tab)
void RenderDebugOverlay(float camX, float camY, float angle, float zoom, float cx, float cy);

// Knobs (atomics; IPC + GUI). Clamps: laneTiles [2,16], stepTiles
// {0 | [0.4,3]}, hitScale [0.25,2.5], standOnType any int, mode {0,1}.
void  SetLaneTiles(float t);          float GetLaneTiles();
void  SetStepTiles(float t);          float GetStepTiles();
void  SetHitScale(float s);           float GetHitScale();
// udodgePlanner: "classic" = the pre-Slice-3 engine, anything else = tactician.
void  SetPlannerPolicy(const char* text);
Contact::Policy GetPlannerPolicy();
// udodgeEnemyStandoff: "off" = the pre-standoff engine, anything else = auto.
void  SetEnemyStandoff(const char* text);
Standoff::Mode GetEnemyStandoff();
// The live player hitbox multiplier the last BuildMap read, and whether the
// collider offset it came from is metadata-trusted (diagnostics).
float GetLiveHitboxMultiplier();      bool GetLiveHitboxTrusted();
    void  SetReactMargin(float m);        float GetReactMargin();
void  SetSafeWalk(bool en);           bool  GetSafeWalk();
void  SetSpeedScale(bool en);         bool  GetSpeedScale();
void  SetFieldEscape(bool en);        bool  GetFieldEscape();
void  SetDebugOverlay(bool en);       bool  GetDebugOverlay();
void  SetDebugWeights(bool en);       bool  GetDebugWeights();
void  SetDiagTiming(bool en);         bool  GetDiagTiming();   // per-phase perf timing (diag, default OFF)
void  SetLockFollow(bool en);         bool  GetLockFollow();
void SetGroupPreference(const char* payload);
void  SetFollowLantern(bool en);      bool  GetFollowLantern();
void  SetAutopilot(bool en);          bool  GetAutopilot();   // auto-lock highest-maxHp enemy
void  SetStandOnType(int t);          int   GetStandOnType();
void  SetOrbitRange(float t);         float GetOrbitRange();   // tiles; 0 = auto
void  SetPlanRadius(float cells);     float GetPlanRadius();   // grid cells [8,40]
void  SetDrawPath(bool en);           bool  GetDrawPath();     // route overlay
// MOVE-envelope backend. `armed` is asserted by the proxy only while its
// outgoing MOVE clamp is installed. Uncertainty is desired-vs-sent distance.
void  SetMoveEnvelope(bool en);        bool  GetMoveEnvelope();
void  SetMoveEnvelopeArmed(bool armed);
void  SetServerPositionError(float tiles);
void  SetServerAnchorX(float x);
void  SetServerAnchorY(float y);
void  SetServerAnchorValid(bool valid);

} // namespace UDodge
