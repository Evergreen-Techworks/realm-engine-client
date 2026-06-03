// Purpose: owns the DLL-side named-pipe bridge loop and keeps the public
// IpcBridge_* API stable while delegating extracted responsibilities to focused
// IPC, feature-state, runtime, and tile-state modules.

// Helpful notes:
// - This DLL is the pipe client; the Node/Electron side is the pipe server.
// - Authentication, heartbeat, and signed command sequencing share s_auth.
// - Per-frame feature application lives in FeatureRuntime; this file only
//   accepts pipe commands, publishes player/diagnostic events, and reconnects.
// - Legacy IpcBridge_* accessors intentionally remain as compatibility shims.

#include "pch-il2cpp.h"
#include "IpcBridge.h"
#include "Handshake.h"
#include "settings.h"
#include "DbgFileLog.h"
#include "RuntimeOffsets.h"

#if __has_include("BuildSecrets.h")
#include "BuildSecrets.h"
#endif

#ifndef BUILD_PIPE_NAME
#define BUILD_PIPE_NAME "\\\\.\\pipe\\lfg-dev-bridge"
#endif

#include <atomic>
#include <mutex>
#include <vector>
#include <cstdio>
#include <cstring>
#include <iostream>

#include "IpcTileState.h"
#include "IpcFraming.h"
#include "IpcJson.h"
#include "IpcMessages.h"
#include "IpcSession.h"
#include "FeatureState.h"
#include "FeatureRuntime.h"
#include "FeatureCommandRegistry.h"

// Debug logging

#ifdef _DEBUG
#define DbgLog(fmt, ...) do { \
    char _b[512]; snprintf(_b, sizeof(_b), fmt, ##__VA_ARGS__); \
    std::cout << "[IpcBridge] " << _b << std::endl; \
} while(0)
#else
#define DbgLog(fmt, ...) (void)0
#endif

// Pipe constants and shared state

static const char* PipeName() { return BUILD_PIPE_NAME; }
static const DWORD PIPE_BUFFER_SIZE = 65536;

// Tile map API

bool IpcBridge_IsTileWalkable(float worldX, float worldY)
{
    return IpcTileState::IsWalkable(worldX, worldY);
}

void IpcBridge_GetTileStats(int* outTileCount, int* outNoWalkTypeCount)
{
    IpcTileState::GetStats(outTileCount, outNoWalkTypeCount);
}

int IpcBridge_CopyUniqueTypeEntries(IpcTileTypeEntry* buf, int maxCount)
{
    return IpcTileState::CopyUniqueTypeEntries(buf, maxCount);
}

static Handshake::AuthState s_auth = {};

// Session and overlay state

const char* IpcBridge_GetUserId()       { return s_auth.userId; }
bool        IpcBridge_IsAuthenticated() { return Handshake::IsHealthy(&s_auth); }

static std::atomic<bool> s_overlayEnabled{false};

bool IpcBridge_IsOverlayEnabled() { return s_overlayEnabled.load(std::memory_order_relaxed); }
void IpcBridge_SetOverlayEnabled(bool on)
{
    s_overlayEnabled.store(on, std::memory_order_relaxed);
    if (!on) settings.bShowMenu = false;
    DbgLog("overlayEnabled = %s", on ? "true" : "false");
}

// Public feature accessors — shim to FeatureState

bool    IpcBridge_GetAutoAimEnabled()                         { return FeatureState::GetAutoAimEnabled(); }
int     IpcBridge_GetAutoAimMode()                            { return FeatureState::GetAutoAimMode(); }
void    IpcBridge_SetAutoAimEnabled(bool enabled)             { FeatureState::SetAutoAimEnabled(enabled); }
void    IpcBridge_SetAutoAimMode(int mode)                    { FeatureState::SetAutoAimMode(mode); }

int     IpcBridge_GetAutoDodgeMode()                          { return FeatureState::GetAutoDodgeMode(); }
void    IpcBridge_SetAutoDodgeMode(int mode)                  { FeatureState::SetAutoDodgeMode(mode); }
float   IpcBridge_GetAutoDodgeHorizonMs()                     { return FeatureState::GetAutoDodgeHorizonMs(); }
void    IpcBridge_SetAutoDodgeHorizonMs(float ms)             { FeatureState::SetAutoDodgeHorizonMs(ms); }
float   IpcBridge_GetAutoDodgeHitboxPadding()                 { return FeatureState::GetAutoDodgeHitboxPadding(); }
void    IpcBridge_SetAutoDodgeHitboxPadding(float p)          { FeatureState::SetAutoDodgeHitboxPadding(p); }
bool    IpcBridge_GetAutoDodgeWallAvoid()                     { return FeatureState::GetAutoDodgeWallAvoid(); }
void    IpcBridge_SetAutoDodgeWallAvoid(bool enabled)         { FeatureState::SetAutoDodgeWallAvoid(enabled); }

bool    IpcBridge_GetAutoAbilityEnabled()                     { return FeatureState::GetAutoAbilityEnabled(); }
void    IpcBridge_SetAutoAbilityEnabled(bool enabled)         { FeatureState::SetAutoAbilityEnabled(enabled); }
float   IpcBridge_GetAutoAbilityMpPct()                       { return FeatureState::GetAutoAbilityMpPct(); }
void    IpcBridge_SetAutoAbilityMpPct(float pct)              { FeatureState::SetAutoAbilityMpPct(pct); }
int     IpcBridge_GetAutoAbilityWizardMode()                  { return FeatureState::GetAutoAbilityWizardMode(); }
void    IpcBridge_SetAutoAbilityWizardMode(int mode)          { FeatureState::SetAutoAbilityWizardMode(mode); }

float   IpcBridge_GetWalkTargetX()                            { return FeatureState::GetWalkTargetX(); }
float   IpcBridge_GetWalkTargetY()                            { return FeatureState::GetWalkTargetY(); }
bool    IpcBridge_GetWalkTargetActive()                       { return FeatureState::GetWalkTargetActive(); }
void    IpcBridge_SetWalkTarget(float wx, float wy, bool a)   { FeatureState::SetWalkTarget(wx, wy, a); }

bool    IpcBridge_GetCameraZoomActive()                       { return FeatureState::GetCameraZoomActive(); }
float   IpcBridge_GetCameraZoomValue()                        { return FeatureState::GetCameraZoomValue(); }
void    IpcBridge_SetCameraZoom(bool active, float zoom)      { FeatureState::SetCameraZoom(active, zoom); }
bool    IpcBridge_GetCameraAngleActive()                      { return FeatureState::GetCameraAngleActive(); }
int     IpcBridge_GetCameraAngleValue()                       { return FeatureState::GetCameraAngleValue(); }
void    IpcBridge_SetCameraAngle(bool active, int angle)      { FeatureState::SetCameraAngle(active, angle); }
bool    IpcBridge_GetCameraCenteringActive()                  { return FeatureState::GetCameraCenteringActive(); }
bool    IpcBridge_GetCameraCentered()                         { return FeatureState::GetCameraCentered(); }
void    IpcBridge_SetCameraCentering(bool active, bool c)     { FeatureState::SetCameraCentering(active, c); }

bool    IpcBridge_GetSkinOverrideEnabled()                    { return FeatureState::GetSkinOverrideEnabled(); }
int     IpcBridge_GetSkinOverrideId()                         { return FeatureState::GetSkinOverrideId(); }
void    IpcBridge_SetSkinOverride(bool enabled, int skinId)   { FeatureState::SetSkinOverride(enabled, skinId); }
int32_t IpcBridge_GetClientDefense()                          { return FeatureState::GetClientDefense(); }
int32_t IpcBridge_GetClientClassType()                        { return FeatureState::GetClientClassType(); }

void IpcBridge_ApplyFeatureOverrides()
{
    FeatureRuntime::ApplyOverrides();
}

static std::atomic<bool> s_shutdown{false};
void IpcBridge_RequestShutdown() { s_shutdown = true; }

// Pending pipe events

struct PendingEvent { char pluginId[32]; char action[128]; };
static std::mutex s_pendingEventsMutex;
static std::vector<PendingEvent> s_pendingEvents;
static constexpr size_t kPendingEventsCap = 64;
void IpcBridge_EmitPredictedHit(int ownerObjId, int bulletId)
{
    PendingEvent ev{};
    std::snprintf(ev.pluginId, sizeof(ev.pluginId), "%s", "ghostHit");
    std::snprintf(ev.action, sizeof(ev.action), "%d:%d", ownerObjId, bulletId);
    std::lock_guard<std::mutex> lk(s_pendingEventsMutex);
    if (s_pendingEvents.size() < kPendingEventsCap) s_pendingEvents.push_back(ev);
}

static bool WriteSignedHotkeyEvent(HANDLE hPipe, char* msgBuf, int msgBufSize, const char* pluginId, const char* action, bool value)
{
    if (!hPipe || !msgBuf || !pluginId || !action) return false;
    char payload[128] = {};
    snprintf(payload, sizeof(payload), "%s|%s|%s", pluginId, action, value ? "true" : "false");
    const uint64_t outSeq = s_auth.nextServerSeq++;
    char outMac[65] = {};
    if (!IpcSession::ComputeSessionMacHex(s_auth.sessionKey, outSeq, "hotkeyEvent", payload, outMac)) return false;
    const int len = IpcMessages::BuildHotkeyEvent(msgBuf, msgBufSize, pluginId, action, value, outSeq, outMac);
    return IpcFraming::WriteMessage(hPipe, msgBuf, len);
}

// Auth and heartbeat dispatcher

static void WriteAuthResult(HANDLE hPipe, char* msgBuf, int msgBufSize, bool ok, const char* response = "")
{
    IpcFraming::WriteMessage(hPipe, msgBuf, IpcMessages::BuildAuthResult(msgBuf, msgBufSize, ok, response));
}

static bool DispatchAuthMessage(char* json, HANDLE hPipe, char* msgBuf, int msgBufSize)
{
    char typeBuf[64] = {};
    if (!IpcJson::GetString(json, "type", typeBuf, sizeof(typeBuf))) return false;
    if (strcmp(typeBuf, "auth") == 0) {
        char userId[128] = {}, response[128] = {}, clientChallenge[128] = {}, protocol[32] = {}, clientPid[32] = {};
        if (!IpcJson::GetString(json, "userId", userId, sizeof(userId)) ||
            !IpcJson::GetString(json, "response", response, sizeof(response)) ||
            !IpcJson::GetString(json, "challenge", clientChallenge, sizeof(clientChallenge)) ||
            !IpcJson::GetString(json, "protocol", protocol, sizeof(protocol)) ||
            !IpcJson::GetString(json, "clientPid", clientPid, sizeof(clientPid))) { DbgLog("Auth message missing required fields."); WriteAuthResult(hPipe, msgBuf, msgBufSize, false); return true; }

        if (!IpcSession::IsAsciiIdSafe(userId) ||
            strcmp(protocol, "bridge-v3") != 0 ||
            strlen(response) != 64 || !Handshake::IsHexString(response, 64) ||
            strlen(clientChallenge) != 64 || !Handshake::IsHexString(clientChallenge, 64) ||
            strlen(s_auth.pendingChallenge) != 64 || !Handshake::IsHexString(s_auth.pendingChallenge, 64)) { DbgLog("Auth payload failed format validation."); WriteAuthResult(hPipe, msgBuf, msgBufSize, false); return true; }
        strncpy_s(s_auth.userId, sizeof(s_auth.userId), userId, _TRUNCATE);

        if (!IpcSession::DeriveSessionKey(s_auth.pendingChallenge, clientChallenge, s_auth.userId, clientPid, s_auth.sessionKey, PipeName())) { DbgLog("Session key derivation failed."); WriteAuthResult(hPipe, msgBuf, msgBufSize, false); return true; }
        s_auth.authenticated = true; s_auth.sessionReady = true; s_auth.heartbeatMisses = 0; s_auth.lastHeartbeatRecv = GetTickCount64(); s_auth.lastClientSeq = 0; s_auth.nextServerSeq = 1;
        DbgLog("Auth OK: userId=%s", userId);
        char dllResponse[65] = {};
        if (!Handshake::ComputeResponse(clientChallenge, strlen(clientChallenge), dllResponse)) { DbgLog("Auth response generation failed."); WriteAuthResult(hPipe, msgBuf, msgBufSize, false); return true; }
        WriteAuthResult(hPipe, msgBuf, msgBufSize, true, dllResponse);
        return true;
    }

    if (strcmp(typeBuf, "heartbeatResp") == 0) {
        char response[128] = {}, seqStr[32] = {}, macHex[128] = {};
        if (!IpcJson::GetString(json, "response", response, sizeof(response))) return true;
        if (!IpcJson::GetString(json, "seq", seqStr, sizeof(seqStr))) return true;
        if (!IpcJson::GetString(json, "mac", macHex, sizeof(macHex))) return true;
        if (strlen(response) != 64 || !Handshake::IsHexString(response, 64) || !IpcSession::VerifyClientSeqAndMac(&s_auth, seqStr, macHex, "heartbeatResp", response)) { s_auth.heartbeatMisses++; return true; }
        if (s_auth.challengePending && Handshake::VerifyResponse(s_auth.pendingChallenge, strlen(s_auth.pendingChallenge), response)) { s_auth.challengePending = false; s_auth.heartbeatMisses = 0; s_auth.lastHeartbeatRecv = GetTickCount64(); }
        else s_auth.heartbeatMisses++;
        return true;
    }

    if (strcmp(typeBuf, "heartbeat") == 0) {
        char nonce[128] = {}, seqStr[32] = {}, macHex[128] = {};
        if (!IpcJson::GetString(json, "nonce", nonce, sizeof(nonce))) return true;
        if (!IpcJson::GetString(json, "seq", seqStr, sizeof(seqStr))) return true;
        if (!IpcJson::GetString(json, "mac", macHex, sizeof(macHex))) return true;
        if (strlen(nonce) != 64 || !Handshake::IsHexString(nonce, 64)) return true;
        if (!IpcSession::VerifyClientSeqAndMac(&s_auth, seqStr, macHex, "heartbeat", nonce)) return true;
        char resp[65] = {}, outMac[65] = {};
        if (!Handshake::ComputeResponse(nonce, strlen(nonce), resp)) return true;
        const uint64_t outSeq = s_auth.nextServerSeq++;
        if (!IpcSession::ComputeSessionMacHex(s_auth.sessionKey, outSeq, "heartbeatResp", resp, outMac)) return true;
        IpcFraming::WriteMessage(hPipe, msgBuf, IpcMessages::BuildHeartbeatResp(msgBuf, msgBufSize, resp, outSeq, outMac));
        return true;
    }
    return false;
}

// Feature command parsing and dispatch

static bool ParseSetFeatureCommand(char* json, const char* seqStr, const char* macHex, FeatureCommand* out)
{
    if (!out) return false;
    if (!IpcJson::GetString(json, "key", out->key, sizeof(out->key))) return false;
    if (!IpcJson::GetString(json, "valueType", out->valueType, sizeof(out->valueType))) return false;
    if (strcmp(out->valueType, "b") == 0) {
        strncpy_s(out->value, sizeof(out->value), IpcJson::GetBool(json, "value") ? "true" : "false", _TRUNCATE);
    } else if (strcmp(out->valueType, "n") == 0) {
        if (!IpcJson::GetNumberToken(json, "value", out->value, sizeof(out->value))) return false;
    } else if (strcmp(out->valueType, "s") == 0) {
        if (!IpcJson::GetString(json, "value", out->value, sizeof(out->value))) return false;
    } else {
        return false;
    }
    char payload[256] = {};
    snprintf(payload, sizeof(payload), "%s|%s|%s", out->key, out->valueType, out->value);
    if (!IpcSession::VerifyClientSeqAndMac(&s_auth, seqStr, macHex, "setFeature", payload)) {
        DBG_FILE_LOG("[IpcBridge] setFeature HMAC REJECTED: key=" << out->key << " valueType=" << out->valueType << " value=" << out->value);
        return false;
    }
    DBG_FILE_LOG("[IpcBridge] setFeature: key=" << out->key << " valueType=" << out->valueType << " value=" << out->value);
    return true;
}

static bool DispatchTileCommand(const char* type, char* json, const char* seqStr, const char* macHex)
{
    if (strcmp(type, "clearTiles") == 0) {
        if (!IpcSession::VerifyClientSeqAndMac(&s_auth, seqStr, macHex, "clearTiles", "")) return true;
        IpcTileState::ClearTiles();
        return true;
    }
    if (strcmp(type, "noWalkInit") == 0) {
        char typesBuf[8192] = {};
        if (!IpcJson::GetString(json, "types", typesBuf, sizeof(typesBuf))) return true;
        if (!IpcSession::VerifyClientSeqAndMac(&s_auth, seqStr, macHex, "noWalkInit", typesBuf)) return true;
        IpcTileState::InitNoWalkTypes(typesBuf);
        return true;
    }
    if (strcmp(type, "tileUpdate") == 0) {
        char tilesBuf[65000] = {};
        if (!IpcJson::GetString(json, "tiles", tilesBuf, sizeof(tilesBuf))) return true;
        if (!IpcSession::VerifyClientSeqAndMac(&s_auth, seqStr, macHex, "tileUpdate", tilesBuf)) return true;
        IpcTileState::ApplyTileUpdate(tilesBuf);
        return true;
    }
    return false;
}

static void DispatchSetFeature(char* json, const char* seqStr, const char* macHex)
{
    FeatureCommand feature{};
    if (!ParseSetFeatureCommand(json, seqStr, macHex, &feature)) return;
    FeatureCommandRegistry::Apply(feature);
}

static void DispatchCommand(char* json)
{
    char typeBuf[64] = {};
    char seqStr[32] = {};
    char macHex[128] = {};
    if (!IpcJson::GetString(json, "type", typeBuf, sizeof(typeBuf))) return;
    if (!IpcJson::GetString(json, "seq", seqStr, sizeof(seqStr))) return;
    if (!IpcJson::GetString(json, "mac", macHex, sizeof(macHex))) return;
    if (DispatchTileCommand(typeBuf, json, seqStr, macHex)) return;
    if (strcmp(typeBuf, "setFeature") == 0) DispatchSetFeature(json, seqStr, macHex);
}

// Bridge thread

DWORD WINAPI IpcBridgeThread(LPVOID)
{
    DBG_FILE_LOG("[IpcBridgeThread] Entered (DLL-as-client mode).");
    DbgLog("Thread started.");
    DBG_FILE_LOG("[IpcBridgeThread] Handshake key OK. Connecting to pipe: " << PipeName());
    while (!s_shutdown) {
        if (!WaitNamedPipeA(PipeName(), 2000)) {
            if (s_shutdown) break;
            Sleep(500);
            continue;
        }

        HANDLE hPipe = CreateFileA(PipeName(), GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
        if (hPipe == INVALID_HANDLE_VALUE) {
            const DWORD err = GetLastError();
            DBG_FILE_LOG("[IpcBridgeThread] CreateFile failed: " << err);
            if (err == ERROR_PIPE_BUSY) WaitNamedPipeA(PipeName(), 2000);
            else Sleep(2000);
            continue;
        }

        DWORD pipeMode = PIPE_READMODE_BYTE;
        SetNamedPipeHandleState(hPipe, &pipeMode, NULL, NULL);

        DBG_FILE_LOG("[IpcBridgeThread] Connected to Node.js pipe server. Sending hello...");
        DbgLog("Connected. Sending hello...");
        Handshake::ResetAuthState(&s_auth);

        char msgBuf[PIPE_BUFFER_SIZE];
        char helloChallenge[65] = {};
        if (!Handshake::GenerateChallenge(helloChallenge)) {
            DbgLog("Failed to generate hello challenge.");
            CloseHandle(hPipe);
            Sleep(1000);
            continue;
        }

        strncpy_s(s_auth.pendingChallenge, sizeof(s_auth.pendingChallenge), helloChallenge, _TRUNCATE);
        int len = IpcMessages::BuildHello(msgBuf, sizeof(msgBuf), helloChallenge);
        if (!IpcFraming::WriteMessage(hPipe, msgBuf, len)) {
            DbgLog("Failed to send hello.");
            CloseHandle(hPipe);
            Sleep(1000);
            continue;
        }

        char readBuf[PIPE_BUFFER_SIZE];
        bool authOk = false;
        ULONGLONG authDeadline = GetTickCount64() + 5000;

        while (GetTickCount64() < authDeadline && !s_shutdown) {
            int readLen = IpcFraming::ReadMessage(hPipe, readBuf, sizeof(readBuf) - 1);
            if (readLen < 0) break;
            if (readLen > 0) {
                readBuf[readLen] = '\0';
                if (DispatchAuthMessage(readBuf, hPipe, msgBuf, sizeof(msgBuf))) {
                    authOk = s_auth.authenticated;
                    break;
                }
            }
            Sleep(25);
        }

        if (!authOk) {
            DbgLog("Auth failed or timed out. Retrying.");
            Handshake::ResetAuthState(&s_auth);
            CloseHandle(hPipe);
            Sleep(2000);
            continue;
        }

        DbgLog("Authenticated. userId=%s", s_auth.userId);
        ULONGLONG lastPlayerPush = 0;
        s_auth.lastHeartbeatSent = GetTickCount64();
        s_auth.lastHeartbeatRecv = GetTickCount64();
        bool connected = true;
        bool sentUnresolvedClasses = false;

        while (connected && !s_shutdown) {
            int readLen = IpcFraming::ReadMessage(hPipe, readBuf, sizeof(readBuf) - 1);
            if (readLen < 0) {
                DbgLog("Server disconnected.");
                connected = false;
                break;
            }
            if (readLen > 0) {
                readBuf[readLen] = '\0';
                if (!DispatchAuthMessage(readBuf, hPipe, msgBuf, sizeof(msgBuf)) && Handshake::IsHealthy(&s_auth))
                    DispatchCommand(readBuf);
            }

            ULONGLONG now = GetTickCount64();
            if (now - s_auth.lastHeartbeatSent >= Handshake::HEARTBEAT_INTERVAL_MS) {
                if (s_auth.challengePending) {
                    s_auth.heartbeatMisses++;
                    DbgLog("Heartbeat miss #%d.", s_auth.heartbeatMisses);
                    if (s_auth.heartbeatMisses >= Handshake::HEARTBEAT_MAX_MISSES) {
                        DbgLog("Too many misses - disconnecting.");
                        connected = false;
                        break;
                    }
                }

                char nonce[65] = {};
                if (Handshake::GenerateChallenge(nonce)) {
                    strncpy_s(s_auth.pendingChallenge, sizeof(s_auth.pendingChallenge), nonce, _TRUNCATE);
                    s_auth.challengePending = true; s_auth.lastHeartbeatSent = now;
                    const uint64_t outSeq = s_auth.nextServerSeq++;
                    char outMac[65] = {};
                    if (!IpcSession::ComputeSessionMacHex(s_auth.sessionKey, outSeq, "heartbeat", nonce, outMac)) {
                        connected = false;
                        break;
                    }
                    len = IpcMessages::BuildHeartbeat(msgBuf, sizeof(msgBuf), nonce, outSeq, outMac);
                    if (!IpcFraming::WriteMessage(hPipe, msgBuf, len)) {
                        connected = false;
                        break;
                    }
                }
            }

            if (Handshake::IsHealthy(&s_auth) && now - lastPlayerPush >= 200) {
                lastPlayerPush = now;
                const uint64_t outSeq = s_auth.nextServerSeq++;
                char payload[256] = {};
                IpcMessages::BuildPlayerSigPayload(payload, sizeof(payload));
                char outMac[65] = {};
                if (!IpcSession::ComputeSessionMacHex(s_auth.sessionKey, outSeq, "player", payload, outMac)) {
                    connected = false;
                    break;
                }
                len = IpcMessages::BuildPlayer(msgBuf, sizeof(msgBuf), outSeq, outMac);
                if (!IpcFraming::WriteMessage(hPipe, msgBuf, len)) {
                    connected = false;
                    break;
                }
            }

            if (Handshake::IsHealthy(&s_auth)) {
                if (FeatureRuntime::PollSocketHotkeyEvent() && !WriteSignedHotkeyEvent(hPipe, msgBuf, sizeof(msgBuf), "socket", "toggle", true)) {
                    connected = false;
                    break;
                }

                const int noclipEnabled = FeatureState::ConsumePendingPlayerNoclipEnabled();
                if (noclipEnabled >= 0 && !WriteSignedHotkeyEvent(hPipe, msgBuf, sizeof(msgBuf), "player-noclip", "noclipEnabled", noclipEnabled != 0)) {
                    connected = false;
                    break;
                }

                std::vector<PendingEvent> drained;
                {
                    std::lock_guard<std::mutex> lk(s_pendingEventsMutex);
                    if (!s_pendingEvents.empty()) drained.swap(s_pendingEvents);
                }
                for (const auto& ev : drained) {
                    if (!WriteSignedHotkeyEvent(hPipe, msgBuf, sizeof(msgBuf), ev.pluginId, ev.action, true)) {
                        connected = false;
                        break;
                    }
                }
                if (!connected) break;
            }

            if (!sentUnresolvedClasses && RuntimeOffsets::HasGivenUp()) {
                sentUnresolvedClasses = true;
                const char* classes = RuntimeOffsets::GetUnresolvedClassNames();
                if (classes && classes[0] != '\0') {
                    const uint64_t outSeq = s_auth.nextServerSeq++;
                    char outMac[65] = {};
                    if (IpcSession::ComputeSessionMacHex(s_auth.sessionKey, outSeq, "unresolvedClasses", classes, outMac)) {
                        len = IpcMessages::BuildUnresolvedClasses(msgBuf, sizeof(msgBuf), classes, outSeq, outMac);
                        IpcFraming::WriteMessage(hPipe, msgBuf, len);
                    }
                }
            }
            Sleep(25);
        }

        Handshake::ResetAuthState(&s_auth);
        CloseHandle(hPipe);
        DbgLog("Disconnected. Will reconnect.");
    }

    DbgLog("Thread exiting.");
    Handshake::ClearSharedKeyCache();
    return 0;
}
