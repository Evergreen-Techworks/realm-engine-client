#pragma once

#include <cstdint>

// MinHook detours for the three game methods involved in shot angle redirection.
// Install() resolves IL2CPP method pointers and creates hooks; safe to call
// every tick until it succeeds (self-guards with installed flag).
namespace AimHooks {

bool Install();
void Uninstall();
bool IsInstalled();

// Called by AutoAim coordinator each tick before hooks may fire.
void SetTarget(bool hasTarget, float x, float y);

// Weapon-specific angle tweaks
void SetReverseCultStaff(bool v);
void SetOffsetColossusSword(bool v);

} // namespace AimHooks
