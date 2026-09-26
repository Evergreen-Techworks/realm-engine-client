#pragma once

#include <cstdint>

// Identity of a native threat as published to the client (IpcThreat
// attackerObjId / bulletId), which keys it against the server-announced shot
// (ENEMYSHOOT ownerId, bulletId) to price it at packet damage.
//
// ProjectileTracking's spawn detour names its game arguments
// (attackerObjId, ownerObjId, angle, bulletId), but the game passes
// (ownerId, bulletId, angle, startTime) — the Flash Projectile.reset order.
// Measured on 2026-09-26 over 93,528 runtime lanes in six recorded runs:
// WorldProjectile.ownerObjId matched an announced (owner, bulletId) in every
// row, and WorldProjectile.bulletId advanced 1:1 with wall-clock ms. The
// detour's field naming is shared by every dodge engine, so this header maps
// the fields for AutoNexus only and leaves the store untouched.
namespace AutoNexusThreatIdentity {

struct Identity {
    int32_t ownerObjId = 0;   // the shooter's object id
    int32_t bulletId   = 0;   // the game's (packet) bullet id, 16-bit
};

inline Identity FromSpawnFields(int32_t attackerObjIdField, uint32_t ownerObjIdField,
                                int32_t /*bulletIdField: spawn startTime in ms*/)
{
    Identity id;
    id.ownerObjId = attackerObjIdField;
    id.bulletId   = static_cast<int32_t>(ownerObjIdField & 0xffffu);
    return id;
}

} // namespace AutoNexusThreatIdentity
