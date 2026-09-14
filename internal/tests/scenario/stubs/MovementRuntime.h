#pragma once
// Harness stand-in for features/movement/dodge/MovementRuntime.h (declarations match).
namespace DodgeRuntime {
bool  EnsureResolved();
float GetDeltaTime();
float GetMoveSpeedMul(void* player);
float GetTilesPerSec(void* player);
bool  CallMoveTo(void* player, float x, float y);
void  Reset();
struct FrameMove {
    bool  budgeted = false;
    float tiles    = 0.f;
};
FrameMove BeginMovementFrame(void* player, float frameMs, float tilesPerMs);
void      EndMovementFrame(void* player);
} // namespace DodgeRuntime
