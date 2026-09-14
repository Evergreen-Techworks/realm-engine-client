#pragma once
// InputFocus — the one gate for native keyboard and mouse reads. Every
// GetAsyncKeyState / GetCursorPos in internal/src goes through here, so input acts
// only while the game window owns the foreground (rules: InputFocusCore.h).
//
//   GameHasFocus()     game window is the foreground window (cached ~one frame)
//   KeyDown(vk)        key held AND the game has focus
//   CursorClient(...)  cursor in game-client coordinates, only while focused
//
// The game window is the swapchain's OutputWindow, reported once by dPresent
// (SetGameWindow). Both it and the foreground window are compared by their root
// window, so a swapchain child window still matches its top-level frame.
// Header-only so the host suite compiles the real facade against a fake Windows.
#include "InputFocusCore.h"

#include <windows.h>

#include <atomic>
#include <cstdint>

namespace InputFocus {

// Longest a focus answer is reused. One 60 FPS frame; GetTickCount64 ticks ~16 ms.
inline constexpr uint64_t kFocusCacheMs = 16;

namespace detail {
inline std::atomic<HWND> g_gameWindow{ nullptr };
inline FocusCache        g_cache;

inline Sample SampleNow()
{
    Sample s;
    if (HWND fg = GetForegroundWindow()) {
        HWND root = GetAncestor(fg, GA_ROOT);
        s.foregroundRoot = static_cast<uintptr_t>(reinterpret_cast<uintptr_t>(root ? root : fg));
        DWORD pid = 0;
        GetWindowThreadProcessId(fg, &pid);
        s.foregroundPid = static_cast<uint32_t>(pid);
    }
    if (HWND game = g_gameWindow.load(std::memory_order_relaxed)) {
        HWND root = GetAncestor(game, GA_ROOT);
        s.gameRoot = static_cast<uintptr_t>(reinterpret_cast<uintptr_t>(root ? root : game));
    }
    s.selfPid = static_cast<uint32_t>(GetCurrentProcessId());
    return s;
}
} // namespace detail

// dPresent, once the swapchain's output window is known.
inline void SetGameWindow(HWND window)
{
    detail::g_gameWindow.store(window, std::memory_order_relaxed);
    detail::g_cache.Invalidate();
}

inline bool GameHasFocus()
{
    return detail::g_cache.Get(GetTickCount64(), kFocusCacheMs, detail::SampleNow);
}

inline bool KeyDown(int vk)
{
    return GameHasFocus() && (GetAsyncKeyState(vk) & 0x8000) != 0;
}

// Cursor position in `window`'s client coordinates. False, with `pt` untouched,
// while the game does not have focus.
inline bool CursorClient(HWND window, POINT& pt)
{
    if (!GameHasFocus()) return false;
    POINT p{};
    if (!GetCursorPos(&p)) return false;
    if (window) ScreenToClient(window, &p);
    pt = p;
    return true;
}

} // namespace InputFocus
