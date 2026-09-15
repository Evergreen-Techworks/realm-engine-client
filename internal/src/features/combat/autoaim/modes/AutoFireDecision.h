#pragma once
// AutoFireDecision — when native AutoFire pulls the trigger. Pure: AutoFire.cpp
// hands the live game in through a World adapter, and the host suite hands in a
// fake one (internal/tests/autofire_decision_tests.cpp).
//
// Two ways to fire:
//
//   Manual  The bound hotkey (only while the game window has focus, never while
//           the menu is open) or auto-break-walls' programmatic engage. Render
//           thread, rule unchanged (ManualEngaged below).
//
//   Script  A script's autoFireEnabled (the farmer's combat.setAutoFire). No
//           hotkey: it fires by itself from the game-update thread, but only
//           while EVERY condition in ScriptStep holds. The trigger is the game's
//           own ShootWithAngle, whose attack-period timer, weapon check and
//           condition checks set the cadence.
//
// No cursor fallback. The World interface has no cursor in it: the shot is aimed
// at the target's position in the enemy snapshot, and with no target nothing is
// fired. (AimHooks' ShootWithAngle detour still redirects the angle to the live
// aim source, which is the same target with lead, or KillAura's pick if KillAura
// is armed. Either is a real enemy. If the source vanishes in between, the
// snapshot angle stands.)
//
// World, as ScriptStep uses it:
//   bool      ScriptArmed() const;        script autoFireEnabled (and the master switch) on
//   bool      ManualEngaged() const;      the manual path owns the trigger right now
//   bool      ShootReady() const;         BootGate allows AutoFire and the firing method is verified
//   uintptr_t LocalPlayer() const;        local player object, 0 = not in a world
//   uint32_t  SceneEpoch() const;         bumped on every new map connection
//   bool      LocalHp(int32_t&) const;    false = unreadable
//   bool      PlayerPos(float&, float&) const;
//   AimTarget Aim() const;                Auto Aim's current pick
//   EnemyView FindEnemy(int32_t id) const;  this thread's enemy snapshot
//   float     RangeTiles() const;         Auto Aim's selection radius
//   bool      Fire(float px, float py, float tx, float ty);  one ShootWithAngle toward (tx,ty)
#include <cmath>
#include <cstdint>

namespace AutoFireDecision {

// How long firing stays off after the map changes. Long enough for Auto Aim and
// the enemy snapshot to rebuild from the new world (both run at ~125 Hz), so an
// id carried over from the old map is never shot at in the new one.
inline constexpr uint64_t kMapSettleMs = 500;

enum class Block : uint8_t {
    None = 0,       // fired
    NotArmed,       // no script autoFireEnabled
    Manual,         // hotkey / auto-break-walls owns the trigger
    NotReady,       // BootGate refused or the shoot methods are not bound
    NoLocal,        // not in a world
    MapSettling,    // the map changed less than kMapSettleMs ago
    Dead,           // local HP <= 0, or unreadable
    AimOff,         // Auto Aim's master toggle is off
    NoTarget,       // Auto Aim has no target
    NoPosition,     // local position unreadable or not finite
    NotInSnapshot,  // Auto Aim's id is not in the enemy snapshot (killed, despawned, filtered)
    TargetDead,     // snapshot HP <= 0
    OutOfRange,     // farther than Auto Aim's selection radius, or a non-finite distance
    FireFailed,     // the shoot call faulted or is unbound
};

inline const char* Name(Block b)
{
    switch (b) {
    case Block::None:          return "firing";
    case Block::NotArmed:      return "not-armed";
    case Block::Manual:        return "manual";
    case Block::NotReady:      return "not-ready";
    case Block::NoLocal:       return "no-local";
    case Block::MapSettling:   return "map-settling";
    case Block::Dead:          return "dead";
    case Block::AimOff:        return "aim-off";
    case Block::NoTarget:      return "no-target";
    case Block::NoPosition:    return "no-position";
    case Block::NotInSnapshot: return "not-in-snapshot";
    case Block::TargetDead:    return "target-dead";
    case Block::OutOfRange:    return "out-of-range";
    case Block::FireFailed:    return "fire-failed";
    }
    return "?";
}

struct AimTarget {
    bool    aimEnabled = false;   // Auto Aim master toggle
    bool    hasTarget  = false;   // Auto Aim's last selection found a target
    int32_t enemyId    = 0;       // that target's object id, 0 = none
};

struct EnemyView {
    bool    found = false;
    int32_t hp    = 0;
    float   x = 0.f, y = 0.f;
};

// The manual trigger, exactly as AutoFire::Tick has always computed it:
// auto-break-walls' engage always counts; the hotkey counts unless the menu is
// open (a keystroke typed into the menu must not fire). hotkeyDown already
// includes "a key is bound" and "the game window has focus".
inline bool ManualEngaged(bool autoEngaged, bool hotkeyDown, bool menuOpen)
{
    if (autoEngaged) return true;
    return hotkeyDown && !menuOpen;
}

// Map-change detector. The game builds a new local player object for every map,
// and the client reports every new map connection (SceneEpoch). Either restarts
// the settle window. Passing through "no local player" and back to the same
// object is not a change. The first sighting counts as one.
struct MapWatch {
    uintptr_t lastLocal = 0;
    uint32_t  lastEpoch = 0;
    uint64_t  changedAtMs = 0;
    bool      primed = false;

    void Observe(uintptr_t local, uint32_t epoch, uint64_t nowMs)
    {
        bool changed = false;
        if (!primed || epoch != lastEpoch) {
            changed = primed;   // an epoch at priming is the baseline, not a change
            primed = true;
            lastEpoch = epoch;
        }
        if (local != 0 && local != lastLocal) {
            lastLocal = local;
            changed = true;
        }
        if (changed) changedAtMs = nowMs;
    }

    bool Settled(uint64_t nowMs) const
    {
        return primed && lastLocal != 0 && nowMs - changedAtMs >= kMapSettleMs;
    }
};

// One game update of the script trigger. Returns Block::None when it fired.
// The map watch observes every update, armed or not.
template <class World>
Block ScriptStep(MapWatch& watch, World& world, uint64_t nowMs)
{
    const uintptr_t local = world.LocalPlayer();
    watch.Observe(local, world.SceneEpoch(), nowMs);

    if (!world.ScriptArmed())   return Block::NotArmed;
    if (world.ManualEngaged())  return Block::Manual;
    if (!world.ShootReady())    return Block::NotReady;
    if (local == 0)             return Block::NoLocal;
    if (!watch.Settled(nowMs))  return Block::MapSettling;

    int32_t hp = 0;
    if (!world.LocalHp(hp) || hp <= 0) return Block::Dead;

    const AimTarget aim = world.Aim();
    if (!aim.aimEnabled)                     return Block::AimOff;
    if (!aim.hasTarget || aim.enemyId <= 0)  return Block::NoTarget;

    float px = 0.f, py = 0.f;
    if (!world.PlayerPos(px, py) || !std::isfinite(px) || !std::isfinite(py))
        return Block::NoPosition;

    const EnemyView enemy = world.FindEnemy(aim.enemyId);
    if (!enemy.found)    return Block::NotInSnapshot;
    if (enemy.hp <= 0)   return Block::TargetDead;

    const float dx = enemy.x - px, dy = enemy.y - py;
    const float dist = std::sqrt(dx * dx + dy * dy);
    const float range = world.RangeTiles();
    // Written so a NaN distance or range fails closed.
    if (!(dist <= range)) return Block::OutOfRange;

    return world.Fire(px, py, enemy.x, enemy.y) ? Block::None : Block::FireFailed;
}

} // namespace AutoFireDecision
