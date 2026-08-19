#pragma once

#include <cstdint>

// AutoAbility — minimal "auto-press the ability key" feature.
//
// Calls EquipmentManager.UseInventoryItemByHotkey(slot=1) on a fixed
// cooldown whenever the player has enough MP. Hotkey 1 is the ability
// slot under default RotMG bindings; configurable for users who've
// rebound. Intentionally NOT per-class smart — just rate-limited
// "always cast when you can." The class-specific aiming / target-
// selection xrDriver does (Wizard targets boss, Priest targets self,
// Bard arc-aims, etc.) is a separate phase-2 enhancement that needs
// real reverse-engineering work per class.
//
// Shares the EquipmentManager plumbing with the autopot path inside
// FeatAutoNexus — both route through Game::ItemUse
// (game/actions/ItemUse.h), which owns method resolution and the
// player→EquipmentManager pointer read.
namespace AutoAbility {

void Tick();

bool IsEnabled();

void SetEnabled(bool on);
void SetMpThresholdPct(float pct);   // 1..99, default 50 — only fire when MP% > this
void SetCooldownMs(int ms);          // 100..2000, default 250 — min interval between fires
void SetHotkey(int hotkey);          // 0..15, default 1 (standard ability slot)

// ── Per-class targeting (xrDriver-style) ────────────────────────────────
// When TargetingEnabled is on, the module routes through
// EquipmentManager.UseInventoryItem (which takes a target Vector2) instead
// of UseInventoryItemByHotkey. The target picks based on TargetMode:
//   0 = AimAtEnemy  — use AutoAim's current target (best for Wizard,
//                     Sorcerer, Necromancer, Mystic, Trickster — abilities
//                     that throw at a point)
//   1 = Self        — use the player's own position (best for Priest,
//                     Bard, Paladin — abilities that buff in a radius
//                     around the caster)
// Off by default — falls back to plain hotkey press.
void SetTargetingEnabled(bool on);
bool GetTargetingEnabled();
void SetTargetMode(int mode);        // 0..1; default 0 (AimAtEnemy)
int  GetTargetMode();

} // namespace AutoAbility
