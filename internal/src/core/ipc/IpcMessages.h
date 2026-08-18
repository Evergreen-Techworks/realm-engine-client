// Purpose: JSON builders for all DLL-to-client IPC message types.

// Helpful notes:
// - Callers own output buffers.
// - Messages are plaintext, dispatched by "type" — no seq/mac envelope.

#pragma once

#include "IpcBridge.h"   // IpcThreat / IpcGround

namespace IpcMessages {

// Threat wire schema version. Bump only in lockstep with the TS decoder's
// THREAT_SCHEMA_VERSION in client/src/bridge/DllThreatBus.ts. A version skew is
// rejected loud on the client (empty threat list) rather than silently misread.
//
// Wire layout (version 1), emitted by EncodeThreats and parsed by
// decodeThreatPayload — the two must agree byte-for-byte:
//   1;<ground>;<threats>;<T>
//     <ground>  = <rawDamage>:<tHitMs>[|<rawDamage>:<tHitMs>]*
//     <threats> = <attackerObjId>:<bulletId>:<tHitMs>:<fallbackDamage>:<fallbackArmorPiercing>
//                 (comma-separated; field order is authoritative here and in the decoder)
//     <T>       = 0 | 1  truncated flag (the DLL shed threats/ground under load)
constexpr int THREAT_SCHEMA_VERSION = 1;

int BuildHello(char* buf, int bufSize);
int BuildHeartbeat(char* buf, int bufSize);       // {"type":"heartbeat"}
int BuildHeartbeatResp(char* buf, int bufSize);   // {"type":"heartbeatResp"}
int BuildUnresolvedClasses(char* buf, int bufSize, const char* classes);
int BuildPlayer(char* buf, int bufSize);
int BuildHotkeyEvent(char* buf, int bufSize, const char* pluginId, const char* action, bool value);
int BuildThreats(char* buf, int bufSize, const char* threats);

// The ONE home that serializes threat objects to the compact wire string
// (see THREAT_SCHEMA_VERSION above). Returns bytes written, or -1 on failure.
int EncodeThreats(char* out, int outSize, const IpcThreat* threats, int count,
                  const IpcGround& ground, bool truncated);

} // namespace IpcMessages
