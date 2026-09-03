#include "splash_logic.h"

#include <cstring>

namespace splash {

bool MatchesSplashSignature(const char* const* fieldNames, std::size_t count)
{
    if (!fieldNames || count == 0) return false;

    for (std::size_t m = 0; m < kMarkerFieldCount; ++m) {
        bool found = false;
        for (std::size_t i = 0; i < count && !found; ++i) {
            const char* name = fieldNames[i];
            if (name && std::strcmp(name, kMarkerFields[m]) == 0) found = true;
        }
        if (!found) return false;
    }
    return true;
}

std::int32_t ZeroFloatList(void* listObject, const ListFloatLayout& layout)
{
    if (!listObject) return 0;

    auto* base = static_cast<unsigned char*>(listObject);

    void* items = *reinterpret_cast<void**>(base + layout.itemsOffset);
    if (!items) return 0;

    const std::int32_t size = *reinterpret_cast<const std::int32_t*>(base + layout.sizeOffset);
    if (size <= 0 || size > kMaxPlausibleLogoCount) return 0;

    auto* data = reinterpret_cast<float*>(
        static_cast<unsigned char*>(items) + layout.arrayDataOffset);
    for (std::int32_t i = 0; i < size; ++i) data[i] = 0.0f;

    return size;
}

} // namespace splash
