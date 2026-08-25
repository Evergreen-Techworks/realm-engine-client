#pragma once

#include "features/combat/autoaim/core/TargetSelector.h"
#include "features/combat/autoaim/core/WeaponProfile.h"
#include <cstdint>

// AutoAim coordinator — public API consumed by FeatAutoAim UI and other features.
// All heavy logic lives in EnemyTracker, TargetSelector, WeaponCalibrator, and AimHooks.
namespace AutoAim {

void Install();
void Uninstall();

// Called from D3D Present each frame (~8ms throttle).
void Tick();

// ── Master toggle ─────────────────────────────────────────────────────────────
void SetEnabled(bool on);
bool IsEnabled();

// ── Aim mode ──────────────────────────────────────────────────────────────────
void SetAimMode(TargetSelector::Mode mode);
TargetSelector::Mode GetAimMode();

// Lock onto a specific enemy by object ID (sets mode to Locked).
// Pass -1 or call SetAimMode to clear the lock.
void SetLockTarget(int32_t enemyId);

// ── KillAura aim handoff ──────────────────────────────────────────────────────
// KillAura publishes its committed target here so the SHOT ANGLE points at it —
// ordinary aiming, no displaced origin, so the server's own simulation of the
// shot agrees with the client's damage claim.
//
// PRECEDENCE (implemented in AimHooks, which owns the two slots):
//   while killaura is ARMED its pick WINS over AutoAim's own target, and it
//   wins even when AutoAim's master toggle is off. Killaura has already made a
//   committed choice — its own selection stickiness and retention hysteresis
//   ran — so there is nothing left for AutoAim to arbitrate, and letting the
//   two alternate at ~125 Hz is precisely the flip-flop that stickiness exists
//   to prevent.
//
// Nothing is parked or restored on disarm: the slots are independent and
// AutoAim keeps writing its own every tick, so clearing the override falls
// straight back to AutoAim's LIVE pick (or to no redirect at all when AutoAim
// has no target). A stale target cannot survive a disarm.
//
// AutoAim is the aim coordinator and the only module that talks to AimHooks;
// KillAura::Tick is the only caller of this.
void SetKillAuraAimOverride(bool active, float x, float y, int32_t enemyId);

// ── Targeting filters ─────────────────────────────────────────────────────────
void SetShootInvulnerable(bool on);
bool IsShootInvulnerable();

void SetPrioritizeBosses(bool on);
bool IsPrioritizeBosses();

void SetIgnoreWalls(bool on);
bool IsIgnoreWalls();

void SetShootWhileStealthed(bool on);
bool IsShootWhileStealthed();

// Phase skip list: object types to exclude from all tiers regardless of invulnerability.
// Pointer is borrowed; caller must keep it alive (static storage recommended).
void SetPhaseSkipTypes(const int32_t* types, int count);

// ── Mouse / range ─────────────────────────────────────────────────────────────
void  SetMouseBoundingEnabled(bool on);
bool  IsMouseBoundingEnabled();
void  SetMouseBoundingRange(float tiles);
float GetMouseBoundingRange();

void  SetRangeLeadBias(float tiles);
float GetRangeLeadBias();

// ── Weapon-specific tweaks ────────────────────────────────────────────────────
void SetReverseCultStaff(bool on);
bool IsReverseCultStaff();

void SetOffsetColossusSword(bool on);
bool IsOffsetColossusSword();

// ── State queries ─────────────────────────────────────────────────────────────
bool    HasTarget();
void    GetAimTarget(float& outX, float& outY);
int32_t GetAimFocusEnemyId();

const WeaponProfile& GetWeaponProfile();

// ── Projectile spawn callback ─────────────────────────────────────────────────
// SpawnProjectile path: call for local non-ability shots to calibrate weapon range.
void OnLocalPlayerProjectileSpawn(void* projProps, bool isAbility,
                                  int32_t attackerObjId, uint32_t ownerObjId);

// ── Shared enemy enumeration (delegates to EnemyTracker) ──────────────────────
// Used by auto-dodge to read live enemy positions. Triggers a (self-throttled)
// EnemyTracker refresh, so it returns fresh data even when auto-aim is disabled.
using EnemyScanCallback = void(*)(float x, float y, int32_t id, void* user);
void EnumerateLiveEnemies(EnemyScanCallback cb, void* user);

// ── Compatibility aliases for existing callers ────────────────────────────────
// AimMode alias so FeatureRuntime etc. don't need updating.
using AimMode = TargetSelector::Mode;

// Proj-stat wrappers used by ZDodge and DangerPlanner.
inline float GetProjRangeTiles()   { return GetWeaponProfile().rangeTiles; }
inline bool  IsProjRangeResolved() { return GetWeaponProfile().isResolved; }

} // namespace AutoAim
