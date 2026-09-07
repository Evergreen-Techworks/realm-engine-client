#pragma once
#include "UDodgeTypes.h"
#include <cmath>

namespace UDodge { namespace Navigation {
constexpr float kWallPadding = 0.15f;
// Only navigation asks for extra clearance. Collision/dodge escape keeps the
// real player footprint, including when the player starts inside the padding.
inline bool PaddedPathClear(const MapInput& in, Vec2 from, Vec2 to)
{
    if (!OccupancyPathClear(in, from, to)) return false;
    for (Vec2 offset : {Vec2{-kWallPadding,-kWallPadding}, Vec2{-kWallPadding,kWallPadding},
                        Vec2{kWallPadding,-kWallPadding}, Vec2{kWallPadding,kWallPadding}}) {
        if (!CanOccupyAt(in, Add(from, offset))) return true; // leave an existing tight spot
    }
    for (Vec2 offset : {Vec2{-kWallPadding,-kWallPadding}, Vec2{-kWallPadding,kWallPadding},
                        Vec2{kWallPadding,-kWallPadding}, Vec2{kWallPadding,kWallPadding}})
        if (!OccupancyPathClear(in, Add(from, offset), Add(to, offset))) return false;
    return true;
}

struct Progress {
    Vec2 anchor{};
    uint64_t since = 0;
    bool active = false;
    void Reset() { active = false; }
    bool Stalled(Vec2 player, uint64_t now) {
        if (!active || LenSq(Sub(player, anchor)) >= 0.25f * 0.25f) {
            anchor = player; since = now; active = true; return false;
        }
        if (now - since < 500) return false;
        anchor = player; since = now;
        return true;
    }
};

// Keep lookahead on the visible part of the corridor. A bend is only skipped
// when the player can sweep directly to the farther target.
template<class Clear>
Vec2 Follow(const Vec2* points, int count, Vec2 player, float lookahead,
            float& outDev, bool& outNearEnd, Clear clear)
{
    outDev = 0.f; outNearEnd = false;
    if (count < 2) return player;
    // Nearest point on the polyline + which segment it's on.
    float bestD2 = 1e18f; int bestSeg = -1; Vec2 bestProj = points[0];
    for (int i = 0; i + 1 < count; ++i) {
        const Vec2 a = points[i], bpt = points[i + 1];
        const Vec2 ab = Sub(bpt, a);
        const float len2 = LenSq(ab);
        const float t = len2 > 1e-6f ? std::clamp(Dot(Sub(player, a), ab) / len2, 0.f, 1.f) : 0.f;
        const Vec2 proj = Add(a, Mul(ab, t));
        const float d2 = LenSq(Sub(player, proj));
        if (d2 < bestD2 && clear(player, proj)) { bestD2 = d2; bestSeg = i; bestProj = proj; }
    }
    outDev = std::sqrt(bestD2);
    if (bestSeg < 0) return player; // disconnected from this corridor: request a replan

    // The projection is verified; the next bend is not. Never return an
    // unchecked bend when lookahead hits a blocked shortcut.
    Vec2 reachable = bestProj;
    // A blocked long shortcut does not imply the whole leg is blocked. Keep
    // the longest verified prefix instead of falling back to the projection
    // (which can be the player's position, producing HOLD until the next replan).
    auto advance = [&](Vec2 candidate) {
        if (clear(player, candidate)) return candidate;
        // Once a clear bend is available, reach it before trying the next leg.
        // Prefix recovery is for the otherwise stationary projection fallback.
        if (LenSq(Sub(reachable, bestProj)) > 1e-6f) return reachable;
        Vec2 low = reachable, high = candidate;
        for (int j = 0; j < 8 && LenSq(Sub(high, low)) > 0.01f * 0.01f; ++j) {
            const Vec2 mid = Mul(Add(low, high), 0.5f);
            if (clear(player, mid)) low = mid;
            else high = mid;
        }
        return low;
    };
    // Walk forward from the projection by `lookahead` tiles along the polyline.
    Vec2 cur = bestProj; float acc = 0.f;
    for (int i = bestSeg + 1; i < count; ++i) {
        const Vec2 w = points[i];
        const float seg = Len(Sub(w, cur));
        if (acc + seg >= lookahead) {
            const float rem = lookahead - acc;
            const Vec2 dir = Normalize(Sub(w, cur));
            const Vec2 candidate = LenSq(dir) > 1e-6f ? Add(cur, Mul(dir, rem)) : w;
            return advance(candidate);
        }
        if (!clear(player, w)) return advance(w);
        reachable = w;
        acc += seg; cur = w;
    }
    // Exhausting lookahead is not arrival. Otherwise short/partial routes are
    // rebuilt every tick, reintroducing start-alignment bends while approaching.
    outNearEnd = LenSq(Sub(player, points[count - 1])) <= kUWalkArriveTiles * kUWalkArriveTiles;
    return reachable;
}
}}
