#pragma once

#include <cstdint>

// MinHook detours for the three game methods involved in shot angle redirection.
// Install() resolves IL2CPP method pointers and creates hooks; safe to call
// every tick until it succeeds (self-guards with installed flag).
//
// The redirect is ANGLE-ONLY. The bullet leaves the player's REAL position and
// only its direction is changed, so the server's own simulation of the shot
// agrees with the client's claim. Nothing here rewrites a shot-packet field:
// ComputeShootAngleDetour sets the angle through the method's out-parameter and
// ShootWithAngleDetour rewrites the angle argument by value.
namespace AimHooks {

bool Install();
void Uninstall();
bool IsInstalled();

// ── Aim sources and their precedence ──────────────────────────────────────────
// Two INDEPENDENT slots, resolved at redirect time inside the detours:
//
//   1. KillAura override (SetKillAuraOverride) — wins whenever it is active,
//      including when AutoAim's master toggle is off. KillAura has already
//      picked and committed a target (with its own stickiness/retention), so
//      once it is armed there is nothing to arbitrate.
//   2. AutoAim's own pick (SetTarget).
//   3. Neither — no redirect at all; the game's own angle stands.
//
// Because the slots are independent, clearing the override drops straight back
// to AutoAim's live pick: AutoAim keeps writing slot 2 every tick, so no stale
// target can survive a killaura disarm.
//
// Both are written from the render thread and read from the game thread.

// Called by the AutoAim coordinator each tick before hooks may fire.
void SetTarget(bool hasTarget, float x, float y);

// Called (via AutoAim::SetKillAuraAimOverride, the single entry point) by
// KillAura on every state commit. enemyId is used for the trace log only.
void SetKillAuraOverride(bool active, float x, float y, int32_t enemyId);

// Weapon-specific angle tweaks
void SetReverseCultStaff(bool v);
void SetOffsetColossusSword(bool v);

} // namespace AimHooks
