#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

// Enemy snapshot shared by the render thread (AutoAim, KillAura) and the
// game-update thread (uDodge, the enemy lock). Call Tick() (self-throttled to
// ~125 Hz) then consume via GetSnapshot / Enumerate ON THE SAME THREAD: each
// thread reads its own consistent copy, refreshed by its own Tick(). Velocity
// fields (vx, vy) are tiles/ms, blended from MoVelocity + chord estimation.
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

// All entries as of this thread's last Tick (no filtering). The reference, and
// pointers into it, stay valid until this thread calls Tick() again.
const std::vector<Entry>& GetSnapshot();

using Callback = void(*)(const Entry&, void* user);
void Enumerate(Callback cb, void* user);

// Object ID of the local player's world-dict entry, updated each Tick.
// More reliable than ProjectileTracking::GetLocalPlayerObjectId() which
// depends on WorldTAB having fired at least once.
int32_t GetLocalPlayerObjectId();

// Diagnostics: why one object id is or is not in the snapshot. Set a watched id
// (0 = none); every build then records the verdict for it. `reason` is
// EnemyClassify::Name — "kept" when it is in the snapshot. Any thread.
struct WatchVerdict {
    int32_t     id       = 0;       // the watched id this verdict describes
    bool        inWorld  = false;   // present in the world dictionary on that build
    const char* reason   = "not-in-world";
    int32_t     objType  = 0, hp = 0, maxHp = 0;
    float       x        = 0.f, y = 0.f;
    void*       objProps = nullptr; // ObjectProperties, for the type name (read under SEH)
};
void SetWatchedId(int32_t id);
WatchVerdict GetWatchVerdict();

// Object types the client's game data marks as hidden helpers (invisible texture,
// no animation, and no MaxHitPoints or Size <= 1 — GameDataLoader isHiddenHelper).
// The snapshot drops them, as Enemies.getAll does. The texture file is not held in
// ObjectProperties, so native cannot derive this itself. Feature command
// "enemyHiddenHelperTypes": decimal or 0x types separated by commas; "+..."
// appends, anything else replaces, "" clears. Any thread.
void SetHiddenHelperTypes(const char* message);

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
