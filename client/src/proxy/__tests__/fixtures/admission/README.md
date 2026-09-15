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
