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
    // Envelope only — the compact payload string is produced by EncodeThreats.
    return snprintf(buf, bufSize, "{\"type\":\"threats\",\"threats\":\"%s\"}", threats);
}

// Serializes the threat/ground objects to the compact versioned wire string
//   1;<ground>;<threats>;<T>
// documented on THREAT_SCHEMA_VERSION in IpcMessages.h. This is the ONLY C++
// encoder; the ONLY decoder is decodeThreatPayload in DllThreatBus.ts. Keep the
// field order below in lockstep with that decoder.
int EncodeThreats(char* out, int outSize, const IpcThreat* threats, int count,
                  const IpcGround& ground, bool truncated)
{
    if (!out || outSize <= 0) return -1;
    if (count < 0) count = 0;
    if (count > kIpcMaxThreats) count = kIpcMaxThreats;

    int used = 0;
    out[0] = '\0';

    // "<version>;<groundSummary d>:<t>", then "|<d>:<t>" per additional ground tick.
    {
        const int wrote = snprintf(out, static_cast<size_t>(outSize),
                                   "%d;%d:%.1f",
                                   THREAT_SCHEMA_VERSION,
                                   ground.rawDamage,
                                   static_cast<double>(ground.tHitMs));
        if (wrote <= 0 || wrote >= outSize) return -1;
        used += wrote;

        int nG = ground.count;
        if (nG > kIpcMaxGroundEvents) nG = kIpcMaxGroundEvents;
        for (int i = 0; i < nG; ++i) {
            const int w2 = snprintf(out + used, static_cast<size_t>(outSize - used),
                                    "|%d:%.1f",
                                    ground.events[i].rawDamage,
                                    static_cast<double>(ground.events[i].tHitMs));
            if (w2 <= 0 || w2 >= outSize - used) break;   // truncate cleanly
            used += w2;
        }

        if (used >= outSize - 1) return -1;
        out[used++] = ';';
        out[used]   = '\0';
    }

    // Threat entries: "attacker:bullet:tHitMs:dmg:pierce", comma separated.
    for (int i = 0; i < count; ++i) {
        const int wrote = snprintf(out + used, static_cast<size_t>(outSize - used),
                                   "%s%d:%d:%.1f:%d:%d",
                                   (i == 0) ? "" : ",",
                                   threats[i].attackerObjId, threats[i].bulletId,
                                   static_cast<double>(threats[i].tHitMs),
                                   threats[i].fallbackDamage,
                                   threats[i].fallbackArmorPiercing ? 1 : 0);
        if (wrote <= 0 || wrote >= outSize - used) break;   // truncate cleanly
        used += wrote;
    }

    // Trailing truncated flag: ";<T>".
    if (used >= outSize - 2) return -1;
    out[used++] = ';';
    out[used++] = truncated ? '1' : '0';
    out[used]   = '\0';

    return used;
}

} // namespace IpcMessages
