# Private 1.0.7 integration validation

2026-09-15 Integrated global runtime `67a39f1` as `026fae0` onto the combined private candidate. Resolved two additive UDodge conflicts by preserving both MBC group preference and global runtime initialization. No client push.

2026-09-15 SDK build, production/test typechecks, bridge contract, packet drift and full client suite pass: 66 files, 629 tests. Full native host suite passes, including 350 router, 57 map memory and 19 actual runtime checks. Large runtime fixture measured maximum worker cycle 3.023 ms, p95 cycle 2.962 ms and p95 repair 1.885 ms on this host; not an in-game timing guarantee.

2026-09-15 Normal production-loop scenarios pass with both legacy and experimental D* navigation: legacy collision 43 assertions / four existing limitations; game collision 45 / two. The two dense-boss engagement limitations remain. Four large-room D* results and source-adapter limitations are recorded in `2026-09-15-global-routing-integration.md`.

2026-09-15 Live game identity still matches the three pinned hashes. All 66 changed Windows paths match base `9cdc818` or are new; backed up original files and hashes under `C:\realm-engine-pinned\source-backup-private107-026fae0` before selective copying. Preserved unrelated files and profiles. Started explicit-version private 1.0.7 build from merged private pipeline without Upload/Notify or release-sequence allocation. Native Windows compilation, artifact verification and delivery are pending; no gameplay approval claimed.
