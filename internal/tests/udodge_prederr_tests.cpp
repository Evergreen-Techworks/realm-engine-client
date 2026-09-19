// UDodge [Diag/PredErr] calibration telemetry + HitCulprit (contact-model study,
// section 4; UDodgePredErr.h): the pure half.
//
// What is tested here: Bucket aggregation (count/sum/max/histogram/p95), the
// full Sample() pipeline against a synthetic straight lane with a hand-computed
// injected error (Chebyshev / along-track / cross-track decomposition), the
// HitCulprit ring's best-match / sinceFirstMs / minChebOverT / isNew logic, and
// that none of it allocates.
//
// OFF is a branch at the call site (`if (diagOn) PredErr::Sample(...)`), not
// code in this header, so — exactly like udodge_telemetry_tests.cpp — it is
// tested where it lives: `run_scenarios.py --telemetry-check` runs the
// production Tick with diagnostics off and on and asserts zero log lines while
// off. What this file proves instead is that nothing here allocates, so the
// off path (simply not calling in) costs nothing beyond the one branch.
#include "UDodgePredErr.h"

#include <cstdlib>
#include <cstring>
#include <new>

using namespace UDodge;
namespace PE = UDodge::PredErr;

// Every operator-new in the process is counted: nothing here may allocate.
static long g_allocations = 0;
void* operator new(std::size_t n) { ++g_allocations; if (void* p = std::malloc(n ? n : 1)) return p; throw std::bad_alloc(); }
void* operator new[](std::size_t n) { ++g_allocations; if (void* p = std::malloc(n ? n : 1)) return p; throw std::bad_alloc(); }
void operator delete(void* p) noexcept { std::free(p); }
void operator delete[](void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }
void operator delete[](void* p, std::size_t) noexcept { std::free(p); }

static int checks = 0, failures = 0;
static void Check(bool ok, const char* name)
{
    ++checks;
    if (!ok) { ++failures; std::fprintf(stderr, "FAIL: %s\n", name); }
}
static bool Near(float a, float b, float eps = 1e-3f) { return std::fabs(a - b) <= eps; }

static int  g_sinkCalls = 0;
static char g_lastLine[256] = {};
static void Sink(const char* line) { ++g_sinkCalls; std::snprintf(g_lastLine, sizeof(g_lastLine), "%s", line ? line : ""); }
static bool Has(const char* s, const char* token) { return s && std::strstr(s, token) != nullptr; }

// A straight lane covering the whole horizon in one segment, so SampleLane's
// interpolation is exact: pos(t) = origin + v*t for every t in [0, 800].
static LaneThreat StraightLane(Vec2 origin, Vec2 velocityTilesPerMs)
{
    LaneThreat L{};
    L.points[0] = origin;
    L.pointTimesMs[0] = 0.f;
    L.points[1] = Add(origin, Mul(velocityTilesPerMs, 1000.f));
    L.pointTimesMs[1] = 1000.f;
    L.pointCount = 2;
    L.hasLinearMotion = true;
    L.linearVelocity = velocityTilesPerMs;
    return L;
}

int main()
{
    // ── Bucket aggregation / histogram / p95 ──────────────────────────────────
    {
        PE::Bucket b{};
        Check(b.count == 0 && Near(b.ChebMean(), 0.f) && Near(b.ChebP95(), 0.f) && Near(b.chebMax, 0.f),
              "an empty bucket reads zero everywhere");

        // 20 samples, cheb = 0.00..0.19 step 0.01 -> two per 0.02-wide bin, bins 0..9.
        for (int i = 0; i < 20; ++i) b.Add(i * 0.01f, 0.f, 0.f);
        Check(b.count == 20, "count tracks every Add");
        Check(Near(b.ChebMean(), 0.095f), "mean is sum/count");
        Check(Near(b.chebMax, 0.19f), "max tracks the largest sample");
        // target = ceil(20*0.95) = 19 -> first bin whose cumulative count reaches
        // 19 is bin 9 (cum 20) -> p95 reads that bin's upper edge, 0.20.
        Check(Near(b.ChebP95(), 0.20f), "p95 is the upper edge of the bin holding the 95th sample");

        PE::Bucket clampb{};
        clampb.Add(5.f, 0.f, 0.f);   // far past the last bin (24 * 0.02 = 0.48)
        Check(clampb.chebHist[PE::kHistBins - 1] == 1, "a value past the histogram clamps into the last bin");
        Check(Near(clampb.ChebP95(), PE::kHistBins * PE::kHistBinTiles), "p95 of one clamped sample is the histogram's own ceiling");

        PE::Bucket ac{};
        ac.Add(0.f, -7.f, 0.02f);
        ac.Add(0.f, 3.f, 0.04f);
        Check(Near(ac.AlongMean(), 5.f), "along-track is aggregated as an absolute value (|-7|, |3| -> mean 5)");
        Check(Near(ac.alongMax, 7.f), "along-track max is the largest magnitude, sign dropped");
        Check(Near(ac.CrossMean(), 0.03f) && Near(ac.crossMax, 0.04f), "cross-track sum/max are plain (already non-negative)");

        ac.Reset();
        Check(ac.count == 0, "Reset clears a bucket back to empty");
    }

    // ── SpeedBand / AgeBand / BucketIndex ─────────────────────────────────────
    {
        Check(PE::SpeedBand(0.f) == 0 && PE::SpeedBand(3.99f) == 0, "under 4 tiles/s is band 0");
        Check(PE::SpeedBand(4.f) == 1 && PE::SpeedBand(7.99f) == 1, "[4,8) tiles/s is band 1");
        Check(PE::SpeedBand(8.f) == 2 && PE::SpeedBand(11.99f) == 2, "[8,12) tiles/s is band 2");
        Check(PE::SpeedBand(12.f) == 3 && PE::SpeedBand(999.f) == 3, "12 tiles/s and over is band 3");
        Check(PE::AgeBand(0.f) == 0 && PE::AgeBand(199.f) == 0, "under 200 ms is fresh");
        Check(PE::AgeBand(200.f) == 1 && PE::AgeBand(999.f) == 1, "[200,1000) ms is mid");
        Check(PE::AgeBand(1000.f) == 2 && PE::AgeBand(50000.f) == 2, "1000 ms and over is old");
        // Every (speed, mark, kind, age) combination maps to a distinct in-range slot.
        bool seen[PE::kBucketCount] = {};
        int  distinct = 0;
        for (int sp = 0; sp < PE::kSpeedBands; ++sp)
            for (int m = 0; m < PE::kMarkCount; ++m)
                for (int k = 0; k < PE::kKindCount; ++k)
                    for (int a = 0; a < PE::kAgeBands; ++a) {
                        const int idx = PE::BucketIndex(sp, m, k, a);
                        Check(idx >= 0 && idx < PE::kBucketCount, "BucketIndex stays in range");
                        if (!seen[idx]) { seen[idx] = true; ++distinct; }
                    }
        Check(distinct == PE::kBucketCount, "every bucket key is distinct (no collisions)");
    }

    // ── Interp matches the hand-computed straight-line interpolation ─────────
    {
        Vec2 pos[Core::Temporal::kSamples];
        for (int k = 0; k < Core::Temporal::kSamples; ++k) pos[k] = { k * 0.5f, 0.f };   // 5 tiles/s (0.5 tile / 100 ms)
        Check(Near(PE::Interp(pos, 0.f).x, 0.f), "Interp at t=0 is the first sample");
        Check(Near(PE::Interp(pos, 800.f).x, 4.f), "Interp at the horizon is the last sample");
        Check(Near(PE::Interp(pos, 1000.f).x, 4.f), "Interp past the horizon clamps to the last sample");
        Check(Near(PE::Interp(pos, 50.f).x, 0.25f), "Interp at a half-step midpoint");
        Check(Near(PE::Interp(pos, 16.f).x, 0.08f), "Interp at the 1-frame mark");
    }

    // ── Sample(): arm, then a known injected error decomposes as expected ────
    {
        PE::State st{};
        // 5 tiles/s along +x -> speed band 1 ("4-8"), unit velocity (1,0).
        const LaneThreat lane = StraightLane({ 100.f, 100.f }, { 0.005f, 0.f });
        const PE::Key key{ 42, 7, 9 };
        const uint64_t t0 = 1'000'000;

        PE::Sample(st, key, lane, lane.points[0], t0, /*curved=*/false, /*ageAtArmMs=*/50.f, /*allowArm=*/true);
        Check(PE::Find(st, key) >= 0, "arming occupies a slot");
        for (auto& bkt : st.buckets) Check(bkt.count == 0, "arming alone records no sample (tau==0, no mark crossed)");

        // Mark 0 (16 ms, index 0): the armed snapshot predicts (100.08,100);
        // inject a pure along-track +0.03 tile error.
        Vec2 observed = { 100.f + 0.005f * 16.f + 0.03f, 100.f };
        PE::Sample(st, key, lane, observed, t0 + 16, false, 0.f, false);
        {
            const int idx = PE::BucketIndex(/*speed*/1, /*mark*/0, /*kind straight*/0, /*age fresh*/0);
            const PE::Bucket& b = st.buckets[idx];
            Check(b.count == 1, "the 1-frame mark crossing lands exactly one sample in its own bucket");
            Check(Near(b.chebSum, 0.03f), "a pure along-track error reads as that same Chebyshev distance");
            Check(Near(b.alongSum, 6.f), "0.03 tile at 5 tiles/s (0.005 tile/ms) along-track is 6 ms");
            Check(Near(b.crossSum, 0.f), "a pure along-track error has no cross-track component");
        }

        // Mark 1 (50 ms): inject a pure cross-track +0.02 tile error.
        observed = { 100.f + 0.005f * 50.f, 100.f + 0.02f };
        PE::Sample(st, key, lane, observed, t0 + 50, false, 0.f, false);
        {
            const int idx = PE::BucketIndex(1, 1, 0, 0);
            const PE::Bucket& b = st.buckets[idx];
            Check(b.count == 1, "the 50 ms mark crossing lands in its own bucket");
            Check(Near(b.chebSum, 0.02f), "a pure cross-track error reads as that same Chebyshev distance");
            Check(Near(b.alongSum, 0.f), "a pure cross-track error has no along-track component");
            Check(Near(b.crossSum, 0.02f), "cross-track error is reported directly");
        }

        // Drive the remaining marks to the horizon: the slot releases once spent.
        PE::Sample(st, key, lane, lane.points[0], t0 + 100, false, 0.f, false);
        PE::Sample(st, key, lane, lane.points[0], t0 + 200, false, 0.f, false);
        PE::Sample(st, key, lane, lane.points[0], t0 + 400, false, 0.f, false);
        PE::Sample(st, key, lane, lane.points[0], t0 + 800, false, 0.f, false);
        Check(PE::Find(st, key) < 0, "a snapshot releases itself once every mark has been observed");

        int nonEmpty = 0;
        for (auto& bkt : st.buckets) if (bkt.count > 0) ++nonEmpty;
        Check(nonEmpty == 6, "one bucket per mark received exactly one sample from this one shot");
    }

    // ── ReanchorMap-style callers never arm ───────────────────────────────────
    {
        PE::State st{};
        const LaneThreat lane = StraightLane({ 0.f, 0.f }, { 0.001f, 0.f });
        PE::Sample(st, PE::Key{ 1, 1, 1 }, lane, lane.points[0], 5000, false, 0.f, /*allowArm=*/false);
        Check(PE::Find(st, PE::Key{ 1, 1, 1 }) < 0, "allowArm=false never creates a snapshot");
    }

    // ── MaybeEmit: rate-limited, non-empty buckets only, resets after ─────────
    {
        PE::State st{};
        st.buckets[0].Add(0.05f, 1.f, 0.01f);
        g_sinkCalls = 0;
        PE::MaybeEmit(st, 200000, &Sink);
        Check(g_sinkCalls == 1, "exactly one non-empty bucket emits exactly one line");
        Check(Has(g_lastLine, "[Diag/PredErr] "), "the line carries its tag");
        Check(st.buckets[0].count == 0, "a bucket is reset once emitted");

        st.buckets[0].Add(0.05f, 1.f, 0.01f);
        g_sinkCalls = 0;
        PE::MaybeEmit(st, 200000 + PE::kEmitPeriodMs - 1, &Sink);
        Check(g_sinkCalls == 0, "MaybeEmit is a no-op before its period elapses");
        PE::MaybeEmit(st, 200000 + PE::kEmitPeriodMs, &Sink);
        Check(g_sinkCalls == 1, "MaybeEmit fires once the period elapses");
    }

    // ── HitCulprit ─────────────────────────────────────────────────────────
    {
        namespace HC = PE::HitCulprit;
        HC::Ring ring{};
        const HC::Culprit none = HC::FindCulprit(ring, 1000);
        Check(!none.found, "an empty ring finds no culprit");

        // Enemy A: tracked for a while, closing in (margin shrinks) but never quite
        // reaches the box (cheb always > half).
        HC::Record(ring, { 1, 1, 1 }, 100u, 0.30f, 6.f, 0.60f, false, false, 1000);
        HC::Record(ring, { 1, 1, 1 }, 100u, 0.30f, 6.f, 0.40f, false, false, 1050);
        HC::Record(ring, { 1, 1, 1 }, 100u, 0.30f, 6.f, 0.32f, false, false, 1100);
        // Enemy B: never tracked before, shows up RIGHT at the hit with cheb inside
        // its own half (the game already counted a hit; this is the "never tracked
        // in time" case).
        HC::Record(ring, { 2, 2, 2 }, 200u, 0.25f, 8.f, 0.10f, false, false, 1120);

        const HC::Culprit c = HC::FindCulprit(ring, 1120);
        Check(c.found, "a culprit is found when the ring has entries in the window");
        Check(c.entry.key.bulletId == 2, "the smallest (cheb - half) margin wins, not the longest-tracked shot");
        Check(Near(c.entry.cheb - c.entry.half, -0.15f), "enemy B's margin is negative (inside the box)");
        Check(c.sinceFirstMs == 0, "enemy B's only sighting is this one: never tracked before contact");
        Check(c.entry.isNew, "enemy B's own entry was flagged new when recorded (no prior entry in-window)");
        Check(Near(c.minChebOverT, 0.10f / 0.25f), "min cheb/T ratio over the window for the winning key");

        // Enemy A alone, at a later time: its margin (0.02) is now the only
        // candidate, and it HAS been tracked for a while.
        HC::Ring ringA{};
        HC::Record(ringA, { 1, 1, 1 }, 100u, 0.30f, 6.f, 0.60f, false, false, 1000);
        HC::Record(ringA, { 1, 1, 1 }, 100u, 0.30f, 6.f, 0.32f, false, false, 1100);
        const HC::Culprit ca = HC::FindCulprit(ringA, 1100);
        Check(ca.found && ca.sinceFirstMs == 100, "a shot tracked for 100 ms before the winning sighting reports that gap");
        Check(!ca.entry.isNew, "the winning entry was not new (an earlier entry for the same key was still in-window)");

        char buf[256] = {};
        const size_t used = HC::AppendCulprit(c, buf, 0, sizeof(buf));
        Check(used > 0 && used < sizeof(buf), "AppendCulprit writes within the buffer");
        Check(Has(buf, "culprit{owner=2"), "the formatted line names the winning owner");
        Check(Has(buf, "sinceFirstMs=0"), "the formatted line carries sinceFirstMs");

        char none_buf[64] = {};
        const size_t noneUsed = HC::AppendCulprit(none, none_buf, 0, sizeof(none_buf));
        Check(Has(none_buf, "culprit=none") && noneUsed < sizeof(none_buf), "no culprit formats as culprit=none");
    }

    // ── GroundDiag: edge-triggered enter/leave ────────────────────────────────
    {
        namespace GD = PE::GroundDiag;
        GD::State st{};
        g_sinkCalls = 0;
        GD::Step(st, 5, 5, /*dmg=*/0, false, true, false, "hold", "cached", "none", 1000, &Sink);
        Check(g_sinkCalls == 0, "a clean tile writes nothing");

        GD::Step(st, 5, 5, /*dmg=*/5, /*hazardKnown=*/false, true, false, "dodge_route", "worker", "lock", 1000, &Sink);
        Check(g_sinkCalls == 1 && Has(g_lastLine, "[Diag/Ground] enter tile=(5,5) dmg=5 hazardKnown=0"),
              "stepping onto a damaging tile the classifier missed logs the miss");
        Check(Has(g_lastLine, "solve=dodge_route src=worker obj=lock"), "the entering line carries this frame's decision");

        // Staying on the same damaging tile: no further lines.
        g_sinkCalls = 0;
        GD::Step(st, 5, 5, 5, false, true, false, "dodge_route", "worker", "lock", 1100, &Sink);
        Check(g_sinkCalls == 0, "remaining on the same damaging tile is silent");

        // Hopping straight to a different damaging tile: one leave, one enter.
        g_sinkCalls = 0;
        GD::Step(st, 6, 5, 3, /*hazardKnown=*/true, true, false, "solver", "live", "lock", 1300, &Sink);
        Check(g_sinkCalls == 2, "moving to a different damaging tile writes a leave then an enter");

        // Stepping off onto clean ground: one leave, dwell reported.
        g_sinkCalls = 0;
        GD::Step(st, 7, 5, 0, false, true, false, "solver", "live", "lock", 1400, &Sink);
        Check(g_sinkCalls == 1 && Has(g_lastLine, "[Diag/Ground] leave tile=(6,5) dwellMs=100"),
              "leaving a damaging tile reports the tile and dwell time");
        Check(!st.onDamaging, "state clears once the player leaves damaging ground");
    }

    Check(g_allocations == 0, "nothing in this file allocates");

    std::printf("PredErr tests: %d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
