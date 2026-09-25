# TestLab live readiness fix — 2026-09-25

Base: bc457ce. Isolated branch: fix/testlab-live-readiness. Source-only change;
no build, installation, Windows mirror, movement change, push or deployment.

The observed run 20260925T081836Z-dd6c entered admission at 08:19:52 UTC,
received an empty server FAILURE and disconnected at 08:20:02, then started
its script when the native bridge became ready at 08:20:06. The probe timed
out without a player, but the runner later labeled elapsed time completed.
The server failure's cause remains unknown.

The runner now requires the current client to be connected and admission
loaded throughout observed native settlement. It rechecks after loading the
temporary plugin configuration because that operation can reconnect. Loss of
admission during the bounded bridge wait produces connection-lost, rather than
starting a script and eventually reporting completed. A disconnect during the
asynchronous script-start handoff also produces connection-lost. Disconnect
timestamps are retained during waiting-bridge. No account retry or relaunch
was added. Existing initial launch, cleanup, and running watchdog remain.

Five integration regressions exercise real runner callbacks with fake time:

- Bridge comes ready after disconnect: script remains stopped until a new
  connected client reaches loaded admission and settlement completes.
- The observed two-minute pre-running outage terminates as connection-lost.
- Stale loaded admission with connected=false cannot authorize startup.
- A profile-induced reconnect requires fresh loaded admission before startup.
- A disconnect during asynchronous script startup does not enter running.

Before the fix, the first four regressions all failed, including the exact
completed-versus-connection-lost mismatch. The fifth regression separately
failed before adding its handoff guard. All recovery tests retain one account
launch; no automatic account change or relaunch occurs.

Commands from the worktree root:

```sh
client/node_modules/.bin/vitest run --root client src/plugins/__tests__/testlabRunner.test.ts -t 'requires current connected|classifies an outage|rejects stale loaded|revalidates loaded admission'
# Before: 4 failed, 34 skipped.
client/node_modules/.bin/vitest run --root client src/plugins/__tests__/testlabRunner.test.ts -t 'classifies a disconnect during asynchronous'
# Before handoff guard: 1 failed, 38 skipped.
client/node_modules/.bin/vitest run --root client src/plugins/__tests__/testlabRunner.test.ts src/testlab/__tests__/runnerCore.test.ts
# After: 2 files passed, 121 tests passed (39 plugin, 82 core).
client/node_modules/.bin/tsc --noEmit -p client/tsconfig.json
# Exit 0, no diagnostics.
```

Validation used the existing dependency installation through a temporary
worktree-local node_modules symlink, removed afterward. No package installation
or build ran. These tests establish runner sequencing and classification, not
live connectivity recovery. The first-admission duration clock is unchanged;
completed remains an elapsed-budget status, not evidence of successful trials.

2026-09-25: Implemented the isolated runner readiness correction and five
regressions; 121 focused tests and client typecheck passed. Local commit records
this report with the source changes. Live acceptance remains unverified.
