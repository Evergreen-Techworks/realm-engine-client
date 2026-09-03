#pragma once
// Pure, dependency-free logic for the splash bypass (docs/plans/110).
// MUST NOT include any Windows or IL2CPP header — this unit is compiled by g++
// into the host test binary as well as into winhttp.dll.
#include <cstddef>
#include <cstdint>

namespace splash {

// Fields that survive Beebyte because Unity needs them for serialization.
// Verified against SplashScreenScript__Fields, il2cpp-types.h:356783.
inline constexpr const char* kMarkerFields[] = {
    "timeForLogo",
    "logosToDisplay",
    "possibleSplashscreens",
};
inline constexpr std::size_t kMarkerFieldCount =
    sizeof(kMarkerFields) / sizeof(kMarkerFields[0]);

// True when `fieldNames` contains every marker, in any order, extras allowed.
// Null entries are skipped. False when `fieldNames` is null or `count` is 0.
bool MatchesSplashSignature(const char* const* fieldNames, std::size_t count);

} // namespace splash
