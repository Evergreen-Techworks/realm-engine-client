# Private 1.0.6 candidate: request audit and test handoff

2026-09-15. This document preserves the requested desktop work and outstanding
acceptance gates. It is not public-release approval or a claim that disconnects
are eliminated. The private build references
`85f3cf0c056a88f246e19e0438c30ce8f499102b` plus preserved Windows-local files;
it is not byte-identical to that checkout. Its receipt records six differing
paths and nineteen local-only build inputs. A subsequent PR carry preserves
the existing UI fixes and WIP labels already present in the artifact, without
changing or rebuilding that artifact.

The artifact SHA-256 is
`50c6ef11e0cdc7ab5bc6b6309009cef08ea69c3101655650403bc482275b65c3`;
its receipt status is `candidate_requires_gameplay_test`.

The historical UI change `8169f83` avoids identical select-option notifications
and preserves the last real class list while a new connection reports class
zero. Its two regression files are carried here, including the map-transition
test present only in Windows at build time. Historical `7cbdf28` marks both
Lost Halls farmer manifests WIP. The developer-local `sync-local.bat` path
override is intentionally not copied into shared source. Remaining local-only
inputs include generated headers, native/assets binaries, script READMEs and
test artifacts; they are recorded in the build receipt, not represented as
newly authored feature code.

## Included desktop requests

| Request | Included implementation and provenance | Remaining verification |
| --- | --- | --- |
| Navigation Stage 1, Tasks 0–11 | Reviewed `fd3c301`, merged as `5b28323`; shared collision, ground-speed timing, lock liveness and scenario checks; native offset and script firing prerequisites retained | Native collision defaults to `legacy`; explicitly compare `game` mode in playtests. Later navigation stages are not implemented here. |
| Faster Oryx/Wine Cellar travel and both spawns | `bc89d58`; skip nearby Cellar trash, prefer observed O2, retain connected-terrain routing and mirrored-spawn tests | Test both actual spawns, known and progressively revealed maps; no invented speed increase. |
| Dead bosses holding scripts in combat | `58485fc`; release confirmed-dead encounters, including HP-zero world-object fallback, without treating missing or invulnerable entities as dead | Confirm real phase transitions and the retained loot/phase window. |
| Potion bag slots and AutoAbility disconnect suspects | `b61e113`; correct consumption mode/position, preserve actual bag indices, share potion reservations, mana budgets, cooldowns and connection timestamps | A unique slot-2/3 indexing failure and the exact live disconnect cause were not proven; test the isolation matrix below. |
| Existing startup improved using ProdMafia findings | Reviewed `1d51ae7`, in `0481bd8`; optional metadata no longer delays required services; await actual plugin registration | Cold/warm/offline Windows startup measurements remain outstanding; no fixed speedup is claimed. |
| Full-server admission and rejoining | Reviewed `e66f0ca`, in `0481bd8`; bounded retries, queue-zero is not admission, portal guards and generation-scoped recovery | Unknown game error mappings remain conservative. No universal full-server success claim or unlimited retry loop. |
| Shooting improvements | Reviewed `6c69711`, in `0481bd8`; native firing readiness separated from an unverified manual angle binding; packet-preservation and synthetic trace checks | Current-game captured cadence/burst evidence is missing. Manual diagnostic autofire remains fail-closed; no replacement scheduler or firing-speed increase. |
| AutoNexus like ProdMafia, integrated into our plugin | Reviewed `20bacc0`, in `0481bd8`; bounded pending-damage evidence, HP reconciliation, forecast validation and shared recovery | Predictions remain observation-only; confirmed-health escape stays active. No immediate socket teardown or hit suppression. Captured replay and activation review remain outstanding. |
| Preserve prior Windows fixes while integrating | `d8703b6` retains loopback/Host/Origin protections; `85f3cf0` retains longest XML/per-item cooldowns and conservative ambiguous-send behavior | Private build must contain these exact carries, not an old whole-file overwrite. |

All reviewed desktop histories are retained through normal merges. The combined
item/script merge is `b235d08`; ProdMafia integration is `0481bd8`. These improve
existing modules rather than installing a second competing set of plugins.

## Recorded combined validation

Actual validation at executable revision `85f3cf0`, not estimated from separate
branch totals:

- SDK generation; production and test TypeScript checks pass.
- Client: **62 files / 574 tests pass**; bridge contract **174 DLL / 155 sendable /
  21 DLL-only / 2 known-unhandled**; packet drift and diff checks pass.
- Native host: pathing **41**, collision **36**, speed **18**, enemy tracker **69**,
  autofire **79**, standalone shooting readiness **30**, all pass.
- Scenarios: `legacy` **33 asserted / 4 known limitations**; `game` **35 asserted /
  2 known limitations**. Other native baseline suites pass.
- Windows MSVC `/Zs`: **20 translation units pass**. Syntax checks alone are not
  a linked portable, game acceptance, measured latency or proof of survival.
- Earlier ProdMafia integration report records eight reversible regression
  mutations and the separate **523-test** integration baseline. The final
  candidate count above supersedes that total for this candidate.

After carrying the preserved Windows UI behavior and WIP labels into the PR,
both historical UI regressions first failed against the checkout, then passed
with the carry. The full suite now passes **63 files / 577 tests**, with both
TypeScript checks and diff checks passing. This tests the preservation commit;
it does not claim the unchanged artifact was built from that later commit.

Reproduction commands: from `client/`, `npm run build:sdk`, `npm test`,
`npm run typecheck`, `npm run typecheck:tests`; from the repository root,
`python3 internal/tests/run_udodge_zone_tests.py`. The standalone readiness test
is `internal/tests/shoot_binding_readiness_tests.cpp`.

## Private packaging and owner playtest

The separate pipeline branch owns the legacy `version.dll` / `winhttp.dll`
preflight and actionable clean-folder guidance. This client PR alone does not
contain that monorepo overlay. Do not silently delete customer DLLs, overwrite
profiles, terminate existing sessions or disable antivirus. The private build
uses explicit version `1.0.6`, verified pinned game inputs, frozen defaults and
scoped source copies with original-file backups. No upload/notification is part
of this handoff. The build controller must record the final EXE hash and build
receipt before calling the artifact delivered.

Test using a disposable character/account situation where loss is acceptable:

1. Launch on clean and previously used Windows profiles; preserve existing
   settings. Confirm stale-DLL detection produces an actionable message rather
   than a silent launch failure. Do not add stale loaders to a working install.
2. Test loot only, ability only, potion only, then combined and manual/script
   input. Exercise bag potion indices 0/1/2, empty slots, changing quantities,
   zero/below/exact-cost mana, refill, cooldown, Quiet/Silenced and map changes.
   Conservative pauses awaiting authoritative state are possible; record them.
3. Run both Cellar spawns, race toward O2 past trash, and verify confirmed death
   releases movement while genuine phases remain supported.
4. Compare navigation `legacy` and opt-in `game`: walls, diagonal pinches,
   water/land, speed conditions, boss keepouts and target death/invulnerability.
5. Test normal transitions, real queue admission and a longer combined session.
   If disconnected, record time, immediate action and visible error; retain
   sanitized logs privately, never credentials or raw session packets.
6. Review AutoNexus observations against confirmed health before authorizing
   predictive activation. Check normal shooting without claiming synthetic
   fixtures establish current-game cadence.

Any failed gameplay gate blocks public distribution. Preserve the release
publish policy and rollback artifact; no PR merge or deployment is authorized
by the request to preserve work in draft PRs.

## Additional requests outside the portable

These belong to separate monorepo workstreams, not this executable. Their
branch-specific tests do not prove a combined server deployment:

| Request | Audited status | Next action |
| --- | --- | --- |
| Marketplace Task A | Completed locally, including `7ee7ac8` and `eb50a85` plus prerequisite history | Preserve in its own PR; flag remains off. |
| Marketplace Task C | Substantial buying implementation exists, but checkout durability decision remains unresolved | Obtain explicit ruling for recoverable pending orders after ambiguous Stripe failure, implement recovery, rerun races/suites and review before completion. Existing tests do not excuse the orphan-payment risk. |
| Legal/site notice audit | Draft `df20181`; not publication-ready | Supply legal operator identity, jurisdiction and privacy contact; verify actual retention, refund/consent and audience practices; obtain qualified review. Notices cannot guarantee immunity. |
| Discord `/buy` thinking incident | Local fixes `54fdf3a` and `8216833` | Integrate/test the bot separately; verify real interaction latency and German locale in a test guild. A portable cannot fix the deployed bot. |
| Release notification purchase link | Local `5fed857`, `/buy` instruction replaces obsolete website/download view | Preserve separately; deployment and live-message validation are distinct. |
| Private bug reports | Local `128deca`; private staff inbox, notification, five-minute cooldown and daily UTC count | Configure staff role/inbox, verify channel privacy, restart persistence and real test submissions before deployment. |
| Public comeback/portable/giveaway announcement | Draft wording supplied | Publish only after availability is real; giveaway eligibility/rules need owner/legal review. |

Task D money operations and optional Task E policy-plan rewrite were listed in
the inherited handoff, not completed in this desktop scope. Further navigation
stages, real shooting/AutoNexus capture gates and startup measurements must not
be mistaken for completed work because their plans exist. Marketplace launch,
public desktop release and production deployment remain separate decisions.
