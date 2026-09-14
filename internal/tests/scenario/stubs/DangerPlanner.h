#pragma once
#include <cstdint>
// Harness stand-in: the goal/lock plumbing UDodge.cpp reads (implemented by the harness).
namespace DangerPlanner {
void    SetWalkGoal(float x, float y);
void    ClearWalkGoal();
bool    GetWalkGoal(float& outX, float& outY, bool& outActive);
void    SetEnemyLock(int32_t objectId);
void    ClearEnemyLock();
int32_t GetEnemyLock();
void    ClearFollowPlayer();
int32_t GetFollowPlayer();
}
