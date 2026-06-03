// Purpose: implements the bridge wire framing used on the named pipe.

// Helpful notes:
// - Every JSON message is prefixed with a 32-bit byte length.
// - ReadMessage is non-blocking when fewer than four bytes are available and
//   returns 0 so the bridge loop can continue ticking heartbeats/events.
// - A negative return means disconnect, malformed length, or pipe read failure.

#include "pch-il2cpp.h"
#include "IpcFraming.h"

#include <cstdint>

namespace IpcFraming {

bool WriteMessage(HANDLE hPipe, const char* json, int len)
{
    uint32_t netLen = static_cast<uint32_t>(len);
    DWORD written = 0;
    if (!WriteFile(hPipe, &netLen, 4, &written, NULL) || written != 4) return false;
    if (!WriteFile(hPipe, json, netLen, &written, NULL) || written != netLen) return false;
    return true;
}

int ReadMessage(HANDLE hPipe, char* buf, int bufSize)
{
    DWORD bytesAvail = 0;
    if (!PeekNamedPipe(hPipe, NULL, 0, NULL, &bytesAvail, NULL)) return -1;
    if (bytesAvail < 4) return 0;
    uint32_t msgLen = 0;
    DWORD bytesRead = 0;
    if (!ReadFile(hPipe, &msgLen, 4, &bytesRead, NULL) || bytesRead != 4) return -1;
    if (msgLen == 0 || msgLen >= (uint32_t)bufSize) return -1;
    if (!ReadFile(hPipe, buf, msgLen, &bytesRead, NULL) || bytesRead != msgLen) return -1;
    buf[msgLen] = '\0';
    return (int)msgLen;
}

} // namespace IpcFraming
