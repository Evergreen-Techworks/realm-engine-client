/**
 * Namespace string for per-user AES-256-GCM script key derivation.
 *
 * ⚠️  This is NOT a secret. Realm Engine is open source; this value ships in
 * every public build. Its purpose is to namespace/domain-separate the key
 * derivation so that userId + hwid alone don't derive a raw AES key that
 * collides with any other system, and to let a marketplace operator run a
 * private fork with a different namespace (rebuild both server and client
 * with the same replacement value, and payloads encrypted for one universe
 * will not decrypt in the other).
 *
 * If you are the operator of an encrypted-script marketplace and you need the
 * derivation output to be genuinely unrecoverable by a client-side attacker,
 * a shared string in an open-source client is the wrong primitive — do the
 * derivation server-side and deliver the derived key over an authenticated
 * channel. See the notes in `ScriptDecryptor.ts` for the current model's
 * threat surface.
 *
 * Key derivation (matched on both client and server):
 *   HMAC-SHA256(SCRIPT_RUNTIME_NAMESPACE, "${userId}:${hwid}")
 *
 * The resulting 32-byte digest is the per-user AES-256-GCM key. It is unique
 * per (userId, hwid) pair for the given namespace, so payloads encrypted for
 * one machine will not decrypt on another under the same namespace.
 */
export const SCRIPT_RUNTIME_NAMESPACE = 'realmengine-script-runtime-v1';

/**
 * @deprecated Renamed to {@link SCRIPT_RUNTIME_NAMESPACE} — the "SECRET"
 * suffix was misleading in an open-source client. Kept as a re-export so
 * existing imports still resolve; new code should import the namespace name.
 */
export const SCRIPT_RUNTIME_SECRET = SCRIPT_RUNTIME_NAMESPACE;
