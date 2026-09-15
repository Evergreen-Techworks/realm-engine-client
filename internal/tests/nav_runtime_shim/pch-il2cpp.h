#pragma once
#include <chrono>
#include <cstdint>
inline uint64_t GetTickCount64()
{
    return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count());
}
