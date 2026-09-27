#pragma once
#include <cstdint>

// KillAura — picks a target (with retention and stickiness) and publishes it for
// the native shot edit in ShotTransaction (features/combat/autoaim/shoot). It
// never pulls the trigger. The edit itself happens per projectile on the game
// thread: the origin moves at most 2 tiles from the player toward the aim point,
// the angle points from that origin at the aim point, and the outgoing
// PlayerShoot carries the same origin and angle. See the comment at the top of
// KillAura.cpp and ShotTransaction.h.
// Ticked from CombatTAB::Tick on the render thread.
namespace KillAura {

enum class Mode : int { AtTarget = 0, AtMouse = 1 };

// Render thread, once per frame. Selects a target and publishes the shot target.
void Tick();

void  SetEnabled(bool on);            bool  IsEnabled();
void  SetMode(Mode m);                Mode  GetMode();

// Selection-range CAP, in tiles. 0 = AUTO, the default: killaura selects inside
// the range the WEAPON actually has (TargetSelector derives it from the
// calibrated projectile properties). A non-zero value is clamped to [1, 40] and
// can only SHRINK that radius. Each shot is still checked on its own: the edit
// is made only when the aim point is within that projectile's range of the
// moved origin.
//
// The client plugin's `rangeTiles` setting MUST default to 0 too:
// syncControlState() pushes it on every enable/settings change, so a mismatched
// client default silently overrides this one.
void  SetRangeTiles(float t);         float GetRangeTiles();       // 0 = auto, else clamp [1, 40]
// How far short of the aim point the moved origin stops, clamp [0.05, 1.5],
// default 0.35.
void  SetStandoffTiles(float t);      float GetStandoffTiles();

// The selection radius the LAST tick actually used (weapon range under the cap),
// or 0 before the first armed tick. Read-only; the overlay and the Combat-tab
// readout use it so they cannot disagree with the selector.
float GetEffectiveRangeTiles();

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
    float    tx = 0.f, ty = 0.f; // lead-predicted aim point from the player (tiles)
    float    px = 0.f, py = 0.f; // local player position at publish time
    uint32_t stampMs  = 0;       // GetTickCount64() low 32 bits
};
State GetState();

// ── What the shot edit reads (game thread) ───────────────────────────────────
// Published by Tick on the render thread every refresh while killaura is
// enabled. The game thread solves the origin, lead and angle per projectile from
// this, because the projectile's own speed and range are only known there.
struct ShotTarget {
    bool     hasTarget = false;
    int32_t  targetId  = 0;
    float    ex = 0.f, ey = 0.f;   // target position at stampMs (tiles)
    float    vx = 0.f, vy = 0.f;   // target velocity, tiles/ms (0 = unknown / still)
    bool     hasMouse  = false;
    float    mx = 0.f, my = 0.f;   // mouse aim point (tiles)
    float    standoffTiles = 0.35f;
    uint32_t stampMs   = 0;        // GetTickCount64() low 32 bits
    uint32_t generation = 0;       // refresh counter; monotonic
};

// Any thread. False — leaving `out` untouched — when killaura is disabled,
// nothing has been published yet, or the writer held the slot for the whole
// (short) retry window. Freshness is the caller's decision (stampMs).
bool GetShotTarget(ShotTarget& out);

// Render thread. Draws the Combat-tab section.
void RenderSettings();

// Render thread, called from the shared world-overlay pass with the frame's
// camera basis (same signature/contract as the dodge engines' RenderDebugOverlay).
// Self-gates on IsEnabled() && IsOverlayEnabled(); draws only, never logs.
void RenderOverlay(float camX, float camY, float angle, float zoom, float cx, float cy);

} // namespace KillAura
