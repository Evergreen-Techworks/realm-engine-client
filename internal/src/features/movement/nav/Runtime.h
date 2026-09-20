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
// ENEMY STANDOFF: the discs the D* navigator routes around. Published from the
// game thread each dodge tick (plain data, copied); the router thread rasterises
// them once per cycle. Passing none clears the overlay.
void SetStandoff(const Router::StandoffDisc* discs, int count);
RouteCorridor Update(RoutePoint player, RoutePoint goal, float baseSpeed, bool active,
                     bool hazardBlocked = false);   // hazardBlocked = udodge safeWalk (S3.11)

} } }
