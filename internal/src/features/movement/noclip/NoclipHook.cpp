#include "pch-il2cpp.h"
#include "NoclipHook.h"
#include "Noclip.h"
#include "Il2CppResolver.h"
#include "Il2CppHook.h"
#include "MemRead.h"
#include "minhook/MinHook.h"

#include <Windows.h>
#include <cstdint>

namespace {

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

static decltype(app::HJMBOMEHGDJ_PEGDEDNHEHD) s_origPegdednhehd = nullptr;
static decltype(app::HJMBOMEHGDJ_LHGGJIAKLMJ) s_origLhggjiaklmj = nullptr;

static bool s_resolved = false;
static bool s_installed = false;
static void* s_pegTarget = nullptr;
static void* s_lhgTarget = nullptr;

static bool dHJMBOMEHGDJ_PEGDEDNHEHD(app::HJMBOMEHGDJ* self, float x, float y, MethodInfo* method)
{
    if (Noclip::ShouldBypassWalkable())
        return true;
    return s_origPegdednhehd ? s_origPegdednhehd(self, x, y, method) : false;
}

static bool dHJMBOMEHGDJ_LHGGJIAKLMJ(app::HJMBOMEHGDJ* self, float x, float y, MethodInfo* method)
{
    if (Noclip::ShouldBypassWalkable())
        return true;
    return s_origLhggjiaklmj ? s_origLhggjiaklmj(self, x, y, method) : false;
}

static void ResolveTargets()
{
    if (s_resolved)
        return;
    if (!EnsureIl2CppThreadAttached())
        return;

    // ResolveMethod uses FindClassLoose (the BeeByte-rename-proof path the old
    // FindClassAny already preferred) then the argc-2 method pointer.
    s_pegTarget = Il2CppHook::ResolveMethod("HJMBOMEHGDJ", "PEGDEDNHEHD", 2, /*loose*/true);
    s_lhgTarget = Il2CppHook::ResolveMethod("HJMBOMEHGDJ", "LHGGJIAKLMJ", 2, /*loose*/true);

    s_resolved = Mem::AddrOk(s_pegTarget) && Mem::AddrOk(s_lhgTarget);
}

static bool EnsureMinHook()
{
    static bool mhInitialized = false;
    if (mhInitialized)
        return true;

    const MH_STATUS st = MH_Initialize();
    if (st != MH_OK && st != MH_ERROR_ALREADY_INITIALIZED)
        return false;

    mhInitialized = true;
    return true;
}

static void TryInstall()
{
    if (s_installed)
        return;

    ResolveTargets();
    if (!s_resolved || !EnsureMinHook())
        return;

    if (!Il2CppHook::InstallMinHook(s_pegTarget,
            reinterpret_cast<void*>(&dHJMBOMEHGDJ_PEGDEDNHEHD),
            reinterpret_cast<void**>(&s_origPegdednhehd), "Noclip:PEG")) {
        s_origPegdednhehd = nullptr;
        return;
    }

    if (!Il2CppHook::InstallMinHook(s_lhgTarget,
            reinterpret_cast<void*>(&dHJMBOMEHGDJ_LHGGJIAKLMJ),
            reinterpret_cast<void**>(&s_origLhggjiaklmj), "Noclip:LHG")) {
        // Roll back the first hook so we never leave PEG installed alone.
        MH_DisableHook(s_pegTarget);
        MH_RemoveHook(s_pegTarget);
        s_origPegdednhehd = nullptr;
        s_origLhggjiaklmj = nullptr;
        return;
    }

    s_installed = true;
}

} // namespace

namespace NoclipHook {

void Tick()
{
    TryInstall();
}

void Uninstall()
{
    if (!s_installed)
        return;

    if (s_lhgTarget) {
        MH_DisableHook(s_lhgTarget);
        MH_RemoveHook(s_lhgTarget);
        s_lhgTarget = nullptr;
    }
    if (s_pegTarget) {
        MH_DisableHook(s_pegTarget);
        MH_RemoveHook(s_pegTarget);
        s_pegTarget = nullptr;
    }

    s_origPegdednhehd = nullptr;
    s_origLhggjiaklmj = nullptr;
    s_installed = false;
}

bool IsInstalled()
{
    return s_installed;
}

bool IsResolved()
{
    ResolveTargets();
    return s_resolved;
}

} // namespace NoclipHook
