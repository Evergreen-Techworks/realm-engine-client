#pragma once

namespace DodgeRuntime {

bool  EnsureResolved();
float GetDeltaTime();
float GetMoveSpeedMul(void* player);
// Move budget in tiles/sec from the game's own CalcMoveSpeed
// (FKALGHJIADI::GCFKGLKAPND, name-stable across builds).
// Returns a negative value when unavailable; zero is valid and must not fall back.
float GetTilesPerSec(void* player);
bool  CallMoveTo(void* player, float x, float y);
void  Reset();

// ── One movement allowance per game update (MovementFrameBudget.h) ──────────
// The game's own update moves the local player from input BEFORE the dodge tick
// runs, and the dodge then issues its own MoveTo in the same update. Unreconciled
// they stack, and the player travels further than the step the solver validated.
//
// BeginMovementFrame measures how far the player actually moved since our last
// command — the game's input step, or a server correction — and charges that
// against this update's allowance. The remainder is what the dodge may still
// command. EndMovementFrame records the resulting position so the next update
// can measure again.
//
// Deliberately OBSERVATIONAL: no hook is installed on the game's MoveTo. The
// measurement is equivalent for this purpose and costs no new hot-path detour.
// `budgeted` is false whenever the accounting cannot be trusted (unreadable
// position, unusable speed, first update); the caller must then fall back to its
// own per-frame clamp, which is exactly the pre-existing behaviour.
struct FrameMove {
    bool  budgeted = false;
    float tiles    = 0.f;   // travel still available to command this update
};
FrameMove BeginMovementFrame(void* player, float frameMs, float tilesPerMs);
void      EndMovementFrame(void* player);

} // namespace DodgeRuntime
