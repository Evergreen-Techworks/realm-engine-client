#pragma once
#include <vector>
#include <cstdint>
#include "gui/tabs/WorldTAB.h"

// ─────────────────────────────────────────────────────────────────────────────
// AoeTracking — hooks the two AOE spawn paths to capture landing zones with
// world position, blast radius, and lifetime.
//
// Hook targets (resolved by class name + method name at runtime via IL2CPP):
//   GJJCEFJMNMK::KOBMINBDOBD  (4 params: Vector2 origin, Vector2 dest, Color, int dur)
//     Throwable entity init/setter. Real entity in allDict. isEnemy resolved via entity
//     dict position-match at the throw origin (deferred, runs in CopyActiveForDraw).
//     Runtime offsets: origin +0x368, dest +0x370, dur +0x388.
//
//   FHOHCELBPDO::KOBMINBDOBD  (5 params: int animIdx, Color, int durMs, Vector2 origin, Vector2 dest)
//     Catch-all fallback for throwable visuals not captured by the GJJ hook. Fires for
//     ALL throwables. Deduplicated against GJJ entries by dest position (0.1 tile tolerance).
//     isEnemy also resolved via entity dict position-match (same deferred mechanism).
//
//   FGOFPGIIEPC::KOBMINBDOBD  (3 params: LKHPPBEGNOM* anchor, CustomExplosionEntrance*, float dur)
//     Only fires for damaging throwables that detonate. Provides authoritative blast radius
//     from CustomExplosionEntrance+0x38 (~3.0 tiles). isEnemy from anchor (thrower character).
//
//   COEFCBBIBMC::JEFJDICFNBA  (1 param: BHFDLBOGHIB* reader)  RVA 0x004B6F60
//     ShowEffect packet's own Read(PacketReader) override — `self` IS the packet, so the
//     detour calls the original FIRST (fields only populate after Read returns). Catches
//     effect types 4=THROW, 5=NOVA, 23=CIRCLE_TELEGRAPH, 39=AoE. THROW entries are deduped
//     against GJJ/FHOH by dest position. isEnemy resolved via targetObjectId→dict key lookup
//     (FindEntityIsEnemyById). Falls back to deferred position-match in CopyActiveForDraw if
//     not yet in dict at hook time.
//     Replaces the WorldManager-side handler HJMBOMEHGDJ::CGBILOJJPEI, which a game patch
//     renamed out of existence — the class still resolved, so the hook failed silently and
//     no Throw/Nova/CircleTelegraph/AoE was ever recorded. The packet class kept its names.
//     The two packet positions are FFLIAABAAFP* (WorldPos) POINTERS, not inline Vector2s;
//     the hook refuses to install unless that class's x/y layout is structurally confirmed.
// ─────────────────────────────────────────────────────────────────────────────
namespace AoeTracking {

    void Install();
    /// Safe every frame: (re)tries IL2CPP resolution for any hook that is not yet installed.
    void EnsureInstalled();
    void Uninstall();

    // Copy active (unexpired) AOE zones into `out`.
    void CopyActiveForDraw(std::vector<WorldAoe>& out);

    // Returns total number of valid unexpired AOEs (for diagnostics).
    int  CountActive();

    // How many native spawn hooks are active (effect paths + explosion path).
    int  CountHooks();

    // ── Per-source arming semantics (ONE definition, all consumers) ──────────
    // Every consumer of WorldAoe has to answer the same two questions — "when
    // does this zone start doing damage?" and "how long does it last?" — and the
    // answer is a property of the CAPTURE PATH, not of the consumer. It lived
    // inline in four places and three of them read `arcMs` as a landing delay,
    // which is flatly wrong for kAoeSrcExpl (see ArmedOnCapture in the .cpp).
    // Anything that needs a landing time MUST call LandDelayMs, never read
    // `arcMs` directly.

    /// True when the zone is full-strength damage from the MOMENT it was
    /// captured — no flight / telegraph phase to wait out.
    bool  ArmedOnCapture(const WorldAoe& a);

    /// Zone duration (ms from spawnTick), with the shared 2000 ms fallback for an
    /// unreadable/absurd lifetime.
    float LifetimeMs(const WorldAoe& a);

    /// Ms after spawnTick at which the zone starts doing damage: 0 for an
    /// armed-on-capture zone, the telegraphed flight time otherwise.
    float LandDelayMs(const WorldAoe& a);
}
