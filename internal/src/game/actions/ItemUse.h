#pragma once

// ─────────────────────────────────────────────────────────────────────────────
// Game::ItemUse — the ONE home for invoking EquipmentManager item usage.
// Owns method resolution (cached via Il2CppHook::ResolveMethodCached) and the
// player→EquipmentManager pointer read (RuntimeOffsets::PlayerEquipMgr).
// Consumers: AutoAbility (ability fire), AutoNexus (auto-pot).
// Thread-safety: call from the render thread only (same rule the current
// per-feature copies follow — resolution is lazy, calls are safe_call-wrapped).
// ─────────────────────────────────────────────────────────────────────────────
namespace Game { namespace ItemUse {

    // Lazily resolves methods on first call; cheap afterwards. True when the
    // hotkey path is callable (method resolved AND local player + eq-mgr
    // pointer currently available).
    bool Ready();

    // EquipmentManager.UseInventoryItemByHotkey(eqMgr, hotkey).
    // Returns false (no-op) if not Ready().
    bool UseByHotkey(int hotkey);

    // True when the 6-arg targeted overload resolved (optional capability).
    bool TargetedAvailable();

    // EquipmentManager.UseInventoryItem(eqMgr, player, slot, 0, {x,y}, false, false).
    // Returns false (no-op) if the targeted overload is unavailable.
    bool UseTargeted(int slot, float x, float y);

}} // namespace Game::ItemUse
