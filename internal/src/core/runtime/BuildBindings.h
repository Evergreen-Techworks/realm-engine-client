#pragma once
#include <cstdint>
#include <cstring>
namespace BuildBindings {
struct ClassBinding { const char* source; const char* target; };
struct MethodBinding { const char* owner; const char* targetOwner; const char* source; const char* target; int args; uintptr_t rva; };
struct FieldBinding {
    const char* owner; const char* targetOwner; const char* source; const char* target;
    uint32_t offset; int32_t adjustment;
    const char* entry = nullptr; // Semantic offset-table consumer, when specified.
};
}
#if __has_include("BuildBindings.generated.h")
#include "BuildBindings.generated.h"
#else
namespace BuildBindings {
inline constexpr const char* gameAssemblySha256 = "";
inline constexpr const char* metadataSha256 = "";
inline constexpr const char* resourcesAssetsSha256 = "";
inline constexpr MethodBinding methods[] = {{"", "", "", "", 0, 0}};
inline constexpr ClassBinding classes[] = {{"", ""}};
inline constexpr FieldBinding fields[] = {{"", "", "", "", 0, 0}};
}
#endif
namespace BuildBindings {
inline const char* ClassName(const char* name) {
    if (!name) return name;
    for (const auto& row : classes) if (strcmp(row.source, name) == 0) return row.target;
    return name;
}
inline const FieldBinding* Field(const char* owner, const char* name, const char* entry = nullptr) {
    if (!owner || !name) return nullptr;
    if (entry) for (const auto& row : fields)
        if (row.entry && strcmp(row.entry, entry) == 0 && strcmp(row.owner, owner) == 0 && strcmp(row.source, name) == 0) return &row;
    for (const auto& row : fields)
        if (!row.entry && strcmp(row.owner, owner) == 0 && strcmp(row.source, name) == 0) return &row;
    return nullptr;
}
inline const MethodBinding* Method(const char* owner, const char* name, int args) {
    if (!owner || !name) return nullptr;
    // Two rows behind one key would make the answer depend on emission order, so an
    // ambiguous key resolves to nothing and the caller falls back to IL2CPP's own
    // lookup -- the rule BakedMethods::Find enforced before this header replaced it.
    const MethodBinding* found = nullptr;
    for (const auto& row : methods)
        if (strcmp(row.targetOwner, owner) == 0 && strcmp(row.source, name) == 0 && row.args == args) {
            if (found) return nullptr;
            found = &row;
        }
    return found;
}
inline const char* FieldName(const char* owner, const char* name) {
    if (!owner || !name) return name;
    for (const auto& row : fields)
        if (strcmp(row.targetOwner, owner) == 0 && strcmp(row.source, name) == 0) return row.target;
    return name;
}
}
