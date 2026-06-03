// Purpose: length-prefixed named-pipe message framing for IPC JSON payloads.

// Helpful notes:
// - WriteMessage expects len to be the exact payload byte count.
// - ReadMessage writes a null terminator after the payload for downstream
//   string-based JSON helpers, but the terminator is not part of the frame.

#pragma once
#include <Windows.h>

namespace IpcFraming {

bool WriteMessage(HANDLE hPipe, const char* json, int len);
int ReadMessage(HANDLE hPipe, char* buf, int bufSize);

} // namespace IpcFraming
