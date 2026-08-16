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
}
