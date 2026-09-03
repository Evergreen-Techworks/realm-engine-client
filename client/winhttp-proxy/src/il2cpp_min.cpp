#include "il2cpp_min.h"

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

namespace il2cppmin {
namespace {

// Order matters: it must match the binding order in LoadApi below.
const char* const kRequiredSymbols[] = {
    "il2cpp_domain_get",
    "il2cpp_thread_attach",
    "il2cpp_domain_get_assemblies",
    "il2cpp_assembly_get_image",
    "il2cpp_image_get_class_count",
    "il2cpp_image_get_class",
    "il2cpp_class_get_name",
    "il2cpp_class_get_fields",
    "il2cpp_class_get_field_from_name",
    "il2cpp_field_get_name",
    "il2cpp_field_get_offset",
    "il2cpp_class_get_method_from_name",
};
constexpr std::size_t kRequiredSymbolCount =
    sizeof(kRequiredSymbols) / sizeof(kRequiredSymbols[0]);

} // namespace

const char* const* RequiredSymbols(std::size_t& count)
{
    count = kRequiredSymbolCount;
    return kRequiredSymbols;
}

bool LoadApi(Api& out, ProcResolver resolve, void* user)
{
    out = Api{};
    if (!resolve) return false;

    void* slots[kRequiredSymbolCount] = {};
    for (std::size_t i = 0; i < kRequiredSymbolCount; ++i) {
        slots[i] = resolve(kRequiredSymbols[i], user);
        if (!slots[i]) return false;   // all-or-nothing; out stays zeroed
    }

    std::size_t i = 0;
    out.domain_get                 = reinterpret_cast<decltype(out.domain_get)>(slots[i++]);
    out.thread_attach              = reinterpret_cast<decltype(out.thread_attach)>(slots[i++]);
    out.domain_get_assemblies      = reinterpret_cast<decltype(out.domain_get_assemblies)>(slots[i++]);
    out.assembly_get_image         = reinterpret_cast<decltype(out.assembly_get_image)>(slots[i++]);
    out.image_get_class_count      = reinterpret_cast<decltype(out.image_get_class_count)>(slots[i++]);
    out.image_get_class            = reinterpret_cast<decltype(out.image_get_class)>(slots[i++]);
    out.class_get_name             = reinterpret_cast<decltype(out.class_get_name)>(slots[i++]);
    out.class_get_fields           = reinterpret_cast<decltype(out.class_get_fields)>(slots[i++]);
    out.class_get_field_from_name  = reinterpret_cast<decltype(out.class_get_field_from_name)>(slots[i++]);
    out.field_get_name             = reinterpret_cast<decltype(out.field_get_name)>(slots[i++]);
    out.field_get_offset           = reinterpret_cast<decltype(out.field_get_offset)>(slots[i++]);
    out.class_get_method_from_name = reinterpret_cast<decltype(out.class_get_method_from_name)>(slots[i++]);

    out.ready = true;
    return true;
}

#ifdef _WIN32
namespace {
void* ResolveFromModule(const char* symbol, void* user)
{
    return reinterpret_cast<void*>(
        GetProcAddress(static_cast<HMODULE>(user), symbol));
}
} // namespace

bool LoadApiFromGameAssembly(Api& out)
{
    HMODULE game = GetModuleHandleW(L"GameAssembly.dll");
    if (!game) { out = Api{}; return false; }
    return LoadApi(out, &ResolveFromModule, game);
}
#endif

} // namespace il2cppmin
