#pragma once

#include <cstdint>

namespace AutoAim {

// Numeric values match Multitool registry `AutoAimMode` / ExaltKitGUI.SettingsControl:
//   0 = closest to player, 1 = highest HP, 2 = closest to mouse.
enum class AimMode : int {
    ClosestToPlayer = 0,
    HighestHP       = 1,
    ClosestToMouse  = 2,
};

void Install();
void Uninstall();

// Called from D3D Present each frame (throttled ~8ms). Keeps world/dict reads off a background thread.
void Tick();

void SetEnabled(bool on);
bool IsEnabled();

void SetAimMode(AimMode mode);
AimMode GetAimMode();

// Multitool AutoAimShootInvulnerable / xrDriver targetInvulnerable. When true, invincible
// enemies become valid targets (but still deprioritised below non-invulnerable candidates).
void SetShootInvulnerable(bool on);
bool IsShootInvulnerable();

// Multitool AutoAimFocusBoss / PrioritizeBosses. When true, quest/boss objectTypes
// (kQuestObjectTypes) are prioritised as first-pass targets. If no boss is in range,
// normal enemies become valid targets instead of being skipped entirely.
void SetPrioritizeBosses(bool on);
bool IsPrioritizeBosses();

// xrDriver MouseBoundingEnabled + MouseBoundingRange (_DAT_18057a878 / _DAT_18057a874). Clamps
// ClosestToMouse-mode candidate distance to this radius around the mouse world position.
void  SetMouseBoundingEnabled(bool on);
bool  IsMouseBoundingEnabled();
void  SetMouseBoundingRange(float tiles);
float GetMouseBoundingRange();

// Multitool AutoAimRangeLead. Extra tiles added on top of computed weapon range when deciding
// whether a candidate is in aim range (starts facing/leading before shots can actually connect).
void  SetRangeLeadBias(float tiles);
float GetRangeLeadBias();

// Multitool AutoAimIgnoreWalls. When true (default), skip wall-like targets (ObjectProperties.noHealthBar).
void  SetIgnoreWalls(bool on);
bool  IsIgnoreWalls();

// Multitool AutoAimReverseCultStaff — add π to aim for Staff of Unholy Sacrifice shots (proj id 0xB0EB).
void  SetReverseCultStaff(bool on);
bool  IsReverseCultStaff();

// Multitool AutoAimOffsetColossusSword — reserved for Sword of the Colossus (proj id 0xB106); offset TBD.
void  SetOffsetColossusSword(bool on);
bool  IsOffsetColossusSword();

// Multitool AutoAimShootWhileStealthed. When false, auto-aim does not redirect while Invisible.
void  SetShootWhileStealthed(bool on);
bool  IsShootWhileStealthed();

// DIA4A SpawnProjectile path: local non-ability weapon shots update lead speed (projProps+0x160).
void OnLocalPlayerProjectileSpawn(void* projProps, bool isAbility, int32_t attackerObjId, uint32_t ownerObjId);

bool HasTarget();
void GetAimTarget(float& outX, float& outY);

// Object id of the enemy auto-aim picked this tick (0 if none). Used for light spell leading.
int32_t GetAimFocusEnemyId();
// Last sampled position + velocity from the aim velocity map; false if unknown.
// outVx/outVy are tiles per millisecond (matches Priest/Wizard spell lead: delta = v * ms).
bool TryGetEnemyAimLeadSample(int32_t objectId, float& outX, float& outY, float& outVx, float& outVy);

// Weapon stats read from projProps at last shot — updated by OnLocalPlayerProjectileSpawn.
float GetProjSpeedRaw();      // raw int as float (divide by 10000 for tiles/ms)
float GetProjLifetimeMs();    // normalized lifetime in ms
float GetProjRangeTiles();    // tiles = (speed/10000) * lifetime_ms
// True only once the passive refresh OR a fired shot has written a real
// weapon range. When false the `GetProjRangeTiles()` value is a placeholder
// default and callers should prefer their manual fallback range.
bool  IsProjRangeResolved();
// Diagnostics for the passive equipped-weapon range refresh.
void  GetWeaponRangeDiag(float& outRangeTiles, uint32_t& outAttempts,
                         uint32_t& outSuccesses, const char*& outLastError);

// Transient suspend (used by the planner during realm transitions to
// pause aim while stale entity pointers from the old world drain).
void SuspendForMs(uint64_t ms);
bool IsSuspended();

// When enabled, Tick() keeps per-enemy velocity (same data as auto-aim lead) even if aim is off.
void SetEnemyNextTickOverlay(bool on);
bool IsEnemyNextTickOverlay();

using EnemyVelCallback = void (*)(int32_t id, float x, float y, float vx, float vy, void* user);
void EnumerateEnemyVelocities(EnemyVelCallback cb, void* user);

// Live enemy world positions from the same world-dict scan as auto-aim (no auto-aim toggle required).
// Entity objectTypes listed in AutoAim.cpp (kIgnoredEnemyObjectTypes) are skipped — same filter as auto-aim.
using EnemyScanCallback = void (*)(float x, float y, int32_t id, void* user);
void EnumerateLiveEnemies(EnemyScanCallback cb, void* user);

} // namespace AutoAim
