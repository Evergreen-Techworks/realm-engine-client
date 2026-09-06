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
volatile LONG g_resolving = 0;
volatile LONG g_done          = 0;
HWND g_unityWindow = nullptr;
UINT_PTR g_dispatchTimer = 0;
DWORD g_dispatchStart = 0;

// Temporary one-run instrumentation. Keep observing after the durations have
// been zeroed: the interesting question is which state still changes (or gets
// stuck) between the last logo and scene activation.
constexpr DWORD kTraceWindowMs = 20000;
constexpr LONG  kMaxTraceChanges = 256;
DWORD g_firstUpdateTick = 0;
LONG  g_updateCount = 0;
LONG  g_traceChanges = 0;

struct SplashSnapshot {
    std::int32_t logoIndexA;
    std::int32_t logoIndexB;
    float timerA;
    float timerB;
    bool flagA;
    bool flagB;
    std::int32_t possibleCount;
    std::int32_t displayCount;
    std::int32_t durationCount;
};

SplashSnapshot g_lastSnapshot{};
bool g_haveSnapshot = false;

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

    // Also append to a file, so a crash can be diagnosed without attaching a
    // debugger. Opened and closed per line on purpose: a fatal error in the
    // game process must not lose the last message to an unflushed buffer.
    char path[MAX_PATH];
    if (GetEnvironmentVariableA("LOCALAPPDATA", path, MAX_PATH)) {
        const char* tail = "\\splash-bypass.log";
        int i = 0; while (path[i]) ++i;
        for (const char* t = tail; *t && i < MAX_PATH - 1; ++t) path[i++] = *t;
        path[i] = '\0';
        HANDLE h = CreateFileA(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                               nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (h != INVALID_HANDLE_VALUE) {
            DWORD written = 0;
            WriteFile(h, buf, static_cast<DWORD>(n), &written, nullptr);
            FlushFileBuffers(h);
            CloseHandle(h);
        }
    }
}

void LogMsg(const char* msg)             { Emit(msg, false, 0); }
void LogVal(const char* msg, long value) { Emit(msg, true, value); }

std::int32_t ReadListSize(void* list)
{
    if (!list) return -1;
    return *reinterpret_cast<const std::int32_t*>(
        static_cast<const unsigned char*>(list) +
        splash::kDefaultListFloatLayout.sizeOffset);
}

bool SameSnapshot(const SplashSnapshot& a, const SplashSnapshot& b)
{
    return a.logoIndexA == b.logoIndexA && a.logoIndexB == b.logoIndexB &&
           a.timerA == b.timerA && a.timerB == b.timerB &&
           a.flagA == b.flagA && a.flagB == b.flagB &&
           a.possibleCount == b.possibleCount &&
           a.displayCount == b.displayCount &&
           a.durationCount == b.durationCount;
}

void TraceSnapshot(void* self)
{
    const DWORD now = GetTickCount();
    if (!g_firstUpdateTick) g_firstUpdateTick = now;
    const LONG update = InterlockedIncrement(&g_updateCount);
    if (now - g_firstUpdateTick > kTraceWindowMs ||
        g_traceChanges >= kMaxTraceChanges) return;

    // Verified SplashScreenScript layout relative to timeForLogo:
    // possibleSplashscreens/list -16, logosToDisplay/list -8,
    // then Sprite* +8, int/int +16/+20, float/float +24/+28,
    // bool/bool +32/+33. Using the resolved serialized field as the anchor
    // survives changes to the MonoBehaviour base layout.
    auto* anchor = static_cast<unsigned char*>(self) + g_timeForLogoOffset;
    SplashSnapshot s{};
    s.possibleCount = ReadListSize(*reinterpret_cast<void**>(anchor - 16));
    s.displayCount  = ReadListSize(*reinterpret_cast<void**>(anchor - 8));
    s.durationCount = ReadListSize(*reinterpret_cast<void**>(anchor));
    s.logoIndexA = *reinterpret_cast<std::int32_t*>(anchor + 16);
    s.logoIndexB = *reinterpret_cast<std::int32_t*>(anchor + 20);
    s.timerA = *reinterpret_cast<float*>(anchor + 24);
    s.timerB = *reinterpret_cast<float*>(anchor + 28);
    s.flagA = *reinterpret_cast<bool*>(anchor + 32);
    s.flagB = *reinterpret_cast<bool*>(anchor + 33);

    if (g_haveSnapshot && SameSnapshot(s, g_lastSnapshot)) return;
    g_lastSnapshot = s;
    g_haveSnapshot = true;
    InterlockedIncrement(&g_traceChanges);

    LogVal("trace change # = ", g_traceChanges);
    LogVal("trace elapsed_ms = ", static_cast<long>(now - g_firstUpdateTick));
    LogVal("trace Update # = ", update);
    LogVal("trace possibleSplashscreens count = ", s.possibleCount);
    LogVal("trace logosToDisplay count = ", s.displayCount);
    LogVal("trace timeForLogo count = ", s.durationCount);
    LogVal("trace int +16 = ", s.logoIndexA);
    LogVal("trace int +20 = ", s.logoIndexB);
    LogVal("trace float +24 x1000 = ", static_cast<long>(s.timerA * 1000.0f));
    LogVal("trace float +28 x1000 = ", static_cast<long>(s.timerB * 1000.0f));
    LogVal("trace bool +32 = ", s.flagA ? 1 : 0);
    LogVal("trace bool +33 = ", s.flagB ? 1 : 0);
}

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
    if (self) {
        // Raw dereferences only — no IL2CPP API calls inside the guard.
        __try {
            // Il2CppObject begins with Il2CppClass* klass. Confirm this really
            // is the class we resolved before writing anything: SEH catches a
            // fault, not a successful write into the wrong object.
            if (*reinterpret_cast<void* const*>(self) == g_splashClass) {
                // The trace established that +28 is the live fade countdown
                // (0.976 -> 0.622 over ~2.6 s) left untouched by timeForLogo.
                // Collapse it every frame until the controller advances.
                auto* anchor = static_cast<unsigned char*>(self) +
                               g_timeForLogoOffset;
                *reinterpret_cast<float*>(anchor + 28) = 0.0f;
                if (!g_done) {
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

bool ResolveAndHook(void* domain)
{
    // Called from a Unity-owned thread. Never sleep here: if metadata is not
    // ready yet, the runtime-invoke trigger will try again on a later call.
    void* klass = FindSplashClass(domain);
    if (!klass) return false;

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

BOOL CALLBACK FindUnityWindow(HWND hwnd, LPARAM param)
{
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid != GetCurrentProcessId()) return TRUE;
    if (GetWindow(hwnd, GW_OWNER) != nullptr) return TRUE;
    *reinterpret_cast<HWND*>(param) = hwnd;
    return FALSE;
}

void CALLBACK UnityTimerProc(HWND hwnd, UINT, UINT_PTR timerId, DWORD)
{
    if (g_hookInstalled || GetTickCount() - g_dispatchStart > kGiveUpMs) {
        KillTimer(hwnd, timerId);
        g_dispatchTimer = 0;
        return;
    }

    if (InterlockedCompareExchange(&g_resolving, 1, 0) != 0) return;
    if (il2cppmin::LoadApiFromGameAssembly(g_api)) {
        // This callback is dispatched by Unity's own window message pump, so
        // IL2CPP sees a runtime-owned thread rather than our CreateThread worker.
        void* domain = g_api.domain_get();
        if (domain) ResolveAndHook(domain);
    }
    InterlockedExchange(&g_resolving, 0);
}

DWORD WINAPI BootstrapThread(LPVOID)
{
    const DWORD start = GetTickCount();
    while (!g_unityWindow && GetTickCount() - start <= kGiveUpMs) {
        EnumWindows(&FindUnityWindow, reinterpret_cast<LPARAM>(&g_unityWindow));
        if (!g_unityWindow) Sleep(kPollMs);
    }
    if (!g_unityWindow) { LogMsg("give up: Unity window not found"); return 0; }

    // SetTimer with a real HWND dispatches TimerProc from the thread that owns
    // that window. No IL2CPP call and no code patch occurs on this worker.
    g_dispatchStart = GetTickCount();
    g_dispatchTimer = SetTimer(g_unityWindow, 0x52454C4D, 250,
                               &UnityTimerProc);
    LogMsg(g_dispatchTimer ? "Unity-thread timer scheduled"
                           : "give up: SetTimer failed");
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
    if (InterlockedCompareExchange(&g_hookInstalled, 0, 1) == 1) {
        MH_DisableHook(g_updateTarget);
        MH_RemoveHook(g_updateTarget);
    }
    if (g_dispatchTimer && g_unityWindow)
        KillTimer(g_unityWindow, g_dispatchTimer);
}

} // namespace splashbypass
