# 84 — Overview: Killaura / Autofire / Auto-break-walls

## What this workstream builds

Three new combat features, split across the two halves of this product:

1. **Killaura / aimbot** — does **not** pull the trigger. When the player (or
   autofire, or the game's own mouse-hold) fires, killaura rewrites **where the
   shot originates** so it lands on a chosen target. Two modes: **at-target**
   (pick the best enemy) and **at-mouse** (pick the enemy nearest the mouse
   cursor).
2. **Autofire hold** — hold a key to continuously fire, driving the game's own
   shoot entry point so the game's rate limit / MP / silence checks still apply.
3. **Auto-break-walls** — when navigation wedges against a breakable wall on the
   route, lock killaura onto that wall and autofire until it dies, then release.

---

## PIVOTAL FINDING — where the outbound shot is rewritten

**Question:** does `internal/` (the DLL) have an outbound-packet interception seam
(a `SocketManager::SendMessage` hook, a packet registry, `core/protocol/`, WireIds)?

**Answer: NO.** Exhaustive search of `internal/src/` (excluding the gitignored
IL2CPP dump) finds:

* No `core/protocol/`, no packet registry, no WireIds, no `Outbound::Register`.
* The *only* send-side touchpoint is
  `internal/src/features/combat/autoaim/AimHooks.cpp:109` —
  `SendShotPacketDetour`, a MinHook detour on `FKALGHJIADI::PMIANFBMMNN`
  ("SendShotPacket"), which writes an **angle** into a shot struct
  (`RuntimeOffsets::Shot_Angle`, a *manual* non-self-healing offset —
  `internal/src/core/runtime/RuntimeOffsets.h:445`) and into
  `RuntimeOffsets::Player_FacingAngle`. It does not touch a shot **origin** and
  has no packet model.
* `internal/src/game/symbols/BeebyteName.h:1636,2791,3083` still carry the
  *old-build* names `HNBDCKLBKCK=get_SocketManager`, `MLMOIEFKJCE=SocketManager`,
  `OBAPLNIPFDG=SendMessage`, but **none of those tokens exist in the current
  build's dump** — BeeByte re-randomized them. The current build's socket entry
  is `SocketManager_SendMessage(SocketManager*, DCBCCBKEIHN* msg)`
  (`internal/src/game/generated/il2cpp-functions.h:3415`), i.e. a *readable*
  class name in this build. So the reference fork's approach is technically
  reachable — but it is not what we should do (see below).

**How this repo's player actually shoots** (verified):

| Step | Symbol | Repo touchpoint |
|---|---|---|
| Compute aim angle + "may I shoot?" | `LKHPPBEGNOM::ELCBJAFBLJG(this, uint8 slot, float* outAngle, bool* outCanShoot, bool, MethodInfo*)` | hooked, `AimHooks.cpp:71` |
| Fire at angle | `FKALGHJIADI::EHGHCACPAGH(this, float angle)` | hooked, `AimHooks.cpp:89` |
| Emit the shot packet | `FKALGHJIADI::PMIANFBMMNN(this, shotData, projCount)` | hooked, `AimHooks.cpp:109` |
| Spawn the local bullet | `HBEAKBIHANL::KOBMINBDOBD(..., float startX, float startY, ...)` — `startX/startY` are **shooter-relative offsets** (vanilla length ≈ 0.3 tiles) | hooked, `internal/src/features/movement/dodge/ProjectileTracking.cpp:174` |

The spawn hook **already rewrites the local shot origin today**: MagnetAim moves
the local projectile 2 tiles toward the AutoAim target
(`ProjectileTracking.cpp:196-220`, `internal/src/features/combat/autoaim/FeatMagnetAim.cpp:9-35`).
That is exactly the "local `MapObject::SetPosition`" half of the reference fork's
mechanism — and we get it **pre-spawn**, so no one-shot arming and no second hook.

### The three-way comparison

| Option | What it is | Verdict |
|---|---|---|
| **(A) Client-proxy PLAYERSHOOT rewrite** | Rewrite `projectilePosition` on the outgoing PLAYERSHOOT inside the Electron MITM proxy (`client/src/proxy/ClientConnection.ts:385-408`). PLAYERSHOOT is declared at `client/data/packet-definitions.json:370-409` and carries **both** `projectilePosition` (the shot origin — the exact analogue of the reference's `WorldPos startPos`) and `angle` and `playerPosition`. | **WINNER for the outbound half.** No IL2CPP hooking, no obfuscated-name binding, no fail-open float write, and **it survives game patches** — BeeByte renames never touch the wire protocol. |
| **(B) DLL outbound `SocketManager::SendMessage` hook** | The reference fork's approach. | **REJECTED.** The reference forked a client that had no proxy. We have one. This would add a new hook, new obfuscated bindings (`HJNFJAHAOOE` / `FLADLOHHCCP` / `FFLIAABAAFP`), and a thread-local save/restore dance, to reach a field we can already reach in TypeScript. |
| **(C) DLL local shoot / projectile-origin rewrite** | Rewrite `startX/startY` in the existing `SpawnProjectile` detour so the LOCAL bullet spawns at the killaura origin. | **REQUIRED, not optional polish.** See below. |

### Why (C) is required, not polish

In RotMG the **client tells the server which enemy it hit**: `ENEMYHIT` is a
CLIENT→SERVER packet (`client/data/packet-definitions.json`, id 25, direction
`client`). Blocking it prevents damage — that is precisely how
`client/plugins/o3-helper.ts:344-352` stops Oryx-3 damage. Therefore:

* **(A) alone is not enough**: rewriting the server's view of the shot origin does
  not make the *local* bullet touch the enemy, so the game never fires ENEMYHIT
  and no damage is dealt.
* **(C) alone is not enough**: the local bullet hits and the game sends ENEMYHIT,
  but the server's own simulation (from the unmodified PLAYERSHOOT origin) says
  the bullet was nowhere near, so the hit can be rejected.

So killaura = **(A) + (C)**, coordinated by one shot-origin formula computed in
the DLL and published over the existing named-pipe bridge:

```
origin = target − (cos(shotAngle), sin(shotAngle)) · standoff
```

Using the **packet's own angle** makes this mode-agnostic: it works identically
whether the player is aiming at the target or at the mouse.

### Which side each feature lives on

| Feature | Side | Why |
|---|---|---|
| Killaura target selection | **DLL** | `TargetSelector` + `EnemyTracker` + `WeaponProfile` already live there (`internal/src/features/combat/autoaim/`), and **at-mouse mode needs the mouse**, which only the in-process DLL has (`TestTAB::GetMouseWorldX/Y`). |
| Killaura outbound origin rewrite | **Client proxy** | Patch-resilient; the wire field already exists and is already parsed. |
| Killaura local origin rewrite | **DLL** | The spawn hook is already there and already does this for MagnetAim. |
| Autofire hold | **DLL** | Must call the game's shoot entry so the rate limit applies. A synthesized PLAYERSHOOT from the proxy would produce no local bullet, no bulletId, and no ENEMYHIT — useless. |
| Auto-break-walls | **DLL** | The nav stuck detector (`internal/src/features/movement/udodge/UDodge.cpp:559-586`) and the breakable-wall entity data (`EnemyTracker::Entry::hasHealthBar`) are both DLL-side. |

This is the same split the project already uses for AutoNexus and GhostHit:
**the DLL predicts/decides, the client sends packets** — see
`IpcBridge_PublishThreats` (`internal/src/core/ipc/IpcBridge.cpp:127`) →
`DllThreatBus.ts` → `client/plugins/auto-nexus.ts`, and
`IpcBridge_EmitPredictedHit` (`internal/src/core/ipc/IpcBridge.cpp:110`) →
`client/src/dashboard/server/DevServer.ts:2946-2960` which synthesizes PLAYERHIT.

---

## The `aim` wire message (pinned schema — both sides implement this verbatim)

New DLL→client bridge message, modelled exactly on the existing `threats`
message (`internal/src/core/ipc/IpcMessages.cpp:47-114` ↔
`client/src/bridge/DllThreatBus.ts:91-153`):

```
{"type":"aim","aim":"<payload>"}
```

```
payload := "1;<armed>;<mode>;<targetId>;<tx>;<ty>;<px>;<py>;<standoff>;<maxOffset>;<stamp>"
```

Exactly **11** `;`-separated tokens. `AIM_SCHEMA_VERSION = 1`.

| Token | Type | Meaning |
|---|---|---|
| `1` | int | schema version — a mismatch is rejected loud on both sides |
| `armed` | `0`/`1` | killaura is enabled AND has a live target this tick |
| `mode` | `0`/`1` | 0 = at-target, 1 = at-mouse |
| `targetId` | int32 | chosen enemy object id; `0` = none |
| `tx`,`ty` | float, `%.3f` | aim point in world tiles (lead-predicted) |
| `px`,`py` | float, `%.3f` | local player position at publish time |
| `standoff` | float, `%.3f` | tiles to back the origin off the target, along the shot angle |
| `maxOffset` | float, `%.3f` | HARD CAP: max allowed distance between the rewritten origin and the packet's own `playerPosition`. The consumer must refuse the rewrite beyond this. |
| `stamp` | uint32 | `GetTickCount64()` low 32 bits at publish; consumers reject payloads older than 250 ms |

Fail-closed rules that both sides must honour:
* version ≠ 1 → drop the whole payload, do nothing.
* `armed == 0` or `targetId == 0` → forward the shot unchanged.
* any non-finite float → forward unchanged.
* computed origin further than `maxOffset` from the packet's `playerPosition` →
  forward unchanged.
* payload older than 250 ms → forward unchanged.

---

## Target architecture (after all plans land)

```
DLL (internal/)                                     Client (client/)
────────────────────────────────────────────        ───────────────────────────────────
EnemyTracker ──┐                                    InternalBridge
TestTAB mouse ─┤                                       │ type:"aim"
WeaponProfile ─┴─▶ TargetSelector::SelectKillAura       ▼
                        │                           DllAimBus.ts (decode + freshness)
                        ▼                              │
                   KillAura  ──── IPC "aim" ──────────▶│
                    │    │                              ▼
                    │    └──▶ ComputeShotOrigin    plugins/killaura.ts
                    │              │                 hookPacket('PLAYERSHOOT')
                    │              ▼                    │ rewrite projectilePosition
                    │        ProjectileTracking          ▼
                    │        SpawnProjectileDetour   proxy → server
                    │        (local bullet origin)
                    │
   AutoFire ────────┤  ShootRuntime → ComputeShootAngle / ShootWithAngle
                    │
   AutoBreakWalls ──┘  (reads UDodge::GetNavWedge + EnemyTracker breakables,
                        drives KillAura::SetForcedTargetId + AutoFire auto-engage)
```

---

## Plans

| # | File | Side | Summary |
|---|---|---|---|
| 84 | `84-overview.md` | — | this document |
| 85 | `85-killaura-core-and-aim-publisher.md` | C++ | `TargetSelector::SelectKillAura`, the `KillAura` module (state, modes, shot-origin math), the `aim` IPC message + publisher, IPC feature keys, Combat-tab UI. Publishes only — nothing is rewritten yet. |
| 86 | `86-client-playershoot-origin-rewrite.md` | **TypeScript only** | `DllAimBus.ts`, bridge contract additions, `InternalBridge` dispatch, `plugins/killaura.ts` PLAYERSHOOT `projectilePosition` rewrite with a serialize-identity self-check and hard caps. |
| 87 | `87-local-shot-origin-provider.md` | C++ | One `ShotOrigin` provider inside the existing `SpawnProjectileDetour`; killaura drives the LOCAL bullet origin so the game emits `ENEMYHIT`. MagnetAim and the muzzle slider keep byte-identical behavior. |
| 88 | `88-autofire-hold.md` | C++ | `ShootRuntime` (sanctioned native shoot-call wrapper) + `AutoFire` hold-to-fire feature + BootGate entry + UI. |
| 89 | `89-auto-break-walls.md` | C++ | `UDodge::GetNavWedge()` (minimal touch), breakable-entity scan, `AutoBreakWalls` orchestrator, plus the raw-access guardrail that forbids new private shoot-method bindings. |

### Dependency graph

```
        84 (read first — no code)
         │
   ┌─────┴───────────────────────────┐
   │                                 │
  85 (C++ foundation)            86 (TypeScript, parallel-safe)
   │
   ├──▶ 87 (C++)
   │      │
   └──▶ 88 (C++)
          │
          └──▶ 89 (C++, needs 85 + 87 + 88)
```

* **86 can be dispatched immediately, in parallel with 85.** It touches only
  `client/**` — zero file overlap with any C++ plan. The wire schema is pinned
  verbatim in both 85 and 86, so neither blocks the other. Killaura only *works*
  end-to-end once 85, 86 and 87 have all landed; each is independently
  build-clean and behaviour-neutral before that.
* **85 → 87 → 88 → 89 must be serial.** They share
  `internal/il2cpp-dll-injection.vcxproj`,
  `internal/src/gui/tabs/CombatTab/CombatTAB.cpp`, and
  `internal/src/features/control/FeatureCommandRegistry.cpp`.
* **BUILD-INFRA HAZARD:** `internal/tools/wsl-build.sh` writes its PCH and objs to
  a **shared** `C:\rebuild\<Config>` directory. Two implementers building
  concurrently will clobber each other's PCH and produce spurious failures.
  **Never run two `wsl-build.sh` invocations at the same time.** Since 85→89 are
  serial anyway, the only concurrency risk is plan 86 — and 86 runs no C++ build.
  If you must build C++ concurrently, override with
  `/p:IntDir=... /p:OutDir=...` to a unique directory.

### Global verification

C++ (run from the repo root, one at a time):

```bash
bash internal/tools/wsl-build.sh Debug          # must end "0 Error(s)"
bash internal/tools/check-raw-access.sh         # must exit 0, print nothing
```

TypeScript (run from `client/`):

```bash
cd client && npx tsc --noEmit -p tsconfig.json  # must print nothing
cd client && npm run build                      # must exit 0
```

`client/tsconfig.json` excludes `src/**/__tests__/**`, so test files never break
the build. If `vitest` is available, `cd client && npx vitest run src/bridge` also
passes; treat it as optional (`vitest` is imported by
`client/src/bridge/__tests__/threatPayload.roundtrip.test.ts` but is not in
`client/package.json` devDependencies).

### House rules every plan inherits

* **Raw access is forbidden in `features/` and `gui/`.** Reads/writes via `Mem::`
  (`internal/src/core/runtime/MemRead.h`), hooks via `Il2CppHook::`
  (`internal/src/platform/hooks/Il2CppHook.h`), offsets via `RuntimeOffsets`,
  containers via `Il2CppC::`. `internal/tools/check-raw-access.sh` is the ratchet.
* **Fail closed.** A failed binding, an unresolved offset, a stale payload, a
  non-finite number: forward the shot **unchanged**. Never corrupt.
* **Self-witnessing, transition-only logs.** Log the binding path once; log
  ARMED/disarmed **edges** only; rate-limit failure logs. No per-frame writes.
* **Liveness stamp** for any feature that owns no hook (autofire, auto-break):
  one heartbeat line every ~30 s while enabled, so "silently dead" is visible.
* **Phase-3 conflict zone:** `internal/src/features/movement/udodge/UDodgeSolver.cpp`
  and `UDodgeTypes.h` were just retuned. **Do not edit them.** Plan 89's only
  udodge touch is a ~15-line addition to `UDodge.cpp`/`UDodge.h`.
