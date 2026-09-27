// Purpose: public DLL-side IPC bridge contract used by hooks, features, and UI
// code that need named-pipe state without depending on the bridge internals.

// Helpful notes:
// - IpcBridgeThread runs the pipe client loop and owns IPC session lifetime.
// - Feature state is owned by FeatureState; IpcBridge owns only overlay,
//   shutdown, threat, and auth state.

#pragma once
#include <Windows.h>
#include <cstdint>
void IpcBridge_EmitNavStatus(const char* goalKind, uint64_t goalId, uint64_t generation, const char* state, const char* reason);

// Named pipe IPC bridge between the injected DLL and the Node client.
// Pipe-delivered feature state is authoritative for unified controls.

DWORD WINAPI IpcBridgeThread(LPVOID lpParam);

// Signal the bridge thread before detour teardown.
void IpcBridge_RequestShutdown();

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

// Auth/session state.
const char* IpcBridge_GetUserId();
bool        IpcBridge_IsAuthenticated();

// Admin-controlled overlay gate.
bool        IpcBridge_IsOverlayEnabled();
void        IpcBridge_SetOverlayEnabled(bool on);

// Apply latest pipe feature state from the render thread once per frame.
void        IpcBridge_ApplyFeatureOverrides();
