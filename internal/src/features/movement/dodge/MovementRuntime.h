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

} // namespace DodgeRuntime
