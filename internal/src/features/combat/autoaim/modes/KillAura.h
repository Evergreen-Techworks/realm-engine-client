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

// Drive the SHOT ANGLE at the selected target, not just the shot origin.
// Defaults ON — it is the only half of this feature the server can be made to
// agree with (the origin displacement makes the server's own simulation of the
// shot disagree with the client's damage claim; an angle change does not,
// because the bullet still leaves the player's real position). Turning it off
// leaves killaura origin-only, which is what it was before.
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
// The shot origin used to be computed TWICE, independently: once inside the
// projectile-spawn detour (a live ComputeShotOrigin call) and once in the client
// proxy from a separately-published aim sample. Nothing forced the two to agree,
// so the LOCAL bullet could be moved to one point while the server was told a
// different one — the client then claimed a hit the server's own simulation of
// the shot never produced, and refused it (visible damage that reverts).
//
// So the origin is now computed EXACTLY ONCE per refresh, inside Tick, from the
// very same (target, player, standoff) values that refresh is committing, and
// stamped with a monotonically increasing GENERATION. Every consumer reads THAT
// value — nobody recomputes it. `ComputeShotOrigin` is deliberately no longer
// part of this interface: a second way to obtain an origin is the bug.
//
// The two consumers still SAMPLE it at different latencies (the local bullet
// reads it in-process; the outbound rewrite reads it across the IPC pipe), so
// they can legitimately hold different generations. That gap is exactly what
// `generation` makes measurable — see the [ShotOriginHook] trace line and the
// [Killaura] diag line in the proxy log.
struct Input {
    float    ox = 0.f, oy = 0.f;   // ABSOLUTE world tiles — the shot origin
    float    angleRad = 0.f;       // the angle the origin was solved at
    int32_t  targetId = 0;
    uint32_t generation = 0;       // refresh counter; monotonic, never reused
    uint32_t stampMs = 0;          // GetTickCount64() low 32 bits at publish
};

// Reads the ONE authoritative input. Returns false — leaving `out` untouched —
// when killaura is not armed, when the refresh that produced this sample refused
// an origin (the standoff/maxOffset caps), when a refresh landed mid-read, or
// when the sample is older than the freshness window (~50 ms; Tick refreshes at
// up to ~125 Hz, so a current sample is always far inside it).
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
