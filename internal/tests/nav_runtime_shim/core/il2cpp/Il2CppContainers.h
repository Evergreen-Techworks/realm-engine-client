#pragma once
#include <cstdint>
#include <cstdio>
namespace Il2CppC {
constexpr uint32_t kListItems = 0x10, kListSize = 0x18, kArrMaxLen = 0x18, kArrData = 0x20;
inline int ReadString(void* value, char* output, int capacity)
{
    return std::snprintf(output, capacity, "%s", static_cast<const char*>(value));
}
}
