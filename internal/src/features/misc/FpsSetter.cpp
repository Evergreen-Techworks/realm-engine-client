#include "pch-il2cpp.h"
#include "FpsSetter.h"
#include "Il2CppResolver.h"

#include <atomic>
#include <climits>
#include <cstdint>

namespace FpsSetter {
namespace {

static std::atomic<int>  s_targetFps{ -1 };
static std::atomic<bool> s_dirty{ false };
static bool s_backgroundApplied = false;

static void ApplyFps(int fps)
{
    if (!app::Application_set_targetFrameRate)
        return;
    Resolver::Protection::safe_call([&]() {
        app::Application_set_targetFrameRate(static_cast<int32_t>(fps), nullptr);
    });
}

} // anonymous namespace

void Tick()
{
    // Unity otherwise throttles/stops player updates when Exalt loses focus,
    // starving dodge/auto-nexus of the frames they need to react.
    if (!s_backgroundApplied && app::Application_set_runInBackground) {
        Resolver::Protection::safe_call([&]() {
            app::Application_set_runInBackground(true, nullptr);
        });
        s_backgroundApplied = true;
    }
    if (s_dirty.exchange(false, std::memory_order_acq_rel))
        ApplyFps(s_targetFps.load(std::memory_order_relaxed));
}

void SetTargetFps(int fps)
{
    s_targetFps.store(fps, std::memory_order_relaxed);
    s_dirty.store(true, std::memory_order_release);
}

int GetTargetFps()
{
    return s_targetFps.load(std::memory_order_relaxed);
}

} // namespace FpsSetter
