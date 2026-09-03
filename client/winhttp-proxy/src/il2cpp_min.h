#pragma once
// Minimal IL2CPP surface for winhttp.dll (docs/plans/110).
//
// Deliberately does NOT include the generated bindings — il2cpp-types.h is
// 1,488,722 lines and has no business in a proxy DLL. Every game type is an
// opaque void*. Symbols are resolved through an injectable ProcResolver so the
// failure path is testable under g++ with no GameAssembly.dll present.
#include <cstddef>
#include <cstdint>

namespace il2cppmin {

using ProcResolver = void* (*)(const char* symbol, void* user);

struct Api {
    void* (*domain_get)()                                                = nullptr;
    void* (*thread_attach)(void* domain)                                 = nullptr;
    void** (*domain_get_assemblies)(void* domain, std::size_t* count)    = nullptr;
    void* (*assembly_get_image)(void* assembly)                          = nullptr;
    std::size_t (*image_get_class_count)(void* image)                    = nullptr;
    void* (*image_get_class)(void* image, std::size_t index)             = nullptr;
    const char* (*class_get_name)(void* klass)                           = nullptr;
    void* (*class_get_fields)(void* klass, void** iter)                  = nullptr;
    void* (*class_get_field_from_name)(void* klass, const char* name)    = nullptr;
    const char* (*field_get_name)(void* field)                           = nullptr;
    std::size_t (*field_get_offset)(void* field)                         = nullptr;
    const void* (*class_get_method_from_name)(void* klass,
                                              const char* name,
                                              int argc)                  = nullptr;
    void (*thread_detach)(void* thread)                                  = nullptr;
    bool ready = false;
};

// The exact symbol names LoadApi requires, in binding order.
const char* const* RequiredSymbols(std::size_t& count);

// Resolves every required symbol through `resolve`. All-or-nothing: if any one
// is missing, `out` is left zeroed with ready == false and this returns false.
bool LoadApi(Api& out, ProcResolver resolve, void* user);

#ifdef _WIN32
// Convenience wrapper resolving from an already-loaded GameAssembly.dll.
// Returns false if the module is not present.
bool LoadApiFromGameAssembly(Api& out);
#endif

} // namespace il2cppmin
