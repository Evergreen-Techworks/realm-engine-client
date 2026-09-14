#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

// Shared, render-thread-only enemy snapshot. Call Tick() (self-throttled to
// ~125 Hz) then consume via GetSnapshot / Enumerate. Velocity fields (vx, vy)
// are tiles/ms, blended from MoVelocity + chord estimation.
namespace EnemyTracker {

struct Entry {
    int32_t id;
    int32_t objType;
    float   x, y;
    int32_t hp, maxHp;
    float   vx, vy;          // tiles/ms; 0 until first velocity sample
    bool    isInvulnerable;  // XML <Invincible/> flag
    bool    hasHealthBar;    // false for walls/destructibles (noHealthBar)
    bool    isScenery;       // static object with no projectile definitions
    float   shotRangeTiles;  // longest projectile reach of this TYPE (tiles); 0 = none / unreadable
    void*   ptr;             // raw entity pointer (for direct field reads)
};

// Rebuilds the snapshot from the world dictionary. Self-throttled, so any
// consumer may call it before reading and redundant calls within a frame are
// cheap no-ops.
void Tick();

// All entries from the last Tick (no filtering).
const std::vector<Entry>& GetSnapshot();

using Callback = void(*)(const Entry&, void* user);
void Enumerate(Callback cb, void* user);

// Object ID of the local player's world-dict entry, updated each Tick.
// More reliable than ProjectileTracking::GetLocalPlayerObjectId() which
// depends on WorldTAB having fired at least once.
int32_t GetLocalPlayerObjectId();

// Resolve the LIVE world position of ANY object by its dict key (object id) —
// including remote PLAYERS, which the enemy snapshot filters out. Walks the world
// Dictionary and reads PosX/PosY off the matching entity. Returns false if the id
// is not in view / the world manager is unreadable. Game-update thread only.
bool ResolveObjectPos(int32_t id, float& outX, float& outY);

// Diagnostics only (lock / aim target capture): one line describing the world
// object with this id — XML name, type, HP, condition words, the ObjectProperties
// flags the target filters read, position, and whether the enemy snapshot holds
// it. Walks the world dictionary, so call it on a change, never per frame.
// Game-update thread only. Always writes a NUL-terminated line into `out`.
void DescribeObject(int32_t id, char* out, size_t outCap);

} // namespace EnemyTracker
