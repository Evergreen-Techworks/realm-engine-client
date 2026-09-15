#include "features/combat/autoaim/shoot/ShootBindingReadiness.h"

#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>

static int checks = 0;
static int failures = 0;

static void Check(bool condition, const char* message)
{
    ++checks;
    if (!condition) {
        ++failures;
        std::printf("FAIL: %s\n", message);
    }
}

static std::string Read(const char* path)
{
    std::ifstream source(path);
    return {std::istreambuf_iterator<char>(source), std::istreambuf_iterator<char>()};
}

int main()
{
    using ShootBindingReadiness::State;
    for (int bits = 0; bits < 8; ++bits) {
        const State state{(bits & 1) != 0, (bits & 2) != 0, (bits & 4) != 0};
        Check(ShootBindingReadiness::CanFire(state) == (state.bootAllowed && state.firingMethodVerified),
              "firing requires boot and verified SWA, independently of manual binding");
        Check(ShootBindingReadiness::CanComputeManualAngle(state) ==
                  (state.bootAllowed && state.firingMethodVerified && state.manualAngleMethodVerified),
              "manual angle requires all three readiness gates");
    }
    Check(ShootBindingReadiness::MatchesMethodBinding(true, 0x1000, 0x1200, 0x200), "matching generated method refused");
    Check(!ShootBindingReadiness::MatchesMethodBinding(false, 0x1000, 0x1200, 0x200), "unknown generated method accepted");
    Check(!ShootBindingReadiness::MatchesMethodBinding(true, 0, 0x1200, 0x200), "missing game module accepted");
    Check(!ShootBindingReadiness::MatchesMethodBinding(true, 0x1000, 0x1201, 0x200), "stale method accepted");
    Check(!ShootBindingReadiness::MatchesMethodBinding(true, 0x1000, 0, 0x200), "null method accepted");
    const auto runtime = Read("internal/src/features/combat/autoaim/shoot/ShootRuntime.cpp");
    const auto hooks = Read("internal/src/features/combat/autoaim/shoot/AimHooks.cpp");
    const auto autofire = Read("internal/src/features/combat/autoaim/modes/AutoFire.cpp");
    Check(!runtime.empty() && !hooks.empty() && !autofire.empty(), "production source inspection requires repository-root cwd");
    Check(runtime.find("ShootBindingReadiness::CanFire") != std::string::npos, "runtime does not consume readiness seam");
    Check(runtime.find("BuildBindings::Method") != std::string::npos, "runtime skips generated method identity");
    Check(runtime.find("s_fnCSA(") == std::string::npos, "unverified manual method remains callable");
    Check(hooks.find("ComputeShootAngleDetour") == std::string::npos, "unverified manual method remains hooked");
    Check(autofire.find("ShootRuntime::IsFiringResolved()") != std::string::npos, "script readiness still coupled to CSA");
    Check(autofire.find("ShootRuntime::IsManualAngleResolved()") != std::string::npos, "manual readiness is not independently gated");
    const auto reset = runtime.substr(runtime.find("void Reset()"));
    Check(reset.find("s_cachedKlass = nullptr") != std::string::npos, "reset retains stale virtual class");
    Check(reset.find("s_cachedFn = nullptr") != std::string::npos, "reset retains stale virtual method");
    std::printf("shoot_binding_readiness_tests: %d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
