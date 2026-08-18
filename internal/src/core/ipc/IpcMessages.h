// Purpose: JSON builders for all DLL-to-client IPC message types.

// Helpful notes:
// - Callers own output buffers.
// - Messages are plaintext, dispatched by "type" — no seq/mac envelope.

#pragma once

namespace IpcMessages {

int BuildHello(char* buf, int bufSize);
int BuildHeartbeat(char* buf, int bufSize);       // {"type":"heartbeat"}
int BuildHeartbeatResp(char* buf, int bufSize);   // {"type":"heartbeatResp"}
int BuildUnresolvedClasses(char* buf, int bufSize, const char* classes);
int BuildPlayer(char* buf, int bufSize);
int BuildHotkeyEvent(char* buf, int bufSize, const char* pluginId, const char* action, bool value);
int BuildThreats(char* buf, int bufSize, const char* threats);

} // namespace IpcMessages
