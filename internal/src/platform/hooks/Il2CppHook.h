#pragma once
#include <cstdint>

struct MethodInfo;

// Il2CppHook — the two things every IL2CPP method hook does: resolve a method
// pointer for hooking, and install a MinHook detour with the standard logging
// sequence. Stateless helpers; each feature keeps owning its own target
// pointers and trampolines (teardown stays in InitHooks.cpp).
namespace Il2CppHook {
    // Resolve a method pointer for hooking. If `loose` (default), the class is
    // found via Resolver::FindClassLoose (BeeByte-rename proof); otherwise via
    // Resolver::GetClass(namespaze, className). Returns nullptr if the class or
    // method (with matching argc) is missing or has no methodPointer. SEH-safe.
    void* ResolveMethod(const char* className, const char* methodName,
                        int argc, bool loose = true, const char* namespaze = "");

    // MH_CreateHook(target, detour, &original) + MH_EnableHook(target) with the
    // standard DBG_FILE_LOG on each failure. Returns true only if both succeed.
    // `label` is used purely for logging. Assumes MH_Initialize already ran
    // (DirectX.cpp / first hook installs it — keep that behavior).
    bool InstallMinHook(void* target, void* detour, void** original,
                        const char* label);

    // Cached variant of ResolveMethod.  Returns the MethodInfo* (not void*)
    // on the first call with a given (className, methodName, argCount, loose,
    // namespaze) tuple and caches it for subsequent calls.  Returns nullptr
    // if the class or method cannot be found or lacks a methodPointer.
    // Failed lookups are NOT cached so callers that retry (TryInstall loops,
    // ResolveTargets, etc.) will re-attempt until the class/method appears.
    // Thread-safe via an internal mutex (init-time lookups, not hot-path).
    const MethodInfo* ResolveMethodCached(const char* className,
                                          const char* methodName,
                                          int argCount,
                                          bool loose = true,
                                          const char* namespaze = "");

    // Attach the calling OS thread to the IL2CPP domain (idempotent per thread,
    // thread_local cached). Required before calling IL2CPP APIs from a thread
    // the runtime has not seen (detour threads, worker threads). Returns false
    // if the IL2CPP API is not initialised yet or attach fails.
    bool EnsureThreadAttached();
}
