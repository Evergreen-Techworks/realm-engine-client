#pragma once
// InputFocusCore — the rules behind the native input focus gate, free of Windows so
// the host suite tests them (internal/tests/input_focus_tests.cpp). The Windows
// facade every input site calls is core/runtime/InputFocus.h.
//
// Why: native features read the keyboard and mouse with GetAsyncKeyState and
// GetCursorPos, which report the whole desktop. Ctrl+click in a browser teleported
// the player, WASD typed into another app steered uDodge and cancelled its walk
// goal, and Shift/middle-click set locks, all while the game was in the background.
#include <atomic>
#include <cstdint>

namespace InputFocus {

// One observation of who owns the foreground. Window values are opaque handles.
struct Sample {
    uintptr_t foregroundRoot = 0;  // root window of the foreground window; 0 = none
    uintptr_t gameRoot       = 0;  // root of the game's swapchain window; 0 = not known yet
    uint32_t  foregroundPid  = 0;  // process owning the foreground window
    uint32_t  selfPid        = 0;  // the game process
};

// The game has input focus when its own window is the foreground window. Before
// the first Present reports that window, the owning process decides instead.
inline bool Decide(const Sample& s)
{
    if (s.foregroundRoot == 0) return false;
    if (s.gameRoot != 0) return s.foregroundRoot == s.gameRoot;
    return s.selfPid != 0 && s.foregroundPid == s.selfPid;
}

// Decide() cached for a short period so the many input sites in one frame share
// one foreground query. Safe from any thread: at worst two threads both sample.
class FocusCache {
public:
    template <typename SampleFn>
    bool Get(uint64_t nowMs, uint64_t periodMs, SampleFn&& sample)
    {
        if (m_valid.load(std::memory_order_relaxed)
            && nowMs - m_sampledMs.load(std::memory_order_relaxed) < periodMs)
            return m_focused.load(std::memory_order_relaxed);
        const bool focused = Decide(sample());
        m_focused.store(focused, std::memory_order_relaxed);
        m_sampledMs.store(nowMs, std::memory_order_relaxed);
        m_valid.store(true, std::memory_order_relaxed);
        return focused;
    }
    void Invalidate() { m_valid.store(false, std::memory_order_relaxed); }

private:
    std::atomic<bool>     m_valid{ false };
    std::atomic<bool>     m_focused{ false };
    std::atomic<uint64_t> m_sampledMs{ 0 };
};

// Press edge for a mouse button or chord that counts only for a press that began
// while the game had focus. While unfocused nothing fires, and after focus returns
// the button must be seen released first, so the click that activates the game
// window (with Ctrl or Shift held) is not taken as a command. One per input site,
// owned by the thread that polls it.
struct PressEdge {
    bool prevDown = true;   // assume held until seen released while focused
    bool Update(bool focused, bool down)
    {
        if (!focused) { prevDown = true; return false; }
        const bool edge = down && !prevDown;
        prevDown = down;
        return edge;
    }
};

} // namespace InputFocus
