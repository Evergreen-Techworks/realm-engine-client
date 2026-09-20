#pragma once
#include "UDodgeTypes.h"
#include <cstdlib>
#include <climits>
#include <cerrno>

namespace UDodge {
struct GroupPreference {
    int32_t bossId = 0;
    Vec2 position{};
    uint64_t updatedMs = 0;

    void Set(const char* payload, uint64_t now) {
        *this = {};
        if (!payload) return;
        char* end = nullptr;
        errno = 0;
        const long long parsedId = std::strtoll(payload, &end, 10);
        if (errno == ERANGE || end == payload || *end != ',' || parsedId <= 0 || parsedId > INT32_MAX) return;
        const char* coordinate = end + 1;
        const float parsedX = std::strtof(coordinate, &end);
        if (end == coordinate || *end != ',') return;
        coordinate = end + 1;
        const float parsedY = std::strtof(coordinate, &end);
        if (end == coordinate || *end != '\0' || !std::isfinite(parsedX) || !std::isfinite(parsedY)
            || std::fabs(parsedX) > 100000.f || std::fabs(parsedY) > 100000.f) return;
        bossId = static_cast<int32_t>(parsedId); position = {parsedX, parsedY}; updatedMs = now;
    }

    bool Read(uint64_t now, int32_t currentLock, Vec2 player, Vec2& target) {
        if (bossId <= 0 || currentLock != bossId || now < updatedMs || now - updatedMs > 750
            || LenSq(Sub(position, player)) > 144.f) { *this = {}; return false; }
        target = position;
        return true;
    }
};
}
