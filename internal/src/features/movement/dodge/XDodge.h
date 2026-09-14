#pragma once
#include <cstdint>

// XDodge — spacetime BFS dodge ported from XRebuild/XDriver decompile.
//
// ALGORITHM: Every kRebuildFrames game ticks, snapshot projectiles, build a
// 25×25×13 spacetime danger grid (0.25 tile cells, 3-tile radius, 13 time
// slices at planStepMs intervals), run BFS through (gx, gy, t) states, then
// NativeMoveTo the first-step cell every game tick. The game's MoveTo does not
// clamp distance, so the step is sized from the player's speed — no raw position writes.
//
// DodgeMode::XDodge = 1
namespace XDodge {

void SetEnabled(bool en);
bool IsEnabled();

// Called when entering XDodge mode.
void OnEnter();

// Per-frame tick — called from Detour_AppEngineUpdate.
void Tick(void* player, float px, float py, float dt);

// ImGui settings panel.
void RenderSettings();

// ── Tunables (also exposed via IpcBridge xdodge* keys) ───────────────────
// Projectile AABB multiplier. 1.0 = exact game hitbox.
void  SetHitScale(float s);    // 0.5..2.0, default 1.0
float GetHitScale();

// Rebuild grid every N frames (~17ms/frame → N=3 ≈ 50ms cadence).
void SetRebuildN(int n);       // 1..10, default 3
int  GetRebuildN();

// Duration of one spacetime time slice (ms).
void  SetPlanStepMs(float ms); // 10..200, default 50
float GetPlanStepMs();

// Read-only: search radius in tiles (compile-time constant kRad * kCell).
float GetSearchRadius();

// No-op setter kept for IpcBridge protocol compatibility (kRad is fixed).
void SetSearchRadius(float t);

// ── Goal pathing (additive; BFS stays the immediate reflex) ──────────────
// A* goal tier: weighted A* toward an external goal when there's no
// imminent hit. Off ⇒ exact BFS-only build. Default on.
void SetAstarEnabled(bool en);
bool GetAstarEnabled();
// Weighted danger field: sparse fringe ring shapes A* path cost (smoother,
// safer). Invisible to BFS. Off ⇒ binary grid (old behavior). Default on.
void SetWeightingEnabled(bool en);
bool GetWeightingEnabled();
// Smart goal: A* aims at the safest cell near the intended goal. A* only;
// BFS keeps the raw goal. Off ⇒ raw clipped goal cell. Default on.
void SetSmartGoalEnabled(bool en);
bool GetSmartGoalEnabled();
// Perp bias: A* prefers sidesteps perpendicular to the incoming bullet
// flow; self-disables in crossfire. A* only. Default on.
void SetPerpEnabled(bool en);
bool GetPerpEnabled();
// Speed match: scale spacetime slices to realized player speed + clamp the
// per-frame commanded step to reach — kills rubber-banding. Affects both
// BFS and A*. Off ⇒ fixed plan-step + no clamp (old behavior). Default on.
void SetSpeedMatchEnabled(bool en);
bool GetSpeedMatchEnabled();
// Walkability cache: recompute the static-wall layer only on grid-recenter
// / slow timer, not the 625 IL2CPP calls per projectile-spawn rebuild
// (stops stalling the game-update thread → AutoNexus reacts on time).
// Cost-only; dodge reactivity unchanged. Off ⇒ recompute every rebuild.
void SetWalkCacheEnabled(bool en);
bool GetWalkCacheEnabled();
// Wall avoidance: graded fringe around walls (A* keeps clearance) +
// diagonal corner-clip filter in BFS/A* (no cutting between two wall
// cells). Cached wall map only. Off ⇒ walls = pure hard block (old).
void SetWallAvoidEnabled(bool en);
bool GetWallAvoidEnabled();
// P3: ORBIT↔SURVIVE arbiter — flee to the safest pocket when the goal
// region is hot; mode-hysteresis. Off ⇒ pure orbit/external. Default on.
void SetArbiterEnabled(bool en);
bool GetArbiterEnabled();
// P5: BFS strategic bias — escape toward the committed goal (tiebreak;
// safety/snappiness unchanged). Off ⇒ natural BFS order. Default on.
void SetBfsBiasEnabled(bool en);
bool GetBfsBiasEnabled();
// P6: CCD-exact tight reflex commit — verify the chosen step against exact
// bullet trajectories; refine to nearest safe neighbor if it clips.
// CcdPad = command-latency margin (tiles). Off ⇒ grid-only. Default on.
void  SetCcdEnabled(bool en);
bool  GetCcdEnabled();
void  SetCcdPad(float tiles);
float GetCcdPad();
// P7/P8: per-type bullet catalog + prediction-error feedback. Off ⇒ no
// per-type residual learning / inflation. Default on.
void SetCatalogEnabled(bool en);
bool GetCatalogEnabled();
// P8 hit booster — call when the player takes a hit (proof a model was
// wrong): bumps learned inflation on sampled types so the next encounter
// is safer. The continuous loop works without this; it's a sharpener.
void OnPlayerHit();

// Debug overlay: draw the planned path on screen (A* polyline / BFS step).
// Call from the tab overlay with current camera state. Toggle-gated.
void  RenderDebugPath(float camX, float camY, float angle, float zoom, float cx, float cy);
void  SetDrawPathEnabled(bool en);
bool  GetDrawPathEnabled();
// Admin debug: render predicted projectile trajectories so we can
// visually verify ComputePosAt tracking. Independent of the path
// overlay above. Off by default.
void  SetDrawProjPredEnabled(bool en);
bool  GetDrawProjPredEnabled();
// Long-horizon prediction probe used by the admin tracking HUD. 50ms
// is the planner slice (always tracked); this is the second probe.
// Defaults to 250ms; clamped [80, 1000].
void  SetDebugPredLongMs(float ms);
float GetDebugPredLongMs();
// Never-stand-on-enemies: stamp live enemy/boss bodies as lethal in
// the danger grid so the planner routes around them (contact damage).
// Default on. Off ⇒ legacy behaviour (only projectiles are stamped).
void  SetAvoidEnemiesEnabled(bool en);
bool  GetAvoidEnemiesEnabled();
// Lock-on: prefer goal cells with clear line-of-sight to the enemy (so we
// can actually shoot it). Soft — survival still wins. Default on.
void  SetLosGoalEnabled(bool en);
bool  GetLosGoalEnabled();
// Manual-WASD yield: while a move key is held, XDodge issues no movement
// (player drives) but keeps planning → instant resume on release.
// Default on. Off ⇒ XDodge always drives (fights manual input).
void  SetWasdYieldEnabled(bool en);
bool  GetWasdYieldEnabled();
// Anti-flee + sidestep bias on goal selection (SelectStandoffGoal +
// SelectSafestCell). Stops the algorithm running backwards from shots when
// a small lateral step would do. Default on.
void  SetLateralPrefEnabled(bool en);
bool  GetLateralPrefEnabled();
// Goal hysteresis on the standoff/survive goal-picker. Default on. Off ⇒
// each rebuild picks the global optimum fresh (visible "flipping" when
// equally-good alternatives exist).
void  SetGoalStickyEnabled(bool en);
bool  GetGoalStickyEnabled();
// Commit-layer direction dwell. After committing a step, hold that
// direction for ~250ms before allowing a sharp (>90deg) reversal.
// Imminent danger overrides. Default on. Off ⇒ planner can flip every
// rebuild between equally-good first steps (visible zigzag).
void  SetCommitDwellEnabled(bool en);
bool  GetCommitDwellEnabled();
// THE live A* danger weight (the real tuning knob; the old danger/stay
// penalty sliders were dead after P2). 0..5, default 2. Lower = tighter.
void  SetDangerWeight(float v);
float GetDangerWeight();

} // namespace XDodge
