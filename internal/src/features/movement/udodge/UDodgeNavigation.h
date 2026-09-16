#pragma once
#include "UDodgeTypes.h"
#include <algorithm>
#include <cmath>

namespace UDodge { namespace Navigation {
constexpr float kWallPadding = 0.15f;

inline bool SameRouteRequest(bool assisting, uint64_t epoch, uint64_t goalId,
                             uint64_t previousEpoch, uint64_t previousGoalId)
{
    return assisting && epoch != 0 && goalId != 0 &&
        epoch == previousEpoch && goalId == previousGoalId;
}

inline bool TravelStepConsumed(bool walkTo, bool cacheValid, bool awaiting, bool safeMove,
                               Vec2 player, Vec2 target, Vec2 corridorStep, float frameTiles)
{
    return walkTo && cacheValid && !awaiting && safeMove && frameTiles > 0.f &&
        LenSq(Sub(target, player)) <= 1e-6f &&
        LenSq(Sub(corridorStep, player)) > frameTiles * frameTiles;
}


// Swept walls-only test for the padding offsets (PaddingClearAt at the same
// 0.2-tile sample spacing as OccupancyPathClear).
inline bool PaddingPathClear(const MapInput& in, Vec2 from, Vec2 to)
{
    if (!PaddingClearAt(in, to)) return false;
    const float d = Len(Sub(to, from));
    const int steps = std::max(1, static_cast<int>(std::ceil(d / 0.20f)));
    for (int i = 1; i < steps; ++i) {
        const float t = static_cast<float>(i) / static_cast<float>(steps);
        if (!PaddingClearAt(in, Add(from, Mul(Sub(to, from), t)))) return false;
    }
    return true;
}

// Only navigation asks for extra clearance. Collision/dodge escape keeps the
// real player footprint, including when the player starts inside the padding.
// The centre sweep applies the full occupancy rule; the padded corner sweeps keep
// the player box off walls and nothing more (see PaddingClearAt).
inline bool PaddedPathClear(const MapInput& in, Vec2 from, Vec2 to)
{
    // The game has no player box, so under its rule there is no padding either.
    if (UsesGameRule(in)) return OccupancyPathClear(in, from, to);
    if (!OccupancyPathClear(in, from, to)) return false;
    for (Vec2 offset : {Vec2{-kWallPadding,-kWallPadding}, Vec2{-kWallPadding,kWallPadding},
                        Vec2{kWallPadding,-kWallPadding}, Vec2{kWallPadding,kWallPadding}}) {
        if (!PaddingClearAt(in, Add(from, offset))) return true; // leave an existing tight spot
    }
    for (Vec2 offset : {Vec2{-kWallPadding,-kWallPadding}, Vec2{-kWallPadding,kWallPadding},
                        Vec2{kWallPadding,-kWallPadding}, Vec2{kWallPadding,kWallPadding}})
        if (!PaddingPathClear(in, Add(from, offset), Add(to, offset))) return false;
    return true;
}

// Does the straight sweep from→to keep the player box out of every remembered
// stuck square (centres in `avoid`, one tile each)? The route follower's shortcuts
// must honour stuck memory too, or its lookahead cuts straight back across the
// square the re-plan just routed around.
inline bool AvoidClear(const Vec2* avoid, int count, Vec2 from, Vec2 to)
{
    if (count <= 0) return true;
    constexpr float reach = 0.5f + kUOccPlayerHalfEdge;
    const auto inside = [&](Vec2 p, int a) {
        return std::fabs(p.x - avoid[a].x) < reach && std::fabs(p.y - avoid[a].y) < reach;
    };
    const float d = Len(Sub(to, from));
    const int steps = std::max(1, static_cast<int>(std::ceil(d / 0.20f)));
    for (int i = 1; i <= steps; ++i) {
        const Vec2 p = Add(from, Mul(Sub(to, from), static_cast<float>(i) / static_cast<float>(steps)));
        for (int a = 0; a < count; ++a) {
            // A remembered square the player already stands within reach of must not
            // block leaving it — the same escape rule zones and enemy bodies use. The
            // game's collision is a point test, so the player is pushed right up to
            // the square that refused it (0.01 away), inside this reach; without the
            // exception every leg, even one leading away, was refused and the follower
            // held there forever while the planner kept re-routing.
            if (inside(from, a)) continue;
            if (inside(p, a)) return false;
        }
    }
    return true;
}

struct Progress {
    Vec2 anchor{};
    uint64_t since = 0;
    bool active = false;
    void Reset() { active = false; }
    bool Stalled(Vec2 player, uint64_t now, bool waitingForRoute = false) {
        if (waitingForRoute) { Reset(); return false; }
        if (!active || LenSq(Sub(player, anchor)) >= 0.25f * 0.25f) {
            anchor = player; since = now; active = true; return false;
        }
        if (now - since < 500) return false;
        anchor = player; since = now;
        return true;
    }
};

// Resolve navigation after the asynchronous route cache has been refreshed.
// The pre-refresh awaiting flag is useful only for detecting transitions; it
// must not overwrite a newly delivered corridor with a HOLD at the player.
struct Handoff {
    Vec2 step{};
    bool solve = false;
};
inline Handoff FinishRefresh(bool walkTo, bool wasWaiting, bool awaiting,
                             bool cacheValid, Vec2 player, Vec2 corridorStep,
                             bool cadenceDue, bool commitmentChanged, bool rejectedFreshWalk,
                             bool steeringChanged = false)
{
    Handoff out;
    out.step = awaiting ? player : corridorStep;
    out.solve = commitmentChanged || (walkTo && (
        steeringChanged ||
        (awaiting && (!wasWaiting || cadenceDue)) ||
        (wasWaiting && !awaiting) ||
        (cadenceDue && (!cacheValid || rejectedFreshWalk))));
    return out;
}

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
