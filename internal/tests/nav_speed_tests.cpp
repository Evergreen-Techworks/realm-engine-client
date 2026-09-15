// Movement::Speed — one speed model for steps and route times (navigation rebuild Stage 1).
#include "features/movement/nav/Speed.h"
#include "features/movement/dodge/MovementSpeed.h"
#include "features/movement/sensors/TileOccupancy.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace S = Movement::Speed;
namespace TO = Movement::TileOccupancy;

namespace {
int g_checks = 0;
void Check(bool ok, const char* name)
{
    ++g_checks;
    if (!ok) { std::fprintf(stderr, "FAIL: %s\n", name); std::exit(1); }
}
bool Near(float a, float b, float eps = 1e-4f) { return std::fabs(a - b) <= eps; }
} // namespace

int main()
{
    // ── GroundFlags marks the squares whose <Speed> the rasters must copy ───────
    Check((TO::GroundFlags(false, false, 0.666f, true, false) & TO::kTileSpeedMod) != 0,
          "a square with <Speed> 0.666 is marked for the speed copy");
    Check((TO::GroundFlags(false, false, 0.f, false, false) & TO::kTileSpeedMod) == 0,
          "plain ground (no <Speed>) is not");
    Check((TO::GroundFlags(false, false, 1.f, false, false) & TO::kTileSpeedMod) == 0,
          "and neither is <Speed>1</Speed>");

    // ── Tile factor: WorldTAB stores 0 for "no <Speed>" ────────────────────────
    Check(S::TileFactor(0.f) == 1.f, "no <Speed> element walks at x1");
    Check(S::TileFactor(0.666f) == 0.666f, "Shallow Water keeps its 0.666");
    Check(S::TileFactor(NAN) == 1.f && S::TileFactor(-1.f) == 1.f && S::TileFactor(9.f) == 1.f,
          "a malformed <Speed> falls back to x1");

    // ── TilesPerSec(pos, conditions) = EffectiveTilesPerSec x <Speed> at pos ────
    DodgeRuntime::SpeedSample s{};
    s.clientSpd = 75; s.conditionsKnown = true;
    s.tileMultiplier = 0.666f;                                   // standing in shallow water
    const float onWater = DodgeRuntime::EffectiveTilesPerSec(s);  // 9.6 x 0.666
    const float base = S::BaseTilesPerSec(onWater, 0.666f);
    Check(Near(base, 9.6f), "the base speed divides the player's own square back out");
    Check(Near(S::TilesPerSec(base, 0.666f), onWater), "on its own square the speed is EffectiveTilesPerSec");
    Check(Near(S::TilesPerSec(base, 0.f), 9.6f), "the dry square next to it is full speed");

    s.cond0 = DodgeRuntime::kCondSlowed;                         // Slowed x water
    const float slowedWater = DodgeRuntime::EffectiveTilesPerSec(s);
    const float slowedBase = S::BaseTilesPerSec(slowedWater, 0.666f);
    Check(Near(slowedBase, 4.f), "Slowed pins the base at 4 tiles/s");
    Check(Near(S::TilesPerSec(slowedBase, 0.666f), 4.f * 0.666f), "Slowed and water compose");

    s.cond0 = DodgeRuntime::kCondSpeedy; s.tileMultiplier = 1.f;
    s.gameTilesPerMs = 0.0096f * 1.5f;                           // the game's getter confirms Speedy
    const float speedy = DodgeRuntime::EffectiveTilesPerSec(s);
    Check(Near(S::BaseTilesPerSec(speedy, 0.f), 14.4f), "Speedy confirmed by the game widens the base x1.5");

    s.cond0 = DodgeRuntime::kCondParalyzed; s.gameTilesPerMs = -1.f;
    Check(S::BaseTilesPerSec(DodgeRuntime::EffectiveTilesPerSec(s), 0.f) == 0.f, "Paralyzed has no base speed");
    Check(S::TilesPerSec(0.f, 0.666f) == 0.f && S::TilesPerSec(NAN, 1.f) == 0.f, "no base, no speed anywhere");

    // ── Route time over an edge between two squares ────────────────────────────
    const float perMs = 9.6f / 1000.f;
    Check(Near(S::EdgeMs(perMs, 1.f, 1.f, 0.5f), 0.5f / perMs, 1e-2f), "a dry edge is length / speed");
    Check(Near(S::EdgeMs(perMs, 0.5f, 0.5f, 0.5f), 1.f / perMs, 1e-2f), "a half-speed edge takes twice as long");
    Check(Near(S::EdgeMs(perMs, 1.f, 0.5f, 1.f), 0.5f / perMs + 1.f / perMs, 1e-2f),
          "dry to half-speed: half the length at each speed");
    Check(std::isinf(S::EdgeMs(0.f, 1.f, 1.f, 1.f)), "no base speed: the edge is never reached");

    std::printf("Speed model tests: %d checks, 0 failures\n", g_checks);
    return 0;
}
