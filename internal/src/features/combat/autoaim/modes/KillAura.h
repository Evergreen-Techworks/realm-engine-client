#pragma once
#include <cstdint>

// KillAura — picks a target, drives the SHOT ANGLE at it, and solves a shot
// origin for the OUTBOUND PLAYERSHOOT rewrite (client proxy, plan 86). It never
// pulls the trigger and it no longer moves the local bullet: see the
// measured-results comment at the top of KillAura.cpp for why the local
// displacement was removed and why range cannot be extended by spoofing.
// Owns no hook. Ticked from CombatTAB::Tick on the render thread.
namespace KillAura {

enum class Mode : int { AtTarget = 0, AtMouse = 1 };

// Render thread, once per frame. Selects a target and publishes the aim state.
void Tick();

void  SetEnabled(bool on);            bool  IsEnabled();
void  SetMode(Mode m);                Mode  GetMode();

// Selection-range CAP, in tiles. 0 = AUTO, the default: killaura selects inside
// the range the WEAPON actually has (TargetSelector derives it from the
// calibrated projectile properties). A non-zero value is clamped to [1, 40] and
// can only SHRINK that radius — it can never extend it, because reach is not
// something the client gets to claim (see KillAura.cpp).
//
// The client plugin's `rangeTiles` setting MUST default to 0 too:
// syncControlState() pushes it on every enable/settings change, so a mismatched
// client default silently overrides this one.
void  SetRangeTiles(float t);         float GetRangeTiles();       // 0 = auto, else clamp [1, 40]
void  SetStandoffTiles(float t);      float GetStandoffTiles();    // clamp [0.05, 1.5], default 0.35

// The selection radius the LAST tick actually used (weapon range under the cap),
// or 0 before the first armed tick. Read-only; the overlay and the Combat-tab
// readout use it so they cannot disagree with the selector.
float GetEffectiveRangeTiles();

// Drive the SHOT ANGLE at the selected target, not just the shot origin.
// Defaults ON — it is the only half of this feature the server can be made to
// agree with, because the bullet still leaves the player's real position.
// Turning it off leaves killaura origin-only, which is what it was before.
// See AutoAim::SetKillAuraAimOverride for the killaura-vs-AutoAim precedence.
void  SetDriveAimAngle(bool on);      bool  IsDriveAimAngle();

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

// ── The ONE authoritative killaura input ─────────────────────────────────────
// The shot origin is computed EXACTLY ONCE per refresh, inside Tick, from the
// very same (target, player, standoff) values that refresh is committing, and
// stamped with a monotonically increasing GENERATION. The origin travels to its
// consumer over the `aim` IPC payload (PublishNow) — nobody recomputes it.
// `ComputeShotOrigin` is deliberately not part of this interface: a second way
// to obtain an origin is the bug that produced hit claims the server had no
// reason to believe.
//
// ORPHANED as of the local-displacement removal: the in-process consumer was
// ProjectileTracking's spawn detour, which armed ShotOriginHook to move the
// LOCAL bullet. That hook is gone (see KillAura.cpp), so `Input`,
// `GetAuthoritativeInput` and the seqlock behind them currently have NO caller —
// the surviving consumer, the outbound PLAYERSHOOT rewrite, reads the origin off
// the IPC payload instead. Kept rather than deleted because the generation
// seqlock is the only mechanism that can hand a torn-free origin to a second
// in-process consumer, and removing it is outside the change that orphaned it.
struct Input {
    float    ox = 0.f, oy = 0.f;   // ABSOLUTE world tiles — the shot origin
    float    angleRad = 0.f;       // the angle the origin was solved at
    int32_t  targetId = 0;
    uint32_t generation = 0;       // refresh counter; monotonic, never reused
    uint32_t stampMs = 0;          // GetTickCount64() low 32 bits at publish
};

// Reads the ONE authoritative input. Currently has no caller — see above.
// Returns false — leaving `out` untouched — when killaura is not armed, when the
// refresh that produced this sample refused an origin (the standoff/offset
// caps), when a refresh landed mid-read, or when the sample is older than the
// freshness window (~50 ms; Tick refreshes at up to ~125 Hz, so a current sample
// is always far inside it).
//
// Callers MUST fail closed on false and leave the shot vanilla. Rewriting from a
// value the server was never told is strictly worse than not rewriting.
bool GetAuthoritativeInput(Input& out);

// Render thread. Draws the Combat-tab section.
void RenderSettings();

// Render thread, called from the shared world-overlay pass with the frame's
// camera basis (same signature/contract as the dodge engines' RenderDebugOverlay).
// Self-gates on IsEnabled() && IsOverlayEnabled(); draws only, never logs.
void RenderOverlay(float camX, float camY, float angle, float zoom, float cx, float cy);

} // namespace KillAura
