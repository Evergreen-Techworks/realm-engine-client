#define WIN32_LEAN_AND_MEAN
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif

#include <windows.h>

#include <cstring>

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

// SplashScreenScript is game code, so it lives in Assembly-CSharp. Opening that
// one image beats enumerating the domain: it is a few thousand types instead of
// the whole universe, and it stops us forcing Class::Init across mscorlib and
// UnityEngine.* during the exact boot phase this feature exists to shorten.
const char* const kGameAssemblyImage = "Assembly-CSharp";

constexpr DWORD kGiveUpMs   = 30000;   // never scan forever after a patch
constexpr DWORD kPollMs     = 50;

// Class-resolution retry backoff only. Each attempt walks Assembly-CSharp and
// calls class_get_fields, which forces Class::Init; fast for the first second,
// then back off.
constexpr DWORD kClassPollFastWindowMs = 1000;
constexpr DWORD kClassPollSlowMs       = 500;

// A believable managed field offset. Anything at or above this means we read
// something that is not the field we asked for; refuse to dereference it.
constexpr std::size_t kMaxPlausibleFieldOffset = 0x1000;

il2cppmin::Api g_api{};

using UpdateFn = void (*)(void* self, void* method);
UpdateFn g_realUpdate  = nullptr;
void*    g_updateTarget = nullptr;
volatile LONG g_hookInstalled = 0;
volatile LONG g_done          = 0;

// Written by the bootstrap thread, read by the detour on the main thread.
void* volatile        g_splashClass        = nullptr;
volatile std::size_t  g_timeForLogoOffset  = 0;

// ---------------------------------------------------------------------------
// Observability. The whole module is silent-by-design otherwise, which makes
// "bypassed the splash", "class not found" and "never ran at all" impossible to
// tell apart from outside — including for the spec's own fail-open manual test.
// Deliberately dependency-free: no CRT formatting, no user32 (wsprintfA), just
// OutputDebugStringA and a hand-rolled integer append.
// ---------------------------------------------------------------------------
void Emit(const char* msg, bool hasValue, long value)
{
    char buf[192];
    int n = 0;

    const char* prefix = "[splash] ";
    for (const char* p = prefix; *p; ++p) buf[n++] = *p;
    for (const char* p = msg; *p && n < 150; ++p) buf[n++] = *p;

    if (hasValue) {
        if (value < 0) { buf[n++] = '-'; value = -value; }
        char digits[24];
        int d = 0;
        do { digits[d++] = static_cast<char>('0' + (value % 10)); value /= 10; }
        while (value != 0 && d < 24);
        while (d > 0) buf[n++] = digits[--d];
    }

    buf[n++] = '\n';
    buf[n]   = '\0';
    OutputDebugStringA(buf);
}

void LogMsg(const char* msg)             { Emit(msg, false, 0); }
void LogVal(const char* msg, long value) { Emit(msg, true, value); }

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

// Set once we have seen Assembly-CSharp open, so the retry loop can tell
// "the image never appeared" from "the image is there, the class is not".
bool g_sawImage = false;

void* FindSplashClass(void* domain)
{
    void* assembly = g_api.domain_assembly_open(domain, kGameAssemblyImage);
    if (!assembly) return nullptr;   // not loaded yet, or gone; caller retries

    void* image = g_api.assembly_get_image(assembly);
    if (!image) return nullptr;

    if (!g_sawImage) { g_sawImage = true; LogMsg("Assembly-CSharp image open"); }

    void* literalHit = nullptr;

    const std::size_t classCount = g_api.image_get_class_count(image);
    for (std::size_t c = 0; c < classCount; ++c) {
        void* klass = g_api.image_get_class(image, c);
        if (!klass) continue;

        if (ClassLooksLikeSplash(klass)) {          // structural wins
            LogMsg("class resolved structurally (marker fields)");
            return klass;
        }

        if (!literalHit) {
            const char* name = g_api.class_get_name(klass);
            if (name) {
                for (const char* literal : kFallbackClassNames) {
                    // strcmp, not lstrcmpA: this is a pure ASCII identity test
                    // in the hottest loop in the module; lstrcmpA is
                    // locale-aware and far slower for no benefit.
                    if (std::strcmp(name, literal) == 0) { literalHit = klass; break; }
                }
            }
        }
    }

    if (literalHit) LogMsg("class resolved by Beebyte literal fallback");
    return literalHit;   // may be nullptr — caller retries, then fails open
}

void __cdecl HookedUpdate(void* self, void* method)
{
    if (self && !g_done) {
        // Raw dereferences only — no IL2CPP API calls inside the guard.
        __try {
            // Il2CppObject begins with Il2CppClass* klass. Confirm this really
            // is the class we resolved before writing anything: SEH catches a
            // fault, not a successful write into the wrong object.
            if (*reinterpret_cast<void* const*>(self) == g_splashClass) {
                auto* list = *reinterpret_cast<void**>(
                    static_cast<unsigned char*>(self) + g_timeForLogoOffset);
                const std::int32_t zeroed =
                    splash::ZeroFloatList(list, splash::kDefaultListFloatLayout);
                if (zeroed > 0) {
                    // Deliberately does not unhook here: the design doc says to
                    // unhook once a non-empty list has been zeroed, but
                    // MH_DisableHook suspends threads and HeapAllocs while they
                    // are suspended, and self-unhooking from inside the
                    // executing detour risks deadlock and corrupting this
                    // thread's own stack. g_done latches this to a no-op
                    // instead; Remove() (DLL_PROCESS_DETACH) cleans up at exit.
                    // Do not "fix" this into a self-unhook.
                    InterlockedExchange(&g_done, 1);
                    LogVal("bypassed: timeForLogo entries zeroed = ", zeroed);
                }
            }
        } __except (EXCEPTION_EXECUTE_HANDLER) {
            InterlockedExchange(&g_done, 1);   // never fault every frame
            LogMsg("give up: faulted reading the instance; splash left alone");
        }
    }

    if (g_realUpdate) g_realUpdate(self, method);
}

// The ONLY raw pointer read in the bootstrap path, isolated so its SEH guard
// covers nothing else. Wrapping the IL2CPP API calls instead would be actively
// dangerous: class_get_fields -> Class::Init takes the runtime's global
// type-initialisation lock, and __except unwinds without releasing it — the
// guard meant to prevent a takedown would hang the game's main thread forever.
void* ReadMethodPointer(const void* method)
{
    __try {
        return *reinterpret_cast<void* const*>(method);   // MethodInfo.methodPointer
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return nullptr;
    }
}

bool ResolveAndHook(void* domain, DWORD start)
{
    // 3. Resolve the class. Classes load lazily, so retry — never cache a miss.
    void* klass = nullptr;
    for (;;) {
        klass = FindSplashClass(domain);
        if (klass) break;

        const DWORD elapsed = GetTickCount() - start;
        if (elapsed > kGiveUpMs) {
            LogMsg(g_sawImage ? "give up: SplashScreenScript not found in Assembly-CSharp"
                              : "give up: Assembly-CSharp never opened");
            return false;
        }
        Sleep(elapsed < kClassPollFastWindowMs ? kPollMs : kClassPollSlowMs);
    }

    // 4. Field offset + Update. "Update" survives Beebyte; the siblings do not.
    void* field = g_api.class_get_field_from_name(klass, "timeForLogo");
    if (!field) { LogMsg("give up: timeForLogo field not found"); return false; }

    const std::size_t offset = g_api.field_get_offset(field);
    if (offset == 0 || offset >= kMaxPlausibleFieldOffset) {
        LogVal("give up: implausible timeForLogo offset = ", static_cast<long>(offset));
        return false;
    }
    LogVal("timeForLogo offset = ", static_cast<long>(offset));

    const void* method = g_api.class_get_method_from_name(klass, "Update", 0);
    if (!method) { LogMsg("give up: Update method not found"); return false; }

    g_updateTarget = ReadMethodPointer(method);
    if (!g_updateTarget) { LogMsg("give up: Update has no native entry point"); return false; }
    LogMsg("Update resolved");

    // Publish what the detour reads only once both are known-good.
    g_timeForLogoOffset = offset;
    g_splashClass       = klass;

    // 5. Hook. MinHook may already be initialised by connect_hook — that is fine.
    const MH_STATUS init = MH_Initialize();
    if (init != MH_OK && init != MH_ERROR_ALREADY_INITIALIZED) {
        LogVal("give up: MH_Initialize failed, status = ", static_cast<long>(init));
        return false;
    }

    const MH_STATUS created = MH_CreateHook(g_updateTarget,
                                            reinterpret_cast<void*>(&HookedUpdate),
                                            reinterpret_cast<void**>(&g_realUpdate));
    if (created != MH_OK) {
        LogVal("give up: MH_CreateHook failed, status = ", static_cast<long>(created));
        return false;
    }

    const MH_STATUS enabled = MH_EnableHook(g_updateTarget);
    if (enabled != MH_OK) {
        LogVal("give up: MH_EnableHook failed, status = ", static_cast<long>(enabled));
        return false;
    }

    InterlockedExchange(&g_hookInstalled, 1);
    LogMsg("Update hook installed");
    return true;
}

DWORD WINAPI BootstrapThread(LPVOID)
{
    const DWORD start = GetTickCount();

    // 1. Wait for GameAssembly.dll and a full IL2CPP export set.
    while (!il2cppmin::LoadApiFromGameAssembly(g_api)) {
        if (GetTickCount() - start > kGiveUpMs) {
            LogMsg("give up: GameAssembly.dll absent or export set incomplete");
            return 0;
        }
        Sleep(kPollMs);
    }
    LogMsg("IL2CPP exports loaded");

    // 2. Wait for a live domain, then attach so class enumeration is legal.
    void* domain = nullptr;
    while (!(domain = g_api.domain_get())) {
        if (GetTickCount() - start > kGiveUpMs) {
            LogMsg("give up: no IL2CPP domain");
            return 0;
        }
        Sleep(kPollMs);
    }

    // A null attach means IL2CPP does not know this thread. Enumerating
    // metadata from it would drive GC-allocating Class::Init from a thread the
    // GC cannot see — a crash path, and the one place this module could break
    // its own fail-open promise. Do nothing instead.
    void* thread = g_api.thread_attach(domain);
    if (!thread) {
        LogMsg("give up: il2cpp_thread_attach returned null");
        return 0;
    }
    LogMsg("domain attached");

    ResolveAndHook(domain, start);

    // Always detach: a give-up or a resolution failure must not leave this
    // thread registered-but-dead with IL2CPP's GC — a later GC walking its
    // stack is a crash long after boot, which "never crash" forbids.
    g_api.thread_detach(thread);
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
