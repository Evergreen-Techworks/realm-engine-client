#pragma once

#include <cstdint>

namespace ShootBindingReadiness {

struct State {
    bool bootAllowed = false;
    bool firingMethodVerified = false;
    bool manualAngleMethodVerified = false;
};

inline constexpr bool CanFire(State state)
{
    return state.bootAllowed && state.firingMethodVerified;
}

inline constexpr bool CanComputeManualAngle(State state)
{
    return CanFire(state) && state.manualAngleMethodVerified;
}

inline constexpr bool MatchesMethodBinding(bool supplied, uintptr_t moduleBase,
                                           uintptr_t methodPointer, uintptr_t expectedRva)
{
    return supplied && moduleBase != 0 && methodPointer >= moduleBase
        && expectedRva != 0 && methodPointer - moduleBase == expectedRva;
}

}
