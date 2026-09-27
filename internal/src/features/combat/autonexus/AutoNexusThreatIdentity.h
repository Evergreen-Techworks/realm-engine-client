#pragma once

#include <algorithm>
#include <cstdint>
#include <vector>

// Identity of a native threat as published to the client (IpcThreat
// attackerObjId / bulletId), which keys it against the server-announced shot
// (ENEMYSHOOT ownerId, bulletId) to price it at packet damage.
//
// The spawn hook stores the corrected identity (ProjectileSpawnIdentity.h):
// WorldProjectile.attackerObjId is the shooter and bulletId the game's bullet
// id. Before that fix bulletId held the spawn startTime clock and AutoNexus
// matched 0 threats to an announced shot in six recorded runs.
namespace AutoNexusThreatIdentity {

struct Identity {
    int32_t ownerObjId = 0;   // the shooter's object id
    int32_t bulletId   = 0;   // the game's (packet) bullet id, 16-bit
};

inline Identity FromStoreFields(int32_t attackerObjId, int32_t bulletId)
{
    Identity id;
    id.ownerObjId = attackerObjId;
    id.bulletId   = static_cast<int32_t>(static_cast<uint32_t>(bulletId) & 0xffffu);
    return id;
}

// One published row per (owner, 16-bit bullet id), keeping the earliest impact.
// The client counts an identity once; this keeps the native list honest too.
template <class Row>
void DedupeThreats(std::vector<Row>& rows)
{
    std::stable_sort(rows.begin(), rows.end(), [](const Row& a, const Row& b) { return a.tHitMs < b.tHitMs; });
    std::vector<Row> out;
    out.reserve(rows.size());
    for (const Row& r : rows) {
        bool seen = false;
        for (const Row& o : out)
            if (o.attackerObjId == r.attackerObjId && ((o.bulletId ^ r.bulletId) & 0xffff) == 0) { seen = true; break; }
        if (!seen) out.push_back(r);
    }
    rows.swap(out);
}

} // namespace AutoNexusThreatIdentity
