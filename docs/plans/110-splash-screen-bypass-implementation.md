# 110 — Exalt Splash Screen Bypass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the RotMG Exalt splash logo sequence by zeroing its per-logo durations from a self-contained module inside `winhttp.dll`, which already loads before Unity initialises.

**Architecture:** `winhttp.dll` is a proxy DLL already dropped next to the game and already running at `DLL_PROCESS_ATTACH`. A new bootstrap thread waits for `GameAssembly.dll`, resolves `SplashScreenScript` structurally (by its serialization-preserved field names, not a Beebyte literal), hooks its unobfuscated `Update` with MinHook, and on the main thread zeroes every float in `timeForLogo`. All pure logic is isolated into a Windows-free unit so it can be unit-tested with `g++` under WSL; only the thin IL2CPP/MinHook glue is Windows-only.

**Tech Stack:** C++17, MinHook (already vendored at `internal/vendor/minhook`, already linked by `build.bat`), MSVC `cl.exe` for the shipping DLL, `g++` for host tests.

**Spec:** `docs/plans/109-splash-screen-bypass.md`

## Global Constraints

- **x64 only.** The game is 64-bit; the shim must match. Build from an "x64 Native Tools Command Prompt for VS 2022".
- **Never include the generated IL2CPP headers in `winhttp.dll`.** `internal/src/game/generated/il2cpp-types.h` is 1,488,722 lines. The shim uses `GetProcAddress` and opaque `void*` types only.
- **`splash_logic.{h,cpp}` must not include any Windows or IL2CPP header.** It is compiled by `g++` in the test build; adding such an include breaks the test cycle.
- **Fail-open at every step.** Any failure — missing module, missing export, unresolved class, unresolved method, null field, hook failure — means do nothing and let the game show its normal splash. Never block boot, never crash.
- **Bootstrap gives up after 30 seconds** so a patched build cannot leave a thread scanning forever.
- **Verified memory layout** (do not re-derive): `List<float>` object has `_items` at `+0x10` and `_size` at `+0x18` (`internal/src/game/generated/il2cpp-types.h:47499`); array element data begins at `+0x20` (`internal/src/core/runtime/Il2CppResolver.h:7`).
- **Marker field names** (exact, case-sensitive): `timeForLogo`, `logosToDisplay`, `possibleSplashscreens`.
- **Beebyte fallback literals** (exact): `OPICLDMNKFI` (`internal/src/game/symbols/BeebyteName.h:3291`), `PAFBKAOKKCJ` (`internal/src/game/generated/il2cpp-types-ptr.h:3244`). They differ because they were captured from different builds; try both.
- **Commit trailer.** Every commit ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```

---

## File Structure

| File | Responsibility |
|---|---|
| `client/winhttp-proxy/src/splash_logic.h` | Pure declarations: marker fields, signature matcher, `List<float>` layout + zeroing. No Windows/IL2CPP. |
| `client/winhttp-proxy/src/splash_logic.cpp` | Pure implementation. Compiled into both the DLL and the host test binary. |
| `client/winhttp-proxy/tests/splash_logic_tests.cpp` | Host test binary (`g++`, runs in WSL). |
| `client/winhttp-proxy/run-logic-tests.sh` | Builds and runs the host tests. The TDD loop. |
| `client/winhttp-proxy/src/il2cpp_min.h` | Minimal IL2CPP API surface + injectable `ProcResolver` seam. |
| `client/winhttp-proxy/src/il2cpp_min.cpp` | Symbol table, `LoadApi` (testable), `LoadApiFromGameAssembly` (Windows-only). |
| `client/winhttp-proxy/src/splash_bypass.h` | `splashbypass::Install()` / `splashbypass::Remove()`. |
| `client/winhttp-proxy/src/splash_bypass.cpp` | Windows-only glue: bootstrap thread, class/method resolution, MinHook `Update` detour. |
| `client/winhttp-proxy/src/dllmain.cpp` | **Modify:** spawn the bypass alongside the existing connect hook. |
| `client/winhttp-proxy/build.bat` | **Modify:** add the three new `.cpp` files to `%SRC%`. |

---

### Task 1: Pure logic — splash class signature matcher

**Files:**
- Create: `client/winhttp-proxy/src/splash_logic.h`
- Create: `client/winhttp-proxy/src/splash_logic.cpp`
- Create: `client/winhttp-proxy/tests/splash_logic_tests.cpp`
- Create: `client/winhttp-proxy/run-logic-tests.sh`

**Interfaces:**
- Consumes: nothing.
- Produces: `splash::kMarkerFields` (`const char* const[3]`), `splash::kMarkerFieldCount` (`std::size_t`), and `bool splash::MatchesSplashSignature(const char* const* fieldNames, std::size_t count)`.

- [ ] **Step 1: Write the failing test**

Create `client/winhttp-proxy/tests/splash_logic_tests.cpp`:

```cpp
#include "../src/splash_logic.h"

#include <cstdio>
#include <cstdint>

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

static void test_signature_matches_exact_three()
{
    const char* fields[] = { "timeForLogo", "logosToDisplay", "possibleSplashscreens" };
    CHECK(splash::MatchesSplashSignature(fields, 3) == true);
}

static void test_signature_matches_with_obfuscated_siblings()
{
    // Mirrors the real SplashScreenScript__Fields: markers readable, siblings mangled.
    const char* fields[] = {
        "background", "logo", "credits",
        "possibleSplashscreens", "logosToDisplay", "timeForLogo",
        "EFOMIEKLCDH", "HFCKLCHLCGF", "NBPKJFAAAHN",
    };
    CHECK(splash::MatchesSplashSignature(fields, 9) == true);
}

static void test_signature_rejects_partial_match()
{
    const char* fields[] = { "timeForLogo", "logosToDisplay" };
    CHECK(splash::MatchesSplashSignature(fields, 2) == false);
}

static void test_signature_rejects_empty_and_null()
{
    const char* fields[] = { "timeForLogo" };
    CHECK(splash::MatchesSplashSignature(fields, 0) == false);
    CHECK(splash::MatchesSplashSignature(nullptr, 3) == false);
    (void)fields;
}

static void test_signature_skips_null_entries()
{
    const char* fields[] = { nullptr, "timeForLogo", nullptr, "logosToDisplay",
                             "possibleSplashscreens", nullptr };
    CHECK(splash::MatchesSplashSignature(fields, 6) == true);
}

static void test_signature_is_case_sensitive()
{
    const char* fields[] = { "TimeForLogo", "logosToDisplay", "possibleSplashscreens" };
    CHECK(splash::MatchesSplashSignature(fields, 3) == false);
}

int main()
{
    std::printf("splash_logic tests\n");
    test_signature_matches_exact_three();
    test_signature_matches_with_obfuscated_siblings();
    test_signature_rejects_partial_match();
    test_signature_rejects_empty_and_null();
    test_signature_skips_null_entries();
    test_signature_is_case_sensitive();

    std::printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
```

Create `client/winhttp-proxy/run-logic-tests.sh`:

```bash
#!/usr/bin/env bash
# Host test loop for the Windows-free splash logic. Runs under WSL with g++;
# no game, no MSVC, no IL2CPP required. See docs/plans/110.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .testbuild
g++ -std=c++17 -Wall -Wextra -Werror -O0 -g \
    src/splash_logic.cpp tests/splash_logic_tests.cpp \
    -o .testbuild/splash_logic_tests
./.testbuild/splash_logic_tests
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
chmod +x client/winhttp-proxy/run-logic-tests.sh && client/winhttp-proxy/run-logic-tests.sh
```
Expected: FAIL — compile error, `splash_logic.h: No such file or directory`.

- [ ] **Step 3: Write minimal implementation**

Create `client/winhttp-proxy/src/splash_logic.h`:

```cpp
#pragma once
// Pure, dependency-free logic for the splash bypass (docs/plans/110).
// MUST NOT include any Windows or IL2CPP header — this unit is compiled by g++
// into the host test binary as well as into winhttp.dll.
#include <cstddef>
#include <cstdint>

namespace splash {

// Fields that survive Beebyte because Unity needs them for serialization.
// Verified against SplashScreenScript__Fields, il2cpp-types.h:356783.
inline constexpr const char* kMarkerFields[] = {
    "timeForLogo",
    "logosToDisplay",
    "possibleSplashscreens",
};
inline constexpr std::size_t kMarkerFieldCount =
    sizeof(kMarkerFields) / sizeof(kMarkerFields[0]);

// True when `fieldNames` contains every marker, in any order, extras allowed.
// Null entries are skipped. False when `fieldNames` is null or `count` is 0.
bool MatchesSplashSignature(const char* const* fieldNames, std::size_t count);

} // namespace splash
```

Create `client/winhttp-proxy/src/splash_logic.cpp`:

```cpp
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `client/winhttp-proxy/run-logic-tests.sh`
Expected: PASS — `7 checks, 0 failures`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add client/winhttp-proxy/src/splash_logic.h \
        client/winhttp-proxy/src/splash_logic.cpp \
        client/winhttp-proxy/tests/splash_logic_tests.cpp \
        client/winhttp-proxy/run-logic-tests.sh
git commit -m "$(cat <<'EOF'
feat(winhttp): structural SplashScreenScript signature matcher

Identifies the class by its serialization-preserved field names rather than
a Beebyte literal, so a class rename cannot break resolution.

Pure and Windows-free so it runs under g++ in WSL — no game required.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Pure logic — `List<float>` zeroing

**Files:**
- Modify: `client/winhttp-proxy/src/splash_logic.h`
- Modify: `client/winhttp-proxy/src/splash_logic.cpp`
- Modify: `client/winhttp-proxy/tests/splash_logic_tests.cpp`

**Interfaces:**
- Consumes: `splash` namespace from Task 1.
- Produces: `struct splash::ListFloatLayout { std::size_t itemsOffset; std::size_t sizeOffset; std::size_t arrayDataOffset; }`, `splash::kDefaultListFloatLayout`, `splash::kMaxPlausibleLogoCount` (`std::int32_t`), and `std::int32_t splash::ZeroFloatList(void* listObject, const ListFloatLayout& layout)` which returns the number of floats written (0 on any no-op).

- [ ] **Step 1: Write the failing test**

Add to `client/winhttp-proxy/tests/splash_logic_tests.cpp`, above `main`:

```cpp
// Synthetic stand-ins for the verified IL2CPP layout:
//   List<float>: _items @ +0x10, _size @ +0x18   (il2cpp-types.h:47499)
//   float[]    : element data @ +0x20            (Il2CppResolver.h:7)
struct FakeArray {
    unsigned char header[0x20];
    float         data[8];
    std::uint32_t guard;
};

struct FakeList {
    unsigned char pad[0x10];
    void*         items;
    std::int32_t  size;
    std::int32_t  version;
};

static FakeArray MakeArray()
{
    FakeArray a{};
    for (int i = 0; i < 8; ++i) a.data[i] = 1.5f + static_cast<float>(i);
    a.guard = 0xDEADBEEFu;
    return a;
}

static void test_zero_clears_every_element()
{
    FakeArray arr = MakeArray();
    FakeList  lst{};
    lst.items = &arr;
    lst.size  = 3;

    const std::int32_t written = splash::ZeroFloatList(&lst, splash::kDefaultListFloatLayout);

    CHECK(written == 3);
    CHECK(arr.data[0] == 0.0f);
    CHECK(arr.data[1] == 0.0f);
    CHECK(arr.data[2] == 0.0f);
    CHECK(arr.data[3] == 4.5f);           // untouched beyond _size
    CHECK(arr.guard == 0xDEADBEEFu);      // no overrun
}

static void test_zero_is_noop_for_empty_list()
{
    FakeArray arr = MakeArray();
    FakeList  lst{};
    lst.items = &arr;
    lst.size  = 0;

    CHECK(splash::ZeroFloatList(&lst, splash::kDefaultListFloatLayout) == 0);
    CHECK(arr.data[0] == 1.5f);
}

static void test_zero_is_noop_for_negative_size()
{
    FakeArray arr = MakeArray();
    FakeList  lst{};
    lst.items = &arr;
    lst.size  = -1;

    CHECK(splash::ZeroFloatList(&lst, splash::kDefaultListFloatLayout) == 0);
    CHECK(arr.data[0] == 1.5f);
}

static void test_zero_rejects_implausible_size()
{
    // A garbage read must not turn into a wild write.
    FakeArray arr = MakeArray();
    FakeList  lst{};
    lst.items = &arr;
    lst.size  = splash::kMaxPlausibleLogoCount + 1;

    CHECK(splash::ZeroFloatList(&lst, splash::kDefaultListFloatLayout) == 0);
    CHECK(arr.data[0] == 1.5f);
    CHECK(arr.guard == 0xDEADBEEFu);
}

static void test_zero_is_noop_for_null_inputs()
{
    FakeList lst{};
    lst.items = nullptr;
    lst.size  = 3;

    CHECK(splash::ZeroFloatList(&lst, splash::kDefaultListFloatLayout) == 0);
    CHECK(splash::ZeroFloatList(nullptr, splash::kDefaultListFloatLayout) == 0);
}
```

Register them inside `main`, after the existing calls:

```cpp
    test_zero_clears_every_element();
    test_zero_is_noop_for_empty_list();
    test_zero_is_noop_for_negative_size();
    test_zero_rejects_implausible_size();
    test_zero_is_noop_for_null_inputs();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `client/winhttp-proxy/run-logic-tests.sh`
Expected: FAIL — compile error, `'ZeroFloatList' is not a member of 'splash'`.

- [ ] **Step 3: Write minimal implementation**

Append to `client/winhttp-proxy/src/splash_logic.h`, inside `namespace splash`, before the closing brace:

```cpp
// Byte offsets of the IL2CPP List<float> / array layout. Defaults are verified
// against the generated bindings; parameterised so the host tests can drive them.
struct ListFloatLayout {
    std::size_t itemsOffset;      // List<float> -> _items
    std::size_t sizeOffset;       // List<float> -> _size
    std::size_t arrayDataOffset;  // array object -> first element
};

inline constexpr ListFloatLayout kDefaultListFloatLayout{ 0x10, 0x18, 0x20 };

// Upper bound on a believable logo count. A larger _size means we misread the
// object; treat it as a no-op rather than writing wild memory.
inline constexpr std::int32_t kMaxPlausibleLogoCount = 4096;

// Writes 0.0f over every element of the List<float> at `listObject`.
// Returns the number of floats written; 0 for null, empty, negative, or
// implausible input (all no-ops).
std::int32_t ZeroFloatList(void* listObject, const ListFloatLayout& layout);
```

Append to `client/winhttp-proxy/src/splash_logic.cpp`, inside `namespace splash`:

```cpp
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `client/winhttp-proxy/run-logic-tests.sh`
Expected: PASS — `22 checks, 0 failures`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add client/winhttp-proxy/src/splash_logic.h \
        client/winhttp-proxy/src/splash_logic.cpp \
        client/winhttp-proxy/tests/splash_logic_tests.cpp
git commit -m "$(cat <<'EOF'
feat(winhttp): zero a List<float> in place, with a sanity bound

Zeroes timeForLogo's backing array using the verified IL2CPP layout
(_items +0x10, _size +0x18, data +0x20). An implausible _size is treated
as a misread and becomes a no-op rather than a wild write.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Minimal IL2CPP shim with an injectable resolver

**Files:**
- Create: `client/winhttp-proxy/src/il2cpp_min.h`
- Create: `client/winhttp-proxy/src/il2cpp_min.cpp`
- Create: `client/winhttp-proxy/tests/il2cpp_min_tests.cpp`
- Modify: `client/winhttp-proxy/run-logic-tests.sh`

**Interfaces:**
- Consumes: nothing.
- Produces: `il2cppmin::Api` (POD of function pointers plus `bool ready`), `il2cppmin::ProcResolver` = `void* (*)(const char* symbol, void* user)`, `bool il2cppmin::LoadApi(Api& out, ProcResolver resolve, void* user)`, `const char* const* il2cppmin::RequiredSymbols(std::size_t& count)`, and (Windows only) `bool il2cppmin::LoadApiFromGameAssembly(Api& out)`.

- [ ] **Step 1: Write the failing test**

Create `client/winhttp-proxy/tests/il2cpp_min_tests.cpp`:

```cpp
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
    CHECK(count == 12);

    bool sawDomainGet = false;
    bool sawMethodFromName = false;
    for (std::size_t i = 0; i < count; ++i) {
        if (std::strcmp(symbols[i], "il2cpp_domain_get") == 0) sawDomainGet = true;
        if (std::strcmp(symbols[i], "il2cpp_class_get_method_from_name") == 0)
            sawMethodFromName = true;
    }
    CHECK(sawDomainGet);
    CHECK(sawMethodFromName);
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
```

Replace the body of `client/winhttp-proxy/run-logic-tests.sh` with:

```bash
#!/usr/bin/env bash
# Host test loop for the Windows-free splash logic. Runs under WSL with g++;
# no game, no MSVC, no IL2CPP required. See docs/plans/110.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .testbuild

g++ -std=c++17 -Wall -Wextra -Werror -O0 -g \
    src/splash_logic.cpp tests/splash_logic_tests.cpp \
    -o .testbuild/splash_logic_tests

g++ -std=c++17 -Wall -Wextra -Werror -O0 -g \
    src/il2cpp_min.cpp tests/il2cpp_min_tests.cpp \
    -o .testbuild/il2cpp_min_tests

./.testbuild/splash_logic_tests
./.testbuild/il2cpp_min_tests
```

- [ ] **Step 2: Run test to verify it fails**

Run: `client/winhttp-proxy/run-logic-tests.sh`
Expected: FAIL — compile error, `il2cpp_min.h: No such file or directory`.

- [ ] **Step 3: Write minimal implementation**

Create `client/winhttp-proxy/src/il2cpp_min.h`:

```cpp
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
```

Create `client/winhttp-proxy/src/il2cpp_min.cpp`:

```cpp
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `client/winhttp-proxy/run-logic-tests.sh`
Expected: PASS — both binaries run; `splash_logic` reports `22 checks, 0 failures` and `il2cpp_min` reports `36 checks, 0 failures` (the missing-symbol test asserts twice per required symbol), exit code 0.

- [ ] **Step 5: Commit**

```bash
git add client/winhttp-proxy/src/il2cpp_min.h \
        client/winhttp-proxy/src/il2cpp_min.cpp \
        client/winhttp-proxy/tests/il2cpp_min_tests.cpp \
        client/winhttp-proxy/run-logic-tests.sh
git commit -m "$(cat <<'EOF'
feat(winhttp): minimal IL2CPP shim with injectable resolver

Twelve GetProcAddress'd exports behind opaque void* types, so the proxy DLL
never pulls in the 1.49M-line generated bindings. The ProcResolver seam lets
the all-or-nothing failure path be tested under g++ with no game present.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Windows glue — class resolution, `Update` hook, wiring

**Files:**
- Create: `client/winhttp-proxy/src/splash_bypass.h`
- Create: `client/winhttp-proxy/src/splash_bypass.cpp`
- Modify: `client/winhttp-proxy/src/dllmain.cpp`
- Modify: `client/winhttp-proxy/build.bat`

**Interfaces:**
- Consumes: `splash::MatchesSplashSignature`, `splash::ZeroFloatList`, `splash::kDefaultListFloatLayout` (Tasks 1-2); `il2cppmin::Api`, `il2cppmin::LoadApiFromGameAssembly` (Task 3).
- Produces: `void splashbypass::Install()` and `void splashbypass::Remove()`.

This task has no host-testable unit — it is IL2CPP and MinHook glue whose only real verification is running the game (Task 5). Its gate is therefore **it compiles clean on Windows and the existing connect hook still works**.

- [ ] **Step 1: Write the header**

Create `client/winhttp-proxy/src/splash_bypass.h`:

```cpp
#pragma once
// Splash screen bypass (docs/plans/109, plan 110).
// Spawns a bootstrap thread at DLL attach; everything is fail-open.
namespace splashbypass {

// Starts the bootstrap thread. Safe to call once, from DllMain.
void Install();

// Removes the Update hook if installed. Safe to call unconditionally.
void Remove();

} // namespace splashbypass
```

- [ ] **Step 2: Write the implementation**

Create `client/winhttp-proxy/src/splash_bypass.cpp`:

```cpp
#define WIN32_LEAN_AND_MEAN
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif

#include <windows.h>

#include "MinHook.h"
#include "il2cpp_min.h"
#include "splash_bypass.h"
#include "splash_logic.h"

namespace splashbypass {
namespace {

// Last-known-good class literals. They disagree because they were captured from
// different builds (BeebyteName.h:3291 vs il2cpp-types-ptr.h:3244); try both.
// Only consulted when the structural field scan finds nothing.
const char* const kFallbackClassNames[] = { "OPICLDMNKFI", "PAFBKAOKKCJ" };

constexpr DWORD kGiveUpMs   = 30000;   // never scan forever after a patch
constexpr DWORD kPollMs     = 50;

il2cppmin::Api g_api{};

using UpdateFn = void (*)(void* self, void* method);
UpdateFn g_realUpdate  = nullptr;
void*    g_updateTarget = nullptr;
volatile LONG g_hookInstalled = 0;
volatile LONG g_done          = 0;

std::size_t g_timeForLogoOffset = 0;

// Collects field names for `klass` and asks the pure matcher.
bool ClassLooksLikeSplash(void* klass)
{
    const char* names[64];
    std::size_t count = 0;

    void* iter = nullptr;
    while (count < 64) {
        void* field = g_api.class_get_fields(klass, &iter);
        if (!field) break;
        const char* name = g_api.field_get_name(field);
        if (name) names[count++] = name;
    }
    return splash::MatchesSplashSignature(names, count);
}

void* FindSplashClass()
{
    std::size_t assemblyCount = 0;
    void** assemblies = g_api.domain_get_assemblies(g_api.domain_get(), &assemblyCount);
    if (!assemblies) return nullptr;

    void* literalHit = nullptr;

    for (std::size_t a = 0; a < assemblyCount; ++a) {
        void* image = g_api.assembly_get_image(assemblies[a]);
        if (!image) continue;

        const std::size_t classCount = g_api.image_get_class_count(image);
        for (std::size_t c = 0; c < classCount; ++c) {
            void* klass = g_api.image_get_class(image, c);
            if (!klass) continue;

            if (ClassLooksLikeSplash(klass)) return klass;   // structural wins

            if (!literalHit) {
                const char* name = g_api.class_get_name(klass);
                if (name) {
                    for (const char* literal : kFallbackClassNames) {
                        if (lstrcmpA(name, literal) == 0) { literalHit = klass; break; }
                    }
                }
            }
        }
    }
    return literalHit;   // may be nullptr — caller fails open
}

void __cdecl HookedUpdate(void* self, void* method)
{
    if (self && !g_done) {
        __try {
            auto* list = *reinterpret_cast<void**>(
                static_cast<unsigned char*>(self) + g_timeForLogoOffset);
            if (splash::ZeroFloatList(list, splash::kDefaultListFloatLayout) > 0) {
                InterlockedExchange(&g_done, 1);
            }
        } __except (EXCEPTION_EXECUTE_HANDLER) {
            InterlockedExchange(&g_done, 1);   // never fault every frame
        }
    }

    if (g_realUpdate) g_realUpdate(self, method);
}

DWORD WINAPI BootstrapThread(LPVOID)
{
    const DWORD start = GetTickCount();

    // 1. Wait for GameAssembly.dll and a full IL2CPP export set.
    while (!il2cppmin::LoadApiFromGameAssembly(g_api)) {
        if (GetTickCount() - start > kGiveUpMs) return 0;
        Sleep(kPollMs);
    }

    // 2. Wait for a live domain, then attach so class enumeration is legal.
    void* domain = nullptr;
    while (!(domain = g_api.domain_get())) {
        if (GetTickCount() - start > kGiveUpMs) return 0;
        Sleep(kPollMs);
    }
    g_api.thread_attach(domain);

    // 3. Resolve the class. Classes load lazily, so retry — never cache a miss.
    void* klass = nullptr;
    while (!(klass = FindSplashClass())) {
        if (GetTickCount() - start > kGiveUpMs) return 0;
        Sleep(kPollMs);
    }

    // 4. Field offset + Update. "Update" survives Beebyte; the siblings do not.
    void* field = g_api.class_get_field_from_name(klass, "timeForLogo");
    if (!field) return 0;
    g_timeForLogoOffset = g_api.field_get_offset(field);
    if (g_timeForLogoOffset == 0) return 0;

    const void* method = g_api.class_get_method_from_name(klass, "Update", 0);
    if (!method) return 0;

    // MethodInfo begins with its native entry point.
    g_updateTarget = *reinterpret_cast<void* const*>(method);
    if (!g_updateTarget) return 0;

    // 5. Hook. MinHook may already be initialised by connect_hook — that is fine.
    const MH_STATUS init = MH_Initialize();
    if (init != MH_OK && init != MH_ERROR_ALREADY_INITIALIZED) return 0;

    if (MH_CreateHook(g_updateTarget, reinterpret_cast<void*>(&HookedUpdate),
                      reinterpret_cast<void**>(&g_realUpdate)) != MH_OK) return 0;
    if (MH_EnableHook(g_updateTarget) != MH_OK) return 0;

    InterlockedExchange(&g_hookInstalled, 1);
    return 0;
}

} // namespace

void Install()
{
    HANDLE t = CreateThread(nullptr, 0, BootstrapThread, nullptr, 0, nullptr);
    if (t) CloseHandle(t);
}

void Remove()
{
    if (InterlockedCompareExchange(&g_hookInstalled, 0, 1) != 1) return;
    MH_DisableHook(g_updateTarget);
    MH_RemoveHook(g_updateTarget);
}

} // namespace splashbypass
```

- [ ] **Step 3: Wire it into `dllmain.cpp`**

In `client/winhttp-proxy/src/dllmain.cpp`, add the include beside the existing ones:

```cpp
#include "splash_bypass.h"
```

In `DLL_PROCESS_ATTACH`, after the existing `CreateThread` for `InitThread`, add:

```cpp
            splashbypass::Install();
```

In `DLL_PROCESS_DETACH`, before `RemoveConnectHook();`, add:

```cpp
            splashbypass::Remove();
```

- [ ] **Step 4: Add the sources to `build.bat`**

In `client/winhttp-proxy/build.bat`, change the `SRC` line to:

```bat
set SRC=src\dllmain.cpp src\connect_hook.cpp src\splash_logic.cpp src\il2cpp_min.cpp src\splash_bypass.cpp
```

- [ ] **Step 5: Verify the host tests still pass, then build on Windows**

Run (WSL): `client/winhttp-proxy/run-logic-tests.sh`
Expected: PASS, unchanged — the pure units must not have regressed.

Run (Windows, from an "x64 Native Tools Command Prompt for VS 2022"):
```bat
cd client\winhttp-proxy
build.bat
```
Expected: `[build] OK -> winhttp.dll`, no warnings from the new files.

- [ ] **Step 6: Commit**

```bash
git add client/winhttp-proxy/src/splash_bypass.h \
        client/winhttp-proxy/src/splash_bypass.cpp \
        client/winhttp-proxy/src/dllmain.cpp \
        client/winhttp-proxy/build.bat
git commit -m "$(cat <<'EOF'
feat(winhttp): bypass the Exalt splash by zeroing timeForLogo

Bootstrap thread waits for GameAssembly.dll, resolves SplashScreenScript by
its serialization-preserved field names (falling back to the two known
Beebyte literals), then hooks the unobfuscated Update and zeroes the logo
durations on the main thread.

Update rather than .ctor: Unity has not deserialized timeForLogo at
construction time. Hooking Update also avoids FindObjectsByType, which the
codebase flags as a full IL2CPP object walk.

Fail-open throughout; gives up after 30s so a patched build cannot leave a
thread scanning forever.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Baseline measurement and manual acceptance

**Files:**
- Modify: `docs/plans/109-splash-screen-bypass.md` (record the measured result)

**Interfaces:**
- Consumes: the built `winhttp.dll` from Task 4.
- Produces: a recorded before/after number, and a go/no-go on keeping the feature.

Do the baseline **first**. Per spec §Non-goals the win is bounded by idle time, and if the splash is covering real asset loading the delta will be small — better to learn that from a number than from an argument.

- [ ] **Step 1: Record the baseline**

With the **current shipped** `winhttp.dll` (no splash module), launch the game 3 times. For each, record wall-clock from process start to the first interactive screen. Between runs, relaunch normally so the file cache state is representative. Write down the three times and the median.

- [ ] **Step 2: Deploy the new DLL**

Copy the `winhttp.dll` built in Task 4 over the deployed one. `GameHooker` already backs up and restores any pre-existing `winhttp.dll` (`client/src/hooker/GameHooker.ts:59,154`), so keep that backup intact.

- [ ] **Step 3: Measure with the feature enabled**

Launch 3 more times, same method, same conditions. Record times and median.

- [ ] **Step 4: Verify no regression in the existing hook**

Confirm the client still connects and plays: the `connect()` hook must still redirect to `127.0.0.1:2050`. Log in, enter a realm, confirm normal play. A splash bypass that breaks the proxy is a failure regardless of its timing win.

- [ ] **Step 5: Verify fail-open**

Temporarily edit `kFallbackClassNames` to two junk strings **and** make `ClassLooksLikeSplash` return `false` unconditionally. Rebuild, launch. Expected: the game boots normally with its splash fully intact, no crash, no hang. Revert both edits and rebuild.

- [ ] **Step 6: Record the outcome and commit**

Append a `## Measured result` section to `docs/plans/109-splash-screen-bypass.md` with the two medians, the delta, and a one-line verdict on whether the win justifies keeping the feature.

```bash
git add docs/plans/109-splash-screen-bypass.md
git commit -m "$(cat <<'EOF'
docs(plan 109): record measured splash bypass result

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage.** Every section of plan 109 maps to a task: the `winhttp.dll` siting and `il2cpp_min` shim → Task 3; structural class resolution with literal fallbacks → Tasks 1 and 4; the `Update` hook point → Task 4; the neutralise step and verified layout → Task 2 and Task 4; error handling, fail-open and the 30s bound → Task 4 (`kGiveUpMs`, SEH, all-or-nothing `LoadApi`) and Task 5 Step 5; the automated/manual testing split → Tasks 1-3 (automated) and Task 5 (manual); build and deployment → Task 4 Steps 4-5. The spec's non-goal — that this removes idle time, not asset-load time — is enforced by making Task 5 measure the baseline before accepting the feature.

**Placeholder scan.** No TBDs. Every code step carries the actual code; no step says "add error handling" or "similar to Task N".

**Type consistency.** `splash::MatchesSplashSignature(const char* const*, std::size_t) -> bool` is declared in Task 1 and called with exactly that signature in Task 4. `splash::ZeroFloatList(void*, const ListFloatLayout&) -> std::int32_t` is declared in Task 2 and its `> 0` return is used in Task 4. `il2cppmin::Api` field names used in Task 4 (`domain_get`, `thread_attach`, `domain_get_assemblies`, `assembly_get_image`, `image_get_class_count`, `image_get_class`, `class_get_name`, `class_get_fields`, `class_get_field_from_name`, `field_get_name`, `field_get_offset`, `class_get_method_from_name`) match the struct in Task 3 one-for-one, and the 12 entries in `kRequiredSymbols` match the 12 struct members in the same order.

**Known soft spot.** Task 4 Step 2 assumes `MethodInfo`'s first pointer-sized member is the native entry point (`methodPointer`), which is true for current IL2CPP but is the one place the glue depends on an undocumented layout rather than an exported accessor. It is guarded by a null check and is fail-open, and Task 5 Step 5 exercises the failure path. If it proves wrong at runtime, the fix is local to that one line.
