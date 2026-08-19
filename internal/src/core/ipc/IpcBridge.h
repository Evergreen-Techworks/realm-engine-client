// Purpose: public DLL-side IPC bridge contract used by hooks, features, and UI
// code that need named-pipe state without depending on the bridge internals.

// Helpful notes:
// - IpcBridgeThread runs the pipe client loop and owns IPC session lifetime.
// - Tile APIs expose the latest tileUpdate/noWalkInit state from the client.
// - Feature state is owned by FeatureState; IpcBridge owns only overlay,
//   shutdown, tile, threat, and auth state.

#pragma once
#include <Windows.h>
#include <cstdint>

// Named pipe IPC bridge between the injected DLL and the Node client.
// Pipe-delivered feature state is authoritative for unified controls.

DWORD WINAPI IpcBridgeThread(LPVOID lpParam);

// Signal the bridge thread before detour teardown.
void IpcBridge_RequestShutdown();

// Queue a signed ghost-hit event for the pipe thread.
void IpcBridge_EmitPredictedHit(int ownerObjId, int bulletId);

// ── AutoNexus threat list ────────────────────────────────────────────────
struct IpcThreat {
    int32_t attackerObjId;
    int32_t bulletId;
    float   tHitMs;                 // ms from the scan instant to impact
    int32_t fallbackDamage;         // raw projectile max damage
    uint8_t fallbackArmorPiercing;  // 0/1
};

constexpr int kIpcMaxGroundEvents = 12;

struct IpcGroundEvent {
    int32_t rawDamage = 0;
    float   tHitMs    = -1.f;
};

struct IpcGround {
    int32_t rawDamage = 0;
    float   tHitMs    = -1.f;

    int32_t count = 0;
    IpcGroundEvent events[kIpcMaxGroundEvents] = {};
};

constexpr int kIpcMaxThreats = 32;

// `truncated` — the publisher had to shed threats/ground events this tick, so
// the client's picture is known-partial (see plan 19). Threaded into the wire
// payload's trailing flag by EncodeThreats.
void IpcBridge_PublishThreats(const IpcThreat* threats, int count, const IpcGround& ground, bool truncated);

// Tile walkability from tileUpdate / noWalkInit packets. Unknown means walkable.
bool IpcBridge_IsTileWalkable(float worldX, float worldY);

// Tile diagnostics.
void IpcBridge_GetTileStats(int* outTileCount, int* outNoWalkTypeCount);

struct IpcTileTypeEntry {
    uint16_t typeId;
    int      count;
    bool     noWalk;
};
int IpcBridge_CopyUniqueTypeEntries(IpcTileTypeEntry* buf, int maxCount);

// Auth/session state.
const char* IpcBridge_GetUserId();
bool        IpcBridge_IsAuthenticated();

// Admin-controlled overlay gate.
bool        IpcBridge_IsOverlayEnabled();
void        IpcBridge_SetOverlayEnabled(bool on);

// Apply latest pipe feature state from the render thread once per frame.
void        IpcBridge_ApplyFeatureOverrides();
