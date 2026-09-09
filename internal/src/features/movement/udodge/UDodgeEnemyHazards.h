#pragma once
#include "UDodgeTypes.h"

namespace UDodge { namespace EnemyHazards {
// Enemy-centred avoidance policy, not a detected explosion or damage estimate.
// objects.xml: GC Mushroom Slammer Melee / Melee E (DisplayId Mushroom Brawler).
// User-supplied RealmEye reference: successive self blasts, maximum radius 3.
// Keep a modest margin before a blast starts; the normal player footprint is
// added by the zone math. Never publish this policy to Auto Nexus as damage.
inline float KeepoutRadius(int objectType)
{
    return objectType == 0xb2a9 || objectType == 0xb502 ? 3.35f : 0.f;
}
inline bool Append(DangerMap& map, int objectType, int hp, Vec2 position, Vec2 player)
{
    const float radius = KeepoutRadius(objectType);
    if (hp <= 0 || radius <= 0.f || !std::isfinite(position.x) || !std::isfinite(position.y)
        || LenSq(Sub(position, player)) > (16.f + radius) * (16.f + radius)) return false;
    if (map.zoneCount >= kMaxAoes) { map.limited = true; return false; }
    ZoneThreat& zone = map.zones[map.zoneCount++];
    zone.pos = position;
    zone.radius = radius;
    zone.active = true;
    return true;
}
} }
