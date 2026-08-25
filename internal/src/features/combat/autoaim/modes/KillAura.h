#pragma once
#include <cstdint>

// KillAura — redirects where an ALREADY-FIRED shot originates so it lands on a
// chosen target. It never pulls the trigger. Two coordinated consumers use the
// origin this module computes:
//   * the LOCAL bullet spawn (plan 87) so the game's own collision fires ENEMYHIT
//   * the OUTBOUND PLAYERSHOOT.projectilePosition (client proxy, plan 86) so the
//     server's simulation agrees
// Owns no hook. Ticked from CombatTAB::Tick on the render thread.
namespace KillAura {

enum class Mode : int { AtTarget = 0, AtMouse = 1 };

// Render thread, once per frame. Selects a target and publishes the aim state.
void Tick();

void  SetEnabled(bool on);            bool  IsEnabled();
void  SetMode(Mode m);                Mode  GetMode();
void  SetRangeTiles(float t);         float GetRangeTiles();       // clamp [1, 40], default 16
void  SetStandoffTiles(float t);      float GetStandoffTiles();    // clamp [0.05, 1.5], default 0.35
void  SetMaxOffsetTiles(float t);     float GetMaxOffsetTiles();   // clamp [1, 40], default 12

// In-world lock overlay: the locked target's marker plus the selection-range
// ring around the reference point, so a target about to fall out of range is
// visible BEFORE the lock drops. Defaults ON — visibility is the whole point.
void  SetOverlayEnabled(bool on);     bool  IsOverlayEnabled();

// Forced target override (auto-break-walls, plan 89). 0 = clear.
void    SetForcedTargetId(int32_t id);
int32_t GetForcedTargetId();

// Snapshot of the last Tick. Plain value copy of atomics — no lock.
struct State {
    bool     armed    = false;   // enabled AND a target was selected this tick
    int32_t  targetId = 0;
    float    tx = 0.f, ty = 0.f; // lead-predicted aim point (tiles)
    float    px = 0.f, py = 0.f; // local player position at publish time
    uint32_t stampMs  = 0;       // GetTickCount64() low 32 bits
};
State GetState();

// The ONE shot-origin formula, shared by every consumer:
//   origin = target - (cos(shotAngle), sin(shotAngle)) * standoff
// Returns false (and leaves ox/oy untouched) when not armed, when the inputs are
// not finite, or when the result would sit further than GetMaxOffsetTiles() from
// the local player — fail-closed, the caller then leaves the shot alone.
bool ComputeShotOrigin(float shotAngleRad, float& ox, float& oy);

// Render thread. Draws the Combat-tab section.
void RenderSettings();

// Render thread, called from the shared world-overlay pass with the frame's
// camera basis (same signature/contract as the dodge engines' RenderDebugOverlay).
// Self-gates on IsEnabled() && IsOverlayEnabled(); draws only, never logs.
void RenderOverlay(float camX, float camY, float angle, float zoom, float cx, float cy);

} // namespace KillAura
