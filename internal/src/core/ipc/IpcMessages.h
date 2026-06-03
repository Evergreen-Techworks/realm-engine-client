// Purpose: JSON builders for all DLL-to-client IPC message types.

// Helpful notes:
// - Callers own output buffers and pass sequence/MAC values for signed messages.
// - BuildPlayerSigPayload produces the canonical payload string used when
//   signing player updates.

#pragma once
#include <cstdint>

namespace IpcMessages {

int BuildHello(char* buf, int bufSize, const char* challenge);
int BuildAuthResult(char* buf, int bufSize, bool ok, const char* response);
int BuildHeartbeat(char* buf, int bufSize, const char* nonce, uint64_t seq, const char* mac);
int BuildHeartbeatResp(char* buf, int bufSize, const char* response, uint64_t seq, const char* mac);
int BuildUnresolvedClasses(char* buf, int bufSize, const char* classes, uint64_t seq, const char* mac);
int BuildPlayer(char* buf, int bufSize, uint64_t seq, const char* mac);
int BuildHotkeyEvent(char* buf, int bufSize, const char* pluginId, const char* action, bool value, uint64_t seq, const char* mac);
void BuildPlayerSigPayload(char* outBuf, int outBufSize);

} // namespace IpcMessages
