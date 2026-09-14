#pragma once
// DiagTiming — field measurement of frame cost and dodge behaviour. OFF by default.
//
// Why this exists: the dodge tab's "Diag timing" checkbox is not reachable in the
// shipped menu (TestTAB::RenderMovementSection has no caller) and its report went
// through DBG_FILE_LOG, which a Release build drops unless RE_TRACE_LOG is set —
// and RE_TRACE_LOG turns on every trace site at once, which perturbs the very
// numbers being measured. So there was no way to measure a user's session.
//
// How to switch it on: create an empty file named `diag-timing.flag` in the same
// folder as the native trace log (RE_ASSETS next to the portable EXE, or
// %LOCALAPPDATA% for a dev build). The flag is polled every 2 s, so it can be
// created and deleted mid-session. Delete it to switch the probes off again.
//
// Cost when OFF: one relaxed atomic load per probe site plus one GetTickCount64
// compare per frame for the poll; the file itself is checked at most every 2 s.
// Output: one line per thread every 2 s, plus event lines ([Diag/Stall],
// [Diag/Hit]), written with the ungated DbgFileLogWrite.
#include "DbgFileLog.h"

#include <atomic>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <windows.h>

namespace DiagTiming {

inline std::atomic<bool> g_on{ false };      // flag file present (PollFlag)
inline std::atomic<bool> g_forced{ false };  // developer checkbox (UDodge::SetDiagTiming)

inline bool On()
{
    return g_on.load(std::memory_order_relaxed) || g_forced.load(std::memory_order_relaxed);
}
inline void SetForced(bool on) { g_forced.store(on, std::memory_order_relaxed); }

// Check for the flag file at most every 2 s. Safe from any thread.
inline void PollFlag()
{
    static std::atomic<ULONGLONG> s_nextMs{ 0 };
    const ULONGLONG now = GetTickCount64();
    ULONGLONG next = s_nextMs.load(std::memory_order_relaxed);
    if (now < next) return;
    if (!s_nextMs.compare_exchange_strong(next, now + 2000ULL, std::memory_order_relaxed)) return;

    char path[MAX_PATH] = {};
    const char* log = DbgFileLogPath();
    if (!log || !*log) return;
    strncpy_s(path, sizeof(path), log, _TRUNCATE);
    char* slash = std::strrchr(path, '\\');
    char* fwd = std::strrchr(path, '/');
    if (fwd && (!slash || fwd > slash)) slash = fwd;
    const size_t dirLen = slash ? static_cast<size_t>(slash - path) + 1 : 0;
    path[dirLen] = '\0';
    strncat_s(path, sizeof(path), "diag-timing.flag", _TRUNCATE);

    const bool present = GetFileAttributesA(path) != INVALID_FILE_ATTRIBUTES;
    const bool was = g_on.exchange(present, std::memory_order_relaxed);
    if (present != was)
        DbgFileLogWrite(present ? "[Diag] timing ON (diag-timing.flag found)"
                                : "[Diag] timing OFF (diag-timing.flag removed)");
}

inline double NowMs()
{
    static const double invFreqMs = [] {
        LARGE_INTEGER f; QueryPerformanceFrequency(&f);
        return 1000.0 / static_cast<double>(f.QuadPart);
    }();
    LARGE_INTEGER t; QueryPerformanceCounter(&t);
    return static_cast<double>(t.QuadPart) * invFreqMs;
}

// Sum / max / count of one measured quantity. Single-thread owner, no locking.
struct Accum {
    double   sum = 0.0;
    double   max = 0.0;
    uint32_t n   = 0;
    void Add(double v) { sum += v; if (v > max) max = v; ++n; }
    double Avg() const { return n ? sum / n : 0.0; }
    void Reset() { *this = Accum{}; }
};

// RAII timer that records only while diagnostics are on.
class Scope {
public:
    explicit Scope(Accum& a) : m_a(a), m_armed(On()) { if (m_armed) m_t0 = NowMs(); }
    ~Scope() { if (m_armed) m_a.Add(NowMs() - m_t0); }
    Scope(const Scope&) = delete;
    Scope& operator=(const Scope&) = delete;
private:
    Accum& m_a;
    bool   m_armed;
    double m_t0 = 0.0;
};

inline void Logf(const char* fmt, ...)
{
    char buf[1536];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    DbgFileLogWrite(buf);
}

// Returns true once every `periodMs` for the calling site's own clock.
inline bool Due(ULONGLONG& lastMs, ULONGLONG periodMs = 2000ULL)
{
    const ULONGLONG now = GetTickCount64();
    if (lastMs == 0) { lastMs = now; return false; }
    if (now - lastMs < periodMs) return false;
    lastMs = now;
    return true;
}

// ── Render thread (dPresent → TestTAB::Tick → WorldTAB::ForceRefresh) ───────
struct RenderStats {
    Accum presentBody;   // dPresent work before the real Present (excl. frame-cap wait)
    Accum capWait;       // Present-level FPS cap sleep/yield
    Accum testTabTick;   // TestTAB::Tick (includes the world refresh when due)
    Accum worldRefresh;  // WorldTAB::DoRefresh
    int32_t tileListSize = 0;   // game's streamed-square list length (last refresh)
    int32_t tileScanned  = 0;   // list entries walked (last refresh)
    int32_t tilesKept    = 0;   // tiles copied into the movement maps (last refresh)
    int32_t entities     = 0;   // entity dict entries (last refresh)
    ULONGLONG lastEmitMs = 0;
};
inline RenderStats& Render() { static RenderStats s; return s; }

// ── Game-update thread (AppEngineManager::Update detour → UDodge::Tick) ─────
struct GameStats {
    Accum origUpdate;    // the game's own AppEngineManager::Update
    Accum dodgeBody;     // RunDodgeTickBody (SteerInput + lock + engine tick)
    Accum updateGap;     // wall time between consecutive detour entries
    uint32_t gapsOver100 = 0, gapsOver250 = 0;
    double lastEntryMs = 0.0;
    ULONGLONG lastEmitMs = 0;
    // UDodge::Tick phases
    Accum sync, rasterOcc, rasterNav, publish, liveSolve, revalidate, debug, total;
    uint32_t rebuilds = 0, reanchors = 0, publishes = 0, publishDropped = 0;
    uint32_t revalidateResolves = 0, navReplans = 0, navStalls = 0, navBlocked = 0, navWaitFrames = 0;
    uint32_t moves = 0, moveRefused = 0, holds = 0, safes = 0, fallbacks = 0, surrounded = 0;
    uint32_t workerAccepted = 0, workerDiscarded = 0, routeFound = 0, routePartial = 0;
    uint32_t navAvoids = 0, lockApproachFrames = 0, hazardRoutes = 0;   // stuck memory / lock approach / hazard-crossing routes
    int32_t  maxLanes = 0, maxZones = 0, maxEnemies = 0;
    uint32_t mapLimited = 0;
    float    workerDodgeMsMax = 0.f, workerNavMsMax = 0.f, workerTimedMsMax = 0.f, workerSolveMsMax = 0.f;
    void ResetWindow()
    {
        origUpdate.Reset(); dodgeBody.Reset(); updateGap.Reset();
        gapsOver100 = gapsOver250 = 0;
        sync.Reset(); rasterOcc.Reset(); rasterNav.Reset(); publish.Reset();
        liveSolve.Reset(); revalidate.Reset(); debug.Reset(); total.Reset();
        rebuilds = reanchors = publishes = publishDropped = 0;
        revalidateResolves = navReplans = navStalls = navBlocked = navWaitFrames = 0;
        moves = moveRefused = holds = safes = fallbacks = surrounded = 0;
        workerAccepted = workerDiscarded = routeFound = routePartial = 0;
        navAvoids = lockApproachFrames = hazardRoutes = 0;
        maxLanes = maxZones = maxEnemies = 0;
        mapLimited = 0;
        workerDodgeMsMax = workerNavMsMax = workerTimedMsMax = workerSolveMsMax = 0.f;
    }
};
inline GameStats& Game() { static GameStats s; return s; }

} // namespace DiagTiming
