// Threat identity published by the native AutoNexus producer.
//
// Evidence (recordings 20260925-encounter-context, 6 runs, 93,528 runtime lanes):
// the spawn hook stored the game's startTime clock in WorldProjectile.bulletId.
// The hook now stores the game's bullet id there (ProjectileSpawnIdentity.h);
// AutoNexus publishes (shooter, 16-bit bullet id) from the store.
#include "features/combat/autonexus/AutoNexusThreatIdentity.h"
#include "features/projectiles/ProjectileSpawnIdentity.h"
#include <cstdio>

int main()
{
    int n = 0, f = 0;
    auto ck = [&](bool x, const char* m) { ++n; if (!x) { ++f; std::printf("FAIL %s\n", m); } };

    // 005343-discovery: hook args (178802, 23, 90209) -> shot record (178802, 23).
    const auto spawn = ProjectileSpawnIdentity::FromSpawnArgs(178802, 23u, 90209);
    const auto a = AutoNexusThreatIdentity::FromStoreFields(spawn.ownerObjId, spawn.bulletId);
    ck(a.ownerObjId == 178802, "owner object id is the spawn owner argument");
    ck(a.bulletId == 23, "bullet id is the game's bullet id, not the startTime clock");

    // 011646-discovery: startTime 196716 has low 16 bits 108, another bullet's id.
    const auto s2 = ProjectileSpawnIdentity::FromSpawnArgs(187839, 41u, 196716);
    const auto b = AutoNexusThreatIdentity::FromStoreFields(s2.ownerObjId, s2.bulletId);
    ck(b.bulletId == 41, "clock never aliases another bullet");

    const auto c = AutoNexusThreatIdentity::FromStoreFields(1, 70000);
    ck(c.bulletId >= 0 && c.bulletId <= 0xffff, "published id stays within the packet id range");

    std::printf("%d/%d autonexus threat identity checks passed\n", n - f, n);
    return f == 0 ? 0 : 1;
}
