#pragma once
#include <cstdint>

// Live-pool reconcile policy, shared by the runtime store and the host-side
// regression tests.
//
// The store tracks shots the spawn hook recorded; the game deletes a shot early
// when it hits a wall, an enemy or the player. Reconcile compares the tracked
// slots against a walk of the game's live projectile pools and retires the ones
// the game no longer has, so their lanes stop painting danger that is not there.
//
// TWO FAILURE MODES, PULLING OPPOSITE WAYS:
//   • Retire too slowly and a despawned volley leaves GHOST LANES. Those lanes
//     are indistinguishable from live shots to the solver, so they fence the
//     player in and the dodge refuses cells that are actually safe.
//   • Retire too eagerly and an INCOMPLETE pool read (observed live: a walk that
//     returned 1 entry while a boss was firing dozens) drops LIVE shots from the
//     danger map. The dodge then walks into a shot it can no longer see.
//
// The old policy answered the second by capping retirements per pass (and by
// refusing an empty read). That bounded the damage of a bad read but made the
// first failure mode proportional to volley size: 40 dead lanes at 4 per 75 ms
// reconcile lingered for ~750 ms.
//
// This policy answers both with EVIDENCE instead of a quota: a shot is retired
// only after it is absent from `kMissesBeforeRetire` CONSECUTIVE successful
// reads. One incomplete read cannot retire anything, because the next read sees
// the live shot again and clears its streak — and the streak is per shot, so a
// genuinely despawned volley retires together on the second pass (~150 ms) no
// matter how large it is. The caller must only invoke this for a read it
// verified succeeded; a failed read is not evidence of absence and must skip
// reconciliation entirely rather than being passed in as "not present".
namespace ProjectileRetirePolicy {

// Consecutive successful reads a tracked shot must be missing from before it is
// retired. Two is the smallest value that survives a single incomplete read.
inline constexpr int kMissesBeforeRetire = 2;

enum class Action { Keep, Retire };

// `present`    — the verified live-pool read contained this slot's instance.
// `ageMs`      — how long this slot has been tracked.
// `minAgeMs`   — grace for a fresh spawn the pool read may not list yet.
// `missStreak` — per-slot state, updated in place; reset whenever the shot is seen.
inline Action Reconcile(bool present, float ageMs, float minAgeMs, uint8_t& missStreak)
{
    if (present) { missStreak = 0; return Action::Keep; }
    // Too young to judge: a just-spawned shot legitimately may not be in the read
    // yet, so it accrues NO miss streak (an old absence must not be inherited).
    if (!(ageMs >= minAgeMs)) return Action::Keep;
    if (missStreak < 255) ++missStreak;
    return missStreak >= kMissesBeforeRetire ? Action::Retire : Action::Keep;
}

} // namespace ProjectileRetirePolicy
