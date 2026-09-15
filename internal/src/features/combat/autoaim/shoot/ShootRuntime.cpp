#include "pch-il2cpp.h"
#include "features/combat/autoaim/shoot/ShootRuntime.h"
#include "features/combat/autoaim/shoot/ShootBindingReadiness.h"

#include "platform/hooks/Il2CppHook.h"
#include "BootGate.h"
#include "BuildBindings.h"
#include "DbgFileLog.h"

#include <cmath>
#include <windows.h>

namespace {

static const char* kShootClass = "FKALGHJIADI";
static const char* kSWAMethod = "EHGHCACPAGH";

using ShootWithAngleFn = void(__fastcall*)(void*, float, void*);

ShootWithAngleFn s_fnSWA = nullptr;
const MethodInfo* s_miSWA = nullptr;
bool s_swaResolved = false;
void* s_cachedKlass = nullptr;
ShootWithAngleFn s_cachedFn = nullptr;

void ResolveSWA()
{
    if (s_swaResolved) return;
    const MethodInfo* method = Il2CppHook::ResolveMethodCached(kShootClass, kSWAMethod, 1, false);
    if (!method) return;
    const auto* binding = BuildBindings::Method(BuildBindings::ClassName(kShootClass), kSWAMethod, 1);
    const uintptr_t moduleBase = reinterpret_cast<uintptr_t>(GetModuleHandleW(L"GameAssembly.dll"));
    if (!ShootBindingReadiness::MatchesMethodBinding(
            binding && BuildBindings::gameAssemblySha256[0] && BuildBindings::metadataSha256[0],
            moduleBase, reinterpret_cast<uintptr_t>(method->methodPointer), binding ? binding->rva : 0))
        return;
    s_fnSWA = reinterpret_cast<ShootWithAngleFn>(method->methodPointer);
    s_miSWA = method;
    s_swaResolved = true;
    DbgFileLogWrite("[ShootRuntime] firing method matches generated binding; manual angle unavailable");
}

ShootWithAngleFn ResolveShootWithAngleForObject(void* player)
{
    if (!s_miSWA) return s_fnSWA;
    void* klass = nullptr;
    __try { klass = *reinterpret_cast<void**>(player); }
    __except (EXCEPTION_EXECUTE_HANDLER) { return s_fnSWA; }
    if (!klass) return s_fnSWA;
    if (klass == s_cachedKlass && s_cachedFn) return s_cachedFn;

    ShootWithAngleFn function = s_fnSWA;
    __try {
        const MethodInfo* method = il2cpp_object_get_virtual_method(
            reinterpret_cast<Il2CppObject*>(player), s_miSWA);
        if (method && method->methodPointer)
            function = reinterpret_cast<ShootWithAngleFn>(method->methodPointer);
    } __except (EXCEPTION_EXECUTE_HANDLER) { function = s_fnSWA; }

    s_cachedKlass = klass;
    s_cachedFn = function;
    return function;
}

ShootBindingReadiness::State Readiness()
{
    return {BootGate::FeatureAllowed("AutoFire"), s_swaResolved && s_fnSWA != nullptr, false};
}

}

namespace ShootRuntime {

bool EnsureResolved()
{
    if (!BootGate::FeatureAllowed("AutoFire")) return false;
    ResolveSWA();
    return IsFiringResolved();
}

bool IsFiringResolved() { return ShootBindingReadiness::CanFire(Readiness()); }
bool IsManualAngleResolved() { return ShootBindingReadiness::CanComputeManualAngle(Readiness()); }
bool IsResolved() { return IsFiringResolved(); }

bool TryComputeShootAngle(void*, uint8_t, float&, bool&)
{
    return false;
}

bool CallShootWithAngle(void* player, float angle)
{
    if (!IsFiringResolved() || !player || !std::isfinite(angle)) return false;
    ShootWithAngleFn function = ResolveShootWithAngleForObject(player);
    if (!function) return false;
    __try {
        function(player, angle, nullptr);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
    return true;
}

void Reset()
{
    s_swaResolved = false;
    s_fnSWA = nullptr;
    s_miSWA = nullptr;
    s_cachedKlass = nullptr;
    s_cachedFn = nullptr;
}

}
