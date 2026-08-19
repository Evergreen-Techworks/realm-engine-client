#include "pch-il2cpp.h"
#include "Il2CppHook.h"
#include "Il2CppResolver.h"
#include "DbgFileLog.h"

#include "minhook/MinHook.h"

#include <mutex>
#include <string>
#include <unordered_map>

namespace Il2CppHook {

void* ResolveMethod(const char* className, const char* methodName,
                    int argc, bool loose, const char* namespaze)
{
    void* result = nullptr;
    Resolver::Protection::safe_call([&]() {
        Il2CppClass* klass = loose ? Resolver::FindClassLoose(className)
                                   : Resolver::GetClass(namespaze, className);
        if (!klass) return;
        const MethodInfo* mi = il2cpp_class_get_method_from_name(klass, methodName, argc);
        if (mi && mi->methodPointer)
            result = reinterpret_cast<void*>(mi->methodPointer);
    });
    return result;
}

bool InstallMinHook(void* target, void* detour, void** original, const char* label)
{
    const char* tag = label ? label : "?";
    if (!target || !detour || !original) {
        DBG_FILE_LOG("[il2cpphook] InstallMinHook(" << tag << ") — null target/detour/original");
        return false;
    }

    const MH_STATUS created = MH_CreateHook(target, detour, original);
    if (created != MH_OK) {
        DBG_FILE_LOG("[il2cpphook] MH_CreateHook(" << tag << ") failed: " << created);
        return false;
    }

    const MH_STATUS enabled = MH_EnableHook(target);
    if (enabled != MH_OK) {
        DBG_FILE_LOG("[il2cpphook] MH_EnableHook(" << tag << ") failed: " << enabled);
        MH_RemoveHook(target);
        return false;
    }

    return true;
}

// ─── Cached method resolution ───────────────────────────────────────────────
static std::mutex                                         s_cacheMutex;
static std::unordered_map<std::string, const MethodInfo*> s_cache;

const MethodInfo* ResolveMethodCached(const char* className,
                                       const char* methodName,
                                       int argCount, bool loose,
                                       const char* namespaze)
{
    // Build cache key: "<L|N><namespace>\0<className>\0<methodName>\0<argCount>"
    std::string key;
    key.reserve(64);
    key += (loose ? 'L' : 'N');
    key.append(namespaze ? namespaze : "");
    key += '\0';
    key.append(className);
    key += '\0';
    key.append(methodName);
    key += '\0';
    key.append(std::to_string(argCount));

    {
        std::lock_guard<std::mutex> lock(s_cacheMutex);
        auto it = s_cache.find(key);
        if (it != s_cache.end())
            return it->second;
    }

    // Resolve (SEH-safe, same class-lookup logic as ResolveMethod).
    const MethodInfo* result = nullptr;
    Resolver::Protection::safe_call([&]() {
        Il2CppClass* klass = loose ? Resolver::FindClassLoose(className)
                                   : Resolver::GetClass(namespaze, className);
        if (!klass) return;
        const MethodInfo* mi = il2cpp_class_get_method_from_name(klass, methodName, argCount);
        if (mi && mi->methodPointer)
            result = mi;
    });

    // Only cache successful resolutions — callers that retry on failure
    // (DangerPlanner::TryInstall, SpeedHack::ResolveTargets, etc.) will
    // re-attempt until the class/method appears.
    if (result) {
        std::lock_guard<std::mutex> lock(s_cacheMutex);
        s_cache.emplace(std::move(key), result);
    }

    return result;
}

bool EnsureThreadAttached()
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

} // namespace Il2CppHook
