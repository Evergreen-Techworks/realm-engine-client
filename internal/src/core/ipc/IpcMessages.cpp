// Purpose: builds the JSON messages sent from the injected DLL to the client.

// Helpful notes:
// - Messages are plaintext, dispatched by "type" — no seq/mac envelope.
// - Player messages read from LocalPlayer at send time so heartbeat/player push
//   cadence stays independent from render-thread feature application.

#include "pch-il2cpp.h"
#include "IpcMessages.h"

#include "LocalPlayer.h"

#include <cstdio>

namespace IpcMessages {

int BuildHello(char* buf, int bufSize)
{
    return snprintf(buf, bufSize, "{\"type\":\"hello\",\"version\":3,\"protocol\":\"bridge-v3\",\"features\":[\"autoDodge\",\"autoAim\",\"tileMap\"]}");
}

int BuildHeartbeat(char* buf, int bufSize)     { return snprintf(buf, bufSize, "{\"type\":\"heartbeat\"}"); }
int BuildHeartbeatResp(char* buf, int bufSize) { return snprintf(buf, bufSize, "{\"type\":\"heartbeatResp\"}"); }

int BuildUnresolvedClasses(char* buf, int bufSize, const char* classes)
{
    return snprintf(buf, bufSize, "{\"type\":\"unresolvedClasses\",\"classes\":\"%s\"}", classes);
}

int BuildPlayer(char* buf, int bufSize)
{
    if (!LocalPlayer::GetPtr())
        return snprintf(buf, bufSize, "{\"type\":\"player\",\"alive\":false}");
    return snprintf(buf, bufSize,
        "{\"type\":\"player\",\"alive\":true,\"hp\":%d,\"maxHp\":%d,\"def\":%d,\"posX\":%.3f,\"posY\":%.3f}",
        LocalPlayer::GetHP(), LocalPlayer::GetMaxHP(), LocalPlayer::GetDefense(),
        (double)LocalPlayer::GetX(), (double)LocalPlayer::GetY());
}

int BuildHotkeyEvent(char* buf, int bufSize, const char* pluginId, const char* action, bool value)
{
    return snprintf(buf, bufSize,
        "{\"type\":\"hotkeyEvent\",\"pluginId\":\"%s\",\"action\":\"%s\",\"value\":%s}",
        pluginId, action, value ? "true" : "false");
}

int BuildThreats(char* buf, int bufSize, const char* threats)
{
    // NOTE: do NOT touch the payload string format — plan 19 owns it.
    return snprintf(buf, bufSize, "{\"type\":\"threats\",\"threats\":\"%s\"}", threats);
}

} // namespace IpcMessages
