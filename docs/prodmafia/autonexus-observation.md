# Auto Nexus observation handoff

Date: 2026-09-15. AutoNexus branch starts at reviewed connection tip `319008fe124a6f2211a93c5fefd1cfeee55f02a0`. It reuses only predictive feature `2c5f952` as local `a4cc783`; unrelated USEITEM commit `26d3898` is not imported. Connection followup `e66f0ca` is integrated separately by the controller.

## Existing feature, changed ownership

| Responsibility | Before | After |
| --- | --- | --- |
| Plugin registration and settings | Existing `plugins/auto-nexus.ts` | Same plugin, same confirmed-health controls; prediction defaults to observe |
| Confirmed HP threshold/burst guard | Existing Auto Nexus server-health path | Unchanged authority; no prediction values overwrite it |
| Outgoing-hit prediction | Imported shot charges, erased on explicit HP | Internal bounded `HealthEvidence` comparison; partial/ambiguous acknowledgements retained |
| ESCAPE initial send/retries/latch | Plugin-owned interval and escaped flag | Only existing `client.recovery.requestEscape(generation, options)`; old interval/latch removed |
| TCP and real RECONNECT | ClientConnection / ReconnectHandler | Same transport owners; plugin never closes sockets |
| Native threat scan | Existing scan bus | Same scan-only publisher; no native ESCAPE sender, ground prediction or overlay added |

Helper modules are internal refactors of this feature, not additional plugins or competing senders. The only remaining plugin interval polls forecast observations. Disable/unload cancels escape requests without disposing transport. A notification says **Escape requested**, never claims Nexus arrival merely because a send was attempted.

## Prediction gate and comparison semantics

Production `register(ctx)` defaults to `observe`; saved `PredictionMode=active`, legacy forecast=true and invalid mode values cannot enable predictive sends. Only off/observe are offered as settings. Existing active-path unit tests explicitly inject a test permission; this is not persisted configuration or production activation. Ambiguous evidence still refuses predictive activation even in those tests.

The confirmed escape point remains `max(configured threshold, min(0.5 * maxHp, 1.25 * largest confirmed recent burst))`, retaining the existing 400 ms window, six-second memory and deliberate zero-threshold exception. Observations distinguish crossing that threshold from forecast lethality; no additional adaptive margin is added.

`HealthEvidence.confirmedHp` is a **comparison copy**, including identified DAMAGE reconciliation, not a replacement server-health authority. Matching DAMAGE replaces pending debt once. Explicit HP consumes no more than observed loss, oldest first; partial loss, healing/net loss, unknown ordering and unattributed DAMAGE mark ambiguity. Covered-loss tombstones prevent later matching DAMAGE from blindly charging HP twice. A fresh explicit HP sample is authoritative for the comparison; stale timestamps cannot resurrect HP zero. Unknown DAMAGE does not invent an identity or overwrite comparison HP. Existing production confirmed-DAMAGE behavior remains unchanged and may differ from the conservative comparison.

Pending/tombstone storage is capped at 4096 entries. Pending expiry uses the existing shot lifetime cap plus round-trip allowance, at most 12000 ms; acknowledgement history survives up to another 12000 ms. These are bounded reuse of existing TTL policy, not measured Exalt acknowledgement windows. Expiry drops debt, not HP. Eviction/expiry/identity reuse mark ambiguity. Adapter identities include recovery generation, owner incarnation, wrapped uint16 bullet ID and receipt sequence; raw/applied damage and receipt/expiry stay in the shot/evidence records. Same-key overlapping announcements and removal/recreation cannot prove which shot an indistinguishable later wire event refers to, so they cannot authorize active prediction. Ambiguity intentionally persists until reset; this favors honesty over false precision.

Defense, unknown piercing and condition rules remain tested estimates, not knowledge of future confirmed damage. XML-only damage, native numeric fallback, synthetic AoE and ground geometry do not create chargeable sources. The current native bus has **no generation or server-anchor provenance**. Receive-age/reset checks reject demonstrably old scans but cannot establish a current scan's source identity or spatial correctness. Server-anchor disagreement and movement tests therefore prove refusal to claim certainty, not correctness of native hit geometry.

## Bounded observation infrastructure

The existing plugin keeps one latest prediction snapshot per client and at most 32 recovery transition records in weakly owned memory. Snapshots include monotonic sample time, generation, authoritative confirmed HP/age, comparison pending damage/certainty, predicted HP, earliest impact, effective threshold, native scan age, mode and separate threshold/lethality decisions. Transition records contain only kind (`escape-requested`, `reconnect`, `mapinfo`), generation and monotonic time. They survive health reset/CREATESUCCESS without carrying old health into a new character. An accepted-request timestamp follows the synchronous initial-send attempt; it is not a measured server arrival time.

The returned diagnostic accessors provide copies for controlled observation/replay tooling. No automatic file exporter, raw packet logger, persistent trace hook, account/session key or HELLO capture is added. Do not use existing debug channels that log reconnect keys for evidence collection. Any export requires owner-approved sanitization and a reviewed pin/provenance record.

## Validation and remaining gate

Task 11 defaults: five regressions fail before the fix, then pass; 49 focused tests and both typechecks pass. Task 12: missing evidence module fails first; production debt/reuse regressions fail 2 before adapter integration; 13 pure evidence tests and 36 predictive/condition tests pass. The historical Jellyfish reconstruction now reports ambiguity instead of claiming it would necessarily save that character.

Task 13: actual-coordinator fixture exposes three ownership failures before the fix. Request/arrival wording and lost transition history expose two further failures; acknowledged-DAMAGE diagnostic freshness exposes another. Final full client suite: **52 files / 489 tests passed**, both typechecks pass. Loopback tests use real recovery ownership and synthetic sockets, not game admission evidence. Native sources are unchanged on this branch; final native runner result is recorded in the root ledger. Existing confirmed-health max-HP, 400 ms burst and six-second memory tests remain active. PLAYERHIT and DAMAGE (including opaque trailing bytes) are checked unchanged.

**Task 14 current-game evidence is pending.** No sanitized current-pin observation captures are available, so no captured-replay test, invented fixture or skipped acceptance test is supplied. Needed cases: ordinary hits, combined volleys, heals interleaved with damage, condition changes, ground/AoE, server-anchor disagreement, and deliberate harness stalls. Capture expectations must be independently reviewed, including false predictive escapes, missed threats, double charges, ambiguity and actual request/reconnect/map timings. Lethal scenarios belong in deterministic replay, never deliberate danger to the owner's character.

No active-policy formula or default is approved. A later activation patch requires real evidence, an explicit owner decision, tests and default/migration review. Native 16 ms polling is not end-to-end escape latency; no survival guarantee, gameplay fix or measured latency improvement is claimed. No Windows mirror, linked native build, portable build, push or deployment occurred.

## Activation — owner decision 2026-09-22

The owner activated prediction by default and widened the forecast's damage
sources, ending the observation-only era. This section is the explicit owner
decision the paragraph above required; the Task 14 capture gate remains
unmet and the owner's live sessions are the acceptance path.

- `PredictiveNexusMode` (Off/Observe/Active, default **Active**) replaces
  `PredictionMode`. The observe-era key is retired like the pre-09-06
  settings — saved values are ignored by config replay, so a stale
  `PredictionMode: 'observe'` cannot keep prediction off. An invalid value
  still never activates. The test-permission hook is removed; production and
  tests drive the same setting.
- Global evidence ambiguity no longer vetoes a prediction-origin escape.
  It was sticky for a whole map once any enemy with live shots died, which
  would have kept active prediction dead in exactly the fights that kill.
  Per-shot ambiguity still refuses that shot; the escape log names
  `evidence=ambiguous`.
- The forecast counts bullets without a packet record at the DLL's fallback
  damage, else the assumed damage (175, piercing — MultiTool Class89's value,
  `PredictiveNexusAssumedDamage`). `PredictiveNexusUnknownDamage` (default
  on) switches it off. A packet record always wins; the synthetic 9999
  marker, ground/AoE geometry and XML-only damage still never charge.
- `escape()` reports whether a request went out, so a latched recovery keeps
  observing the rest of the volley instead of truncating the observation.

### Option C — full #52 coverage (same day, owner decision)

- **Ground**: `PredictiveNexusGround` (default on) arms the native tile
  predictor (`autoNexusTilePredict`) and charges its ground forecasts — the
  soonest event within the horizon, in full (piercing; tile damage has no
  projectile defense rules here). The wire GROUNDDAMAGE/AOEACK packets carry
  no damage, so the native channel is the only ground source.
- **AoE**: `PredictiveNexusAoe` (default on) tracks server AOE packets —
  which carry their own position, radius, damage and armorPierce — for their
  duration (seconds/ms per AoeCapturePolicy) and charges every zone the
  player stands inside, at the packet's own numbers.
- **Regen**: the method_29 model (2*(1+0.12*VIT)/s, +20 Healing, none Sick,
  −20 Bleeding, halved in combat) accrues as credit between explicit server
  HPs and lifts `predictedHp`, capped at max HP; any explicit HP restarts it.
  It is a prediction like any other — it can only delay, never veto.
- **Unknown PLAYERHIT**: a hit the game reports for a bullet the server never
  announced charges the assumed damage as a real shot record, so the forecast
  cannot double-count it and a server DAMAGE reconciles it like any charge.
  Follows `PredictiveNexusUnknownDamage`.
- Still never: packet holding/dropping/modification, native ESCAPE, the debug
  overlay, XML-only damage as a bullet source.
