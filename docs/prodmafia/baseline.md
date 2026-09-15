# ProdMafia startup implementation baseline

2026-09-15: inspected clean tracked status and exact detached base `9d316adbbd0c4e2250907e85987595477de32bd7` in nav-stage1-base; created isolated `feat/prodmafia-startup` worktree with filesystem approval. No nested AGENTS.md exists in that base. Root AGENTS.md and CLAUDE.md read; the newer no-mirror/build restrictions take precedence.

Node 20.20.2, npm 10.8.2, Linux. Installed lockfile using `npm ci --ignore-scripts --offline`: 566 packages, no source changes. Native Electron install scripts intentionally not run. Electron rebuild dependencies warn that they require Node >=22.12.0; a portable build is not attempted.

The initial test/typecheck attempt lacked generated SDK declarations: 13 suite import failures (240 collected tests passed), missing SDK type errors. Ran required `npm run build:sdk` in this worktree only. Repeated selected-base baseline before any implementation/test patch:

- `npm test`: 42 files, 375 tests passed. Bridge contract 173 DLL / 154 sendable / 21 DLL-only / 2 known unhandled; packet drift passed.
- `npm run typecheck`: exit 0.
- `npm run typecheck:tests`: exit 0.
- `python3 internal/tests/run_udodge_zone_tests.py`: exit 0; AoE 52, temporal 24, admission 30, speed/expiry 90, commitment 12, timed escape 35, pruning 80000, pathing 29, enemy tracker 60, autofire 73, input focus 29; navigation regressions pass; scenarios 29 asserted / 3 known limitations.

Logs: `/tmp/prodmafia-validation/startup/baseline-*-sdk.txt` and `baseline-native.txt`. Windows compiler, current-game launch, captures, cold/warm/offline timing measurements remain unrun, not passing. No push, deployment, Windows copy, or portable build.
