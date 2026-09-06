#include "pch-il2cpp.h"
#include "SteerInput.h"

#include <atomic>
#include <cmath>
#include <cstdint>
#include <windows.h>

namespace {

constexpr float kDirThreshold = 0.05f;

std::atomic<bool>  s_active{ false };
std::atomic<float> s_dirX{ 0.f };
std::atomic<float> s_dirY{ 0.f };
std::atomic<bool>  s_edgeToIdle{ false };

// Read the raw keyboard state for WASD / arrows. We intentionally DO NOT
// use FKALGHJIADI.Player_Moving / Player_MoveDirX/Y here: those fields are
// true whenever the character is interpolating to a move target — including
// when the planner itself drives movement via DGLCONCOIBO. That produces a
// feedback loop (planner moves → game sets Player_Moving → planner thinks
// WASD is held → planner stops → Player_Moving clears → planner resumes
// → ...), which shows up as a ~30 Hz stutter. GetAsyncKeyState reads OS
// input directly and only reports genuine user input.
bool ReadMovementKeys(bool& outMoving, float& outDx, float& outDy)
{
    const bool w = (GetAsyncKeyState('W')     & 0x8000) != 0 ||
                   (GetAsyncKeyState(VK_UP)   & 0x8000) != 0;
    const bool a = (GetAsyncKeyState('A')     & 0x8000) != 0 ||
                   (GetAsyncKeyState(VK_LEFT) & 0x8000) != 0;
    const bool s = (GetAsyncKeyState('S')     & 0x8000) != 0 ||
                   (GetAsyncKeyState(VK_DOWN) & 0x8000) != 0;
    const bool d = (GetAsyncKeyState('D')     & 0x8000) != 0 ||
                   (GetAsyncKeyState(VK_RIGHT)& 0x8000) != 0;

    outDx = 0.f;
    outDy = 0.f;
    // RotMG world-space: +X is east/right, +Y is SOUTH/down. Up (W) must
    // therefore DECREASE Y. (This is the axis the dirY contract promises;
    // screen-space +Y-up here inverted vertical movement.)
    if (w) outDy -= 1.f;
    if (s) outDy += 1.f;
    if (d) outDx += 1.f;
    if (a) outDx -= 1.f;
    outMoving = (w || a || s || d);
    return true;
}

} // namespace

namespace SteerInput {

void Tick()
{
    bool  moving = false;
    float dx = 0.f, dy = 0.f;
    ReadMovementKeys(moving, dx, dy);

    float len = 0.f;
    if (std::isfinite(dx) && std::isfinite(dy)) {
        len = sqrtf(dx * dx + dy * dy);
    }

    const bool nowActive  = moving && (len > kDirThreshold);
    const bool wasActive  = s_active.exchange(nowActive, std::memory_order_acq_rel);

    if (nowActive && len > 0.f) {
        s_dirX.store(dx / len, std::memory_order_relaxed);
        s_dirY.store(dy / len, std::memory_order_relaxed);
    }

    // Edge: active -> idle. Planner polls this flag and forces a replan so
    // the next frame after release already moves toward a safe cell.
    if (wasActive && !nowActive) {
        s_edgeToIdle.store(true, std::memory_order_release);
    }
}

SteerState Get()
{
    SteerState s{};
    s.active = s_active.load(std::memory_order_acquire);
    s.dirX   = s_dirX.load(std::memory_order_relaxed);
    s.dirY   = s_dirY.load(std::memory_order_relaxed);
    return s;
}

bool ConsumeReleaseEdge()
{
    return s_edgeToIdle.exchange(false, std::memory_order_acq_rel);
}

// Debounce is intentionally removed — transitions must fire within one frame
// so the planner reactivates the instant the user lets go of WASD. The stubs
// are kept so older settings code links; they're no-ops now.
void SetDebounce(int, int) {}
void GetDebounce(int& outOn, int& outOff) { outOn = 0; outOff = 0; }

} // namespace SteerInput
