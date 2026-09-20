# Admission evidence gate

The checked packet definitions establish QUEUEMESSAGE curPos/maxPos and
QUEUECANCEL. Queue position zero means pending admission, not a loaded player.
MAPINFO followed by CREATESUCCESS establishes map and character readiness.

No current-pin server-full or portal-refusal capture is available here. FAILURE
is therefore exposed as generic observed rejection with unknown semantics.
No ActionScript error 11/15 mapping or eight-second retry rule is enabled.
Semantic portal-refusal tests are synthetic policy tests, not protocol evidence.

Before enabling a mapping, add sanitized decrypted frames with build SHA-256,
capture provenance, decoded fields, trailing bytes, and independently verified
server meaning. Exclude credentials, HELLO and reconnect keys. Synthetic retry
exhaustion retains existing wire bytes and is labeled transport in diagnostics.

## SDK projection

World.getConnectionStatus() returns a detached status snapshot or null.
Portal.availability and optional retryAt are additive; isOpen still represents
the existing population estimate. Queue zero and all queued states block SDK
USEPORTAL writes. Portal closures capture both connection identity and generation.
Only a loaded map permits entry. A pending attempt is latched until a confirmed
transition or a validated refusal; no archive timeout is guessed for a silent
portal response. A semantic portal-refused event clears that attempt and preserves
the existing hub world, allowing another portal or one retry after its deadline.

RecoveryCoordinator owns only ESCAPE requests and bounded resends. Transport
retry timers remain owned by ClientConnection. HELLO/map/character replacements
advance one process-wide generation token. Reconnect handoffs are generation
checked and consumed once; raw HELLO bytes and unknown fields remain preserved.
