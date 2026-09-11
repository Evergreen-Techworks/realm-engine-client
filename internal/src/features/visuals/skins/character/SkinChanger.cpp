#include "pch-il2cpp.h"
#include "SkinChanger.h"
#include "CosmeticOverrides.h"
#include "GameState.h"
#include "RuntimeOffsets.h"
#include "Il2CppResolver.h"

#include <Windows.h>
#include <atomic>
#include <cstdint>

// ─────────────────────────────────────────────────────────────────────────────
// SkinChanger — writes KJNHLADHEMH on the local player object to override skin.
//
// Uses il2cpp_field_set_value via RuntimeOffsets::FI_HP. The FI_HP name is a
// misnomer inherited from the offset table: il2cpp_field_set_value addresses the
// dump layout, while RuntimeOffsets::HP is that same field plus the ACTK +0x50
// runtime shift. The two therefore land on different memory, which is why this
// writes the skin without disturbing the HP that AutoNexus reads.
//
// Writes are triggered only when:
//   • The local player pointer changes (new map / realm entry)
//   • The override skin ID is changed
//   • Apply() is called explicitly from the UI
// ─────────────────────────────────────────────────────────────────────────────

namespace SkinChanger {

static std::atomic<bool>    s_enabled{ false };
static std::atomic<int32_t> s_skinId{ 0 };

static void*   s_lastAppliedPtr    = nullptr;
static int32_t s_lastAppliedSkinId = 0;
static bool    s_applied           = false;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Writes value to KJNHLADHEMH via IL2CPP API — FI_HP resolves that field.
static void WriteSkinField(void* obj, int32_t value)
{
    FieldInfo* fi = RuntimeOffsets::FI_HP;
    if (!fi) return;

    Resolver::Protection::safe_call([&]() {
        il2cpp_field_set_value(
            reinterpret_cast<Il2CppObject*>(obj), fi, &value);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

void SetOverride(bool enabled, int32_t skinId)
{
    s_skinId.store(skinId,   std::memory_order_relaxed);
    s_enabled.store(enabled, std::memory_order_relaxed);
    // Invalidate so Apply() triggers on next Tick().
    s_lastAppliedSkinId = skinId - 1;
    if (!enabled) {
        s_applied        = false;
        s_lastAppliedPtr = nullptr;
    }
}

bool    IsOverrideEnabled() { return s_enabled.load(std::memory_order_relaxed); }
int32_t GetOverrideSkinId() { return s_skinId.load(std::memory_order_relaxed); }
bool    IsApplied()         { return s_applied; }

void Apply()
{
    if (!s_enabled.load(std::memory_order_relaxed)) return;

    void* ptr = GameState::GetLocalPtr();
    if (!ptr) return;   // GameState will resolve it; we'll catch it next frame.

    const int32_t skin = s_skinId.load(std::memory_order_relaxed);
    WriteSkinField(ptr, skin);

    s_lastAppliedPtr    = ptr;
    s_lastAppliedSkinId = skin;
    s_applied           = true;

    // The HUD portrait is a cached sprite that otherwise only reloads on world
    // entry, so it would keep showing the previous skin until the next map.
    CosmeticOverrides::RequestCharacterIconRefresh();
}

void Tick()
{
    if (!s_enabled.load(std::memory_order_relaxed)) return;

    void*         ptr  = GameState::GetLocalPtr();
    const int32_t skin = s_skinId.load(std::memory_order_relaxed);

    if (ptr != s_lastAppliedPtr || skin != s_lastAppliedSkinId)
        Apply();
}

} // namespace SkinChanger
