#pragma once

#include <cstdint>

// MinHook detours for the verified firing path and existing packet-facing update.
// Install() resolves IL2CPP method pointers and creates hooks; safe to call
// every tick until it succeeds (self-guards with installed flag).
//
// The redirect is ANGLE-ONLY. The bullet leaves the player's REAL position and
// only its direction is changed, so the server's own simulation of the shot
// agrees with the client's claim. Nothing here rewrites a shot-packet field:
// ShootWithAngleDetour rewrites the angle argument by value. No unverified
// manual-angle routine is hooked.
namespace AimHooks {

bool Install();
void Uninstall();
bool IsInstalled();

// ── Aim source ────────────────────────────────────────────────────────────────
// AutoAim's own pick (SetTarget) redirects the shot angle while AutoAim is on;
// with no target the game's own angle stands. Killaura does not use this: it
// edits each projectile and its PlayerShoot after the game has fired it
// (ShotTransaction.h).
//
// Written from the render thread and read from the game thread.

// Called by the AutoAim coordinator each tick before hooks may fire.
void SetTarget(bool hasTarget, float x, float y);

// Weapon-specific angle tweaks
void SetReverseCultStaff(bool v);
void SetOffsetColossusSword(bool v);

// The shot angle from (px,py) toward (tx,ty), with the weapon tweaks above: the
// same formula the detours redirect with. Any thread.
float ShotAngleTo(float px, float py, float tx, float ty);

} // namespace AimHooks
