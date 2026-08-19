#include "pch-il2cpp.h"
#include "RuntimeOffsets.h"
#include "GameState.h"
#include "Il2CppResolver.h"
#include "Il2CppHook.h"
#include "core/runtime/MemRead.h"
#include <mutex>
#include <cstdio>
#include <cstring>
#include "FloatingTextService.h"

namespace {
    std::mutex s_pluginFloatingTextMutex;
    char s_pluginFloatingText[128] = {};
    bool s_pluginFloatingTextPending = false;

    struct UnityNullableColor32Abi {
        bool hasValue;
        uint8_t padding[3];
        uint32_t rgba;
    };

    static_assert(sizeof(UnityNullableColor32Abi) == 8, "Nullable<Color32> ABI must be 8 bytes");
    constexpr uint32_t PackColor32(uint8_t r, uint8_t g, uint8_t b, uint8_t a = 255) { return uint32_t(r) | (uint32_t(g) << 8) | (uint32_t(b) << 16) | (uint32_t(a) << 24); }
}

void FloatingTextService::QueuePluginText(const char* text)
{
    std::lock_guard<std::mutex> lk(s_pluginFloatingTextMutex);
    strncpy_s(s_pluginFloatingText, sizeof(s_pluginFloatingText), text ? text : "", _TRUNCATE);
    s_pluginFloatingTextPending = true;
}

void FloatingTextService::ApplyPendingPluginText()
{
    char raw[128] = {};
    {
        std::lock_guard<std::mutex> lk(s_pluginFloatingTextMutex);
        if (!s_pluginFloatingTextPending) return;
        strncpy_s(raw, sizeof(raw), s_pluginFloatingText, _TRUNCATE);
    }

    // Optional trailing "|#RRGGBB" picks the colour explicitly (noclip's
    // socket-hold countdown ramps green -> red). Without it the old
    // green / red-on-"Disabled" default stands. `raw` stays intact for the
    // pending-flag compare below; `text` is what the game gets shown.
    char text[128] = {};
    strncpy_s(text, sizeof(text), raw, _TRUNCATE);
    uint32_t forcedRgba = 0;
    if (char* tag = strstr(text, "|#"); tag && strlen(tag) == 8) {
        unsigned r = 0, g = 0, b = 0;
        if (sscanf_s(tag + 2, "%2x%2x%2x", &r, &g, &b) == 3) {
            forcedRgba = PackColor32(uint8_t(r), uint8_t(g), uint8_t(b));
            *tag = '\0';
        }
    }

    Il2CppClass* klass = Resolver::FindClassLoose("MapObjectUIManager");
    const MethodInfo* mi = Il2CppHook::ResolveMethodCached("MapObjectUIManager", "ShowFloatingText", 6);
    app::MapObjectUIManager* localMgr = nullptr;
    void* local = GameState::GetLocalPtr();

    Resolver::Protection::safe_call([&]() {
        auto* localView = static_cast<app::ViewHandler*>(Mem::ReadPtr(local, RuntimeOffsets::KJ_ViewHandler));
        if (localView) localMgr = localView->fields.GUIManager;
    });

    void* receiver = localMgr;
    if (!receiver && klass) { auto objs = Resolver::FindObjectsByType(klass); if (!objs.empty()) receiver = objs[0]; }
    if (!receiver || !mi || !mi->methodPointer) return;

    using Fn = void(*)(void*, app::DGKAANOAENH__Enum, app::String*, UnityNullableColor32Abi, float, float, float, const MethodInfo*);
    auto showFloatingText = reinterpret_cast<Fn>(mi->methodPointer);
    const bool off = strstr(text, "Disabled") != nullptr;

    UnityNullableColor32Abi col{};
    col.hasValue = true;
    col.rgba = forcedRgba ? forcedRgba : (off ? PackColor32(255, 0, 25) : PackColor32(32, 220, 0));

    static void* s_primedReceiver = nullptr;
    if (s_primedReceiver != receiver) {
        app::String* emptyText = reinterpret_cast<app::String*>(il2cpp_string_new(""));
        const bool primeOk = Resolver::Protection::safe_call([&]() { for (int i = 0; i < 12; ++i) showFloatingText(receiver, app::DGKAANOAENH__Enum::Xp, emptyText, col, 0.f, 0.f, 0.f, mi); });
        if (primeOk) s_primedReceiver = receiver;
        return;
    }

    app::String* ilText = reinterpret_cast<app::String*>(il2cpp_string_new(text));
    const bool ok = Resolver::Protection::safe_call([&]() { showFloatingText(receiver, app::DGKAANOAENH__Enum::Xp, ilText, col, 0.f, 0.f, 0.f, mi); });
    if (ok) {
        std::lock_guard<std::mutex> lk(s_pluginFloatingTextMutex);
        if (strcmp(s_pluginFloatingText, raw) == 0) s_pluginFloatingTextPending = false;
    }
}
