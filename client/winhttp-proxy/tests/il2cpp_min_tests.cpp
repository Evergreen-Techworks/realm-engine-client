#include "../src/il2cpp_min.h"

#include <cstdint>
#include <cstdio>
#include <cstring>

static int g_checks = 0;
static int g_failures = 0;

#define CHECK(cond)                                                        \
    do {                                                                   \
        ++g_checks;                                                        \
        if (!(cond)) {                                                     \
            ++g_failures;                                                  \
            std::printf("  FAIL  %s:%d  %s\n", __FILE__, __LINE__, #cond); \
        }                                                                  \
    } while (0)

// Returns a distinct non-null stub for every symbol.
static void* ResolveAll(const char* symbol, void* user)
{
    (void)user;
    (void)symbol;
    static int slot = 0;
    ++slot;
    return reinterpret_cast<void*>(static_cast<std::uintptr_t>(0x1000 + slot));
}

// Fails exactly one symbol, named by `user`.
static void* ResolveAllBut(const char* symbol, void* user)
{
    const char* missing = static_cast<const char*>(user);
    if (symbol && missing && std::strcmp(symbol, missing) == 0) return nullptr;
    return reinterpret_cast<void*>(static_cast<std::uintptr_t>(0x2000));
}

static void* ResolveNone(const char*, void*) { return nullptr; }

static void test_required_symbols_are_declared()
{
    std::size_t count = 0;
    const char* const* symbols = il2cppmin::RequiredSymbols(count);
    CHECK(symbols != nullptr);
    CHECK(count == 15);

    bool sawDomainGet = false;
    bool sawMethodFromName = false;
    bool sawRuntimeInvoke = false;
    for (std::size_t i = 0; i < count; ++i) {
        if (std::strcmp(symbols[i], "il2cpp_domain_get") == 0) sawDomainGet = true;
        if (std::strcmp(symbols[i], "il2cpp_class_get_method_from_name") == 0)
            sawMethodFromName = true;
        if (std::strcmp(symbols[i], "il2cpp_runtime_invoke") == 0)
            sawRuntimeInvoke = true;
    }
    CHECK(sawDomainGet);
    CHECK(sawMethodFromName);
    CHECK(sawRuntimeInvoke);
}

static void test_load_succeeds_when_every_symbol_resolves()
{
    il2cppmin::Api api{};
    CHECK(il2cppmin::LoadApi(api, &ResolveAll, nullptr) == true);
    CHECK(api.ready == true);
    CHECK(api.domain_get != nullptr);
    CHECK(api.class_get_method_from_name != nullptr);
}

static void test_load_fails_when_any_symbol_is_missing()
{
    std::size_t count = 0;
    const char* const* symbols = il2cppmin::RequiredSymbols(count);

    // Every single required symbol must be load-bearing.
    for (std::size_t i = 0; i < count; ++i) {
        il2cppmin::Api api{};
        void* missing = const_cast<char*>(symbols[i]);
        CHECK(il2cppmin::LoadApi(api, &ResolveAllBut, missing) == false);
        CHECK(api.ready == false);
    }
}

static void test_load_fails_with_no_resolver_or_nothing_resolvable()
{
    il2cppmin::Api api{};
    CHECK(il2cppmin::LoadApi(api, nullptr, nullptr) == false);
    CHECK(api.ready == false);

    il2cppmin::Api api2{};
    CHECK(il2cppmin::LoadApi(api2, &ResolveNone, nullptr) == false);
    CHECK(api2.ready == false);
}

int main()
{
    std::printf("il2cpp_min tests\n");
    test_required_symbols_are_declared();
    test_load_succeeds_when_every_symbol_resolves();
    test_load_fails_when_any_symbol_is_missing();
    test_load_fails_with_no_resolver_or_nothing_resolvable();

    std::printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
