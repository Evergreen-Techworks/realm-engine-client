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
