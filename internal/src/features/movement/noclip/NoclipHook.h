#pragma once

#include <cstdint>

namespace NoclipHook {

    // Lazy-installs the player noclip hooks once IL2CPP metadata is available.
    // Called from FeatureRuntime while the feature is enabled — resolution is
    // throttled internally, so calling it every frame is cheap.
    void Tick();
    void Uninstall();

    bool IsInstalled();
    bool IsResolved();

    // Probe surface for Test -> PLAYER NOCLIP: which Map predicates are hooked
    // and how often the game calls each one.
    int         Count();
    const char* TargetName(int i);
    bool        TargetHooked(int i);
    bool        TargetForced(int i);   // false = observe-only counter
    uint32_t    TargetHits(int i);

} // namespace NoclipHook
