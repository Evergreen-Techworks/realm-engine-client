// Purpose: public DLL-side IPC bridge contract used by hooks, features, and UI
// code that need named-pipe state without depending on the bridge internals.

// Helpful notes:
// - IpcBridgeThread runs the pipe client loop and owns IPC session lifetime.
// - Feature accessors are compatibility shims over FeatureState.
// - Tile APIs expose the latest tileUpdate/noWalkInit state from the client.
// - IpcBridge_ApplyFeatureOverrides is retained for legacy callers; new render
//   code can call FeatureRuntime directly.

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

// Unified feature state accessors.
bool        IpcBridge_GetAutoAimEnabled();
int         IpcBridge_GetAutoAimMode();
void        IpcBridge_SetAutoAimEnabled(bool enabled);
void        IpcBridge_SetAutoAimMode(int mode);
int         IpcBridge_GetAutoDodgeMode();
void        IpcBridge_SetAutoDodgeMode(int mode);
float       IpcBridge_GetAutoDodgeHorizonMs();
void        IpcBridge_SetAutoDodgeHorizonMs(float ms);
float       IpcBridge_GetAutoDodgeHitboxPadding();
void        IpcBridge_SetAutoDodgeHitboxPadding(float paddingTiles);
bool        IpcBridge_GetAutoDodgeWallAvoid();
void        IpcBridge_SetAutoDodgeWallAvoid(bool enabled);
bool        IpcBridge_GetAutoAbilityEnabled();
void        IpcBridge_SetAutoAbilityEnabled(bool enabled);
float       IpcBridge_GetAutoAbilityMpPct();
void        IpcBridge_SetAutoAbilityMpPct(float pctZeroTo100);
int         IpcBridge_GetAutoAbilityWizardMode();
void        IpcBridge_SetAutoAbilityWizardMode(int mode);
float       IpcBridge_GetWalkTargetX();
float       IpcBridge_GetWalkTargetY();
bool        IpcBridge_GetWalkTargetActive();
void        IpcBridge_SetWalkTarget(float worldX, float worldY, bool active);
bool        IpcBridge_GetCameraZoomActive();
float       IpcBridge_GetCameraZoomValue();
void        IpcBridge_SetCameraZoom(bool active, float zoom);
bool        IpcBridge_GetCameraAngleActive();
int         IpcBridge_GetCameraAngleValue();
void        IpcBridge_SetCameraAngle(bool active, int angle);
bool        IpcBridge_GetCameraCenteringActive();
bool        IpcBridge_GetCameraCentered();
void        IpcBridge_SetCameraCentering(bool active, bool centered);
bool        IpcBridge_GetSkinOverrideEnabled();
int         IpcBridge_GetSkinOverrideId();
void        IpcBridge_SetSkinOverride(bool enabled, int skinId);
int32_t     IpcBridge_GetClientDefense();
int32_t     IpcBridge_GetClientClassType();

// Apply latest pipe feature state from the render thread once per frame.
void        IpcBridge_ApplyFeatureOverrides();
