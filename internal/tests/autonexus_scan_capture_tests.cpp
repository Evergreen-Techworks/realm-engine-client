// AUTONEXUS-SCAN-DIAG (private diagnostic; strip with the files named in
// AutoNexusScanCapture.h). Bounded AutoNexus scan capture: gating, capacity,
// geometry helpers and wire shape.
#include "features/combat/autonexus/AutoNexusScanCapture.h"
#include "features/combat/autonexus/AutoNexusScanWire.h"
#include <cstdio>
#include <memory>
#include <string>

int main(int argc, char** argv)
{
    int n = 0, f = 0;
    auto ck = [&](bool x, const char* m) { ++n; if (!x) { ++f; std::printf("FAIL %s\n", m); } };
    using namespace AutoNexusScanCapture;

    // Damage estimate mirrors the client's defense rule (min 10%, piercing ignores defense).
    ck(Applied(100, false, 17) == 83, "defense subtracts");
    ck(Applied(100, false, 95) == 10, "floor is a tenth of raw");
    ck(Applied(70, true, 50) == 70, "piercing ignores defense");

    // Gate: >= 50% of confirmed HP, only when enabled, never on unknown HP.
    ck(!Wanted(false, 400, 500), "disabled capture does no work");
    ck(Wanted(true, 250, 500) && !Wanted(true, 249, 500), "50% of confirmed HP threshold");
    ck(!Wanted(true, 999, 0), "no confirmed HP, no capture");

    // Closest approach (Chebyshev) of a linear bullet against a moving track and a hold.
    const Track hold{ 0.f, 0.f, 0.f, 0.f };
    const Track moving{ 0.f, 0.f, 0.f, -0.005f };          // 5 tiles/s toward -y
    auto bullet = [](float t, float& x, float& y) { x = 1.f - 0.01f * t; y = 1.f - 0.01f * t; return true; };  // diagonal, through the origin at 100 ms
    const Approach a = ClosestApproach(bullet, hold, 200.f, 5.f);
    ck(a.distance >= 0.f && a.distance < 0.06f && a.atMs >= 95.f && a.atMs <= 105.f, "hold: bullet crosses the stand at 100 ms");
    const Approach b = ClosestApproach(bullet, moving, 200.f, 5.f);
    ck(b.distance > 0.30f && b.distance < 0.37f && b.atMs >= 125.f && b.atMs <= 140.f, "moving track: closest 0.33 near 133 ms");

    // Capacity: fixed queue, overflow counted, no growth.
    auto ch = std::make_unique<Channel>();
    Scan s{}; s.hp = 500; s.maxHp = 675;
    for (unsigned i = 0; i < kQueue + 5; ++i) ch->Offer(s);
    ck(ch->queue.write.load() - ch->queue.read.load() == kQueue, "queue holds exactly kQueue scans");
    ck(ch->dropped.load() == 5, "overflow is counted, not waited on");
    Scan out{};
    ck(ch->queue.Pop(out) && out.sequence == 1, "scans carry a sequence");

    // Threat rows are bounded; the observed count keeps the truth.
    Scan t{};
    for (int i = 0; i < 40; ++i) { ThreatRow r{}; r.bullet = i; AddThreat(t, r); }
    ck(t.threatCount == kThreats && t.threatsObserved == 40, "threat rows capped, observed count kept");

    // Wire shape.
    t.ms = 1000; t.sequence = 7; t.branch = 1; t.targetValid = true; t.targetDist = 0.12f;
    const std::string json = EncodeScan(t, 3, 11, 1000, 1790000000000ULL, 16, 2);
    ck(json.find("\"kind\":\"native_autonexus_scan\"") != std::string::npos, "versioned record kind");
    ck(json.find("\"scan\":{") != std::string::npos && json.find("\"threats\":[[") != std::string::npos, "scan and threat rows present");
    ck(json.find("\"dropped\":2") != std::string::npos && json.find("\"branch\":1") != std::string::npos, "drops and branch serialized");
    ck(json.find("\"threatsObserved\":40") != std::string::npos, "observed threat count serialized");
    if (argc > 1) { FILE* out2 = std::fopen(argv[1], "wb"); if (out2) { std::fwrite(json.data(), 1, json.size(), out2); std::fclose(out2); } }

    std::printf("%d/%d autonexus scan capture checks passed\n", n - f, n);
    return f == 0 ? 0 : 1;
}
