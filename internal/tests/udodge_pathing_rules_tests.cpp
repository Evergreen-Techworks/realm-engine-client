// Pure rules behind the 2026-09-13 pathing fixes. The end-to-end evidence is the
// scenario harness (tests/scenario); these pin the pieces it depends on.
#include "UDodgePathfinder.h"
#include "UDodgeNavigation.h"
#include "UDodgeEnemyHazards.h"
#include "features/movement/sensors/TileOccupancy.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <unordered_map>

using namespace UDodge;
namespace TO = Movement::TileOccupancy;

namespace {
int g_checks = 0;
void Check(bool ok, const char* name)
{
    ++g_checks;
    if (!ok) { std::fprintf(stderr, "FAIL: %s\n", name); std::exit(1); }
}

std::unordered_map<uint32_t, uint8_t> g_flags;
std::vector<uint32_t> g_full;
uint8_t FlagsAt(int tx, int ty)
{
    const auto it = g_flags.find(TO::SquareKey(tx, ty));
    return it == g_flags.end() ? 0 : it->second;
}
void Open(int x0, int y0, int x1, int y1)
{
    for (int y = y0; y <= y1; ++y) for (int x = x0; x <= x1; ++x) g_flags[TO::SquareKey(x, y)] = TO::kTileKnown;
}
void FullOccupy(int tx, int ty)
{
    g_flags[TO::SquareKey(tx, ty)] |= TO::kTileBlocked | TO::kTileFullOcc;
    g_full.push_back(TO::SquareKey(tx, ty));
}

bool LiveOccupy(float x, float y, bool)
{
    auto f = [](int tx, int ty) { return FlagsAt(tx, ty); };
    return !TO::BoxBlocked(f, x, y) && !TO::FullOccupyBlocked(f, x, y);
}
bool LiveWalls(float x, float y)
{
    return !TO::BoxBlocked([](int tx, int ty) { return FlagsAt(tx, ty); }, x, y);
}
} // namespace

int main()
{
    // ── Ground flags: XML NoWalk is authoritative ──────────────────────────────
    Check((TO::GroundFlags(true, false, 0.75f, true, false) & TO::kTileBlocked) != 0,
          "deep water carrying <Speed> is still NoWalk (Crystal Cave Deep Water)");
    Check((TO::GroundFlags(false, false, 0.666f, true, false) & TO::kTileBlocked) == 0,
          "shallow sink water stays walkable");
    Check((TO::GroundFlags(false, false, 0.666f, true, false) & TO::kTileSink) != 0, "sink bit kept");

    // ── FullOccupy half-tile rule, shared by raster and live check ─────────────
    Open(-5, -5, 5, 5);
    FullOccupy(1, 0);
    auto f = [](int tx, int ty) { return FlagsAt(tx, ty); };
    Check(TO::FullOccupyBlocked(f, 0.7f, 0.5f), "centre in the half facing a FullOccupy neighbour is refused");
    Check(!TO::FullOccupyBlocked(f, 0.5f, 0.5f), "the centre line itself is allowed");
    Check(!TO::FullOccupyBlocked(f, 0.505f, 0.3f), "a hair off the centre line counts as on it");
    Check(!TO::FullOccupyBlocked(f, 0.3f, 0.5f), "the far half is free");
    TO::NearFullOccupyMask mask;
    TO::PrepareRasterMask(mask, g_full.data(), g_full.size(), 0.7f - 2.f, 0.5f - 2.f, 9, 0.5f, TO::kPlayerHalfEdge);
    Check((TO::RasterCell(f, mask, 0.7f, 0.5f, TO::kPlayerHalfEdge, true) & TO::kCellFullRing) != 0,
          "the dodge raster marks the half-tile ring the live check refuses");
    Check((TO::RasterCell(f, mask, 0.2f, 0.5f, TO::kPlayerHalfEdge, true) & TO::kCellFullRing) == 0,
          "and leaves the far half open");
    TO::PrepareRasterMask(mask, g_full.data(), g_full.size(), 0.5f - 72.f, 0.5f - 72.f, 145, 1.f, 0.3785f);
    Check(!mask.Any(), "a whole-tile raster from a half-tile origin never needs the rule (no mask work)");

    // ── Navigation padding keeps the box off walls, not off the half-tile ring ─
    MapInput live{};
    live.env.canOccupy = &LiveOccupy;
    live.env.wallsClear = &LiveWalls;
    // Walking the ring's boundary (x = 0.5) past the FullOccupy square at (1,0).
    Check(Navigation::PaddedPathClear(live, { 0.5f, -1.5f }, { 0.5f, 1.5f }),
          "a route along a FullOccupy boundary is followable with padding");
    Check(!Navigation::PaddedPathClear(live, { 0.75f, -1.5f }, { 0.75f, 1.5f }),
          "a route through the half-tile ring still is not");

    // ── Nav A*: damaging ground, goal disk, stuck memory ────────────────────────
    static Path::PlannerSnapshot snap{};
    static Path::PlanResult plan{};
    auto cell = [](int x, int y) -> uint8_t& {
        return snap.navGrid.flags[(y + kUNavRadCells) * kUNavSide + x + kUNavRadCells];
    };
    auto reset = [&]() {
        snap = Path::PlannerSnapshot{};
        snap.navActive = true; snap.moveBudget = 1.2f; snap.speed = 0.006f;
        snap.settings.safeWalk = true;
        for (auto& c : snap.navGrid.flags) c = 0x1;
    };
    // A 3-wide corridor crossed by one damaging row: the only way through.
    reset();
    for (int x = 0; x <= 16; ++x) for (int y = -1; y <= 1; ++y) cell(x, y) = 0;
    for (int y = -1; y <= 1; ++y) cell(8, y) = 0x2;
    snap.navGoal = { 16, 0 };
    Path::Compute(snap, plan);
    Check(plan.navFound && !plan.navPartial && plan.navCrossesHazard,
          "a corridor crossed by damaging ground is routed across it, flagged for relaxed following");
    // Same corridor with a short clean bypass: the clean route wins, no relaxation.
    for (int x = 7; x <= 9; ++x) cell(x, 2) = 0;
    Path::Compute(snap, plan);
    Check(plan.navFound && !plan.navPartial && !plan.navCrossesHazard,
          "a clean detour within the slack beats crossing damaging ground");

    // Goal disk: the route ends at the first cell inside the radius.
    reset();
    for (int x = -20; x <= 20; ++x) for (int y = -20; y <= 20; ++y) cell(x, y) = 0;
    snap.navGoal = { 15, 0 }; snap.navGoalRadius = 5.f;
    Path::Compute(snap, plan);
    Check(plan.navFound && !plan.navPartial && Len(Sub(plan.navGoalCell, snap.navGoal)) <= 5.f + 1e-3f &&
          Len(Sub(plan.navGoalCell, snap.navGoal)) >= 4.f,
          "a goal disk is reached at its rim, not its centre");

    // Stuck memory: a remembered square on the straight line is routed around.
    snap.navGoalRadius = 0.f; snap.navGoal = { 10, 0 };
    Path::Compute(snap, plan);
    bool straight = plan.navWptCount == 2;
    snap.navAvoid[0] = { 5, 0 }; snap.navAvoid[1] = { 5, 1 }; snap.navAvoid[2] = { 5, -1 }; snap.navAvoidCount = 3;
    Path::Compute(snap, plan);
    bool detour = false;
    for (int i = 0; i < plan.navWptCount; ++i) if (std::fabs(plan.navWpts[i].y) >= 2.f) detour = true;
    Check(straight && plan.navFound && detour, "remembered stuck squares push the re-plan onto another line");
    const Vec2 avoid[] = { { 5, 0 } };
    Check(!Navigation::AvoidClear(avoid, 1, { 0, 0 }, { 10, 0 }) && Navigation::AvoidClear(avoid, 1, { 0, 2 }, { 10, 2 }),
          "the follower's shortcut test honours remembered squares");
    // The game's point collision leaves the player 0.01 from the square that refused
    // it — inside the remembered square's reach. Leaving must stay possible.
    Check(Navigation::AvoidClear(avoid, 1, { 4.49f, 0 }, { 2, 0 }),
          "a player already within a remembered square's reach can walk away from it");
    Check(!Navigation::AvoidClear(avoid, 1, { 4.49f, 3 }, { 5, 0 }),
          "walking into a remembered square from outside is still refused");

    // ── Enemy keep-outs are hard for walk-to too, and the route goes round them ──
    DangerMap map{};
    Check(EnemyHazards::Append(map, 0xb2a9, 100, { 3, 0 }, { 0, 0 }) && map.zones[0].active && map.zones[0].enemyKeepout,
          "keep-outs are hard zones for the dodge");
    Check(EnemyHazards::BurstKeepoutRadius(4.5f) == 5.f, "a point-blank shooter keeps out its reach plus margin");
    Check(EnemyHazards::BurstKeepoutRadius(8.f) == 0.f, "a long-range shooter is left to the bullet dodge");
    Check(EnemyHazards::BurstKeepoutRadius(0.f) == 0.f && EnemyHazards::BurstKeepoutRadius(-1.f) == 0.f,
          "no projectiles, no keep-out");
    DangerMap burst{};
    Check(EnemyHazards::Append(burst, 0x1234, 100, { 3, 0 }, { 0, 0 }, 4.5f) && burst.zones[0].radius == 5.f,
          "a shooter's reach makes a keep-out without any learned blast");
    Check(!EnemyHazards::Append(burst, 0x1234, 100, { 3, 0 }, { 0, 0 }, 0.f),
          "the locked target passes no reach and gets no burst keep-out");
    Check(!EnemyHazards::Append(burst, 0x1234, 0, { 3, 0 }, { 0, 0 }, 4.5f), "a dead enemy keeps nothing out");

    // Nav A*: a keep-out across the straight line is routed round, never through.
    reset();
    for (int x = -20; x <= 20; ++x) for (int y = -20; y <= 20; ++y) cell(x, y) = 0;
    snap.navGoal = { 16, 0 };
    snap.map.zoneCount = 0;
    EnemyHazards::Append(snap.map, 0x1234, 100, { 8, 1 }, { 0, 0 }, 4.5f);
    Path::Compute(snap, plan);
    float closest = 1e9f;
    for (int i = 0; i + 1 < plan.navWptCount; ++i)
        for (int k = 0; k <= 20; ++k) {
            const Vec2 q = Add(plan.navWpts[i], Mul(Sub(plan.navWpts[i + 1], plan.navWpts[i]), k / 20.f));
            closest = std::min(closest, Len(Sub(q, { 8, 1 })));
        }
    Check(plan.navFound && !plan.navPartial && closest >= 5.f,
          "a walk-to route detours around an enemy keep-out");
    // Standing inside one: the way out stays open.
    snap.player = { 7, 1 };
    snap.navGoal = { -10, 1 };
    Path::Compute(snap, plan);
    Check(plan.navFound && !plan.navPartial, "a player already inside a keep-out can route out of it");
    // Walled corridor fully covered by the keep-out: no route through (the player waits).
    reset();
    for (int x = 0; x <= 16; ++x) for (int y = -1; y <= 1; ++y) cell(x, y) = 0;
    snap.navGoal = { 16, 0 };
    EnemyHazards::Append(snap.map, 0x1234, 100, { 8, 0 }, { 0, 0 }, 4.5f);
    Path::Compute(snap, plan);
    Check(!plan.navFound || plan.navPartial, "with no way round, the route does not cross the keep-out");

    std::printf("Pathing rules tests: %d checks, 0 failures\n", g_checks);
    return 0;
}
