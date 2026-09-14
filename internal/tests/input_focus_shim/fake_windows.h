#pragma once
// Fake Windows layer for tests/input_focus_tests.cpp. Only what the input focus
// facade (core/runtime/InputFocus.h) and SteerInput.cpp call. The test sets which
// window is in the foreground, each window's root, and which keys are held.
#include <cstdint>
#include <map>

using HWND = struct FakeHwnd*;
using DWORD = unsigned long;
using BOOL = int;
using SHORT = short;
struct POINT { long x; long y; };
using LPPOINT = POINT*;
using ULONGLONG = unsigned long long;
inline constexpr unsigned GA_ROOT = 2;
inline constexpr int VK_LEFT = 0x25, VK_UP = 0x26, VK_RIGHT = 0x27, VK_DOWN = 0x28;

namespace FakeWin {
inline const HWND kGameRoot  = reinterpret_cast<HWND>(0x1000);
inline const HWND kGameChild = reinterpret_cast<HWND>(0x1001);   // swapchain window under the root
inline const HWND kBrowser   = reinterpret_cast<HWND>(0x2000);
inline HWND foreground = nullptr;
inline std::map<int, bool> keys;
inline ULONGLONG nowMs = 50000;
inline int cursorReads = 0;
inline void Reset() { foreground = nullptr; keys.clear(); nowMs += 100000; cursorReads = 0; }
}

inline HWND GetForegroundWindow() { return FakeWin::foreground; }
inline HWND GetAncestor(HWND w, unsigned) { return w == FakeWin::kGameChild ? FakeWin::kGameRoot : w; }
inline DWORD GetWindowThreadProcessId(HWND w, DWORD* pid)
{
    if (pid) *pid = (w == FakeWin::kGameRoot || w == FakeWin::kGameChild) ? 100 : 200;
    return 1;
}
inline DWORD GetCurrentProcessId() { return 100; }
inline ULONGLONG GetTickCount64() { return FakeWin::nowMs; }
inline SHORT GetAsyncKeyState(int vk)
{
    auto it = FakeWin::keys.find(vk);
    return (it != FakeWin::keys.end() && it->second) ? static_cast<SHORT>(0x8000) : 0;
}
inline BOOL GetCursorPos(LPPOINT p) { ++FakeWin::cursorReads; if (p) { p->x = 10; p->y = 20; } return 1; }
inline BOOL ScreenToClient(HWND, LPPOINT) { return 1; }
