#pragma once
// AUTONEXUS-SCAN-DIAG — private diagnostic, OFF unless encounter-capture.flag
// exists (UDodgeCapture::capture.enabled). Records the native AutoNexus scan
// whenever the published threat set is predicted to take >= 50% of confirmed HP.
// Strip: delete this file, AutoNexusScanWire.h, tests/autonexus_scan_capture_tests.cpp,
// tests/run_autonexus_scan_capture_tests.py, and every block tagged
// AUTONEXUS-SCAN-DIAG (AutoNexus.cpp, IpcBridge.cpp, DllCaptureBus.ts and its test).
//
// Single game-thread producer / single IPC-thread consumer. No allocation,
// waiting, I/O or managed pointers: fixed-size scalar records in a fixed ring.
#include "features/movement/udodge/UDodgeCapture.h"
#include <atomic>
#include <cmath>
#include <cstdint>
#include <type_traits>

namespace AutoNexusScanCapture {

constexpr unsigned kThreats = 16, kQueue = 32;

// Per-threat evidence. Closest approach is Chebyshev (the hit test's metric),
// measured from the scan instant over the horizon along the projected track
// and along a stationary hold at the scan position.
struct ThreatRow {
    int32_t owner = 0, bullet = 0, rawDamage = 0, applied = 0;
    uint32_t flags = 0;                      // 1 armor piercing
    float bx = 0.f, by = 0.f;                // bullet position at the scan (tiles)
    float bvx = 0.f, bvy = 0.f;              // bullet velocity at the scan (tiles/s)
    float tHitMs = -1.f;                     // published time-to-hit
    float trackClosest = -1.f, trackClosestMs = -1.f;
    float holdClosest = -1.f, holdClosestMs = -1.f;
};

struct Scan {
    uint64_t ms = 0, sequence = 0;
    int32_t hp = -1, maxHp = -1, defense = 0, totalApplied = 0;
    uint32_t branch = 0;                     // 1 committed (UDodge move), 0 observed/conservative
    float x = 0.f, y = 0.f, vx = 0.f, vy = 0.f;   // track origin and velocity (tiles, tiles/s)
    bool targetValid = false;
    float targetX = 0.f, targetY = 0.f, targetDist = -1.f;  // UDodge solver target this tick
    float horizonMs = 0.f, hitPad = 0.f;
    uint32_t threatsObserved = 0, threatCount = 0;
    ThreatRow threats[kThreats]{};
};
static_assert(std::is_trivially_copyable<Scan>::value, "scan capture owns only copied scalar data");

// Mirrors the client's defense rule (tomatoDamageWithDefense, no conditions).
inline int32_t Applied(int32_t raw, bool armorPiercing, int32_t defense)
{
    if (raw <= 0) return 0;
    const int32_t minDmg = (raw * 2) / 20;
    const int32_t after = raw - (armorPiercing ? 0 : defense);
    return after > minDmg ? after : minDmg;
}

inline bool Wanted(bool enabled, int32_t totalApplied, int32_t hp)
{
    return enabled && hp > 0 && totalApplied * 2 >= hp;
}

struct Track { float x = 0.f, y = 0.f, vx = 0.f, vy = 0.f; };   // tiles, tiles/ms
struct Approach { float distance = -1.f, atMs = -1.f; };

// Sampler(tMs, x, y) -> bool gives the bullet position tMs after the scan.
template <class Sampler>
Approach ClosestApproach(Sampler&& bulletAt, const Track& track, float horizonMs, float stepMs)
{
    Approach best;
    for (float t = 0.f; t <= horizonMs + 0.5f * stepMs; t += stepMs) {
        const float tc = t > horizonMs ? horizonMs : t;
        float bx = 0.f, by = 0.f;
        if (!bulletAt(tc, bx, by) || !std::isfinite(bx) || !std::isfinite(by)) continue;
        const float dx = std::fabs(bx - (track.x + track.vx * tc));
        const float dy = std::fabs(by - (track.y + track.vy * tc));
        const float d = dx > dy ? dx : dy;
        if (best.distance < 0.f || d < best.distance) { best.distance = d; best.atMs = tc; }
        if (tc >= horizonMs) break;
    }
    return best;
}

inline void AddThreat(Scan& s, const ThreatRow& row)
{
    ++s.threatsObserved;
    if (s.threatCount < kThreats) s.threats[s.threatCount++] = row;
}

struct Channel {
    UDodgeCapture::Queue<Scan, kQueue> queue{};
    std::atomic<uint64_t> dropped{0};
    uint64_t sequence = 0;
    void Offer(Scan s)
    {
        s.sequence = ++sequence;
        if (!queue.Push(s)) dropped.fetch_add(1, std::memory_order_relaxed);
    }
};
inline Channel channel{};

} // namespace AutoNexusScanCapture
