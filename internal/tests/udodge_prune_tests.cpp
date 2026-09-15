// Exact-pruning regression: Core::PointSafety / Core::SegmentSafety must return
// BIT-IDENTICAL values to the unpruned all-lanes loops they replaced. The
// reference implementations below are verbatim copies of the pre-pruning code.
#include "UDodgeCore.h"
#include <cstdio>
#include <cstring>
#include <random>

using namespace UDodge;
static int checks = 0, failures = 0;

namespace Ref {
float LaneDistCheb(const LaneThreat& L, Vec2 p)
{
    const int n = L.instantCount;
    if (n <= 0) return kHugeClearance;
    if (n == 1) return Cheb(L.points[0].x - p.x, L.points[0].y - p.y);
    float best = kHugeClearance;
    for (int j = 0; j + 1 < n; ++j) {
        const Vec2 a = L.points[j];
        const Vec2 b = L.points[j + 1];
        best = std::min(best, MinChebOnSegment(a.x - p.x, a.y - p.y, b.x - p.x, b.y - p.y));
    }
    return best;
}
bool SegmentsIntersect(Vec2 p1, Vec2 p2, Vec2 p3, Vec2 p4)
{
    const auto cross = [](Vec2 o, Vec2 a, Vec2 b) {
        return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    };
    const float d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2);
    const float d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
    return ((d1 > 0.f && d2 < 0.f) || (d1 < 0.f && d2 > 0.f)) &&
           ((d3 > 0.f && d4 < 0.f) || (d3 < 0.f && d4 > 0.f));
}
float SegSegCheb(Vec2 a, Vec2 b, Vec2 p, Vec2 q)
{
    if (SegmentsIntersect(a, b, p, q)) return 0.f;
    float d = MinChebOnSegment(p.x - a.x, p.y - a.y, q.x - a.x, q.y - a.y);
    d = std::min(d, MinChebOnSegment(p.x - b.x, p.y - b.y, q.x - b.x, q.y - b.y));
    d = std::min(d, MinChebOnSegment(a.x - p.x, a.y - p.y, b.x - p.x, b.y - p.y));
    d = std::min(d, MinChebOnSegment(a.x - q.x, a.y - q.y, b.x - q.x, b.y - q.y));
    return d;
}
float PointSegDistEuclid(Vec2 c, Vec2 a, Vec2 b)
{
    const Vec2 ab = Sub(b, a);
    const float l2 = LenSq(ab);
    float t = 0.f;
    if (l2 > 1e-12f) t = std::clamp(Dot(Sub(c, a), ab) / l2, 0.f, 1.f);
    return Len(Sub(c, Add(a, Mul(ab, t))));
}
float Unc(const MapInput& in) { return std::clamp(in.settings.positionUncertainty, 0.f, 0.35f); }
float PointSafety(const MapInput& in, Vec2 pos)
{
    if (!in.map) return 0.f;
    const float hitScale = std::clamp(in.settings.hitScale, 0.25f, 2.5f);
    const float laneHalf = Core::ProjectilePlayerHalf(in.settings) + Unc(in);
    const float zoneHalf = kUPlayerHalf + Unc(in);
    float best = kHugeClearance;
    for (int i = 0; i < in.map->laneCount; ++i) {
        const LaneThreat& L = in.map->lanes[i];
        if (L.instantCount <= 0) continue;
        const float half = std::clamp(L.hitHalf, 0.05f, kUMaxProjectileHalf) * hitScale + laneHalf;
        best = std::min(best, LaneDistCheb(L, pos) - half);
    }
    for (int i = 0; i < in.map->zoneCount; ++i) {
        const ZoneThreat& z = in.map->zones[i];
        if (z.active) best = std::min(best, Len(Sub(z.pos, pos)) - (z.radius + zoneHalf));
    }
    return best;
}
float SegmentSafety(const MapInput& in, Vec2 a, Vec2 b)
{
    if (!in.map) return 0.f;
    const float hitScale = std::clamp(in.settings.hitScale, 0.25f, 2.5f);
    const float laneHalf = Core::ProjectilePlayerHalf(in.settings) + Unc(in);
    const float zoneHalf = kUPlayerHalf + Unc(in);
    float best = kHugeClearance;
    for (int i = 0; i < in.map->laneCount; ++i) {
        const LaneThreat& L = in.map->lanes[i];
        const int n = L.instantCount;
        if (n <= 0) continue;
        const float half = std::clamp(L.hitHalf, 0.05f, kUMaxProjectileHalf) * hitScale + laneHalf;
        float dCheb;
        if (n == 1) {
            dCheb = MinChebOnSegment(L.points[0].x - a.x, L.points[0].y - a.y,
                                     L.points[0].x - b.x, L.points[0].y - b.y);
        } else {
            dCheb = kHugeClearance;
            for (int j = 0; j + 1 < n; ++j)
                dCheb = std::min(dCheb, SegSegCheb(a, b, L.points[j], L.points[j + 1]));
        }
        best = std::min(best, dCheb - half);
    }
    for (int i = 0; i < in.map->zoneCount; ++i) {
        const ZoneThreat& z = in.map->zones[i];
        if (!z.active) continue;
        best = std::min(best, PointSegDistEuclid(z.pos, a, b) - (z.radius + zoneHalf));
    }
    return best;
}
} // namespace Ref

static bool SameBits(float a, float b) { return std::memcmp(&a, &b, sizeof a) == 0; }

int main()
{
    std::mt19937 rng(20260912);
    std::uniform_real_distribution<float> u(0.f, 1.f);
    static DangerMap map{};
    long mismatchPoint = 0, mismatchSeg = 0;
    for (int trial = 0; trial < 200; ++trial) {
        // World origin far from zero on half the trials: realm coordinates reach
        // ~2048 where float rounding is coarsest.
        const Vec2 origin = (trial % 2) ? Vec2{ 1024.f + u(rng) * 1000.f, 1024.f + u(rng) * 1000.f }
                                        : Vec2{ u(rng) * 8.f, u(rng) * 8.f };
        map.laneCount = static_cast<int>(u(rng) * kMaxProjectiles);
        for (int i = 0; i < map.laneCount; ++i) {
            LaneThreat& L = map.lanes[i];
            L = LaneThreat{};
            L.hitHalf = 0.02f + u(rng) * 12.f;
            L.pointCount = 1 + static_cast<int>(u(rng) * kMaxLanePoints);
            L.instantCount = static_cast<int>(u(rng) * (L.pointCount + 1));
            Vec2 p{ origin.x + (u(rng) - 0.5f) * 40.f, origin.y + (u(rng) - 0.5f) * 40.f };
            const float mode = u(rng);
            Vec2 v{ (u(rng) - 0.5f) * 0.8f, (u(rng) - 0.5f) * 0.8f };
            for (int k = 0; k < L.pointCount; ++k) {
                if (mode < 0.1f) v = Vec2{};                              // stationary (speed-0 shot)
                else if (mode < 0.4f) v = Vec2{ v.x * 0.9f - v.y * 0.3f,  // curving
                                                v.y * 0.9f + v.x * 0.3f };
                L.points[k] = p;
                L.pointTimesMs[k] = k * kTraceStepMs;
                p = Add(p, v);
            }
        }
        map.zoneCount = static_cast<int>(u(rng) * 6);
        for (int i = 0; i < map.zoneCount; ++i) {
            map.zones[i].pos = { origin.x + (u(rng) - 0.5f) * 20.f, origin.y + (u(rng) - 0.5f) * 20.f };
            map.zones[i].radius = 0.2f + u(rng) * 4.f;
            map.zones[i].active = u(rng) < 0.6f;
        }
        MapInput in{};
        in.map = &map;
        in.settings.hitScale = 0.25f + u(rng) * 2.f;
        in.settings.positionUncertainty = u(rng) < 0.5f ? 0.f : u(rng) * 0.4f;
        in.settings.pointPlayer = u(rng) < 0.7f;
        for (int q = 0; q < 200; ++q) {
            const Vec2 a{ origin.x + (u(rng) - 0.5f) * 30.f, origin.y + (u(rng) - 0.5f) * 30.f };
            const Vec2 b = q % 5 == 0 ? a : Vec2{ a.x + (u(rng) - 0.5f) * 4.f, a.y + (u(rng) - 0.5f) * 4.f };
            ++checks;
            if (!SameBits(Core::PointSafety(in, a), Ref::PointSafety(in, a))) ++mismatchPoint;
            ++checks;
            if (!SameBits(Core::SegmentSafety(in, a, b), Ref::SegmentSafety(in, a, b))) ++mismatchSeg;
        }
    }
    if (mismatchPoint) { ++failures; std::fprintf(stderr, "FAIL: PointSafety differs in %ld queries\n", mismatchPoint); }
    if (mismatchSeg)   { ++failures; std::fprintf(stderr, "FAIL: SegmentSafety differs in %ld queries\n", mismatchSeg); }
    std::printf("Exact-pruning tests: %d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
