#pragma once
#include <cstdint>

// ShotOriginHook — the ONE thing that actually moves our LOCAL bullet to the
// KillAura origin, so the client's own collision fires ENEMYHIT and the enemy
// takes damage.
//
// WHY THIS EXISTS AS A SEPARATE HOOK (the bug this file fixes):
// rewriting the shooter-relative startX/startY passed to the projectile SPAWN
// method (HBEAKBIHANL::KOBMINBDOBD) does NOT move the bullet. The game writes
// the projectile's ACTUAL position through a LATER entity setter
// (KJMONHENJEN::BDEBGEHBPCJ(float,float) — the base-class SetPosition every
// world object goes through), which overwrites whatever the spawn arguments
// said. KillAura therefore looked armed in the trace log while every shot still
// left the muzzle: armed != moved.
//
// MECHANISM: ProjectileTracking's spawn detour arms a ONE-SHOT override for the
// exact projectile instance the spawn funnel just returned; the SetPosition
// detour replaces x/y for that one instance, then clears the slot. The slot is
// also cleared on the first NON-matching call, so an override can never leak
// onto a later projectile or an unrelated entity.
//
// Coordinates are ABSOLUTE world tiles — the same space the setter takes and
// the same space KillAura::Input carries. Nothing is rebased.
//
// FAIL-CLOSED: the hook refuses to install unless exactly one method on the
// KJMONHENJEN class itself matches (name, 2 float params, bool return). A
// second class in this build (LKFFPGONEOB) carries the SAME obfuscated method
// name and the SAME signature at a different address, so a bare-name bind would
// corrupt unrelated objects.
namespace ShotOriginHook {

    // Resolve + install. Idempotent; safe to call every time ProjectileTracking
    // installs. Returns true when the detour is live. A resolution that is
    // ambiguous (or a class/method that does not match the expected signature)
    // is refused PERMANENTLY and logged once — see Stats::refused.
    bool Install();

    // Teardown (game thread / DLL unload path only).
    void Uninstall();

    bool IsInstalled();

    // Arm the one-shot override for `projectile` (the instance the spawn funnel
    // returned). `ownerObjId` is carried for the witness log only. `generation`
    // is the KillAura::Input generation the origin came from — carried so the
    // trace line can be compared against the generation the OUTBOUND rewrite
    // used (the [Killaura] diag line in the proxy log). No-op when the hook is
    // not installed, so a refused hook silently leaves shots alone.
    void ArmOneShot(void* projectile, int32_t ownerObjId, float absX, float absY,
                    uint32_t generation);

    // A local shot fired while killaura was enabled but no CURRENT authoritative
    // origin existed, so the shot was left vanilla. Counted (and witnessed) so
    // "killaura is on but nothing is being rewritten" is visible rather than
    // silent. See KillAura::GetAuthoritativeInput.
    void NoteStaleInput();

    // Read-only diagnostic (Combat tab). `rewrites` is the count that actually
    // matters: `arms` without `rewrites` means killaura is aiming but the bullet
    // is not being moved. `lastGeneration` is the generation of the most recent
    // arm — the local half of the local-vs-outbound generation comparison.
    struct Stats {
        bool     installed      = false;
        bool     refused        = false;
        uint32_t arms           = 0;
        uint32_t rewrites       = 0;
        uint32_t drops          = 0;
        uint32_t staleInputs    = 0;
        uint32_t lastGeneration = 0;
    };
    Stats GetStats();

} // namespace ShotOriginHook
