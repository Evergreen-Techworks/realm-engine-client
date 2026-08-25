#pragma once
#include <cstdint>

struct MethodInfo;

// Il2CppHook — the two things every IL2CPP method hook does: resolve a method
// pointer for hooking, and install a MinHook detour with the standard logging
// sequence. Stateless helpers; each feature keeps owning its own target
// pointers and trampolines (teardown stays in InitHooks.cpp).
namespace Il2CppHook {
    // Resolve a method pointer for hooking. If `loose` (default), the class is
    // found via Resolver::FindClassLoose, a namespace-ignoring exact-name scan —
    // it is NOT rename proof; for a class that may be renamed, resolve it through
    // GameClasses:: first (game/symbols/GameClasses.h) and hook by MethodInfo*.
    // Otherwise the class comes from Resolver::GetClass(namespaze, className).
    // Returns nullptr if the class or method (with matching argc) is missing or
    // has no methodPointer. SEH-safe.
    void* ResolveMethod(const char* className, const char* methodName,
                        int argc, bool loose = true, const char* namespaze = "");

    // Idempotent, process-wide MinHook bring-up. Safe to call from any hook
    // installer; the FIRST successful call latches and every later call is a
    // relaxed atomic load. MH_ERROR_ALREADY_INITIALIZED counts as success (a
    // second MH_Initialize is not an error — it means someone beat us to it).
    //
    // Returns false only when MinHook genuinely cannot come up, in which case
    // the caller MUST NOT proceed to InstallMinHook. A failure is logged ONCE
    // (with `label`) rather than once per caller — six modules retrying a
    // failed global one-shot is what the old per-file `static bool s_mhInit`
    // latches produced.
    //
    // Thread-safety: safe to call from any thread. Uses a std::once_flag; the
    // fast path after initialisation is a relaxed atomic load, so it is cheap
    // enough for a per-frame TryInstall retry loop.
    bool EnsureRuntime(const char* label);

    // MH_CreateHook(target, detour, &original) + MH_EnableHook(target) with the
    // standard DBG_FILE_LOG on each failure. Returns true only if both succeed.
    // `label` is used purely for logging. Call `EnsureRuntime()` first; this
    // helper does not initialise MinHook.
    bool InstallMinHook(void* target, void* detour, void** original,
                        const char* label);

    // MH_DisableHook(target) + MH_RemoveHook(target) with the standard
    // DBG_FILE_LOG on failure, then `target = nullptr`. No-op (returns true)
    // when `target` is already null, so callers can drop their `if (t)` guards.
    //
    // `target` is taken BY REFERENCE and nulled on the way out precisely
    // because every existing copy of this pattern nulls it immediately after
    // — folding that in removes the "removed but not nulled" failure mode.
    //
    // Trampoline pointers stay the caller's business: they are typed and this
    // helper is not. Null them yourself, right after this returns.
    //
    // Thread-safety: same as MinHook's own — call from the teardown path only.
    bool UninstallMinHook(void*& target, const char* label);

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
