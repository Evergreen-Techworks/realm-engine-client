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

// Byte offsets of the IL2CPP List<float> / array layout. Defaults are verified
// against the generated bindings; parameterised so the host tests can drive them.
struct ListFloatLayout {
    std::size_t itemsOffset;      // List<float> -> _items
    std::size_t sizeOffset;       // List<float> -> _size
    std::size_t arrayDataOffset;  // array object -> first element
};

inline constexpr ListFloatLayout kDefaultListFloatLayout{ 0x10, 0x18, 0x20 };

// Upper bound on a believable logo count. A larger _size means we misread the
// object; treat it as a no-op rather than writing wild memory.
inline constexpr std::int32_t kMaxPlausibleLogoCount = 4096;

// Writes 0.0f over every element of the List<float> at `listObject`.
// Returns the number of floats written; 0 for null, empty, negative, or
// implausible input (all no-ops).
std::int32_t ZeroFloatList(void* listObject, const ListFloatLayout& layout);

} // namespace splash
