// AutoNexus projectile scan tracks, replayed on the recorded false escape.
//
// Run 004614-discovery, escape 00:53:02.973Z at confirmed 558/615: five Maze
// Minotaur bullets (532, 538, 540, 542, 546) predicted to hit in 14-114 ms; no
// PLAYERHIT followed and HP rose 558 -> 560. Scene 2889 (13 ms before the
// scan): player (1003.547, 1258.854) moving (-2.01, -4.63) tiles/s; the last
// outbound MOVE point (125 ms old) was (1004.075, 1259.606), 0.86 tiles behind.
// Bullet positions/velocities are the scene's runtime-lane trace (first two points).
#include "features/combat/autonexus/AutoNexusDodgePolicy.h"
#include <algorithm>
#include <cmath>
#include <cstdio>

namespace {
struct Bullet { int id; float x, y, vx, vy; };   // tiles, tiles/ms
constexpr float kEffR = 0.5f + 0.2139f + 0.04f;  // hitHalf 0.5 + kPlayerHalf + kNexusHitPadTiles

float FirstHitMs(const Bullet& b, const AutoNexusDodgePolicy::Track& t, float horizonMs)
{
    for (float ms = 0.f; ms <= horizonMs; ms += 2.f) {
        const float dx = (b.x + b.vx * ms) - (t.x + t.vx * ms);
        const float dy = (b.y + b.vy * ms) - (t.y + t.vy * ms);
        if (std::max(std::fabs(dx), std::fabs(dy)) < kEffR) return ms;
    }
    return -1.f;
}
} // namespace

int main()
{
    int n = 0, f = 0;
    auto ck = [&](bool x, const char* m) { ++n; if (!x) { ++f; std::printf("FAIL %s\n", m); } };
    const float px = 1003.547f, py = 1258.854f;
    auto rel = [&](int id, float x0, float y0, float x1, float y1, float stepMs) {
        return Bullet{ id, px + x0, py + y0, (x1 - x0) / stepMs, (y1 - y0) / stepMs };
    };
    const Bullet bullets[] = {
        rel(542, 0.05f, 0.91f, -0.23f, 0.73f, 50.f), rel(540, 0.13f, 0.96f, -0.14f, 0.79f, 50.f),
        rel(538, 0.20f, 1.01f, -0.04f, 0.85f, 50.f), rel(546, 0.91f, 0.86f, 0.88f, 0.74f, 30.f),
        rel(532, -0.59f, 0.87f, -0.66f, 0.75f, 30.f),
    };
    const AutoNexusDodgePolicy::Track local{ px, py, -2.01f / 1000.f, -4.63f / 1000.f };
    const AutoNexusDodgePolicy::Track anchor{ 1004.075f, 1259.606f, -2.01f / 1000.f, -4.63f / 1000.f };

    int anchorHits = 0;
    for (const auto& b : bullets) { const float t = FirstHitMs(b, anchor, 200.f); if (t >= 0.f && t <= 50.f) ++anchorHits; }
    ck(anchorHits >= 4, "the stale MOVE anchor reproduces the recorded 14-44 ms predictions");

    const auto set = AutoNexusDodgePolicy::ProjectileTracks(local);
    int hits = 0;
    for (int i = 0; i < set.count; ++i)
        for (const auto& b : bullets) if (FirstHitMs(b, set.tracks[i], 200.f) >= 0.f) ++hits;
    ck(set.count == 1 && set.tracks[0].x == px && set.tracks[0].y == py, "projectiles are scanned against the live local track only");
    ck(hits == 0, "no recorded bullet is predicted to hit along the player's actual motion");

    std::printf("%d/%d autonexus track checks passed\n", n - f, n);
    return f == 0 ? 0 : 1;
}
