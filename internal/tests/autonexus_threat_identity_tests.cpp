// Threat identity published by the native AutoNexus producer.
//
// Evidence (recordings 20260925-encounter-context, 6 runs, 93,528 runtime lanes):
// the spawn detour's WorldProjectile.ownerObjId held the game's bullet id in
// every row (it matched an announced ENEMYSHOOT (owner, bulletId) 100% of the
// time), while WorldProjectile.bulletId advanced 1:1 with wall-clock ms: it is
// the projectile's startTime. AutoNexus published that clock as the threat's
// bulletId, so the client could never match a threat to its announced shot.
#include "features/combat/autonexus/AutoNexusThreatIdentity.h"
#include <cstdio>

int main()
{
    int n = 0, f = 0;
    auto ck = [&](bool x, const char* m) { ++n; if (!x) { ++f; std::printf("FAIL %s\n", m); } };

    // 005343-discovery scene row [owner=23, attacker=178802, bullet=90209]:
    // shot record (178802, 23) exists; 90209 is the spawn startTime in ms.
    const auto a = AutoNexusThreatIdentity::FromSpawnFields(178802, 23u, 90209);
    ck(a.ownerObjId == 178802, "owner object id is the spawn owner argument");
    ck(a.bulletId == 23, "bullet id is the game's bullet id, not the startTime clock");

    // 011646-discovery: startTime 196716 has low 16 bits 108, the id of a
    // different announced bullet; the real bullet id must be published instead.
    const auto b = AutoNexusThreatIdentity::FromSpawnFields(187839, 41u, 196716);
    ck(b.bulletId == 41 && (b.bulletId & 0xffff) != (196716 & 0xffff), "clock never aliases another bullet");

    // Packet bullet ids are 16-bit; the published id is always a packet id.
    const auto c = AutoNexusThreatIdentity::FromSpawnFields(1, 70000u, 5);
    ck(c.bulletId >= 0 && c.bulletId <= 0xffff, "published id stays within the packet id range");

    std::printf("%d/%d autonexus threat identity checks passed\n", n - f, n);
    return f == 0 ? 0 : 1;
}
