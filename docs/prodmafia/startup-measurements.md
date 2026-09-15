# Startup readiness and measurement handoff

2026-09-15: implementation is code-tested; no portable launch or timing claim is made.

Optional mirror acquisition no longer blocks mandatory plugin registration, saved profile application, watcher startup, proxy listening, or DLL pipe listening. Local objects/tiles loading, runtime checks, release verification, packet handlers, and the one-shot parsed-object scaling handoff remain on the mandatory path. No enchantments parser exists at this base; metadata availability does not mean enchant damage calculations are implemented.

Dashboard `startupStatus` snapshots report loading/available/unavailable/cancelled metadata and pending/loaded/degraded plugins. New dashboard sockets receive the retained snapshot. Shutdown cancels downloads, skips later startup stages, and stops status publication. Parent cancellation terminates candidate iteration and prevents destination writes; individual mirror timeouts remain 8000 ms.

Readiness markers use `performance.now()` within each process and one Electron-generated launch UUID passed to the child environment. The stages are `window-visible` (after showing the window), `dashboard-ready` (HTTP listen callback), `proxy-listening` (existing listenStarted event), `pipe-listening` (successful named-pipe listen callback), and `plugin-profile-ready` (after plugin/profile/watcher completion). Never subtract Electron and proxy process clocks. Log markers are once-per-startup observations, not per-frame instrumentation.

## Owner-approved Windows measurements still pending

Use an isolated test cache/profile, never modify the owner's live accounts or caches. Capture at least five before/after samples for each condition with identical pinned game, plugin/profile data, hardware, and launch method:

| Condition | Before samples | After samples | Median comparison |
| --- | --- | --- | --- |
| Cold optional XML cache | Pending | Pending | Not measured |
| Warm optional XML cache | Pending | Pending | Not measured |
| Offline metadata mirrors | Pending | Pending | Not measured |

Preserve each launch id, process label, five readiness values, cache condition and sanitized errors. Also verify profile settings apply before gameplay traffic, essential confirmed-health protection still loads, cold/offline metadata leaves gameplay usable, dashboard labels match actual file availability, and closing during acquisition emits no late writes/listeners.

Six sequential 8-second candidates imply approximately 48 seconds possible old wait, not an observed startup duration or a promised saving. Full Electron/native portable compilation and current-game validation remain separate gates. Do not publish, mirror or deploy as part of this workstream.
