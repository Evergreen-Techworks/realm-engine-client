// Purpose: fixed-buffer JSON field extraction helpers used by the IPC bridge.

// Helpful notes:
// - Use for known bridge message fields only; this is not a full JSON parser.
// - GetString returns valBuf on success and null on missing/malformed fields.
// - GetBool and GetNumberToken support both auth/heartbeat and setFeature paths.

#pragma once

namespace IpcJson {

char* GetString(char* json, const char* key, char* valBuf, int valBufSize);
bool GetBool(char* json, const char* key);
bool GetNumberToken(char* json, const char* key, char* outBuf, int outBufSize);

} // namespace IpcJson
