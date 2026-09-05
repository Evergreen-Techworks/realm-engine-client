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
#include <ctime>
#include <Windows.h>
#include <sstream>

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

inline void DbgFileLogWrite(const char* line)
{
    FILE* f = nullptr;
    if (fopen_s(&f, DbgFileLogPath(), "ab") != 0 || !f) return;

    SYSTEMTIME st;
    GetLocalTime(&st);
    fprintf(f, "[%02d:%02d:%02d.%03d] [tid=%lu] %s\n",
            st.wHour, st.wMinute, st.wSecond, st.wMilliseconds,
            GetCurrentThreadId(), line ? line : "");
    fflush(f);
    fclose(f);
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
