#pragma once
#include <cstdint>

// RolloutDodge — forward input-simulation dodge (DodgeMode::RolloutGrid = 2 / RolloutQuad = 3).
//
// Instead of asking "is this cell occupied at time-slice t?" (XDodge's
// discretized spacetime danger grid), this asks the direct question:
//
//   "If I commit this input and the game advances 1, 2, 3 ... N ticks, does my
//    swept path collide with anything?"
//
// Each rebuild it snapshots the live projectiles, samples each one's predicted
// trajectory over the horizon into a Threat (center positions + collision
// half-side + a swept AABB), and indexes those AABBs in a broad-phase
// (ThreatIndex). Then for each candidate input — Hold plus N evenly-spaced
// headings — it rolls the player forward under that input, queries the bullets
// whose swept box overlaps the player's swept path, and runs precise per-sample
// CCD only on those. The input with the largest time-to-first-collision wins;
// intent (the shared external goal) breaks ties. The committed heading is
// issued through DangerPlanner::NativeMoveTo (speed-clamped, server-acked) —
// the same single move chokepoint XDodge uses.
//
// Shares the goal/lock/follow plumbing and toggle
// discipline with XDodge; only one of the two is enabled at a time.
namespace RolloutDodge {

void SetEnabled(bool en);
bool IsEnabled();
void OnEnter();

// Per-frame tick — called from Detour_AppEngineUpdate when this mode is live.
void Tick(void* player, float px, float py, float dt);

// ImGui settings panel (Movement tab) + on-screen debug overlay.
void RenderSettings();
void RenderDebugPath(float camX, float camY, float angle, float zoom, float cx, float cy);

// ── Tunables (mirrored over IpcBridge rollout* keys) ─────────────────────────
// Planning horizon in server ticks (~200 ms each). How many ticks ahead the
// rollout simulates. 1..8, default 4 (~800 ms).
void  SetHorizonTicks(float ticks);
float GetHorizonTicks();
// Trajectory / CCD sample step (ms). Smaller = finer continuous detection,
// more compute. 10..60, default 25.
void  SetSampleStepMs(float ms);
float GetSampleStepMs();
// Number of evenly-spaced candidate headings (excludes Hold). 8..24, default 16.
void  SetHeadingCount(int n);
int   GetHeadingCount();
// Projectile AABB multiplier (1.0 = exact game hitbox). 0.5..2.0, default 1.0.
void  SetHitScale(float s);
float GetHitScale();
// Tie-break weight pulling equally-safe inputs toward the goal. 0..3, default 1.
void  SetIntentWeight(float w);
float GetIntentWeight();
// Rebuild the plan every N frames (between rebuilds the committed heading is
// re-issued each frame). 1..10, default 2.
void  SetRebuildN(int n);
int   GetRebuildN();
// Broad-phase backend selector (for A/B): 0 = Auto (grid when dense, else
// brute-force), 1 = Brute-force, 2 = Grid, 3 = Quadtree. Default Auto. The
// dodge mode (RolloutGrid / RolloutQuad) sets this on enter.
void  SetBroadPhase(int mode);
int   GetBroadPhase();
// Never stand on enemy bodies (contact damage): stamp live enemies as static
// threats so the rollout routes around them. Default on.
void  SetAvoidEnemiesEnabled(bool en);
bool  GetAvoidEnemiesEnabled();
// Manual-WASD yield: while a move key is held, issue no movement (player
// drives) but keep planning so dodge resumes instantly on release. Default on.
void  SetWasdYieldEnabled(bool en);
bool  GetWasdYieldEnabled();
// Commit-layer direction dwell: hold the committed heading briefly before
// allowing a sharp (>90deg) reversal; imminent danger overrides. Default on.
void  SetCommitDwellEnabled(bool en);
bool  GetCommitDwellEnabled();
// Debug overlay: draw candidate rollouts + the committed heading. Default off.
void  SetDrawPathEnabled(bool en);
bool  GetDrawPathEnabled();

} // namespace RolloutDodge
