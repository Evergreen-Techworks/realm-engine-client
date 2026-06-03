// Purpose: small, allocation-free JSON token helpers for the constrained bridge
// message shapes exchanged with the Electron client.

// Helpful notes:
// - These helpers are intentionally not a general JSON parser.
// - They assume compact bridge messages with known keys and simple scalar values.
// - String values are copied into caller-owned fixed buffers and truncated safely.

#include "pch-il2cpp.h"
#include "IpcJson.h"

#include <cstring>
#include <cstdio>

namespace IpcJson {

char* GetString(char* json, const char* key, char* valBuf, int valBufSize)
{
    char pattern[128];
    snprintf(pattern, sizeof(pattern), "\"%s\":\"", key);
    char* start = strstr(json, pattern);
    if (!start) return NULL;
    start += strlen(pattern);
    char* end = strchr(start, '"');
    if (!end) return NULL;
    int len = (int)(end - start);
    if (len >= valBufSize) len = valBufSize - 1;
    memcpy(valBuf, start, len);
    valBuf[len] = '\0';
    return valBuf;
}

bool GetBool(char* json, const char* key)
{
    char valBuf[16] = {};
    if (GetString(json, key, valBuf, sizeof(valBuf))) return strcmp(valBuf, "true") == 0 || strcmp(valBuf, "1") == 0;
    char pattern[128];
    snprintf(pattern, sizeof(pattern), "\"%s\":", key);
    const char* p = strstr(json, pattern);
    if (!p) return false;
    p += strlen(pattern);
    while (*p == ' ') p++;
    return strncmp(p, "true", 4) == 0;
}

bool GetNumberToken(char* json, const char* key, char* outBuf, int outBufSize)
{
    if (!json || !key || !outBuf || outBufSize <= 1) return false;
    char pattern[128];
    snprintf(pattern, sizeof(pattern), "\"%s\":", key);
    const char* p = strstr(json, pattern);
    if (!p) return false;
    p += strlen(pattern);
    while (*p == ' ') p++;
    int i = 0;
    if (*p == '-') { if (i < outBufSize - 1) outBuf[i++] = *p; ++p; }
    bool seenDigit = false;
    while ((*p >= '0' && *p <= '9') || *p == '.') { seenDigit = true; if (i >= outBufSize - 1) return false; outBuf[i++] = *p++; }
    if (!seenDigit) return false;
    outBuf[i] = '\0';
    return true;
}

} // namespace IpcJson
