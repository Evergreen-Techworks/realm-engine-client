// Purpose: owns the DLL-side named-pipe bridge loop and the public IpcBridge_*
// API for overlay, shutdown, threat, and auth state.

// Helpful notes:
// - This DLL is the pipe client; the Node/Electron side is the pipe server.
// - The bridge speaks plaintext length-prefixed JSON dispatched by "type";
//   liveness is tracked by bidirectional heartbeats in s_conn (no MAC/auth).
// - Per-frame feature application lives in FeatureRuntime; this file only
//   accepts pipe commands, publishes player/diagnostic events, and reconnects.
// - Feature state is owned by FeatureState; no forwarding shims remain here.

#include "pch-il2cpp.h"
#include "IpcBridge.h"
#include "settings.h"
#include "DbgFileLog.h"
#include "RuntimeOffsets.h"

#ifndef BUILD_PIPE_NAME
#define BUILD_PIPE_NAME "\\\\.\\pipe\\lfg-dev-bridge"
#endif

#include <atomic>
#include <mutex>
#include <vector>
#include <string>
#include <cstdio>
#include <cstring>
#include <iostream>

#include "IpcFraming.h"
#include "IpcJson.h"
#include "IpcMessages.h"
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

// Connection liveness state (single-threaded — only touched by IpcBridgeThread).
struct BridgeConn {
    int       heartbeatMisses;    // consecutive unanswered heartbeats
    ULONGLONG lastHeartbeatSent;  // GetTickCount64() of last heartbeat we sent
    bool      heartbeatPending;   // we sent a heartbeat, awaiting heartbeatResp
    bool      connected;          // hello sent, loop live
};
static BridgeConn s_conn = {};

static const DWORD HEARTBEAT_INTERVAL_MS = 5000;
static const int   HEARTBEAT_MAX_MISSES  = 3;

// Session and overlay state

const char* IpcBridge_GetUserId()       { return ""; }
bool        IpcBridge_IsAuthenticated() { return s_conn.connected && s_conn.heartbeatMisses < HEARTBEAT_MAX_MISSES; }

static std::atomic<bool> s_overlayEnabled{false};

bool IpcBridge_IsOverlayEnabled() { return s_overlayEnabled.load(std::memory_order_relaxed); }
void IpcBridge_SetOverlayEnabled(bool on)
{
    s_overlayEnabled.store(on, std::memory_order_relaxed);
    if (!on) settings.bShowMenu = false;
    DbgLog("overlayEnabled = %s", on ? "true" : "false");
}

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

static std::mutex s_threatsMutex;
static IpcThreat  s_threats[kIpcMaxThreats];
static int        s_threatCount     = 0;
static bool       s_threatsPending  = false;
static bool       s_threatsTruncated = false;
static IpcGround  s_ground;

void IpcBridge_PublishThreats(const IpcThreat* threats, int count, const IpcGround& ground, bool truncated)
{
    if (count < 0) count = 0;
    if (count > kIpcMaxThreats) count = kIpcMaxThreats;
    std::lock_guard<std::mutex> lk(s_threatsMutex);
    for (int i = 0; i < count; ++i) s_threats[i] = threats[i];
    s_threatCount     = count;
    s_ground          = ground;
    s_threatsTruncated = truncated;
    s_threatsPending  = true;
}

static std::mutex s_aimMutex;
static IpcAim     s_aim;
static bool       s_aimPending = false;

void IpcBridge_PublishAim(const IpcAim& aim)
{
    std::lock_guard<std::mutex> lk(s_aimMutex);
    s_aim        = aim;
    s_aimPending = true;
}

// Room for the compact versioned payload (see IpcMessages::EncodeThreats):
// "<version>;<ground>;<threats>;<T>" — +4 over the raw segments for the leading
// "1;" and trailing ";<T>" tokens.
constexpr int kThreatEntryMax = 11 + 11 + 14 + 11 + 1 + 5;
constexpr int kGroundSegMax   = (11 + 1 + 14) + kIpcMaxGroundEvents * (1 + 11 + 1 + 14) + 2;
constexpr int kThreatPayloadMax = kIpcMaxThreats * kThreatEntryMax + kGroundSegMax + 1 + 4;

static bool WriteThreats(HANDLE hPipe, char* msgBuf, int msgBufSize)
{
    IpcThreat local[kIpcMaxThreats];
    IpcGround localGround{};
    int  n         = 0;
    bool truncated = false;
    {
        std::lock_guard<std::mutex> lk(s_threatsMutex);
        if (!s_threatsPending) return true;   // nothing new
        s_threatsPending = false;
        n = s_threatCount;
        for (int i = 0; i < n; ++i) local[i] = s_threats[i];
        localGround = s_ground;
        truncated   = s_threatsTruncated;
    }

    char payload[kThreatPayloadMax] = {};
    if (IpcMessages::EncodeThreats(payload, sizeof(payload), local, n, localGround, truncated) < 0)
        return true;   // encode failure — skip this tick
    const int len = IpcMessages::BuildThreats(msgBuf, msgBufSize, payload);
    return IpcFraming::WriteMessage(hPipe, msgBuf, len);
}

static bool WriteAim(HANDLE hPipe, char* msgBuf, int msgBufSize)
{
    IpcAim local{};
    {
        std::lock_guard<std::mutex> lk(s_aimMutex);
        if (!s_aimPending) return true;   // nothing new
        s_aimPending = false;
        local = s_aim;
    }

    // Ample for the fixed 11-token layout (see IpcMessages::EncodeAim).
    char payload[192] = {};
    if (IpcMessages::EncodeAim(payload, sizeof(payload), local) < 0)
        return true;   // encode failure — skip this tick
    const int len = IpcMessages::BuildAim(msgBuf, msgBufSize, payload);
    return IpcFraming::WriteMessage(hPipe, msgBuf, len);
}

static bool WriteHotkeyEvent(HANDLE hPipe, char* msgBuf, int msgBufSize, const char* pluginId, const char* action, bool value)
{
    if (!hPipe || !msgBuf || !pluginId || !action) return false;
    const int len = IpcMessages::BuildHotkeyEvent(msgBuf, msgBufSize, pluginId, action, value);
    return IpcFraming::WriteMessage(hPipe, msgBuf, len);
}

// Heartbeat liveness dispatcher

static bool HandleControlMessage(char* json, HANDLE hPipe, char* msgBuf, int msgBufSize)
{
    char typeBuf[64] = {};
    if (!IpcJson::GetString(json, "type", typeBuf, sizeof(typeBuf))) return false;
    if (strcmp(typeBuf, "heartbeat") == 0) {
        IpcFraming::WriteMessage(hPipe, msgBuf, IpcMessages::BuildHeartbeatResp(msgBuf, msgBufSize));
        return true;
    }
    if (strcmp(typeBuf, "heartbeatResp") == 0) {
        s_conn.heartbeatPending = false;
        s_conn.heartbeatMisses = 0;
        return true;
    }
    return false;
}

// Feature command parsing and dispatch

static bool ParseSetFeatureCommand(char* json, FeatureCommand* out)
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
    DBG_FILE_LOG("[IpcBridge] setFeature: key=" << out->key << " valueType=" << out->valueType << " value=" << out->value);
    return true;
}

static void DispatchSetFeature(char* json)
{
    FeatureCommand feature{};
    if (!ParseSetFeatureCommand(json, &feature)) return;
    FeatureCommandRegistry::Apply(feature);
}

static void DispatchCommand(char* json)
{
    char typeBuf[64] = {};
    if (!IpcJson::GetString(json, "type", typeBuf, sizeof(typeBuf))) return;
    if (strcmp(typeBuf, "setFeature") == 0) DispatchSetFeature(json);
}

// Bridge thread

DWORD WINAPI IpcBridgeThread(LPVOID)
{
    DBG_FILE_LOG("[IpcBridgeThread] Entered (DLL-as-client mode).");
    DbgLog("Thread started.");
    DBG_FILE_LOG("[IpcBridgeThread] Connecting to pipe: " << PipeName());
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
        s_conn = {};

        char msgBuf[PIPE_BUFFER_SIZE];
        int len = IpcMessages::BuildHello(msgBuf, sizeof(msgBuf));
        if (!IpcFraming::WriteMessage(hPipe, msgBuf, len)) {
            DbgLog("Failed to send hello.");
            CloseHandle(hPipe);
            Sleep(1000);
            continue;
        }

        char readBuf[PIPE_BUFFER_SIZE];
        DbgLog("Hello sent. Entering main loop.");
        ULONGLONG lastPlayerPush = 0;
        s_conn.connected = true;
        s_conn.lastHeartbeatSent = GetTickCount64();
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
                if (!HandleControlMessage(readBuf, hPipe, msgBuf, sizeof(msgBuf)))
                    DispatchCommand(readBuf);
            }

            ULONGLONG now = GetTickCount64();
            if (now - s_conn.lastHeartbeatSent >= HEARTBEAT_INTERVAL_MS) {
                if (s_conn.heartbeatPending) {
                    s_conn.heartbeatMisses++;
                    DbgLog("Heartbeat miss #%d.", s_conn.heartbeatMisses);
                    if (s_conn.heartbeatMisses >= HEARTBEAT_MAX_MISSES) {
                        DbgLog("Too many misses - disconnecting.");
                        connected = false;
                        break;
                    }
                }
                len = IpcMessages::BuildHeartbeat(msgBuf, sizeof(msgBuf));
                if (!IpcFraming::WriteMessage(hPipe, msgBuf, len)) {
                    connected = false;
                    break;
                }
                s_conn.heartbeatPending = true;
                s_conn.lastHeartbeatSent = now;
            }

            if (now - lastPlayerPush >= 200) {
                lastPlayerPush = now;
                len = IpcMessages::BuildPlayer(msgBuf, sizeof(msgBuf));
                if (!IpcFraming::WriteMessage(hPipe, msgBuf, len)) {
                    connected = false;
                    break;
                }
            }

            if (FeatureRuntime::PollSocketHotkeyEvent() && !WriteHotkeyEvent(hPipe, msgBuf, sizeof(msgBuf), "socket", "toggle", true)) {
                connected = false;
                break;
            }

            std::vector<std::string> pluginToggleEvents;
            FeatureRuntime::CollectPluginToggleHotkeyEvents(pluginToggleEvents);
            for (const auto& pluginId : pluginToggleEvents) {
                if (!WriteHotkeyEvent(hPipe, msgBuf, sizeof(msgBuf), pluginId.c_str(), "togglePlugin", true)) {
                    connected = false;
                    break;
                }
            }
            if (!connected) break;

            const int noclipEnabled = FeatureState::ConsumePendingPlayerNoclipEnabled();
            if (noclipEnabled >= 0 && !WriteHotkeyEvent(hPipe, msgBuf, sizeof(msgBuf), "player-noclip", "noclipEnabled", noclipEnabled != 0)) {
                connected = false;
                break;
            }

            std::vector<PendingEvent> drained;
            {
                std::lock_guard<std::mutex> lk(s_pendingEventsMutex);
                if (!s_pendingEvents.empty()) drained.swap(s_pendingEvents);
            }
            for (const auto& ev : drained) {
                if (!WriteHotkeyEvent(hPipe, msgBuf, sizeof(msgBuf), ev.pluginId, ev.action, true)) {
                    connected = false;
                    break;
                }
            }
            if (!connected) break;

            if (!WriteThreats(hPipe, msgBuf, sizeof(msgBuf))) {
                connected = false;
                break;
            }

            if (!WriteAim(hPipe, msgBuf, sizeof(msgBuf))) {
                connected = false;
                break;
            }

            if (!sentUnresolvedClasses && RuntimeOffsets::HasGivenUp()) {
                sentUnresolvedClasses = true;
                const char* classes = RuntimeOffsets::GetUnresolvedClassNames();
                if (classes && classes[0] != '\0') {
                    len = IpcMessages::BuildUnresolvedClasses(msgBuf, sizeof(msgBuf), classes);
                    IpcFraming::WriteMessage(hPipe, msgBuf, len);
                }
            }
            Sleep(25);
        }

        s_conn = {};
        CloseHandle(hPipe);
        DbgLog("Disconnected. Will reconnect.");
    }

    DbgLog("Thread exiting.");
    return 0;
}
