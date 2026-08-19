#include "pch-il2cpp.h"
#include "SpeedHack.h"

#include "Il2CppResolver.h"
#include "Il2CppHook.h"
#include "MemRead.h"
#include "detours/detours.h"

#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>

namespace SpeedHack {
namespace {

using TimeIcallFn = float (*)();
using DoubleTimeIcallFn = double (*)();

static std::atomic<float> s_multiplier{ 1.0f };
static bool s_installed = false;
static bool s_resolved = false;

static decltype(app::Time_1_get_deltaTime) s_origDeltaTime = nullptr;
static decltype(app::Time_1_get_fixedDeltaTime) s_origFixedDeltaTime = nullptr;
static decltype(app::Time_1_get_unscaledDeltaTime) s_origUnscaledDeltaTime = nullptr;
static decltype(app::Time_1_get_realtimeSinceStartup) s_origRealtimeSinceStartup = nullptr;
static decltype(app::Time_1_get_realtimeSinceStartupAsDouble) s_origRealtimeSinceStartupAsDouble = nullptr;
static decltype(app::SpeedHackProofTime_Update) s_origProofTimeUpdate = nullptr;
static decltype(app::SpeedHackDetector_Update) s_origDetectorUpdate = nullptr;

static TimeIcallFn* s_icallDeltaTime = nullptr;
static TimeIcallFn* s_icallFixedDeltaTime = nullptr;
static TimeIcallFn* s_icallUnscaledDeltaTime = nullptr;
static TimeIcallFn* s_icallRealtimeSinceStartup = nullptr;
static DoubleTimeIcallFn* s_icallRealtimeSinceStartupAsDouble = nullptr;

static Il2CppClass* s_proofTimeClass  = nullptr;
static Il2CppClass* s_detectorClass   = nullptr;
static bool         s_antiCheatDone   = false; // give-up flag for BeeByte-renamed classes
static ULONGLONG    s_resolveTick     = 0;

namespace VirtualClock {
static double g_virtualTime = 0.0;
static double g_lastRealTime = -1.0;

static void Reset(double realNow)
{
    g_lastRealTime = realNow;
    g_virtualTime = realNow;
}

static void Tick(double realNow, float scale)
{
    if (g_lastRealTime < 0.0) {
        Reset(realNow);
        return;
    }

    double realDelta = realNow - g_lastRealTime;
    if (!std::isfinite(realDelta) || realDelta < 0.0 || realDelta > 10.0)
        realDelta = 0.0;

    g_lastRealTime = realNow;
    g_virtualTime += realDelta * static_cast<double>(scale);
}

static double GetTime() { return g_virtualTime; }
static float GetTimeF() { return static_cast<float>(g_virtualTime); }
}

static bool LooksLikeUnityTimeThunk(void* thunkPtr)
{
    if (!Mem::AddrOk(thunkPtr))
        return false;

    __try {
        const unsigned char* p = static_cast<const unsigned char*>(thunkPtr);
        return p[0] == 0x48 && p[1] == 0x83 && p[2] == 0xEC && p[3] == 0x28 &&
            p[4] == 0x48 && p[5] == 0x8B && p[6] == 0x05;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

static bool PtrInRange(const uint8_t* ptr, const uint8_t* begin, size_t size)
{
    return ptr >= begin && ptr < (begin + size);
}

template <typename Callback>
static void ForEachGameAssemblySection(Callback cb)
{
    HMODULE gameAssembly = GetModuleHandleA("GameAssembly.dll");
    if (!gameAssembly)
        return;

    auto* base = reinterpret_cast<uint8_t*>(gameAssembly);
    __try {
        auto* dos = reinterpret_cast<IMAGE_DOS_HEADER*>(base);
        if (dos->e_magic != IMAGE_DOS_SIGNATURE)
            return;
        auto* nt = reinterpret_cast<IMAGE_NT_HEADERS*>(base + dos->e_lfanew);
        if (nt->Signature != IMAGE_NT_SIGNATURE)
            return;

        IMAGE_SECTION_HEADER* section = IMAGE_FIRST_SECTION(nt);
        for (WORD i = 0; i < nt->FileHeader.NumberOfSections; ++i, ++section) {
            uint8_t* begin = base + section->VirtualAddress;
            const size_t size = section->Misc.VirtualSize ? section->Misc.VirtualSize : section->SizeOfRawData;
            if (!begin || size == 0)
                continue;
            cb(begin, size, section->Characteristics);
        }
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
    }
}

static const uint8_t* FindGameAssemblyString(const char* needle)
{
    const size_t needleLen = strlen(needle) + 1;
    const uint8_t* found = nullptr;

    ForEachGameAssemblySection([&](uint8_t* begin, size_t size, DWORD characteristics) {
        if (found || (characteristics & IMAGE_SCN_MEM_EXECUTE) != 0 || size < needleLen)
            return;

        __try {
            for (size_t i = 0; i <= size - needleLen; ++i) {
                if (memcmp(begin + i, needle, needleLen) == 0) {
                    found = begin + i;
                    return;
                }
            }
        }
        __except (EXCEPTION_EXECUTE_HANDLER) {
        }
    });

    return found;
}

static void* ResolveUnityTimeThunkByScan(const char* icallNameText)
{
    const uint8_t* icallName = FindGameAssemblyString(icallNameText);
    if (!icallName)
        return nullptr;

    void* found = nullptr;
    ForEachGameAssemblySection([&](uint8_t* begin, size_t size, DWORD characteristics) {
        if (found || (characteristics & IMAGE_SCN_MEM_EXECUTE) == 0 || size < 16)
            return;

        __try {
            for (size_t i = 0; i + 7 <= size; ++i) {
                uint8_t* p = begin + i;
                if (p[0] != 0x48 || p[1] != 0x8D || p[2] != 0x0D)
                    continue;

                const int32_t disp = static_cast<int32_t>(
                    p[3] | (p[4] << 8) | (p[5] << 16) | (p[6] << 24));
                const uint8_t* target = p + 7 + static_cast<std::intptr_t>(disp);
                if (target != icallName)
                    continue;

                const size_t maxBack = (i < 32) ? i : 32;
                for (size_t back = 0; back <= maxBack; ++back) {
                    uint8_t* candidate = p - back;
                    if (!PtrInRange(candidate, begin, size))
                        break;
                    if (LooksLikeUnityTimeThunk(candidate)) {
                        found = candidate;
                        return;
                    }
                }
            }
        }
        __except (EXCEPTION_EXECUTE_HANDLER) {
        }
    });

    return found;
}

template <typename Fn>
static void ResolveUnityTimeThunk(Fn& target, const char* icallNameText)
{
    if (void* thunk = ResolveUnityTimeThunkByScan(icallNameText))
        target = reinterpret_cast<Fn>(thunk);
}

static bool EnsureIl2CppThreadAttached()
{
    static thread_local bool attached = false;
    if (attached)
        return true;
    if (!il2cpp_domain_get || !il2cpp_thread_attach)
        return false;

    Il2CppDomain* domain = il2cpp_domain_get();
    if (!domain)
        return false;

    attached = il2cpp_thread_attach(domain) != nullptr;
    return attached;
}

static const MethodInfo* FindMethod(Il2CppClass* klass, const char* name, int argc)
{
    if (!klass || !klass->name) return nullptr;
    return Il2CppHook::ResolveMethodCached(klass->name, name, argc,
                                            false, klass->namespaze ? klass->namespaze : "");
}

static Il2CppClass* FindClassAny(const char* namespaze, const char* name)
{
    Il2CppClass* klass = nullptr;
    Resolver::Protection::safe_call([&]() {
        klass = Resolver::FindClass(namespaze, name);
        if (!klass)
            klass = Resolver::FindClassLoose(name);
        if (!klass)
            klass = Resolver::GetClass(namespaze, name);
    });
    return klass;
}

template <typename Fn>
static void AssignMethod(Fn& target, Il2CppClass* klass, const char* methodName)
{
    const MethodInfo* method = FindMethod(klass, methodName, 0);
    if (method)
        target = reinterpret_cast<Fn>(method->methodPointer);
}

static TimeIcallFn* TimeIcallSlotFromThunk(void* thunkPtr)
{
    if (!Mem::AddrOk(thunkPtr))
        return nullptr;

    TimeIcallFn* slot = nullptr;
    __try {
        const unsigned char* mov = static_cast<const unsigned char*>(thunkPtr) + 4;
        if (mov[0] != 0x48 || mov[1] != 0x8B || mov[2] != 0x05)
            return nullptr;
        const int32_t disp = static_cast<int32_t>(
            mov[3] | (mov[4] << 8) | (mov[5] << 16) | (mov[6] << 24));
        const uintptr_t rip = reinterpret_cast<uintptr_t>(mov) + 7;
        slot = reinterpret_cast<TimeIcallFn*>(rip + static_cast<std::intptr_t>(disp));
        if (!Mem::AddrOk(slot) || !Mem::AddrOk(*slot))
            slot = nullptr;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        slot = nullptr;
    }
    return slot;
}

static float CallIcall(TimeIcallFn* slot, decltype(app::Time_1_get_deltaTime) fallback, MethodInfo* method)
{
    if (slot) {
        __try {
            TimeIcallFn fn = *slot;
            if (Mem::AddrOk(reinterpret_cast<const void*>(fn)))
                return fn();
        }
        __except (EXCEPTION_EXECUTE_HANDLER) {}
    }
    return fallback ? fallback(method) : 0.0f;
}

static double CallIcallDouble(DoubleTimeIcallFn* slot, decltype(app::Time_1_get_realtimeSinceStartupAsDouble) fallback, MethodInfo* method)
{
    if (slot) {
        __try {
            DoubleTimeIcallFn fn = *slot;
            if (Mem::AddrOk(reinterpret_cast<const void*>(fn)))
                return fn();
        }
        __except (EXCEPTION_EXECUTE_HANDLER) {}
    }
    return fallback ? fallback(method) : 0.0;
}

static float EffectiveClientTimeScale()
{
    const float scale = s_multiplier.load(std::memory_order_relaxed);
    return (scale > 1.0f) ? scale : 1.0f;
}

static float dTime_1_get_deltaTime(MethodInfo* method)
{
    const float raw = CallIcall(s_icallDeltaTime, s_origDeltaTime, method);
    return raw * EffectiveClientTimeScale();
}

static float dTime_1_get_fixedDeltaTime(MethodInfo* method)
{
    const float raw = CallIcall(s_icallFixedDeltaTime, s_origFixedDeltaTime, method);
    return raw * EffectiveClientTimeScale();
}

static float dTime_1_get_unscaledDeltaTime(MethodInfo* method)
{
    const float raw = CallIcall(s_icallUnscaledDeltaTime, s_origUnscaledDeltaTime, method);
    return raw * EffectiveClientTimeScale();
}

static float dTime_1_get_realtimeSinceStartup(MethodInfo* method)
{
    const float real = CallIcall(s_icallRealtimeSinceStartup, s_origRealtimeSinceStartup, method);
    const float scale = EffectiveClientTimeScale();
    if (scale <= 1.0f) {
        VirtualClock::Reset(static_cast<double>(real));
        return real;
    }

    VirtualClock::Tick(static_cast<double>(real), scale);
    return VirtualClock::GetTimeF();
}

static double dTime_1_get_realtimeSinceStartupAsDouble(MethodInfo* method)
{
    const double real = CallIcallDouble(s_icallRealtimeSinceStartupAsDouble, s_origRealtimeSinceStartupAsDouble, method);
    const float scale = EffectiveClientTimeScale();
    if (scale <= 1.0f) {
        VirtualClock::Reset(real);
        return real;
    }

    VirtualClock::Tick(real, scale);
    return VirtualClock::GetTime();
}

static void ApplySpeedHackProofTimeStaticFieldsScale()
{
    const float scale = EffectiveClientTimeScale();
    if (scale <= 1.0f)
        return;

    app::SpeedHackProofTime__StaticFields* sf = nullptr;
    if (s_proofTimeClass && s_proofTimeClass->static_fields) {
        sf = reinterpret_cast<app::SpeedHackProofTime__StaticFields*>(s_proofTimeClass->static_fields);
    } else if (app::SpeedHackProofTime__TypeInfo && *app::SpeedHackProofTime__TypeInfo) {
        sf = (*app::SpeedHackProofTime__TypeInfo)->static_fields;
    }

    if (!sf)
        return;

    const float rawDelta = sf->reliableDeltaTime;
    const float rawUnscaledDelta = sf->reliableUnscaledDeltaTime;

    sf->reliableDeltaTime = rawDelta * scale;
    sf->reliableUnscaledDeltaTime = rawUnscaledDelta * scale;
    sf->reliableTime += (scale - 1.0f) * rawDelta;
    sf->reliableUnscaledTime += (scale - 1.0f) * rawUnscaledDelta;
    sf->reliableRealtimeSinceStartup += (scale - 1.0f) * rawUnscaledDelta;
    sf->reliableTimeSinceLevelLoad += (scale - 1.0f) * rawDelta;
}

static void dSpeedHackProofTime_Update(app::SpeedHackProofTime* self, MethodInfo* method)
{
    if (s_origProofTimeUpdate)
        s_origProofTimeUpdate(self, method);
    ApplySpeedHackProofTimeStaticFieldsScale();
}

static void dSpeedHackDetector_Update(app::SpeedHackDetector* self, MethodInfo* method)
{
    if (EffectiveClientTimeScale() > 1.0f)
        return;
    if (s_origDetectorUpdate)
        s_origDetectorUpdate(self, method);
}

template <typename Fn>
static bool HookOne(Fn& target, Fn detour, Fn& original)
{
    if (!Mem::AddrOk(reinterpret_cast<void*>(target)) || !detour)
        return false;
    if (DetourAttach(&(PVOID&)target, reinterpret_cast<PVOID>(detour)) != NO_ERROR) {
        original = nullptr;
        return false;
    }
    original = target;
    return true;
}

template <typename Fn>
static void UnhookOne(Fn& target, Fn detour, Fn original)
{
    if (!original || !Mem::AddrOk(reinterpret_cast<void*>(target)) || !detour)
        return;
    DetourDetach(&(PVOID&)target, reinterpret_cast<PVOID>(detour));
}

static void ResolveTargets()
{
    if (s_resolved)
        return;
    if (!EnsureIl2CppThreadAttached())
        return;

    // Track time so we can give up on BeeByte-renamed anti-cheat classes.
    // FindClassLoose scans all IL2CPP metadata — calling it every frame for
    // a class that was renamed is what tanks FPS. After 5 s we stop looking.
    const ULONGLONG now = GetTickCount64();
    if (s_resolveTick == 0) s_resolveTick = now;
    if (!s_antiCheatDone) s_antiCheatDone = (now - s_resolveTick) >= 5000ULL;

    Il2CppClass* timeClass = FindClassAny("UnityEngine", "Time");

    // Only scan for anti-cheat classes while we haven't given up.
    if (!s_antiCheatDone) {
        if (!s_proofTimeClass)
            s_proofTimeClass = FindClassAny("CodeStage.AntiCheat.Time", "SpeedHackProofTime");
        if (!s_detectorClass)
            s_detectorClass = FindClassAny("CodeStage.AntiCheat.Detectors", "SpeedHackDetector");
    }

    AssignMethod(app::Time_1_get_deltaTime, timeClass, "get_deltaTime");
    AssignMethod(app::Time_1_get_fixedDeltaTime, timeClass, "get_fixedDeltaTime");
    AssignMethod(app::Time_1_get_unscaledDeltaTime, timeClass, "get_unscaledDeltaTime");
    AssignMethod(app::Time_1_get_realtimeSinceStartup, timeClass, "get_realtimeSinceStartup");
    AssignMethod(app::Time_1_get_realtimeSinceStartupAsDouble, timeClass, "get_realtimeSinceStartupAsDouble");
    AssignMethod(app::SpeedHackProofTime_Update, s_proofTimeClass, "Update");
    AssignMethod(app::SpeedHackDetector_Update, s_detectorClass, "Update");

    ResolveUnityTimeThunk(app::Time_1_get_deltaTime, "UnityEngine.Time::get_deltaTime()");
    ResolveUnityTimeThunk(app::Time_1_get_fixedDeltaTime, "UnityEngine.Time::get_fixedDeltaTime()");
    ResolveUnityTimeThunk(app::Time_1_get_unscaledDeltaTime, "UnityEngine.Time::get_unscaledDeltaTime()");
    ResolveUnityTimeThunk(app::Time_1_get_realtimeSinceStartup, "UnityEngine.Time::get_realtimeSinceStartup()");
    ResolveUnityTimeThunk(app::Time_1_get_realtimeSinceStartupAsDouble, "UnityEngine.Time::get_realtimeSinceStartupAsDouble()");

    if (!s_icallDeltaTime)
        s_icallDeltaTime = TimeIcallSlotFromThunk(reinterpret_cast<void*>(app::Time_1_get_deltaTime));
    if (!s_icallFixedDeltaTime)
        s_icallFixedDeltaTime = TimeIcallSlotFromThunk(reinterpret_cast<void*>(app::Time_1_get_fixedDeltaTime));
    if (!s_icallUnscaledDeltaTime)
        s_icallUnscaledDeltaTime = TimeIcallSlotFromThunk(reinterpret_cast<void*>(app::Time_1_get_unscaledDeltaTime));
    if (!s_icallRealtimeSinceStartup)
        s_icallRealtimeSinceStartup = TimeIcallSlotFromThunk(reinterpret_cast<void*>(app::Time_1_get_realtimeSinceStartup));
    if (!s_icallRealtimeSinceStartupAsDouble)
        s_icallRealtimeSinceStartupAsDouble = reinterpret_cast<DoubleTimeIcallFn*>(
            reinterpret_cast<void*>(TimeIcallSlotFromThunk(reinterpret_cast<void*>(app::Time_1_get_realtimeSinceStartupAsDouble))));

    // Core Time hooks required. Anti-cheat hooks optional — if BeeByte renamed
    // them and we gave up, we stop scanning and install what we have.
    s_resolved = app::Time_1_get_deltaTime &&
        app::Time_1_get_fixedDeltaTime &&
        app::Time_1_get_unscaledDeltaTime &&
        LooksLikeUnityTimeThunk(reinterpret_cast<void*>(app::Time_1_get_deltaTime)) &&
        LooksLikeUnityTimeThunk(reinterpret_cast<void*>(app::Time_1_get_fixedDeltaTime)) &&
        LooksLikeUnityTimeThunk(reinterpret_cast<void*>(app::Time_1_get_unscaledDeltaTime));
}

static void TryInstall()
{
    if (s_installed)
        return;

    ResolveTargets();
    if (!s_resolved)
        return;

    DetourTransactionBegin();
    DetourUpdateThread(GetCurrentThread());

    bool ok = HookOne(app::Time_1_get_deltaTime, dTime_1_get_deltaTime, s_origDeltaTime);
    ok = HookOne(app::Time_1_get_fixedDeltaTime, dTime_1_get_fixedDeltaTime, s_origFixedDeltaTime) && ok;
    ok = HookOne(app::Time_1_get_unscaledDeltaTime, dTime_1_get_unscaledDeltaTime, s_origUnscaledDeltaTime) && ok;

    if (ok && app::Time_1_get_realtimeSinceStartup)
        ok = HookOne(app::Time_1_get_realtimeSinceStartup, dTime_1_get_realtimeSinceStartup, s_origRealtimeSinceStartup);
    if (ok && app::Time_1_get_realtimeSinceStartupAsDouble)
        ok = HookOne(app::Time_1_get_realtimeSinceStartupAsDouble, dTime_1_get_realtimeSinceStartupAsDouble, s_origRealtimeSinceStartupAsDouble);
    if (ok && app::SpeedHackProofTime_Update)
        ok = HookOne(app::SpeedHackProofTime_Update, dSpeedHackProofTime_Update, s_origProofTimeUpdate);
    if (ok && app::SpeedHackDetector_Update)
        ok = HookOne(app::SpeedHackDetector_Update, dSpeedHackDetector_Update, s_origDetectorUpdate);

    if (!ok) {
        DetourTransactionAbort();
        s_origDeltaTime = nullptr;
        s_origFixedDeltaTime = nullptr;
        s_origUnscaledDeltaTime = nullptr;
        s_origRealtimeSinceStartup = nullptr;
        s_origRealtimeSinceStartupAsDouble = nullptr;
        s_origProofTimeUpdate = nullptr;
        s_origDetectorUpdate = nullptr;
        return;
    }

    if (DetourTransactionCommit() != NO_ERROR) {
        DetourTransactionAbort();
        s_origDeltaTime = nullptr;
        s_origFixedDeltaTime = nullptr;
        s_origUnscaledDeltaTime = nullptr;
        s_origRealtimeSinceStartup = nullptr;
        s_origRealtimeSinceStartupAsDouble = nullptr;
        s_origProofTimeUpdate = nullptr;
        s_origDetectorUpdate = nullptr;
        return;
    }

    s_installed = true;
}

} // namespace

void Tick()
{
    TryInstall();
}

void Uninstall()
{
    s_multiplier.store(1.0f, std::memory_order_relaxed);
    if (!s_installed)
        return;

    DetourTransactionBegin();
    DetourUpdateThread(GetCurrentThread());

    UnhookOne(app::Time_1_get_deltaTime, dTime_1_get_deltaTime, s_origDeltaTime);
    UnhookOne(app::Time_1_get_fixedDeltaTime, dTime_1_get_fixedDeltaTime, s_origFixedDeltaTime);
    UnhookOne(app::Time_1_get_unscaledDeltaTime, dTime_1_get_unscaledDeltaTime, s_origUnscaledDeltaTime);
    UnhookOne(app::Time_1_get_realtimeSinceStartup, dTime_1_get_realtimeSinceStartup, s_origRealtimeSinceStartup);
    UnhookOne(app::Time_1_get_realtimeSinceStartupAsDouble, dTime_1_get_realtimeSinceStartupAsDouble, s_origRealtimeSinceStartupAsDouble);
    UnhookOne(app::SpeedHackProofTime_Update, dSpeedHackProofTime_Update, s_origProofTimeUpdate);
    UnhookOne(app::SpeedHackDetector_Update, dSpeedHackDetector_Update, s_origDetectorUpdate);

    if (DetourTransactionCommit() != NO_ERROR)
        DetourTransactionAbort();

    s_origDeltaTime = nullptr;
    s_origFixedDeltaTime = nullptr;
    s_origUnscaledDeltaTime = nullptr;
    s_origRealtimeSinceStartup = nullptr;
    s_origRealtimeSinceStartupAsDouble = nullptr;
    s_origProofTimeUpdate = nullptr;
    s_origDetectorUpdate = nullptr;
    s_installed = false;
}

void SetMultiplier(float mult)
{
    if (!std::isfinite(mult) || mult <= 1.0f)
        mult = 1.0f;
    s_multiplier.store(mult, std::memory_order_relaxed);
}

float GetMultiplier()
{
    return s_multiplier.load(std::memory_order_relaxed);
}

bool IsActive()
{
    return GetMultiplier() > 1.0001f;
}

bool IsHookInstalled()
{
    return s_installed;
}

bool IsResolved()
{
    ResolveTargets();
    return s_resolved;
}

float GetActualTimeScale()
{
    return GetMultiplier();
}

void LogTimingProbe(const char*)
{
}

} // namespace SpeedHack
