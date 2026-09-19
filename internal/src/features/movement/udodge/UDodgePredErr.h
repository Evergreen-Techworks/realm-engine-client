#pragma once
// UDodge prediction-error telemetry (contact-model study, section 4): how far the
// lane model's own forecast (Core::Temporal::SampleLane) drifts from the live
// projectile position it is later compared against, bucketed by shot speed,
// lookahead mark, straight/curved and shot age at arm. This is CALIBRATION DATA
// for the pad in the proposed Contact::Pad (contact-model-study.md section 5,
// NOT implemented) — it reads the solver's own inputs and never feeds back into
// any dodge decision.
//
// OFF by default, riding the SAME DiagTiming::On() switch as UDodge::Telemetry
// (RE_ASSETS\diag-timing.flag, or the developer "Diag timing" checkbox): the
// caller tests `diagOn` once per sensor pass, exactly like UDodge::Telemetry, and
// this header does nothing when it is false — no table touch, no allocation, no
// log call. Plain data, IL2CPP-free, host testable: the caller supplies the
// clock (nowMs, already GetTickCount64() in the sensor pass) and the log sink.
//
// Mechanism: up to kMaxSnaps armed snapshots, keyed by the same
// (bulletId, attackerObjId, ownerObjId) identity UDodgeSensors.cpp already uses
// to re-anchor a lane. BuildMap arms a snapshot for a shot with no existing one —
// BuildMap already visits shots nearest-first (UDodgeSensors.cpp: the sort before
// the per-shot loop), so the fixed slot budget goes to the shots nearest the
// player — by copying the lane model's own 9 samples (Core::Temporal::SampleLane,
// t = 0, 100, ..., 800 ms: the exact array the solver's floors consume). Every
// later sensor pass (BuildMap OR ReanchorMap) that sees a shot already holding a
// snapshot checks whether elapsed time since arm (tau) has crossed one of the
// lookahead marks in kMarksMs; at each crossing it takes ONE sample:
//   predicted = interpolate the armed snapshot's 9 positions at the mark time,
//               the SAME formula as Core::Temporal::BulletPosAt;
//   observed  = the live projectile position the sensor pass already has for
//               that shot (ProjectileStore's TryReadLivePos, reached here as
//               WorldProjectile::x/y) — NO new IL2CPP read.
// The error (observed - predicted) decomposes against the shot's own initial
// direction of travel into a Chebyshev distance (tiles, the game's own hit
// metric), an along-track term (ms, via the shot's own speed — this is the
// timing-error component arrPad exists to cover) and a cross-track term (tiles).
// A snapshot is released once tau passes its last mark (800 ms) or, if its shot
// stops appearing in either sensor pass, once a later arm needs the slot back
// (kReleaseMs).
//
// Buckets: speed {0-4, 4-8, 8-12, 12+ tiles/s} x mark (6) x kind
// (straight/curved) x age-at-arm (fresh <200 ms, mid 200-1000 ms, old >=1000 ms)
// = kBucketCount (144) buckets. Each holds a count, sum/max of the three error
// quantities, and a kHistBins-bin (0.02 tile) histogram of the Chebyshev error
// for an approximate p95. MaybeEmit writes one "[Diag/PredErr]" line per
// non-empty bucket at most once every kEmitPeriodMs (10 s) and resets what it
// wrote — a flapping bucket never repeats stale data on the next window.
#include "UDodgeCore.h"
#include "UDodgeTypes.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>

namespace UDodge { namespace PredErr {

using Sink = void (*)(const char* line);

constexpr int      kMaxSnaps   = 64;
constexpr int      kMarkCount  = 6;
constexpr float     kMarksMs[kMarkCount] = { 16.f, 50.f, 100.f, 200.f, 400.f, 800.f };   // ~1 frame @60Hz, then the shared lookahead marks
constexpr uint64_t kReleaseMs  = 800;    // tau past which an orphaned snapshot may be reclaimed
constexpr uint64_t kEmitPeriodMs = 10000;

constexpr int   kSpeedBands = 4;
constexpr float kSpeedBandEdgesTilesPerSec[kSpeedBands - 1] = { 4.f, 8.f, 12.f };
constexpr const char* kSpeedBandNames[kSpeedBands] = { "0-4", "4-8", "8-12", "12+" };

constexpr int   kAgeBands   = 3;
constexpr float kAgeFreshMs = 200.f;
constexpr float kAgeMidMs   = 1000.f;
constexpr const char* kAgeBandNames[kAgeBands] = { "fresh", "mid", "old" };

constexpr int kKindCount = 2;   // straight, curved
constexpr const char* kKindNames[kKindCount] = { "straight", "curved" };

constexpr int   kHistBins    = 24;
constexpr float kHistBinTiles = 0.02f;

constexpr int kBucketCount = kSpeedBands * kMarkCount * kKindCount * kAgeBands;   // 144

inline int SpeedBand(float tilesPerSec)
{
    if (tilesPerSec < kSpeedBandEdgesTilesPerSec[0]) return 0;
    if (tilesPerSec < kSpeedBandEdgesTilesPerSec[1]) return 1;
    if (tilesPerSec < kSpeedBandEdgesTilesPerSec[2]) return 2;
    return 3;
}
inline int AgeBand(float ageMs)
{
    if (ageMs < kAgeFreshMs) return 0;
    if (ageMs < kAgeMidMs) return 1;
    return 2;
}
inline int BucketIndex(int speedBand, int mark, int kind, int ageBand)
{
    return ((speedBand * kMarkCount + mark) * kKindCount + kind) * kAgeBands + ageBand;
}

// Count, sum/max of the three error quantities, and a histogram of the
// Chebyshev error (the game's own hit metric) for an approximate p95.
struct Bucket {
    uint32_t count = 0;
    float    chebSum = 0.f, chebMax = 0.f;
    uint32_t chebHist[kHistBins] = {};
    float    alongSum = 0.f, alongMax = 0.f;   // |ms|
    float    crossSum = 0.f, crossMax = 0.f;   // tiles

    void Add(float chebTiles, float alongMsSigned, float crossTiles)
    {
        ++count;
        chebSum += chebTiles;
        if (chebTiles > chebMax) chebMax = chebTiles;
        int bin = static_cast<int>(chebTiles / kHistBinTiles);
        bin = std::clamp(bin, 0, kHistBins - 1);
        ++chebHist[bin];
        const float a = std::fabs(alongMsSigned);
        alongSum += a;
        if (a > alongMax) alongMax = a;
        crossSum += crossTiles;
        if (crossTiles > crossMax) crossMax = crossTiles;
    }
    float ChebMean()  const { return count ? chebSum  / static_cast<float>(count) : 0.f; }
    float AlongMean() const { return count ? alongSum / static_cast<float>(count) : 0.f; }
    float CrossMean() const { return count ? crossSum / static_cast<float>(count) : 0.f; }
    // Bin edge containing the smallest cumulative count >= 95 % (ceil), i.e. an
    // upper bound on the true p95 with the histogram's own resolution.
    float ChebP95() const
    {
        if (count == 0) return 0.f;
        const uint32_t target = (count * 95u + 99u) / 100u;
        uint32_t cum = 0;
        for (int i = 0; i < kHistBins; ++i) {
            cum += chebHist[i];
            if (cum >= target) return static_cast<float>(i + 1) * kHistBinTiles;
        }
        return static_cast<float>(kHistBins) * kHistBinTiles;
    }
    void Reset() { *this = Bucket{}; }
};

struct Key {
    int32_t  bulletId      = 0;
    int32_t  attackerObjId = 0;
    uint32_t ownerObjId    = 0;
    bool operator==(const Key& o) const
    {
        return bulletId == o.bulletId && attackerObjId == o.attackerObjId && ownerObjId == o.ownerObjId;
    }
};

// One armed shot: the lane model's own 9-sample forecast at arm time, plus what
// the error decomposition needs (speed, initial direction) and the bucket keys
// fixed at arm time (kind, age band).
struct Snap {
    bool     used = false;
    Key      key{};
    uint64_t t0Ms = 0;
    Vec2     pos[Core::Temporal::kSamples]{};   // Core::Temporal::SampleLane's own output, t = 0..800 ms
    float    speedTilesPerMs = 0.f;             // max segment speed across pos[]
    Vec2     unitVel{};                         // direction of travel at t0 (pos[1]-pos[0], normalized)
    bool     curved = false;
    uint8_t  ageBand = 0;                       // shot age AT ARM time (elapsed since spawn), banded once
    uint8_t  nextMark = 0;                      // next unobserved mark index, 0..kMarkCount
};

struct State {
    Snap     snaps[kMaxSnaps]{};
    Bucket   buckets[kBucketCount]{};
    uint64_t lastEmitMs = 0;
};

// Bullet position at an arbitrary mark time, interpolated over the armed
// snapshot's 9 samples — the SAME formula as Core::Temporal::BulletPosAt, just
// over a plain array instead of a Ctx.
inline Vec2 Interp(const Vec2* pos9, float tMs)
{
    constexpr float step    = kUTemporalStepMs;
    constexpr float horizon = kUTemporalSteps * kUTemporalStepMs;
    if (tMs <= 0.f)        return pos9[0];
    if (tMs >= horizon)    return pos9[kUTemporalSteps];
    const float g = tMs / step;
    const int   k = static_cast<int>(g);
    const float f = g - static_cast<float>(k);
    return Add(pos9[k], Mul(Sub(pos9[k + 1], pos9[k]), f));
}

inline int Find(const State& st, Key key)
{
    for (int i = 0; i < kMaxSnaps; ++i)
        if (st.snaps[i].used && st.snaps[i].key == key) return i;
    return -1;
}

// A free slot, or the oldest ORPHANED snapshot (tau already past kReleaseMs —
// its shot stopped being touched before it ever reached its own release), or -1
// when every slot holds a still-relevant snapshot (skip arming this frame; the
// next BuildMap tries again).
inline int FreeSlot(const State& st, uint64_t nowMs)
{
    for (int i = 0; i < kMaxSnaps; ++i)
        if (!st.snaps[i].used) return i;
    int      oldest   = -1;
    uint64_t oldestT0 = 0;
    for (int i = 0; i < kMaxSnaps; ++i) {
        const uint64_t tau = nowMs - st.snaps[i].t0Ms;
        if (tau > kReleaseMs && (oldest < 0 || st.snaps[i].t0Ms < oldestT0)) {
            oldest = i;
            oldestT0 = st.snaps[i].t0Ms;
        }
    }
    return oldest;
}

inline void Arm(Snap& s, Key key, const LaneThreat& lane, uint64_t nowMs, bool curved, float ageAtArmMs)
{
    s.used = true;
    s.key = key;
    s.t0Ms = nowMs;
    Core::Temporal::SampleLane(lane, s.pos);
    float maxSpeed = 0.f;
    for (int i = 1; i < Core::Temporal::kSamples; ++i)
        maxSpeed = std::max(maxSpeed, Len(Sub(s.pos[i], s.pos[i - 1])) / kUTemporalStepMs);
    s.speedTilesPerMs = maxSpeed;
    s.unitVel = Normalize(Sub(s.pos[1], s.pos[0]));
    s.curved = curved;
    s.ageBand = static_cast<uint8_t>(AgeBand(ageAtArmMs));
    s.nextMark = 0;
}

inline void Record(State& st, const Snap& s, float chebTiles, float alongMs, float crossTiles)
{
    const int sb = SpeedBand(s.speedTilesPerMs * 1000.f);
    const int kind = s.curved ? 1 : 0;
    st.buckets[BucketIndex(sb, s.nextMark, kind, s.ageBand)].Add(chebTiles, alongMs, crossTiles);
}

// For each mark this snapshot's tau has newly crossed: predicted from the armed
// 9-sample forecast at the mark time, observed = the live position the caller
// already read this pass, error decomposed along the shot's own t0 direction.
inline void ObserveMarks(State& st, Snap& s, Vec2 observed, uint64_t nowMs)
{
    if (nowMs < s.t0Ms) return;   // guard a clock hiccup; never observe backwards
    const float tau = static_cast<float>(nowMs - s.t0Ms);
    while (s.nextMark < kMarkCount && tau >= kMarksMs[s.nextMark]) {
        const Vec2 predicted = Interp(s.pos, kMarksMs[s.nextMark]);
        const Vec2 e = Sub(observed, predicted);
        const float speedForDiv = std::max(s.speedTilesPerMs, 1e-6f);
        const float alongTiles = Dot(e, s.unitVel);   // s.unitVel is {} (zero) for a stationary/degenerate lane
        const Vec2  crossVec = Sub(e, Mul(s.unitVel, alongTiles));
        Record(st, s, Cheb(e.x, e.y), alongTiles / speedForDiv, Len(crossVec));
        ++s.nextMark;
    }
}

// One shot, one sensor pass. `allowArm` is true only from BuildMap — it visits
// shots nearest-first, so the fixed slot budget goes to the shots nearest the
// player; ReanchorMap only observes snapshots BuildMap already armed.
// `ageAtArmMs` (elapsed time since the shot's own spawn) is read only the
// instant a fresh snapshot is armed.
inline void Sample(State& st, Key key, const LaneThreat& lane, Vec2 observed, uint64_t nowMs,
                   bool curved, float ageAtArmMs, bool allowArm)
{
    const int found = Find(st, key);
    if (found < 0) {
        if (!allowArm) return;
        const int slot = FreeSlot(st, nowMs);
        if (slot < 0) return;
        Arm(st.snaps[slot], key, lane, nowMs, curved, ageAtArmMs);
        return;   // t0 == nowMs: tau == 0, no mark has been crossed yet
    }
    Snap& s = st.snaps[found];
    ObserveMarks(st, s, observed, nowMs);
    if (s.nextMark >= kMarkCount) s.used = false;   // every mark spent — free the slot
}

inline void FormatBucket(int idx, const Bucket& b, char* out, size_t cap)
{
    int t = idx;
    const int ageBand   = t % kAgeBands;  t /= kAgeBands;
    const int kind      = t % kKindCount; t /= kKindCount;
    const int mark      = t % kMarkCount; t /= kMarkCount;
    const int speedBand = t;
    std::snprintf(out, cap,
        "[Diag/PredErr] spd=%s kind=%s age=%s tau=%.0f n=%u"
        " cheb mean=%.3f p95=%.3f max=%.3f alongMs mean=%.1f max=%.1f cross mean=%.3f max=%.3f",
        kSpeedBandNames[speedBand], kKindNames[kind], kAgeBandNames[ageBand], kMarksMs[mark],
        static_cast<unsigned>(b.count), b.ChebMean(), b.ChebP95(), b.chebMax,
        b.AlongMean(), b.alongMax, b.CrossMean(), b.crossMax);
}

// One line per non-empty bucket, at most once every kEmitPeriodMs, then reset —
// a quiet bucket never repeats stale numbers on the next window. No-op (no
// allocation, no snprintf) when the period has not elapsed.
inline void MaybeEmit(State& st, uint64_t nowMs, Sink sink)
{
    if (st.lastEmitMs != 0 && nowMs - st.lastEmitMs < kEmitPeriodMs) return;
    st.lastEmitMs = nowMs;
    char line[224];
    for (int i = 0; i < kBucketCount; ++i) {
        Bucket& b = st.buckets[i];
        if (b.count == 0) continue;
        FormatBucket(i, b, line, sizeof(line));
        if (sink) sink(line);
        b.Reset();
    }
}

// ── HitCulprit: closest-approach history for post-hoc hit attribution ───────
// [Diag/Hit] cannot always name the shot that hit: a real session showed hits
// logged with standClr +0.85/+1.14 and the nearest REMAINING lane 3 tiles away
// — the hitting projectile is gone from the live pool (and so from g_map)
// before the HP-drop packet is processed. This keeps a short, fixed-size
// history of what was actually being tracked in the frames just before the
// hit, so the hit handler can look BACKWARD through recent frames instead of
// only at the current, already-too-late map.
//
// Same switch, same shape: OFF costs one branch and touches nothing; ON is a
// plain ring buffer (kRingCap entries, no allocation) the caller fills once a
// tick with the nearest kNearestN lanes' closest approach (owner identity, the
// unscaled contact half T, speed, Chebyshev distance to the player, beam/
// provisional flags, and whether this identity had no other entry in the
// window yet). At a hit, FindCulprit scans the still-in-window entries for the
// smallest (cheb - T) — the shot that came closest to actually touching the
// player's box, tracked or not — and reports how long that identity had been
// in the ring before this occurrence (0 = this IS the first sighting: never
// tracked before contact) and the smallest cheb/T ratio seen for it in the
// window, so a caller can tell apart a tracked-but-too-small box (small
// margin, sinceFirstMs > 0), a mispredicted position (larger margin, ratio
// swings a lot across the window) and a shot that was simply never seen in
// time (sinceFirstMs == 0, or found == false).
namespace HitCulprit {

constexpr int      kNearestN  = 4;     // nearest lanes recorded per tick
constexpr int      kRingCap   = 96;    // >= kHistoryMs worth of ticks * kNearestN
constexpr uint64_t kHistoryMs = 300;

struct Entry {
    bool     used = false;
    uint64_t atMs = 0;
    Key      key{};
    uint32_t ownerType = 0;             // resolved enemy type; 0 = unresolved
    float    half = 0.f;                // T, unscaled (LaneThreat::hitHalf)
    float    speedTilesPerSec = 0.f;
    float    cheb = 0.f;                // Chebyshev distance to the player this frame
    bool     beam = false;
    bool     provisional = false;
    bool     isNew = false;             // no other entry for this key was still in-window
};

struct Ring {
    Entry ring[kRingCap]{};
    int   writeIdx = 0;
};

// Record one lane's closest-approach snapshot this frame. Called up to
// kNearestN times per tick by the caller (already has the lanes; picks its own
// nearest few — a lane beyond that is not worth a slot). No allocation, plain
// data in, plain data recorded.
inline void Record(Ring& r, Key key, uint32_t ownerType, float half, float speedTilesPerSec,
                   float chebTiles, bool beam, bool provisional, uint64_t nowMs)
{
    bool isNew = true;
    for (int i = 0; i < kRingCap; ++i) {
        const Entry& e = r.ring[i];
        if (e.used && e.key == key && nowMs >= e.atMs && nowMs - e.atMs <= kHistoryMs) { isNew = false; break; }
    }
    Entry& e = r.ring[r.writeIdx];
    e = Entry{};
    e.used = true; e.atMs = nowMs; e.key = key; e.ownerType = ownerType; e.half = half;
    e.speedTilesPerSec = speedTilesPerSec; e.cheb = chebTiles; e.beam = beam; e.provisional = provisional;
    e.isNew = isNew;
    r.writeIdx = (r.writeIdx + 1) % kRingCap;
}

struct Culprit {
    bool     found = false;
    Entry    entry{};
    uint64_t sinceFirstMs = 0;   // ms between this key's earliest still-in-window entry and `entry`; 0 = entry IS the earliest
    float    minChebOverT = 0.f; // min(cheb/half) for this key across the window
};

// Best-match lookup at the moment of an HP drop: the in-window entry (within
// kHistoryMs of `nowMs`) with the smallest (cheb - half) — closest actual
// approach to the game's own hit test, whether or not it was still tracked at
// the instant the HP drop was processed.
inline Culprit FindCulprit(const Ring& r, uint64_t nowMs)
{
    Culprit c{};
    float best = 3.402823466e+38f;
    int   bestIdx = -1;
    for (int i = 0; i < kRingCap; ++i) {
        const Entry& e = r.ring[i];
        if (!e.used || nowMs < e.atMs || nowMs - e.atMs > kHistoryMs) continue;
        const float margin = e.cheb - e.half;
        if (margin < best) { best = margin; bestIdx = i; }
    }
    if (bestIdx < 0) return c;
    c.found = true;
    c.entry = r.ring[bestIdx];
    uint64_t earliest = c.entry.atMs;
    float minRatio = c.entry.half > 1e-4f ? c.entry.cheb / c.entry.half : c.entry.cheb;
    for (int i = 0; i < kRingCap; ++i) {
        const Entry& e = r.ring[i];
        if (!e.used || !(e.key == c.entry.key) || nowMs < e.atMs || nowMs - e.atMs > kHistoryMs) continue;
        if (e.atMs < earliest) earliest = e.atMs;
        const float ratio = e.half > 1e-4f ? e.cheb / e.half : e.cheb;
        if (ratio < minRatio) minRatio = ratio;
    }
    c.sinceFirstMs = c.entry.atMs - earliest;
    c.minChebOverT = minRatio;
    return c;
}

// Appends " culprit{...}" (or " culprit=none") to `out+used`; returns the new
// used length, clamped to cap — meant to extend an existing snprintf-append
// buffer (e.g. DiagLogHit's own `lanes`), not to start a new log line.
inline size_t AppendCulprit(const Culprit& c, char* out, size_t used, size_t cap)
{
    if (used >= cap) return used;
    int n;
    if (!c.found) {
        n = std::snprintf(out + used, cap - used, " culprit=none");
    } else {
        n = std::snprintf(out + used, cap - used,
            " culprit{owner=%u type=0x%X half=%.3f cheb=%.3f margin=%.3f spd=%.1ft/s beam=%d prov=%d"
            " new=%d sinceFirstMs=%llu minChebOverT=%.2f}",
            c.entry.key.ownerObjId, c.entry.ownerType, c.entry.half, c.entry.cheb,
            c.entry.cheb - c.entry.half, c.entry.speedTilesPerSec, c.entry.beam ? 1 : 0,
            c.entry.provisional ? 1 : 0, c.entry.isNew ? 1 : 0,
            static_cast<unsigned long long>(c.sinceFirstMs), c.minChebOverT);
    }
    if (n <= 0) return used;
    return std::min(cap - 1, used + static_cast<size_t>(n));
}

} // namespace HitCulprit

// ── GroundDiag: edge-triggered damaging-ground steps ─────────────────────────
// The owner reports the bot walking onto damaging ground with hazardRoutes=0 in
// the same session's [Diag/Nav] stats, which says nothing about which layer let
// it happen (the classifier never flagged the tile, or it did and something
// stepped there anyway). Same switch: OFF touches nothing; ON is edge-triggered
// off the player's own tile, so a long stand on damaging ground costs one
// comparison a tick, not a line a tick.
//
// `hazardKnown` is the caller's Sensors::IsHazardAt reading for the player's
// EXACT position, taken the same tick the transition is detected (ground-damage
// classification is a static per-tile property, not a moving projectile lane,
// so this is effectively what the classifier would have said about this tile
// before the step landed — there is no cheap way to time-shift it a full tick
// without caching a predicted destination, which is out of scope here).
namespace GroundDiag {

struct State {
    bool     onDamaging = false;
    int      tileX = 0, tileY = 0;
    uint64_t enteredMs = 0;
};

// Call once a tick with the player's current tile. `solve`/`src`/`obj` are the
// SAME strings [Diag/Nav] prints for this frame's decision (Telemetry::Name on
// the sample already built this tick) — passed in, not recomputed.
inline void Step(State& st, int tileX, int tileY, int damageLive, bool hazardKnown, bool safeWalk,
                 bool liveHazActive, const char* solve, const char* src, const char* obj, uint64_t nowMs,
                 Sink sink)
{
    const bool damaging = damageLive > 0;
    const bool tileChanged = tileX != st.tileX || tileY != st.tileY;
    if (st.onDamaging && (!damaging || tileChanged)) {
        char line[128];
        std::snprintf(line, sizeof(line), "[Diag/Ground] leave tile=(%d,%d) dwellMs=%llu",
                      st.tileX, st.tileY, static_cast<unsigned long long>(nowMs - st.enteredMs));
        if (sink) sink(line);
        st.onDamaging = false;
    }
    if (damaging && !st.onDamaging) {
        st.onDamaging = true;
        st.tileX = tileX;
        st.tileY = tileY;
        st.enteredMs = nowMs;
        char line[224];
        std::snprintf(line, sizeof(line),
            "[Diag/Ground] enter tile=(%d,%d) dmg=%d hazardKnown=%d safeWalk=%d liveHaz=%d solve=%s src=%s obj=%s",
            tileX, tileY, damageLive, hazardKnown ? 1 : 0, safeWalk ? 1 : 0, liveHazActive ? 1 : 0,
            solve ? solve : "?", src ? src : "?", obj ? obj : "?");
        if (sink) sink(line);
    }
}

} // namespace GroundDiag

} } // namespace UDodge::PredErr
