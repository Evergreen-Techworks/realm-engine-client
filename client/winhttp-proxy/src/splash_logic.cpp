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

} // namespace splash
