// Spawn-hook identity, provisional-lane supersession and AutoNexus threat rows.
//
// Recorded evidence (run 004614-discovery, 2026-09-27 00:53:02Z, Maze Minotaur
// 202950): the spawn detour received (ownerId=202950, bulletId=542,
// startTime=386872) in parameters it names (attackerObjId, ownerObjId, bulletId),
// so the store's bulletId held the startTime clock. The packet-derived lane for
// ENEMYSHOOT (202950, 542) was then never superseded by its runtime twin.
#include "features/projectiles/ProjectileSpawnIdentity.h"
#include "features/combat/autonexus/AutoNexusThreatIdentity.h"
#include <cstdio>
#include <vector>

int main()
{
    int n = 0, f = 0;
    auto ck = [&](bool x, const char* m) { ++n; if (!x) { ++f; std::printf("FAIL %s\n", m); } };
    using namespace ProjectileSpawnIdentity;

    // Detour arguments in the detour's own (mislabelled) order.
    const Identity id = FromSpawnArgs(/*named attackerObjId*/ 202950, /*named ownerObjId*/ 542u,
                                      /*named bulletId*/ 386872);
    ck(id.ownerObjId == 202950, "owner is the first id argument");
    ck(id.bulletId == 542, "bullet id is the second id argument");
    ck(id.startTimeMs == 386872, "the third argument is the startTime clock");

    // Supersession: the runtime twin of ENEMYSHOOT (202950, 542) is the same shot.
    ck(IsSameShot(id.ownerObjId, id.bulletId, 202950, 542), "runtime twin supersedes its provisional lane");
    ck(!IsSameShot(202950, 386872, 202950, 542), "the startTime clock is not a bullet id");
    ck(!IsSameShot(id.ownerObjId, id.bulletId, 202950, 540), "a different bullet of the same owner is not the twin");
    ck(!IsSameShot(id.ownerObjId, id.bulletId, 202951, 542), "the same id from another owner is not the twin");
    ck(IsSameShot(202950, 542 + 65536, 202950, 542), "packet ids compare on 16 bits");

    // Local-shot classification uses the owner only, never the bullet id.
    ck(IsLocalShot(FromSpawnArgs(7001, 3u, 1000), 7001), "own shot is local");
    ck(!IsLocalShot(FromSpawnArgs(202950, 7001u, 1000), 7001), "an enemy bullet whose id equals our object id is not local");
    ck(!IsLocalShot(FromSpawnArgs(202950, 3u, 1000), 0), "unknown local id classifies nothing as local");

    // AutoNexus publishes one row per announced bullet, earliest impact kept.
    struct Row { int32_t attackerObjId; int32_t bulletId; float tHitMs; };
    std::vector<Row> rows{ {202950, 542, 44.f}, {202950, 540, 14.f}, {202950, 542, 14.f},
                           {202950, 542 + 65536, 30.f}, {202951, 542, 90.f} };
    AutoNexusThreatIdentity::DedupeThreats(rows);
    int n542 = 0; float t542 = -1.f;
    for (const auto& r : rows) if (r.attackerObjId == 202950 && (r.bulletId & 0xffff) == 542) { ++n542; t542 = r.tHitMs; }
    ck(rows.size() == 3, "one row per (owner, bullet)");
    ck(n542 == 1 && t542 == 14.f, "duplicate rows of one bullet collapse to the earliest impact");

    std::printf("%d/%d projectile spawn identity checks passed\n", n - f, n);
    return f == 0 ? 0 : 1;
}
