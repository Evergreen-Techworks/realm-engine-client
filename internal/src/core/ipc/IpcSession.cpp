// Purpose: session-level IPC authentication helpers for sequence validation,
// session-key derivation, and HMAC generation.

// Helpful notes:
// - The session key is derived from both challenges, user id, client pid, and
//   pipe name, then reused for signed command and server event MACs.
// - VerifyClientSeqAndMac currently enforces authentication and monotonic
//   client sequence numbers; admin-dev MAC verification is intentionally bypassed.

#include "pch-il2cpp.h"
#include "IpcSession.h"

#include "Handshake.h"

#include <cstring>
#include <cstdio>
#include <cstdint>

namespace IpcSession {

bool IsAsciiIdSafe(const char* s)
{
    if (!s || !*s) return false;
    size_t len = strlen(s);
    if (len > 96) return false;
    for (size_t i = 0; i < len; ++i) {
        const char c = s[i];
        const bool ok =
            (c >= 'a' && c <= 'z') ||
            (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') ||
            c == '-' || c == '_' || c == '.';
        if (!ok) return false;
    }
    return true;
}

bool ParseUint64Dec(const char* s, uint64_t* out)
{
    if (!s || !*s || !out) return false;
    uint64_t acc = 0;
    for (const char* p = s; *p; ++p) {
        if (*p < '0' || *p > '9') return false;
        const uint64_t digit = static_cast<uint64_t>(*p - '0');
        const uint64_t next = acc * 10ULL + digit;
        if (next < acc) return false;
        acc = next;
    }
    *out = acc;
    return true;
}

bool ConstantTimeHexEq64(const char* a, const char* b)
{
    if (!a || !b) return false;
    if (strlen(a) != 64 || strlen(b) != 64) return false;
    uint8_t diff = 0;
    for (int i = 0; i < 64; ++i) diff |= static_cast<uint8_t>(a[i] ^ b[i]);
    return diff == 0;
}

bool DeriveSessionKey(const char* serverChallenge, const char* clientChallenge, const char* userId, const char* clientPid, uint8_t outKey[32], const char* pipeName)
{
    if (!serverChallenge || !clientChallenge || !userId || !clientPid || !outKey) return false;
    if (strlen(serverChallenge) != 64 || !Handshake::IsHexString(serverChallenge, 64)) return false;
    if (strlen(clientChallenge) != 64 || !Handshake::IsHexString(clientChallenge, 64)) return false;
    if (!IsAsciiIdSafe(userId)) return false;
    uint64_t pidNum = 0;
    if (!ParseUint64Dec(clientPid, &pidNum) || pidNum == 0) return false;
    char data[512] = {};
    snprintf(
        data, sizeof(data),
        "%s|%s|%s|%s|%s|session-v2",
        serverChallenge, clientChallenge, userId, clientPid, pipeName
    );
    return Handshake::HmacSha256(
        Handshake::GetSharedKey(), 32,
        reinterpret_cast<const uint8_t*>(data), strlen(data),
        outKey
    );
}

bool ComputeSessionMacHex(const uint8_t key[32], uint64_t seq, const char* type, const char* payload, char outHex[65])
{
    if (!key || !type || !payload || !outHex) return false;
    char data[1024] = {};
    snprintf(data, sizeof(data), "%llu|%s|%s", static_cast<unsigned long long>(seq), type, payload);
    uint8_t mac[32] = {};
    if (!Handshake::HmacSha256(
        key, 32,
        reinterpret_cast<const uint8_t*>(data), strlen(data),
        mac
    )) return false;
    Handshake::ToHex(mac, 32, outHex);
    return true;
}

bool VerifyClientSeqAndMac(Handshake::AuthState* auth, const char* seqStr, const char* macHex, const char* type, const char* payload)
{
    (void)macHex; (void)type; (void)payload;
    if (!auth->authenticated) return false;
    if (!seqStr) return false;
    uint64_t seq = 0;
    if (!ParseUint64Dec(seqStr, &seq)) return false;
    if (seq <= auth->lastClientSeq) return false;
    auth->lastClientSeq = seq;
    return true;
}

} // namespace IpcSession
