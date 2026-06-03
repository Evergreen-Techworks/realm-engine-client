// Purpose: builds the JSON messages sent from the injected DLL to the client.

// Helpful notes:
// - Most outbound messages are signed by the caller before construction.
// - Player messages read from LocalPlayer at send time so heartbeat/player push
//   cadence stays independent from render-thread feature application.
// - BuildPlayerSigPayload must stay in sync with BuildPlayer fields covered by
//   the session MAC.

#include "pch-il2cpp.h"
#include "IpcMessages.h"

#include "LocalPlayer.h"

#include <cstdio>
#include <cstdint>

namespace IpcMessages {

static int BuildSignedStringJson(char* buf, int bufSize, const char* type, const char* key, const char* value, uint64_t seq, const char* mac)
{
    return snprintf(buf, bufSize, "{\"type\":\"%s\",\"%s\":\"%s\",\"seq\":\"%llu\",\"mac\":\"%s\"}", type, key, value, static_cast<unsigned long long>(seq), mac);
}

int BuildHello(char* buf, int bufSize, const char* challenge)
{
    return snprintf(buf, bufSize, "{\"type\":\"hello\",\"version\":3,\"protocol\":\"bridge-v3\",\"challenge\":\"%s\",\"features\":[\"autoDodge\",\"autoAim\",\"tileMap\"]}", challenge);
}

int BuildAuthResult(char* buf, int bufSize, bool ok, const char* response)
{
    return ok ? snprintf(buf, bufSize, "{\"type\":\"authResult\",\"ok\":true,\"response\":\"%s\"}", response) : snprintf(buf, bufSize, "{\"type\":\"authResult\",\"ok\":false}");
}

int BuildHeartbeat(char* buf, int bufSize, const char* nonce, uint64_t seq, const char* mac)
{
    return BuildSignedStringJson(buf, bufSize, "heartbeat", "nonce", nonce, seq, mac);
}

int BuildHeartbeatResp(char* buf, int bufSize, const char* response, uint64_t seq, const char* mac)
{
    return BuildSignedStringJson(buf, bufSize, "heartbeatResp", "response", response, seq, mac);
}

int BuildUnresolvedClasses(char* buf, int bufSize, const char* classes, uint64_t seq, const char* mac)
{
    return BuildSignedStringJson(buf, bufSize, "unresolvedClasses", "classes", classes, seq, mac);
}

int BuildPlayer(char* buf, int bufSize, uint64_t seq, const char* mac)
{
    float posX = LocalPlayer::GetX(), posY = LocalPlayer::GetY();
    int32_t hp = LocalPlayer::GetHP(), maxHp = LocalPlayer::GetMaxHP(), def = LocalPlayer::GetDefense();
    if (!LocalPlayer::GetPtr())
        return snprintf(buf, bufSize, "{\"type\":\"player\",\"alive\":false,\"seq\":\"%llu\",\"mac\":\"%s\"}", static_cast<unsigned long long>(seq), mac);
    return snprintf(buf, bufSize, "{\"type\":\"player\",\"alive\":true,\"hp\":%d,\"maxHp\":%d,\"def\":%d,\"posX\":%.3f,\"posY\":%.3f,\"seq\":\"%llu\",\"mac\":\"%s\"}", hp, maxHp, def, (double)posX, (double)posY, static_cast<unsigned long long>(seq), mac);
}

int BuildHotkeyEvent(char* buf, int bufSize, const char* pluginId, const char* action, bool value, uint64_t seq, const char* mac)
{
    return snprintf(buf, bufSize, "{\"type\":\"hotkeyEvent\",\"pluginId\":\"%s\",\"action\":\"%s\",\"value\":%s,\"seq\":\"%llu\",\"mac\":\"%s\"}", pluginId, action, value ? "true" : "false", static_cast<unsigned long long>(seq), mac);
}

void BuildPlayerSigPayload(char* outBuf, int outBufSize)
{
    if (!outBuf || outBufSize <= 0) return;
    float posX = LocalPlayer::GetX();
    float posY = LocalPlayer::GetY();
    int32_t hp    = LocalPlayer::GetHP();
    int32_t maxHp = LocalPlayer::GetMaxHP();
    int32_t def   = LocalPlayer::GetDefense();
    if (!LocalPlayer::GetPtr()) {snprintf(outBuf, outBufSize, "alive:false"); return; }
    snprintf(outBuf, outBufSize, "alive:true|hp:%d|maxHp:%d|posX:%.3f|posY:%.3f|def:%d", hp, maxHp, (double)posX, (double)posY, def);
}

} // namespace IpcMessages
