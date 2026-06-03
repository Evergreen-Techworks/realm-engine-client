#pragma once
/**
 * Handshake.h — Mutual authentication + heartbeat between bot-client and DLL.
 *
 * Uses HMAC-SHA256 (Windows BCrypt/CNG) with a shared secret baked in at
 * build time.  Both sides prove possession of the key via challenge-response.
 *
 * Protocol:
 *   1. DLL sends hello with a 32-byte hex challenge.
 *   2. Bot sends auth{userId, response: HMAC(challenge‖userId, key), challenge2}.
 *   3. DLL verifies, stores userId, replies authResult{ok, response: HMAC(challenge2, key)}.
 *   4. Session key = HMAC(serverChallenge|clientChallenge|userId|session-v1, key).
 *      All post-auth control/heartbeat messages include monotonic seq + mac:
 *      mac = HMAC(seq|type|payload, sessionKey).
 *   5. Every HEARTBEAT_INTERVAL_MS each side sends signed heartbeat{nonce} and
 *      expects signed heartbeatResp{resp: HMAC(nonce, key)} within timeout.
 *   6. HEARTBEAT_MAX_MISSES consecutive misses → disconnect + disable.
 */

#include <cstdint>
#include <cstddef>
#include <Windows.h>

namespace Handshake {

// ── Timing constants ────────────────────────────────────────────────────────
constexpr DWORD HEARTBEAT_INTERVAL_MS = 5000;   // send a challenge every 5 s
constexpr DWORD HEARTBEAT_TIMEOUT_MS  = 3000;   // response must arrive within 3 s
constexpr int   HEARTBEAT_MAX_MISSES  = 3;       // 3 missed → kill

// ── Crypto primitives (Windows CNG) ─────────────────────────────────────────

// HMAC-SHA256.  Returns true on success.  `out` must be at least 32 bytes.
bool HmacSha256(const uint8_t* key, size_t keyLen,
                const uint8_t* data, size_t dataLen,
                uint8_t out[32]);

// Fill buffer with cryptographic random bytes.
bool GenRandom(uint8_t* buf, size_t len);

// ── Hex helpers ─────────────────────────────────────────────────────────────

// Encode `len` bytes to hex into `out` (must be at least len*2+1).
void ToHex(const uint8_t* data, size_t len, char* out);

// Decode hex string of `hexLen` chars into `out`.  Returns decoded byte count.
int FromHex(const char* hex, size_t hexLen, uint8_t* out, size_t outCap);
bool IsHexString(const char* s, size_t len);

// ── Build-time shared secret ─��──────────────────────────────────────────────

// Returns pointer to the 32-byte shared key (decrypted via xorstr at runtime).
const uint8_t* GetSharedKey();
bool IsSharedKeyStrong();
void ClearSharedKeyCache();

// ─��� Auth state ──────────────────────────────────────────────────────────────

struct AuthState {
    bool   authenticated;
    char   userId[128];        // authenticated user ID (UUID string)
    int    heartbeatMisses;    // consecutive missed heartbeats from client
    ULONGLONG lastHeartbeatSent;
    ULONGLONG lastHeartbeatRecv;
    char   pendingChallenge[65]; // hex nonce we're waiting for a response to
    bool   challengePending;
    uint8_t sessionKey[32];    // per-session key derived after auth
    bool    sessionReady;
    uint64_t lastClientSeq;    // last accepted client sequence number
    uint64_t nextServerSeq;    // next sequence number for DLL->client messages
};

void ResetAuthState(AuthState* state);

// Returns true if currently authenticated and heartbeat is healthy.
bool IsHealthy(const AuthState* state);

// ── Challenge generation & verification ─────────────────────────────────────

// Generate a 32-byte random challenge, write hex to `hexOut` (65 bytes incl NUL).
bool GenerateChallenge(char hexOut[65]);

// Compute HMAC(data, key) and write hex to `hexOut` (65 bytes incl NUL).
bool ComputeResponse(const char* data, size_t dataLen, char hexOut[65]);

// Verify that `hexResp` matches HMAC(data, key).
bool VerifyResponse(const char* data, size_t dataLen, const char* hexResp);

} // namespace Handshake
