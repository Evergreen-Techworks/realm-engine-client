#include "pch-il2cpp.h"
#include "Il2CppHook.h"
#include "Il2CppResolver.h"
#include "DbgFileLog.h"

#include "minhook/MinHook.h"

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

} // namespace Il2CppHook
