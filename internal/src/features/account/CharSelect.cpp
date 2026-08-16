#include "pch-il2cpp.h"
#include "CharSelect.h"
#include "Il2CppResolver.h"
#include "platform/hooks/Il2CppHook.h"
#include "DbgFileLog.h"

#include <atomic>
#include <windows.h>

namespace CharSelect {
namespace {

using CtorFn = void(__fastcall*)(void* __this, void* methodInfo);

std::atomic<void*> s_panelPtr      { nullptr };
CtorFn             s_origCtor      = nullptr;
CtorFn             s_origHide      = nullptr;
bool               s_resolved      = false;
bool               s_hooksInstalled = false;

void __fastcall HookedCtor(void* __this, void* methodInfo)
{
    if (s_origCtor) s_origCtor(__this, methodInfo);
    s_panelPtr.store(__this, std::memory_order_release);
    DBG_FILE_LOG("[charselect] CharacterSelectionPanel ctor — panel=" << __this);
}

void __fastcall HookedHide(void* __this, void* methodInfo)
{
    if (s_origHide) s_origHide(__this, methodInfo);
    // Only clear the cached ptr if this Hide is on OUR captured panel —
    // multiple panels can exist over a session (re-shown after enter-
    // realm), so just match by pointer.
    if (s_panelPtr.load(std::memory_order_acquire) == __this) {
        s_panelPtr.store(nullptr, std::memory_order_release);
        DBG_FILE_LOG("[charselect] CharacterSelectionPanel hide — panel=" << __this);
    }
}

void ResolveOnce()
{
    if (s_resolved) return;
    Resolver::Protection::safe_call([&]() {
        Il2CppClass* cls = Resolver::FindClassLoose("BHDDFAELFIL");   // CharacterSelectionPanel
        if (!cls) return;

        // Hook constructor for capture.
        if (!s_hooksInstalled) {
            const MethodInfo* ctor = il2cpp_class_get_method_from_name(cls, ".ctor", 0);
            const MethodInfo* hide = il2cpp_class_get_method_from_name(cls, "Hide", 0);
            if (ctor && ctor->methodPointer) {
                void* t = reinterpret_cast<void*>(ctor->methodPointer);
                if (Il2CppHook::InstallMinHook(t, reinterpret_cast<void*>(&HookedCtor),
                                               reinterpret_cast<void**>(&s_origCtor),
                                               "charselect.ctor")) {
                    s_hooksInstalled = true;
                }
            }
            if (s_hooksInstalled && hide && hide->methodPointer) {
                void* th = reinterpret_cast<void*>(hide->methodPointer);
                Il2CppHook::InstallMinHook(th, reinterpret_cast<void*>(&HookedHide),
                                           reinterpret_cast<void**>(&s_origHide),
                                           "charselect.Hide");
            }
        }
    });
    if (s_hooksInstalled) s_resolved = true;
}

} // namespace

void Tick()
{
    ResolveOnce();
}

bool IsPanelVisible()
{
    return s_panelPtr.load(std::memory_order_acquire) != nullptr;
}

void* GetPanelPtr()
{
    return s_panelPtr.load(std::memory_order_acquire);
}

void RequestSelectSlot(int /*slotIndex*/)
{
    // TODO when CurrentCharacterSlot accessor is identified:
    //   1. Read the panel's character-slot collection (the
    //      ICollection_1_OPGNFGEANDG_ argument in JAOIKPIOALF
    //      suggests a parameterized slot list is held internally).
    //   2. Find the slot at `slotIndex` (or skip the slot matching
    //      the player's current character).
    //   3. Call CharacterSelectionPanel_NJOBNAEOALD(panel, slot, true)
    //      to trigger the same code path as a UI click.
    DBG_FILE_LOG("[charselect] RequestSelectSlot called — TODO: identify CurrentCharacterSlot accessor on panel");
}

} // namespace CharSelect
