#pragma once

#include "Router.h"

namespace Movement { namespace Nav { namespace Runtime {

void SetNavigatorText(const char* value);
bool Enabled();
void SetMapInfoText(const char* value);
void SetScriptGoalText(const char* value);
void NotifySceneReset();
void InvalidateGoal();
void Start();
void Stop();
RouteCorridor Update(RoutePoint player, RoutePoint goal, float baseSpeed, bool active,
                     bool hazardBlocked = false);   // hazardBlocked = udodge safeWalk (S3.11)

} } }
