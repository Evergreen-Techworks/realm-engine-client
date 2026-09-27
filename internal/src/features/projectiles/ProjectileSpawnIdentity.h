#pragma once

#include <cstdint>

// Identity carried by the game's projectile spawn call.
//
// ProjectileTracking's SpawnProjectileDetour names its game arguments
// (attackerObjId, ownerObjId, angle, bulletId), but the game passes
// (ownerId, bulletId, angle, startTime) — the Flash Projectile.reset order.
// Measured on 2026-09-26 over 93,528 runtime lanes in six recorded runs: the
// argument named ownerObjId matched an announced ENEMYSHOOT (owner, bulletId)
// in every row, and the one named bulletId advanced 1:1 with wall-clock ms.
// The hook stores the corrected identity: WorldProjectile.attackerObjId and
// ownerObjId both hold the shooter, bulletId holds the game's bullet id.
namespace ProjectileSpawnIdentity {

struct Identity {
    int32_t ownerObjId  = 0;   // the shooter's object id
    int32_t bulletId    = 0;   // the game's (packet) bullet id
    int32_t startTimeMs = 0;   // the projectile's spawn time on the game clock
};

inline Identity FromSpawnArgs(int32_t namedAttackerObjId, uint32_t namedOwnerObjId, int32_t namedBulletId)
{
    Identity id;
    id.ownerObjId  = namedAttackerObjId;
    id.bulletId    = static_cast<int32_t>(namedOwnerObjId);
    id.startTimeMs = namedBulletId;
    return id;
}

// Packet bullet ids are 16-bit; compare on those bits.
inline bool IsSameShot(int32_t runtimeOwner, int32_t runtimeBullet, int32_t packetOwner, int32_t packetBullet)
{
    return runtimeOwner == packetOwner && ((runtimeBullet ^ packetBullet) & 0xffff) == 0;
}

inline bool IsLocalShot(const Identity& id, int32_t localObjectId)
{
    return localObjectId != 0 && id.ownerObjId == localObjectId;
}

} // namespace ProjectileSpawnIdentity
