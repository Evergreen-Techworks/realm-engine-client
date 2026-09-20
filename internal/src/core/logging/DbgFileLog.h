#pragma once
// DbgFileLog — write trace messages to a file that persists after crashes.
// Every write is immediately flushed so nothing is lost when the game dies.
//
// Log path: %LOCALAPPDATA%\RotMG Exalt DLL Trace.log
//
// Usage:  DBG_FILE_LOG("about to call X, value=" << someVar);
//
// ── TRACE vs CRASH ───────────────────────────────────────────────────────────
// Two things live here and they are gated DIFFERENTLY on purpose:
//
//   DBG_FILE_LOG    — the ~150 chatty trace sites. OFF in Release unless opted in
//                     (see DbgFileLogEnabled). A shipped build must not write a
//                     100 MB forensic log to the user's disk, and must not pay a
//                     synchronous fopen/fflush/fclose per message on the IPC and
//                     game threads. Left ungated, `[IpcBridge] setFeature` alone
//                     accounted for 1,039,481 of 1,117,392 logged lines (93%) —
//                     one disk round-trip per feature command.
//
//   DbgFileLogWrite — the raw writer, deliberately NOT gated. The crash handlers
//                     (CrashProbe.h) and the SEH __except paths in DangerPlanner /
//                     MovementRuntime / ShootRuntime call it directly, because a
//                     fault handler cannot safely construct C++ objects like the
//                     ostringstream the macro uses. A crash report is exactly what
//                     you still want out of a RELEASE build, and these fire once
//                     per fault rather than once per message.
#include <cstdio>
#include <cstdarg>
#include <cstring>
#include <ctime>
#include <Windows.h>
#include <sstream>
#include <string>
#include <vector>
#include <mutex>
#include <atomic>

inline const char* DbgFileLogPath()
{
    static char s_path[MAX_PATH] = {};
    if (s_path[0]) return s_path;
    char local[MAX_PATH] = {};
    DWORD n = GetEnvironmentVariableA("LOCALAPPDATA", local, sizeof(local));
    if (n > 0 && n < sizeof(local)) {
        snprintf(s_path, sizeof(s_path), "%s\\RotMG Exalt DLL Trace.log", local);
    } else {
        snprintf(s_path, sizeof(s_path), "C:\\dll-trace.log");
    }
    return s_path;
}

// Is chatty tracing on? Debug: always. Release: only when RE_TRACE_LOG is set to
// something other than "0". Resolved ONCE (function-local static), so the steady
// -state cost at a disabled call site is a single relaxed bool load.
//
// Opt-in rather than compiled out, deliberately. Every field diagnosis this project
// has made — the IPC throughput ceiling, the solver's Surrounded holds, the nav
// routes collapsing to one waypoint, the projectile lane garbage — was read out of
// this file on a RELEASE build, because Release is what actually runs the game.
// Compiling the sites away would have made all of that impossible; putting them one
// environment variable away keeps the capability while shipping a silent default.
//
//   cmd:         set RE_TRACE_LOG=1  &&  "RotMG Exalt.exe"
//   PowerShell:  $env:RE_TRACE_LOG=1 ;  & "RotMG Exalt.exe"
inline bool DbgFileLogEnabled()
{
#ifdef _DEBUG
    return true;
#else
    static const bool s_enabled = [] {
        char v[32] = {};
        const DWORD n = GetEnvironmentVariableA("RE_TRACE_LOG", v, sizeof(v));
        return n > 0 && n < sizeof(v) && v[0] != '\0' && v[0] != '0';
    }();
    return s_enabled;
#endif
}

// ── Buffering (navigation finish plan, Item 4) ───────────────────────────────
// This is the ungated writer: 11,290 lines in 28 minutes with diag timing on
// was 11,290 synchronous fopen/fprintf/fflush/fclose round-trips on the game
// thread, perturbing the very numbers the flag exists to measure. Lines are now
// queued in memory (their timestamp/tid is still stamped HERE, at emit time —
// only the disk write is deferred) and flushed as ONE fopen/fwrite/fclose when
// the queue reaches kFlushBytes or kFlushPeriodMs have passed since the last
// flush, whichever comes first — checked opportunistically on each write, since
// there is no dedicated logging thread to own a timer. Behaviour with nothing
// calling this function is unchanged: an empty queue never flushes itself.
//
// Crash safety is preserved, not weakened: DbgFileLogEnterCrashMode() (wired to
// CrashProbe's vectored/top-level handlers and to DLL_PROCESS_DETACH) flushes
// whatever is queued and switches every LATER call back to the original
// unbuffered, immediately-flushed behaviour — so the crash report CrashProbe is
// about to write, and everything queued before it, both reach disk before the
// process can die. try_lock only in that path: a vectored handler can fire on
// the same thread that is mid-push_back under BufMutex(), and a blocking
// re-lock there would hang the crash handler itself instead of writing a report.
namespace DbgFileLogDetail {
inline std::mutex& BufMutex() { static std::mutex m; return m; }
inline std::vector<std::string>& Buf() { static std::vector<std::string> v; return v; }
inline size_t& BufBytes() { static size_t n = 0; return n; }
inline ULONGLONG& LastFlushMs() { static ULONGLONG t = 0; return t; }
inline std::atomic<bool>& ImmediateMode() { static std::atomic<bool> b{ false }; return b; }
constexpr size_t     kFlushBytes    = 64 * 1024;
constexpr ULONGLONG  kFlushPeriodMs = 250;

// Caller already holds BufMutex() (or crash mode, where nothing else can be
// concurrently appending on this thread). ONE fopen/fwrite/fclose for the
// whole queue.
inline void FlushLocked()
{
    std::vector<std::string>& buf = Buf();
    if (buf.empty()) { LastFlushMs() = GetTickCount64(); return; }
    FILE* f = nullptr;
    if (fopen_s(&f, DbgFileLogPath(), "ab") == 0 && f) {
        for (const std::string& s : buf) fwrite(s.data(), 1, s.size(), f);
        fflush(f);
        fclose(f);
    }
    buf.clear();
    BufBytes() = 0;
    LastFlushMs() = GetTickCount64();
}

inline void WriteImmediate(const char* formatted, size_t len)
{
    FILE* f = nullptr;
    if (fopen_s(&f, DbgFileLogPath(), "ab") != 0 || !f) return;
    fwrite(formatted, 1, len, f);
    fflush(f);
    fclose(f);
}
} // namespace DbgFileLogDetail

// Flush whatever is currently queued. Safe to call any time; a no-op with an
// empty queue.
inline void DbgFileLogFlush()
{
    std::lock_guard<std::mutex> lk(DbgFileLogDetail::BufMutex());
    DbgFileLogDetail::FlushLocked();
}

// Fatal-exception / shutdown path only (CrashProbe.h, dllmain.cpp
// DLL_PROCESS_DETACH). Flushes the queue with try_lock (see the note above —
// never blocks) and puts every later DbgFileLogWrite call back to unbuffered,
// immediately-flushed writes for the rest of the process's life.
inline void DbgFileLogEnterCrashMode()
{
    if (DbgFileLogDetail::ImmediateMode().exchange(true, std::memory_order_seq_cst))
        return;   // already in crash mode (a second fault, or detach after a crash)
    std::unique_lock<std::mutex> lk(DbgFileLogDetail::BufMutex(), std::try_to_lock);
    if (lk.owns_lock()) DbgFileLogDetail::FlushLocked();
}

inline void DbgFileLogWrite(const char* line)
{
    SYSTEMTIME st;
    GetLocalTime(&st);
    char formatted[1200];
    const int n = snprintf(formatted, sizeof(formatted), "[%02d:%02d:%02d.%03d] [tid=%lu] %s\n",
                            st.wHour, st.wMinute, st.wSecond, st.wMilliseconds,
                            GetCurrentThreadId(), line ? line : "");
    if (n <= 0) return;
    const size_t len = n < static_cast<int>(sizeof(formatted)) ? static_cast<size_t>(n) : sizeof(formatted) - 1;

    if (DbgFileLogDetail::ImmediateMode().load(std::memory_order_relaxed)) {
        DbgFileLogDetail::WriteImmediate(formatted, len);
        return;
    }

    std::lock_guard<std::mutex> lk(DbgFileLogDetail::BufMutex());
    DbgFileLogDetail::Buf().emplace_back(formatted, len);
    DbgFileLogDetail::BufBytes() += len;
    ULONGLONG& last = DbgFileLogDetail::LastFlushMs();
    const ULONGLONG now = GetTickCount64();
    if (last == 0) last = now;   // first write of the process: start the window, don't flush yet
    if (DbgFileLogDetail::BufBytes() >= DbgFileLogDetail::kFlushBytes ||
        now - last >= DbgFileLogDetail::kFlushPeriodMs)
        DbgFileLogDetail::FlushLocked();
}

// The guard wraps the FORMATTING, not just the write. Building the ostringstream
// first and discarding it would still cost an allocation and a full format per call
// at all 150 sites on the hot paths — the string nobody reads is most of the cost.
#define DBG_FILE_LOG(expr) do { \
    if (DbgFileLogEnabled()) { \
        std::ostringstream _dbg_oss; _dbg_oss << expr; \
        DbgFileLogWrite(_dbg_oss.str().c_str()); \
    } \
} while(0)
