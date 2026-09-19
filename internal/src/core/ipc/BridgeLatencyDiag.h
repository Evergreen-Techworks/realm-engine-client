#pragma once
// BridgeLatencyDiag — measurement only, part of item 4b (script-to-dodge command
// latency). No behaviour change: this file only ever reads timestamps and writes
// log lines, gated end-to-end by DiagTiming::On() (the existing diag-timing.flag).
//
// What it measures: the receive->apply delta for client->DLL bridge commands
// (setFeature). "Receive" is stamped in IpcBridge.cpp's ParseSetFeatureCommand,
// right after a command is parsed off the pipe, on IpcBridgeThread. "Apply" is
// stamped at the point the command actually takes effect:
//   - most commands: FeatureCommandRegistry's FH macro stamps it right after the
//     handler body runs (same thread, same call — this is the "pipe-parsed to
//     handler-executed" cost, not a cross-thread wait, and will read ~0 unless
//     the handler itself blocks).
//   - walkTargetX/Y/Active: deliberately EXCLUDED from the FH auto-stamp (see
//     FH_DEFERRED in FeatureCommandRegistry.cpp) because their real apply point
//     is FeatureRuntime::ApplyWalkTargetFeatureState(), called once per frame
//     from the DirectX Present hook — a genuine game/render-thread handoff with
//     real latency (one frame period normally, longer during a stall). That is
//     the one instrumented case that can show more than noise.
//
// Both stamps use DiagTiming::NowMs() (QueryPerformanceCounter), so this never
// has to reconcile the Node clock with the native one — it is a native-only,
// self-consistent measurement written to native-trace.log as [Diag/Bridge].
//
// Cost when off: one relaxed atomic load (DiagTiming::On()) per command; the
// map/vector below are never touched.
#include "DiagTiming.h"

#include <algorithm>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>
#include <windows.h>

namespace BridgeLatencyDiag {

struct State {
    std::mutex mutex;
    std::unordered_map<std::string, double> receivedAtMs;  // key -> NowMs() at receipt
    std::vector<double> windowSamplesMs;                    // this 5s window's receive->apply deltas
    ULONGLONG windowStartMs = 0;
};
inline State& S()
{
    static State s;
    return s;
}

inline void FlushWindowIfDue()
{
    auto& s = S();
    std::vector<double> window;
    {
        std::lock_guard<std::mutex> lk(s.mutex);
        const ULONGLONG now = GetTickCount64();
        if (s.windowStartMs == 0) { s.windowStartMs = now; return; }
        if (now - s.windowStartMs < 5000ULL) return;
        s.windowStartMs = now;
        if (s.windowSamplesMs.empty()) return;
        window.swap(s.windowSamplesMs);
    }
    std::sort(window.begin(), window.end());
    const size_t n = window.size();
    const auto pct = [&](double p) {
        size_t i = static_cast<size_t>(p * static_cast<double>(n - 1));
        return window[i];
    };
    DiagTiming::Logf("[Diag/Bridge] window n=%zu p50=%.1fms p95=%.1fms max=%.1fms",
                      n, pct(0.50), pct(0.95), window.back());
}

// Called on IpcBridgeThread right after a setFeature command is parsed.
inline void NoteReceived(const char* key)
{
    if (!DiagTiming::On() || !key || !*key) return;
    auto& s = S();
    std::lock_guard<std::mutex> lk(s.mutex);
    s.receivedAtMs[key] = DiagTiming::NowMs();
}

// Called at the real apply point for `key`. No-op if no receive stamp is
// pending for this key (nothing was sent this window, or it was already
// consumed) — never fabricates a delta.
inline void NoteApplied(const char* key)
{
    if (!DiagTiming::On() || !key || !*key) return;
    auto& s = S();
    double deltaMs = -1.0;
    {
        std::lock_guard<std::mutex> lk(s.mutex);
        auto it = s.receivedAtMs.find(key);
        if (it == s.receivedAtMs.end()) return;
        deltaMs = DiagTiming::NowMs() - it->second;
        s.receivedAtMs.erase(it);
        s.windowSamplesMs.push_back(deltaMs);
    }
    if (deltaMs > 100.0)
        DiagTiming::Logf("[Diag/Bridge] key=%s receive->apply=%.1fms (>100ms)", key, deltaMs);
    FlushWindowIfDue();
}

}  // namespace BridgeLatencyDiag
