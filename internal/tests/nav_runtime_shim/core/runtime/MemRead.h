#pragma once
#include <cstdint>
#include <cstring>
namespace Mem {
inline bool AddrOk(const void* pointer) { return pointer != nullptr; }
template<class Value> bool TryRead(const void* base, uint32_t offset, Value& output)
{
    if (!base) return false;
    std::memcpy(&output, static_cast<const uint8_t*>(base) + offset, sizeof(Value));
    return true;
}
}
