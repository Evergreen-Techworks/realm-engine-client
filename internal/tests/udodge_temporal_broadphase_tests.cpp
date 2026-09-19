// Differential regression for the Core::Temporal lane queries (TimeToDanger / PathClear,
// ArrivalClear, EdgeClear). They may skip work only where the answer is provably "no
// contact", so every answer must equal the plain all-lanes code they started from.
//
// Ref:: below is that code: UDodgeCore.cpp at 2be5472, the last commit before any
// broad phase, copied function by function with comment-only lines dropped and two
// calls qualified (Ref::BulletPosAt, Ref::ArrivalClear) so argument-dependent lookup
// cannot reach the production overloads. Both sides read the SAME context, built by
// the production Build(), so only the queries are under test.
//
// Seeded and reproducible: mt19937 with a hand-rolled float draw, no <random>
// distributions (their sequences differ between standard libraries).
//   udodge_temporal_broadphase_tests [seed] [trials]
#include "UDodgeCore.h"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <random>

using namespace UDodge;

namespace Ref {
using namespace UDodge::Core::Temporal;

bool SegmentsIntersect(Vec2 p1, Vec2 p2, Vec2 p3, Vec2 p4)
{
    const auto cross = [](Vec2 o, Vec2 a, Vec2 b) {
        return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    };
    const float d1 = cross(p3, p4, p1);
    const float d2 = cross(p3, p4, p2);
    const float d3 = cross(p1, p2, p3);
    const float d4 = cross(p1, p2, p4);
    return ((d1 > 0.f && d2 < 0.f) || (d1 < 0.f && d2 > 0.f)) &&
           ((d3 > 0.f && d4 < 0.f) || (d3 < 0.f && d4 > 0.f));
}

float SegSegCheb(Vec2 a, Vec2 b, Vec2 p, Vec2 q)
{
    if (SegmentsIntersect(a, b, p, q)) return 0.f;
    float d = MinChebOnSegment(p.x - a.x, p.y - a.y, q.x - a.x, q.y - a.y);   // a → seg pq
    d = std::min(d, MinChebOnSegment(p.x - b.x, p.y - b.y, q.x - b.x, q.y - b.y)); // b → seg pq
    d = std::min(d, MinChebOnSegment(a.x - p.x, a.y - p.y, b.x - p.x, b.y - p.y)); // p → seg ab
    d = std::min(d, MinChebOnSegment(a.x - q.x, a.y - q.y, b.x - q.x, b.y - q.y)); // q → seg ab
    return d;
}

static bool TracedPathClear(const Ctx& c, int li, Vec2 a, Vec2 b, float half)
{
    const int n = c.trust[li];
    if (n <= 0) {   // nothing traced at all (single-point lane): the live disc
        return MinChebOnSegment(c.pos[li][0].x - a.x, c.pos[li][0].y - a.y,
                                c.pos[li][0].x - b.x, c.pos[li][0].y - b.y) > half;
    }
    for (int j = 0; j < n; ++j)
        if (SegSegCheb(a, b, c.pos[li][j], c.pos[li][j + 1]) <= half) return false;
    return true;
}

Vec2 BulletPosAt(const Ctx& c, int li, float tMs)
{
    if (tMs <= 0.f)          return c.pos[li][0];
    if (tMs >= kHorizonMs)   return c.pos[li][kUTemporalSteps];
    const float g = tMs / kUTemporalStepMs;
    const int   k = static_cast<int>(g);
    const float f = g - static_cast<float>(k);
    return Add(c.pos[li][k], Mul(Sub(c.pos[li][k + 1], c.pos[li][k]), f));
}

static Vec2 BulletPosFine(const Ctx& c, int li, float tMs)
{
    if (!c.sub[li])          return Ref::BulletPosAt(c, li, tMs);
    if (tMs <= 0.f)          return c.pos[li][0];
    if (tMs >= kHorizonMs)   return c.pos[li][kUTemporalSteps];
    const float h = kUTemporalStepMs * 0.5f;
    const float g = tMs / h;
    int         j = static_cast<int>(g);                 // half-step index
    if (j >= 2 * kUTemporalSteps) j = 2 * kUTemporalSteps - 1;   // defensive; g < 2·steps above
    const float f = std::clamp(g - static_cast<float>(j), 0.f, 1.f);
    const int   k = j >> 1;
    const Vec2  a = (j & 1) ? c.mid[li][k] : c.pos[li][k];
    const Vec2  b = (j & 1) ? c.pos[li][k + 1] : c.mid[li][k];
    return Add(a, Mul(Sub(b, a), f));
}

static inline Vec2 BulletInStep(const Ctx& c, int li, int k, float f)
{
    if (f <= 0.f) return c.pos[li][k];
    if (f >= 1.f) return c.pos[li][k + 1];
    if (c.sub[li]) {
        const Vec2 a = (f <= 0.5f) ? c.pos[li][k]   : c.mid[li][k];
        const Vec2 b = (f <= 0.5f) ? c.mid[li][k]   : c.pos[li][k + 1];
        const float g = (f <= 0.5f) ? (f * 2.f) : ((f - 0.5f) * 2.f);
        return Add(a, Mul(Sub(b, a), g));
    }
    const Vec2 a = c.pos[li][k];
    const Vec2 b = c.pos[li][k + 1];
    return Add(a, Mul(Sub(b, a), f));
}

static float ExpiryMs(const Ctx& c, int li)
{
    return c.expiresMs[li] > 0.f ? c.expiresMs[li] : kHugeClearance;
}

float TimeToDanger(const Ctx& c, Vec2 player, float speed, Vec2 P, float scanUntilMs)
{
    const Vec2  to = Sub(P, player);
    const float dist = Len(to);
    const Vec2  dir = dist > 1e-4f ? Mul(to, 1.f / dist) : Vec2{};
    const float v = speed;   // tiles/ms
    const float tArrive = (v > 1e-6f) ? dist / v : (dist > 1e-4f ? kHugeClearance : 0.f);
    const float tEnd = std::min(std::max(scanUntilMs, 0.f), kHorizonMs);

    const auto playerAt = [&](float t) -> Vec2 {
        return (t >= tArrive) ? P : Add(player, Mul(dir, v * t));
    };

    for (int k = 0; k < kUTemporalSteps; ++k) {
        const float t0 = static_cast<float>(k) * kUTemporalStepMs;
        if (t0 >= tEnd) break;                       // past the scanned window
        const float t1 = t0 + kUTemporalStepMs;

        const float tMid = t0 + kUTemporalStepMs * 0.5f;
        const bool  useArr = (tArrive > t0 && tArrive < t1);
        float ts[4]; Vec2 ps[4]; bool isMid[4];
        int   n = 0;
        ts[n] = t0;                                         isMid[n] = false; ++n;
        if (useArr && tArrive <  tMid) { ts[n] = tArrive;    isMid[n] = false; ++n; }
        ts[n] = tMid;                                       isMid[n] = true;  ++n;
        if (useArr && tArrive >= tMid) { ts[n] = tArrive;    isMid[n] = false; ++n; }
        ts[n] = t1;                                         isMid[n] = false; ++n;
        for (int i = 0; i < n; ++i) {
            ps[i] = playerAt(ts[i]);
        }

        for (int li = 0; li < c.count; ++li) {
            const float expiry = ExpiryMs(c, li);
            if (t0 >= expiry) continue;
            if (c.beam[li]) {
                const float end = std::min({t1, tEnd, expiry});
                if (!TracedPathClear(c, li, playerAt(t0), playerAt(end), c.half[li] + c.arrPad[li])) return t0;
                continue;
            }
            const int trust = c.trust[li];
            if (k > trust) continue;                 // untrusted tail already judged at k == trust
            const float half = c.half[li] + c.arrPad[li];   // speed-scaled (kUPredErrMs)
            if (k == trust) {
                Vec2 pa = ps[0];
                const float tailEnd = std::min(tEnd, expiry);
                if (tArrive > t0 && tArrive < tailEnd) {
                    if (!TracedPathClear(c, li, pa, P, half)) return t0;
                    pa = P;
                }
                if (!TracedPathClear(c, li, pa, playerAt(tailEnd), half)) return t0;
                continue;
            }
            const bool useMid = c.sub[li];
            Vec2 pPrev = ps[0];
            Vec2 bPrev = BulletInStep(c, li, k, 0.f);
            for (int i = 1; i < n; ++i) {
                if (isMid[i] && !useMid) continue;   // slow lane: one chord across the step
                const float curTime = std::min(ts[i], expiry);
                const Vec2 pCur = curTime == ts[i] ? ps[i] : playerAt(curTime);
                const Vec2 bCur = BulletInStep(c, li, k, (curTime - t0) / kUTemporalStepMs);
                if (MinChebOnSegment(bPrev.x - pPrev.x, bPrev.y - pPrev.y,
                                     bCur.x  - pCur.x,  bCur.y  - pCur.y) <= half) return t0;
                pPrev = pCur; bPrev = bCur;
                if (curTime >= expiry) break;
            }
        }
    }
    return kNoDanger;
}

bool ArrivalClear(const Ctx& c, Vec2 B, float tA, float tB)
{
    for (int li = 0; li < c.count; ++li) {
        const float laneEnd = std::min(tB, ExpiryMs(c, li));
        if (tA >= ExpiryMs(c, li)) continue;
        const float half = c.half[li] + c.arrPad[li];   // speed-scaled (kUPredErrMs)
        if (c.beam[li]) {
            if (!TracedPathClear(c, li, B, B, half)) return false;
            continue;
        }
        if (c.trust[li] < kUTemporalSteps) {
            const float tTrust = static_cast<float>(c.trust[li]) * kUTemporalStepMs;
            if (laneEnd > tTrust && !TracedPathClear(c, li, B, B, half)) return false;
        }
        const float dt = c.sub[li] ? kUTemporalStepMs * 0.5f : kUTemporalStepMs;
        float t = std::max(tA, 0.f);
        const float tEnd = std::min(std::max(laneEnd, t), kHorizonMs);
        Vec2  prev = BulletPosFine(c, li, t);
        bool  tested = false;
        for (int guard = 0; guard < 2 * kUTemporalSteps + 2 && t < tEnd; ++guard) {
            float tn = (std::floor(t / dt) + 1.f) * dt;
            if (tn > tEnd || tn <= t) tn = tEnd;
            const Vec2 cur = BulletPosFine(c, li, tn);
            if (MinChebOnSegment(prev.x - B.x, prev.y - B.y,
                                 cur.x  - B.x, cur.y  - B.y) <= half) return false;
            prev   = cur;
            t      = tn;
            tested = true;
        }
        if (!tested && Cheb(prev.x - B.x, prev.y - B.y) <= half) return false;
        if (laneEnd > kHorizonMs) {
            const Vec2 bFrozen = c.pos[li][kUTemporalSteps];
            if (Cheb(bFrozen.x - B.x, bFrozen.y - B.y) <= half) return false;
        }
    }
    return true;
}

bool EdgeClear(const Ctx& c, Vec2 A, Vec2 B, float tA, float tB)
{
    if (!(tB > tA)) return Ref::ArrivalClear(c, B, tA, tB);
    const auto playerAt = [&](float t) -> Vec2 {
        const float f = std::clamp((t - tA) / (tB - tA), 0.f, 1.f);
        return Add(A, Mul(Sub(B, A), f));
    };

    for (int li = 0; li < c.count; ++li) {
        const float laneEnd = std::min(tB, ExpiryMs(c, li));
        if (tA >= ExpiryMs(c, li)) continue;
        const float half = c.half[li] + c.arrPad[li];
        if (c.beam[li]) {
            if (!TracedPathClear(c, li, A, playerAt(laneEnd), half)) return false;
            continue;
        }
        const float tTrust = static_cast<float>(c.trust[li]) * kUTemporalStepMs;
        const float trustedEnd = std::min(laneEnd, tTrust);

        float t = std::max(tA, 0.f);
        const float tEnd = std::min(std::max(trustedEnd, t), kHorizonMs);
        Vec2 pPrev = playerAt(t);
        Vec2 bPrev = BulletPosFine(c, li, t);
        const float dt = c.sub[li] ? kUTemporalStepMs * 0.5f : kUTemporalStepMs;
        for (int guard = 0; guard < 2 * kUTemporalSteps + 2 && t < tEnd; ++guard) {
            float tn = (std::floor(t / dt) + 1.f) * dt;
            if (tn > tEnd || tn <= t) tn = tEnd;
            const Vec2 pCur = playerAt(tn);
            const Vec2 bCur = BulletPosFine(c, li, tn);
            if (MinChebOnSegment(bPrev.x - pPrev.x, bPrev.y - pPrev.y,
                                 bCur.x  - pCur.x,  bCur.y  - pCur.y) <= half) return false;
            pPrev = pCur;
            bPrev = bCur;
            t = tn;
        }

        if (laneEnd > tTrust) {
            const Vec2 u0 = playerAt(std::max(tA, tTrust));
            if (!TracedPathClear(c, li, u0, playerAt(laneEnd), half)) return false;
        }
        if (tA >= kHorizonMs) {
            const Vec2 frozen = c.pos[li][kUTemporalSteps];
            if (MinChebOnSegment(frozen.x - A.x, frozen.y - A.y,
                                 frozen.x - playerAt(laneEnd).x, frozen.y - playerAt(laneEnd).y) <= half) return false;
        }
    }
    return true;
}

bool PathClear(const Ctx& c, Vec2 player, float speed, Vec2 P, float dwellMs)
{
    const float window = DwellWindowMs(player, speed, P, dwellMs);
    return Ref::TimeToDanger(c, player, speed, P, window) == kNoDanger;
}
} // namespace Ref

namespace {
namespace T = UDodge::Core::Temporal;

struct Rng {
    std::mt19937 g;
    explicit Rng(uint32_t seed) : g(seed) {}
    float U() { return static_cast<float>(g() >> 8) * (1.f / 16777216.f); }   // [0, 1)
    float R(float a, float b) { return a + (b - a) * U(); }
    int   I(int a, int b) { return a + static_cast<int>(g() % static_cast<uint32_t>(b - a + 1)); }   // inclusive
    bool  P(float p) { return U() < p; }
    Vec2  Dir() { const float a = R(0.f, 6.2831853f); return { std::cos(a), std::sin(a) }; }
};

constexpr float kNaN = std::numeric_limits<float>::quiet_NaN();
constexpr float kInf = std::numeric_limits<float>::infinity();

// One lane of a random kind. Speeds are tiles/ms. `hostile` plants NaN / infinity.
// `bigShots` is the share of lanes with a contact half above one tile, up to and past
// kUMaxProjectileHalf. Most trials keep it at zero: one 16-tile shot blocks the whole
// region, and a set that is all "in contact" cannot show a wrongly skipped lane.
void MakeLane(Rng& r, Vec2 origin, float region, bool hostile, float bigShots, LaneThreat& L)
{
    L = LaneThreat{};
    if (r.P(bigShots)) {
        const float hh = r.U();
        L.hitHalf = hh < 0.5f ? r.R(1.f, 4.f)
                  : hh < 0.8f ? r.R(4.f, kUMaxProjectileHalf)
                  : hh < 0.9f ? kUMaxProjectileHalf
                              : r.R(kUMaxProjectileHalf, 24.f);   // clamped by Build
    } else {
        L.hitHalf = r.P(0.95f) ? r.R(0.1f, 0.8f) : r.R(0.f, 0.05f);   // the low end is clamped by Build
    }
    const Vec2 p0{ origin.x + r.R(-region, region), origin.y + r.R(-region, region) };
    const int kind = r.I(0, 10);
    const Vec2 dir = kind == 3 ? Vec2{ r.P(0.5f) ? 1.f : -1.f, 0.f }
                   : kind == 4 ? Vec2{ 0.f, r.P(0.5f) ? 1.f : -1.f } : r.Dir();
    const Vec2 perp{ -dir.y, dir.x };
    const float speed = kind == 2 ? r.R(0.012f, 0.030f)      // fast aimed shot: half-step samples
                      : (kind == 3 || kind == 4) ? r.R(0.003f, 0.020f)
                      : r.R(0.002f, 0.010f);
    const float amp = r.R(0.3f, 1.5f), hz = r.R(1.5f, 6.f), phase = r.R(0.f, 6.28f);
    const float omega = r.R(1.f, 8.f) * (r.P(0.5f) ? 1.f : -1.f) / 1000.f;   // rad/ms
    const float reach = r.R(2.f, 9.f);
    const auto at = [&](float t) -> Vec2 {
        switch (kind) {
        case 5: {   // wavy
            const float s = amp * std::sin(6.2831853f * hz * t / 1000.f + phase);
            return { p0.x + dir.x * speed * t + perp.x * s, p0.y + dir.y * speed * t + perp.y * s };
        }
        case 6: {   // curving: the velocity turns at omega
            const float a = omega * t, rad = speed / std::fabs(omega);
            return { p0.x + rad * (dir.x * std::sin(a) + perp.x * (1.f - std::cos(a))),
                     p0.y + rad * (dir.y * std::sin(a) + perp.y * (1.f - std::cos(a))) };
        }
        case 7: {   // boomerang: out and back inside the trace
            const float s = reach * std::sin(3.1415927f * t / 1000.f);
            return { p0.x + dir.x * s, p0.y + dir.y * s };
        }
        case 8: case 9: return p0;   // stationary, single point
        default: return { p0.x + dir.x * speed * t, p0.y + dir.y * speed * t };
        }
    };
    if (kind == 9) {
        L.pointCount = 1;
    } else if (kind == 10) {   // beam: every point occupied at once
        L.beam = true;
        L.pointCount = r.I(2, 6);
    } else {
        L.pointCount = r.P(0.7f) ? kMaxLanePoints : r.I(2, kMaxLanePoints - 1);
    }
    L.instantCount = L.pointCount;
    const float step = r.P(0.9f) ? kTraceStepMs : r.R(20.f, 120.f);
    const float reanchor = r.P(0.2f) ? r.R(0.f, step) : 0.f;   // a re-anchored lane: short first segment
    for (int k = 0; k < L.pointCount; ++k) {
        const float t = k == 0 ? 0.f : std::max(0.f, k * step - reanchor);
        L.pointTimesMs[k] = t;
        L.points[k] = kind == 10 ? Vec2{ p0.x + dir.x * reach * k, p0.y + dir.y * reach * k } : at(t);
    }
    const float traced = L.pointTimesMs[L.pointCount - 1];
    const float life = r.U();
    L.remainingLifeMs = life < 0.55f ? -1.f : life < 0.90f ? r.R(0.f, 1400.f) : traced;
    L.tailAtShotEnd = r.P(0.5f);
    if (hostile) {
        const int k = r.I(0, L.pointCount - 1);
        switch (r.I(0, 5)) {
        case 0: L.points[k].x = kNaN; break;
        case 1: L.points[k].y = kNaN; break;
        case 2: L.points[k].x = r.P(0.5f) ? kInf : -kInf; break;
        case 3: L.points[k].y = r.P(0.5f) ? kInf : -kInf; break;
        case 4: L.hitHalf = kNaN; break;
        default: L.hitHalf = kInf; break;
        }
    }
}

struct Tally { long n = 0, blocked = 0, mismatch = 0; };
Tally edge, arrival, ttd, path, hostileTally;
int printed = 0;

bool SameBits(float a, float b) { return std::memcmp(&a, &b, sizeof a) == 0; }

void Report(const char* what, const T::Ctx& c, Vec2 a, Vec2 b, float t0, float t1, float got, float want)
{
    if (printed++ >= 12) return;
    std::fprintf(stderr, "  MISMATCH %s lanes=%d A=(%.9g,%.9g) B=(%.9g,%.9g) t=[%.9g,%.9g] got=%.9g want=%.9g\n",
                 what, c.count, a.x, a.y, b.x, b.y, t0, t1, got, want);
}

void CheckEdge(const T::Ctx& c, Vec2 A, Vec2 B, float tA, float tB, Tally& tally)
{
    const bool want = Ref::EdgeClear(c, A, B, tA, tB), got = T::EdgeClear(c, A, B, tA, tB);
    ++tally.n; tally.blocked += !want;
    if (got != want) { ++tally.mismatch; Report("EdgeClear", c, A, B, tA, tB, got, want); }
}
void CheckArrival(const T::Ctx& c, Vec2 B, float tA, float tB, Tally& tally)
{
    const bool want = Ref::ArrivalClear(c, B, tA, tB), got = T::ArrivalClear(c, B, tA, tB);
    ++tally.n; tally.blocked += !want;
    if (got != want) { ++tally.mismatch; Report("ArrivalClear", c, B, B, tA, tB, got, want); }
}
void CheckTtd(const T::Ctx& c, Vec2 player, float speed, Vec2 P, float scan, Tally& tally)
{
    const float want = Ref::TimeToDanger(c, player, speed, P, scan), got = T::TimeToDanger(c, player, speed, P, scan);
    ++tally.n; tally.blocked += want != T::kNoDanger;
    if (!SameBits(got, want)) { ++tally.mismatch; Report("TimeToDanger", c, player, P, speed, scan, got, want); }
}
void CheckPath(const T::Ctx& c, Vec2 player, float speed, Vec2 P, float dwell, Tally& tally)
{
    const bool want = Ref::PathClear(c, player, speed, P, dwell), got = T::PathClear(c, player, speed, P, dwell);
    ++tally.n; tally.blocked += !want;
    if (got != want) { ++tally.mismatch; Report("PathClear", c, player, P, speed, dwell, got, want); }
}

// A point near where lane `li` is at time t: offsets are drawn around the lane's own
// contact size, so the set is dense exactly where a too-small margin would show.
Vec2 NearLane(Rng& r, const T::Ctx& c, int li, float t)
{
    Vec2 bp = Ref::BulletPosAt(c, li, t);
    if (c.beam[li]) {
        const float f = r.U();
        bp = { c.pos[li][0].x + (c.pos[li][1].x - c.pos[li][0].x) * f, c.pos[li][0].y + (c.pos[li][1].y - c.pos[li][0].y) * f };
    }
    const float H = c.half[li] + c.arrPad[li];
    Vec2 off{ r.R(-2.5f, 2.5f) * H, r.R(-2.5f, 2.5f) * H };
    if (r.P(0.35f)) {   // hug the contact boundary on one axis
        const float edgeOff = (r.P(0.5f) ? 1.f : -1.f) * H * r.R(0.97f, 1.03f);
        if (r.P(0.5f)) off = { edgeOff, r.R(-1.f, 1.f) * H }; else off = { r.R(-1.f, 1.f) * H, edgeOff };
    }
    return { bp.x + off.x, bp.y + off.y };
}

constexpr Vec2 kLattice[8] = { {1,0},{-1,0},{0,1},{0,-1},{0.70710678f,0.70710678f},{-0.70710678f,0.70710678f},
                               {0.70710678f,-0.70710678f},{-0.70710678f,-0.70710678f} };

float HostileFloat(Rng& r, float v)
{
    switch (r.I(0, 3)) { case 0: return kNaN; case 1: return kInf; case 2: return -kInf; default: return v; }
}
// Edge and arrival TIMES are never NaN here: the code under test (before and after)
// turns a NaN time into an array index in BulletPosAt / BulletPosFine, which is
// undefined behaviour, so there is no reference answer to compare against.
float HostileTime(Rng& r, float v)
{
    switch (r.I(0, 2)) { case 0: return kInf; case 1: return -kInf; default: return v; }
}
} // namespace

int main(int argc, char** argv)
{
    const uint32_t seed = argc > 1 ? static_cast<uint32_t>(std::strtoul(argv[1], nullptr, 10)) : 20260918u;
    const int trials = argc > 2 ? std::atoi(argv[2]) : 320;
    Rng r(seed);
    static DangerMap map{};
    static T::Ctx ctx;
    long lanesBuilt = 0, subLanes = 0, shortLanes = 0, beams = 0, expiring = 0;

    for (int trial = 0; trial < trials; ++trial) {
        // Realm coordinates reach ~2048, where float rounding is coarsest.
        const Vec2 origin = (trial % 2) ? Vec2{ 1024.f + r.U() * 1000.f, 1024.f + r.U() * 1000.f }
                                        : Vec2{ r.U() * 8.f, r.U() * 8.f };
        const bool hostile = trial % 16 == 15;
        const float region = r.R(4.f, 24.f);
        map.laneCount = trial % 32 == 31 ? kMaxProjectiles : trial % 40 == 0 ? 0 : r.I(1, 90);
        const float bigShots = trial % 4 == 3 ? r.R(0.02f, 0.5f) : 0.f;
        for (int i = 0; i < map.laneCount; ++i)
            MakeLane(r, origin, region, hostile && r.P(0.15f), bigShots, map.lanes[i]);
        const int hs = r.I(0, 4);
        const float hitScale = hs == 0 ? 0.65f : hs == 1 ? 1.f : hs == 2 ? r.R(0.25f, 2.5f) : hs == 3 ? 3.f : 0.1f;
        const float uncertainty = r.P(0.5f) ? 0.f : r.R(0.f, 0.4f);
        const float playerHalf = r.P(0.5f) ? 0.f : kUPlayerHalf;
        const float cull = r.P(0.3f) ? kUTemporalCullTiles : r.P(0.5f) ? 20.5f : 60.f;
        T::Build(map, hitScale, uncertainty, origin, cull, ctx, playerHalf);
        lanesBuilt += ctx.count;
        for (int i = 0; i < ctx.count; ++i) {
            subLanes += ctx.sub[i]; beams += ctx.beam[i];
            shortLanes += ctx.trust[i] < kUTemporalSteps;
            expiring += ctx.expiresMs[i] > 0.f && ctx.expiresMs[i] < T::kHorizonMs;
        }
        Tally& e = hostile ? hostileTally : edge;
        Tally& a = hostile ? hostileTally : arrival;
        Tally& d = hostile ? hostileTally : ttd;
        Tally& p = hostile ? hostileTally : path;
        const int queries = ctx.count > 200 ? 250 : 1100;
        for (int q = 0; q < queries; ++q) {
            const bool aimed = ctx.count > 0 && r.P(0.8f);
            const int   li = aimed ? r.I(0, ctx.count - 1) : 0;
            const float tStar = r.P(0.2f) ? 100.f * r.I(0, 9) : r.R(-100.f, 1400.f);
            Vec2 anchor = aimed ? NearLane(r, ctx, li, tStar)
                                : Vec2{ origin.x + r.R(-region, region), origin.y + r.R(-region, region) };
            if (hostile && r.P(0.05f)) anchor.x = HostileFloat(r, anchor.x);
            if (hostile && r.P(0.05f)) anchor.y = HostileFloat(r, anchor.y);

            // ── EdgeClear ──
            {
                const float v = r.R(0.004f, 0.012f);
                const int mode = r.I(0, 9);
                Vec2 A, B; float tA, tB;
                if (mode <= 4) {           // a lattice step that passes the anchor at tStar
                    const Vec2 dir = kLattice[r.I(0, 7)];
                    const float len = (dir.x != 0.f && dir.y != 0.f) ? kUPathCellTiles * kUPathRoot2 : kUPathCellTiles;
                    const float f = r.U(), dur = len / v;
                    A = { anchor.x - dir.x * len * f, anchor.y - dir.y * len * f };
                    B = { A.x + dir.x * len, A.y + dir.y * len };
                    tA = mode == 4 ? 100.f * r.I(0, 9) : tStar - f * dur;
                    tB = tA + dur;
                } else if (mode == 5 || mode == 6) {   // zero-length edge: a wait
                    A = B = anchor;
                    tA = tStar - r.R(0.f, 100.f);
                    tB = tA + (mode == 5 ? kUTemporalStepMs : 2.f * kUTemporalStepMs);
                } else if (mode == 7) {    // degenerate or reversed window
                    const Vec2 dir = r.Dir();
                    A = anchor; B = { A.x + dir.x * 0.5f, A.y + dir.y * 0.5f };
                    tA = tStar; tB = r.P(0.5f) ? tA : tA - r.R(0.f, 200.f);
                } else {                   // a long free edge, any window, also past the horizon
                    const Vec2 dir = r.Dir();
                    const float len = r.R(0.f, 4.f), f = r.U();
                    A = { anchor.x - dir.x * len * f, anchor.y - dir.y * len * f };
                    B = { A.x + dir.x * len, A.y + dir.y * len };
                    tA = tStar - r.R(0.f, 300.f); tB = tA + r.R(0.f, 600.f);
                }
                if (hostile && r.P(0.03f)) tA = HostileTime(r, tA);
                if (hostile && r.P(0.03f)) tB = HostileTime(r, tB);
                CheckEdge(ctx, A, B, tA, tB, e);
            }
            // ── ArrivalClear ──
            {
                const int mode = r.I(0, 5);
                float tA = mode == 0 ? 100.f * r.I(0, 9) : tStar - r.R(0.f, 150.f);
                float tB = mode == 1 ? tA : mode == 2 ? tA + kUDwellMs : mode == 3 ? tA + kUTemporalStepMs : tA + r.R(0.f, 500.f);
                if (hostile && r.P(0.03f)) tA = HostileTime(r, tA);
                if (hostile && r.P(0.03f)) tB = HostileTime(r, tB);
                CheckArrival(ctx, anchor, tA, tB, a);
            }
            // ── TimeToDanger / PathClear ──
            {
                const int sm = r.I(0, 9);
                float v = sm == 0 ? 0.f : sm == 1 ? 0.05f : sm == 2 ? 1e-7f : r.R(0.003f, 0.012f);
                if (hostile && r.P(0.05f)) v = r.P(0.5f) ? -0.006f : HostileFloat(r, v);
                const Vec2 dir = r.Dir();
                Vec2 player, P;
                const int mode = r.I(0, 3);
                if (mode == 0) {            // stand on the anchor
                    player = P = anchor;
                } else if (mode == 1) {     // walk through the anchor at tStar, stop somewhere along the way
                    const float back = v * std::max(tStar, 0.f);
                    player = { anchor.x - dir.x * back, anchor.y - dir.y * back };
                    const float len = r.R(0.f, 2.5f);
                    P = { player.x + dir.x * len, player.y + dir.y * len };
                } else {                    // walk to the anchor and hold there
                    const float len = r.R(0.f, 2.5f);
                    P = anchor;
                    player = { P.x - dir.x * len, P.y - dir.y * len };
                }
                const int scanMode = r.I(0, 4);
                const float scan = scanMode == 0 ? T::kHorizonMs
                                 : scanMode == 1 ? T::DwellWindowMs(player, v, P)
                                 : scanMode == 2 ? 100.f * r.I(0, 9)
                                 : r.R(-50.f, 1000.f);
                CheckTtd(ctx, player, v, P, (hostile && r.P(0.03f)) ? HostileFloat(r, scan) : scan, d);
                if (q % 2 == 0)
                    CheckPath(ctx, player, v, P, r.P(0.6f) ? kUDwellMs : r.P(0.5f) ? T::kHorizonMs : r.R(0.f, 400.f), p);
            }
        }
    }

    int failures = 0;
    const auto line = [&](const char* name, const Tally& t, bool needBalance) {
        std::printf("  %-13s %8ld queries, %5.1f %% in contact, %ld mismatches\n", name, t.n,
                    t.n ? 100.0 * t.blocked / t.n : 0.0, t.mismatch);
        if (t.mismatch) { ++failures; std::fprintf(stderr, "FAIL: %s differs from the reference in %ld queries\n", name, t.mismatch); }
        // A set that is nearly all clear or all blocked would prove little.
        if (needBalance && (t.blocked * 10 < t.n || t.blocked * 10 > t.n * 9)) {
            ++failures; std::fprintf(stderr, "FAIL: %s query set is unbalanced\n", name);
        }
    };
    std::printf("Temporal broad-phase differential: seed %u, %d trials, %ld lanes in context "
                "(%ld half-step, %ld short trace, %ld beam, %ld expiring inside the horizon)\n",
                seed, trials, lanesBuilt, subLanes, shortLanes, beams, expiring);
    line("EdgeClear", edge, true);
    line("ArrivalClear", arrival, true);
    line("TimeToDanger", ttd, true);
    line("PathClear", path, true);
    line("NaN/infinity", hostileTally, false);
    std::printf("Temporal broad-phase tests: %ld checks, %d failures\n",
                edge.n + arrival.n + ttd.n + path.n + hostileTally.n, failures);
    return failures == 0 ? 0 : 1;
}
