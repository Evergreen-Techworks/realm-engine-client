#pragma once
// AUTONEXUS-SCAN-DIAG — IPC-thread only formatting (allocates); see
// AutoNexusScanCapture.h for the strip list.
#include "AutoNexusScanCapture.h"
#include "features/movement/udodge/UDodgeCaptureWire.h"
#include <string>

namespace AutoNexusScanCapture {

inline std::string EncodeScan(const Scan& s, uint32_t pid, uint64_t startUtc, uint64_t anchorMs, uint64_t anchorUtc,
                              uint64_t uncertainty, uint64_t dropped)
{
    auto j = UDodgeCapture::Envelope("native_autonexus_scan", pid, startUtc, anchorMs, anchorUtc, uncertainty);
    j.Int("scanQueueHighWater", channel.queue.highWater.load(std::memory_order_relaxed));
    j.Int("channelBytes", sizeof(Channel));
    j.Int("dropped", dropped);
    j.out += "\"scan\":{";
    j.Int("ms", s.ms); j.Int("sequence", s.sequence);
    j.Num("hp", s.hp); j.Num("maxHp", s.maxHp); j.Num("defense", s.defense); j.Num("totalApplied", s.totalApplied);
    j.Int("branch", s.branch);
    j.Num("x", s.x); j.Num("y", s.y); j.Num("vx", s.vx); j.Num("vy", s.vy);
    j.Int("targetValid", s.targetValid); j.Num("targetX", s.targetX); j.Num("targetY", s.targetY); j.Num("targetDist", s.targetDist);
    j.Num("horizonMs", s.horizonMs); j.Num("hitPad", s.hitPad);
    j.Int("threatsObserved", s.threatsObserved);
    j.Key("threatCount"); j.Integer(s.threatCount); j.out += "},\"threats\":[";
    for (unsigned i = 0; i < s.threatCount; ++i) {
        if (i) j.out += ',';
        const auto& t = s.threats[i];
        const double a[] = { double(t.owner), double(t.bullet), double(t.rawDamage), double(t.applied), double(t.flags),
                             t.bx, t.by, t.bvx, t.bvy, t.tHitMs, t.trackClosest, t.trackClosestMs, t.holdClosest, t.holdClosestMs };
        j.out += '[';
        for (unsigned k = 0; k < 14; ++k) { if (k) j.out += ','; j.Number(a[k]); }
        j.out += ']';
    }
    j.out += "]}";
    return j.out;
}

} // namespace AutoNexusScanCapture
