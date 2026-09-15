# Current-game shooting fixtures

No captured weapon fixtures are available yet. Synthetic packet unit tests are not gameplay acceptance evidence.

Each sanitized capture consists of the plan's `ShotTrace` object and a provenance record. The trace carries `pinHash`, `caseName`, `mode` (`native` or `script`), `frames` (`atMs`, full `bytesHex`, `verifiedAngleByteOffsets`), `expectedProjectileCounts` and `cadenceToleranceMs`.

Provenance records capture time, exact GameAssembly/metadata/collector hashes, source artifact hash, observation/review method, equipment and conditions, verified meanings of any weapon/subattack/pattern identifiers, whether each timestamp is an attempt or serialized send, angle-offset justification, count/tolerance justification, target changes, weapon-switch boundary and server acceptance/rejection observations.

Required native/script pairs: ordinary weapon, mixed-rate subattacks, burst longbow, pattern cycling, enchanted reduced fire rate, switch during burst. Compare like equipment and conditions. Review volley identities/counts and intervals; do not compare unrelated packet IDs between separate play sessions.

Keep only PLAYERSHOOT frames and necessary non-sensitive observations. Exclude HELLO, credentials, authentication/session/reconnect keys, player account details and unrelated packet captures. Preserve unknown fields and trailing bytes; never fill gaps with archive formulas.

Validation must reject missing pin/provenance, invalid/negative/non-monotonic timestamps, malformed hex, frame-length mismatch and unsupported claimed angle offsets. Before/after rewrites of the same frame may change only explicitly reviewed angle/coordinate bytes. Changing `attackIndex`, `bulletId`, `unknownShort` or any unknown/trailing byte must fail. Counts and tolerance are capture-reviewed inputs, never inferred production rules.

Task 10's real-cadence acceptance and its specified commit remain blocked until actual reviewed pairs exist. Do not add skipped tests or synthetic captures to imply that gate passed.
