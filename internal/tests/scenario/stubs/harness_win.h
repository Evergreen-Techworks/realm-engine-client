#pragma once
// Host shim for the UDodge scenario harness. Stands in for <windows.h> and the
// precompiled header when the production dodge sources are compiled on Linux.
// GetTickCount64 is the SIMULATED clock, so every timer the production code keeps
// (nav stall detection, follow throttles) advances with the scenario, not the host.
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

typedef unsigned long long ULONGLONG;
typedef unsigned long      DWORD;
typedef long               LONG;

struct LARGE_INTEGER { long long QuadPart; };
inline void QueryPerformanceFrequency(LARGE_INTEGER* p) { p->QuadPart = 1000000000LL; }
inline void QueryPerformanceCounter(LARGE_INTEGER* p)
{
    p->QuadPart = std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}

ULONGLONG HarnessNowMs();   // defined by the harness (simulated milliseconds)
inline ULONGLONG GetTickCount64() { return HarnessNowMs(); }

#define MAX_PATH 260
#define INVALID_FILE_ATTRIBUTES (static_cast<DWORD>(-1))
inline DWORD GetFileAttributesA(const char*) { return INVALID_FILE_ATTRIBUTES; }

#ifndef _TRUNCATE
#define _TRUNCATE (static_cast<size_t>(-1))
#endif
inline int strncpy_s(char* dst, size_t cap, const char* src, size_t)
{
    if (!dst || cap == 0) return 1;
    std::snprintf(dst, cap, "%s", src ? src : "");
    return 0;
}
inline int strncat_s(char* dst, size_t cap, const char* src, size_t)
{
    if (!dst || cap == 0) return 1;
    const size_t used = std::strlen(dst);
    if (used + 1 >= cap) return 1;
    std::snprintf(dst + used, cap - used, "%s", src ? src : "");
    return 0;
}

#ifndef __fastcall
#define __fastcall
#endif
