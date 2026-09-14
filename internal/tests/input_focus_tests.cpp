// Native input focus gate: keyboard and mouse reads act only while the game
// window owns the foreground.
//
// Part 1 tests the pure rules (core/runtime/InputFocusCore.h). Part 2 compiles
// the real Windows facade (core/runtime/InputFocus.h) and the real
// features/movement/dodge/SteerInput.cpp against the fake Windows layer in
// tests/input_focus_shim/windows.h, whose foreground window, window roots and key
// states the test sets. So "WASD does nothing while another app has focus" is
// checked on the production handler, not on a copy.
#include "input_focus_shim/fake_windows.h"
#include "core/runtime/InputFocusCore.h"
#include "core/runtime/InputFocus.h"
#include "features/movement/dodge/SteerInput.h"

#include <cstdio>

static int checks = 0, failures = 0;
#define CHECK(cond, ...) do { ++checks; if (!(cond)) { ++failures; \
    std::printf("FAIL %s:%d: ", __FILE__, __LINE__); std::printf(__VA_ARGS__); std::printf("\n"); } } while (0)

using InputFocus::Sample;

// ── Part 1: pure rules ────────────────────────────────────────────────────────
static void TestDecide()
{
    Sample s;
    s.selfPid = 100;
    s.foregroundPid = 100;
    s.foregroundRoot = 0x10;
    s.gameRoot = 0x10;
    CHECK(InputFocus::Decide(s), "game window in the foreground reads unfocused");

    s.foregroundRoot = 0x20;   // a browser, same PID impossible but roots decide
    CHECK(!InputFocus::Decide(s), "another window in the foreground reads focused");

    s.foregroundRoot = 0;
    CHECK(!InputFocus::Decide(s), "no foreground window (lock screen, desktop switch) reads focused");

    // Before the first Present the game window is unknown: fall back to the process.
    s.gameRoot = 0;
    s.foregroundRoot = 0x30;
    s.foregroundPid = 100;
    CHECK(InputFocus::Decide(s), "own process in the foreground before the window is known reads unfocused");
    s.foregroundPid = 200;
    CHECK(!InputFocus::Decide(s), "another process in the foreground before the window is known reads focused");
}

static void TestCacheRefreshesOncePerPeriod()
{
    InputFocus::FocusCache cache;
    int samples = 0;
    bool focused = true;
    const auto sample = [&]() {
        ++samples;
        Sample s;
        s.foregroundRoot = focused ? 1 : 2;
        s.gameRoot = 1;
        return s;
    };
    CHECK(cache.Get(1000, 16, sample) && samples == 1, "first read did not sample");
    focused = false;
    CHECK(cache.Get(1010, 16, sample) && samples == 1, "read inside the period re-sampled");
    CHECK(!cache.Get(1016, 16, sample) && samples == 2, "read after the period did not re-sample");
    cache.Invalidate();
    focused = true;
    CHECK(cache.Get(1017, 16, sample) && samples == 3, "invalidate did not force a sample");
}

static void TestPressEdge()
{
    InputFocus::PressEdge edge;
    CHECK(!edge.Update(true, false), "idle frame fired");
    CHECK(edge.Update(true, true), "press while focused did not fire");
    CHECK(!edge.Update(true, true), "held button fired twice");
    CHECK(!edge.Update(true, false), "release fired");

    // Presses while another app has focus never fire.
    CHECK(!edge.Update(false, true), "press while unfocused fired");
    CHECK(!edge.Update(false, false), "release while unfocused fired");

    // The click that activates the game window arrives already held: it must not
    // count (Ctrl-clicking back into the game would otherwise teleport).
    CHECK(!edge.Update(false, false), "unfocused idle fired");
    CHECK(!edge.Update(true, true), "focusing click fired");
    CHECK(!edge.Update(true, true), "focusing click fired while still held");
    CHECK(!edge.Update(true, false), "focusing click release fired");
    CHECK(edge.Update(true, true), "first press after refocus did not fire");
}

// ── Part 2: the real facade and SteerInput on the fake Windows layer ─────────
static void SetFocus(bool gameFocused)
{
    FakeWin::foreground = gameFocused ? FakeWin::kGameChild : FakeWin::kBrowser;
    FakeWin::nowMs += 1000;   // step past the focus cache
}

static void TestFacadeUsesTheGameWindowRoot()
{
    FakeWin::Reset();
    InputFocus::SetGameWindow(FakeWin::kGameChild);   // swapchain window is a child
    SetFocus(true);
    CHECK(InputFocus::GameHasFocus(), "game root in the foreground reads unfocused");
    SetFocus(false);
    CHECK(!InputFocus::GameHasFocus(), "browser in the foreground reads focused");

    FakeWin::keys['W'] = true;
    CHECK(!InputFocus::KeyDown('W'), "W read down while unfocused");
    SetFocus(true);
    CHECK(InputFocus::KeyDown('W'), "W read up while focused");
    FakeWin::keys['W'] = false;
}

static void TestSteerInputIgnoresKeysWhileUnfocused()
{
    FakeWin::Reset();
    InputFocus::SetGameWindow(FakeWin::kGameChild);

    // W and D (typed into another app) must not steer; opposite keys would cancel
    // out and prove nothing, so hold a diagonal.
    SetFocus(false);
    FakeWin::keys['W'] = true;
    FakeWin::keys['D'] = true;
    SteerInput::Tick();
    CHECK(!SteerInput::Get().active, "SteerInput steered from keys held in another app");
    FakeWin::keys[VK_UP] = true;
    FakeWin::keys[VK_RIGHT] = true;
    SteerInput::Tick();
    CHECK(!SteerInput::Get().active, "SteerInput steered from arrow keys held in another app");

    FakeWin::keys['D'] = false;
    FakeWin::keys[VK_UP] = false;
    FakeWin::keys[VK_RIGHT] = false;
    SetFocus(true);
    SteerInput::Tick();
    const SteerInput::SteerState held = SteerInput::Get();
    CHECK(held.active && held.dirY < -0.9f, "SteerInput ignored W while focused (active=%d dirY=%.2f)",
          held.active ? 1 : 0, held.dirY);

    // Tabbing out while W is held releases the steer (and fires the release edge).
    (void)SteerInput::ConsumeReleaseEdge();
    SetFocus(false);
    SteerInput::Tick();
    CHECK(!SteerInput::Get().active, "steer stayed active after focus moved away");
    CHECK(SteerInput::ConsumeReleaseEdge(), "losing focus did not release the steer");
    FakeWin::keys['W'] = false;
}

int main()
{
    TestDecide();
    TestCacheRefreshesOncePerPeriod();
    TestPressEdge();
    TestFacadeUsesTheGameWindowRoot();
    TestSteerInputIgnoresKeysWhileUnfocused();
    std::printf("input_focus_tests: %d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
