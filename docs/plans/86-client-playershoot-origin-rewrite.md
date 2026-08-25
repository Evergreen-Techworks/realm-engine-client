# 86 — Client proxy: PLAYERSHOOT origin rewrite (TypeScript only)

## Goal

After this plan the Electron client can receive a killaura aim state from the
injected DLL over the existing named pipe and rewrite the **outgoing
`PLAYERSHOOT.projectilePosition`** so the *server's* simulation of the shot
starts adjacent to the chosen target. This is the outbound half of killaura; it
replaces the reference fork's native `SocketManager::SendMessage` hook with a
pure-TypeScript rewrite that survives game patches (BeeByte renames never touch
the wire protocol).

Delivered as: a new `DllAimBus` (decode + freshness + publish), two additions to
the bridge contract, one dispatch case in `InternalBridge`, and a new bundled
plugin `client/plugins/killaura.ts` that owns the PLAYERSHOOT hook and all the
fail-closed guards.

## Dependencies

**None — parallel-safe.** This plan touches **only** `client/**`. It has zero
file overlap with plans 85, 87, 88 and 89, all of which are C++.

The `aim` wire schema is pinned verbatim below and in plan 85, so the two halves
can be implemented and merged in either order. Until plan 85 lands the DLL never
sends an `aim` message, so this plan is inert in production and cannot regress
anything.

Files this plan touches that other plans also touch: **none**.

## Current state

### 1. The proxy already parses PLAYERSHOOT and has a modify-and-forward contract

`client/data/packet-definitions.json:370-409` (mirrored into
`client/src/packets/packetDefinitions.generated.ts:375+`) declares packet id 30:

```json
"30": { "name": "PLAYERSHOOT", "direction": "client", "fields": [
  { "name": "time",               "type": "int32"    },
  { "name": "shotId",             "type": "uint16"   },
  { "name": "containerType",      "type": "int16"    },
  { "name": "attackIndex",        "type": "sbyte"    },
  { "name": "projectilePosition", "type": "Location" },
  { "name": "angle",              "type": "float"    },
  { "name": "bulletId",           "type": "byte"     },
  { "name": "unknownShort",       "type": "int16"    },
  { "name": "playerPosition",     "type": "Location" }
]}
```

`Location` is `{ x: float, y: float }`
(`client/data/packet-definitions.json`, `dataObjects.Location`).

Every C→S packet is parsed, handed to hooks, then forwarded —
`client/src/proxy/ClientConnection.ts:388-408`:

```ts
const packet = this.proxy.packetFactory.createFromBytes(rawPacket);
...
this.proxy.fireClientPacket(this, packet);
...
if (packet.send) {
  const plainBytes = packet.modified
    ? this.proxy.packetFactory.serialize(packet)
    : packet.rawBytes !== rawPacket ? packet.rawBytes : rawPacket;
  ...
  this.forwardRaw(plainBytes, !isClient);
}
```

So setting `packet.data.projectilePosition = {x, y}` **and** `packet.modified = true`
is all it takes.

**The hazard this plan must defend against** is documented in the same file at
`client/src/proxy/ClientConnection.ts:143-149`:

> `NEVER use sendToServer here: it calls serialize() which reconstructs the packet
> from parsed fields. After a game update, stale packet definitions produce corrupt
> bytes and DECA drops the connection.`

`serialize()` (`client/src/packets/PacketFactory.ts:127-160`) rebuilds the body
from `def.fields` and appends `packet.unreadData`. If the PLAYERSHOOT definition
ever drifts from the live game, a rewrite would corrupt every shot. This plan
therefore adds a **serialize-identity self-check** before arming (see §Target).

### 2. Hook registration and the plugin surface already exist

* `client/src/proxy/Proxy.ts:101-118` — `hookPacket(name, handler, pluginId, prepend)`.
* `client/src/proxy/Proxy.ts:176-207` — `fireClientPacket` runs the hooks.
* `client/src/plugins/PluginContext.ts:266` — `ctx.hookPacket(...)`.
* `client/plugins/api.ts:22-36` — the sanctioned plugin import barrel. It already
  re-exports `sendDllFeature`, `getDllThreats`, `RuntimeScheduler`, and the
  `DllThreat`/`DllGround` types. **New DLL-bus exports must go through here**, not
  via a deep `../src/...` import from the plugin.
* Plugins are auto-discovered from `client/plugins/*.ts` — no manifest to edit
  (`client/src/plugins/PluginManager.ts:405`, `client/scripts/build-prod.mjs:219-221`).

### 3. There is exactly one precedent for a DLL→client decision bus — copy it

* Wire contract: `client/src/bridge/contract.ts:22-48` (`BRIDGE`, `DllMessageType`).
* Feature-key union: `client/src/bridge/contract.ts:57-92` (`DLL_FEATURE_KEYS`) —
  `sendDllFeature`'s parameter type, so a typo is a compile error.
* Dispatch: `client/src/bridge/InternalBridge.ts:243-270` (`handleMessage` switch)
  and `:325-329`:
  ```ts
  private handleThreats(msg: DllMessage): void {
    const payload = typeof msg.threats === 'string' ? msg.threats : '';
    const parsed = decodeThreatPayload(payload);
    publishDllThreats(parsed.threats, parsed.ground, parsed.truncated);
  }
  ```
* Bus module: `client/src/bridge/DllThreatBus.ts` — a `globalThis`-keyed slot
  (`:25-37`), `publish*` (`:39-49`), age-gated `get*` (`:51-73`), and the ONE
  decoder with a hard schema-version check (`:91-153`).
* Round-trip test: `client/src/bridge/__tests__/threatPayload.roundtrip.test.ts`.

### 4. StateManager already hooks PLAYERSHOOT — do not disturb it

`client/src/state/StateManager.ts:67` registers, and `:211-231` infers the player
position from `projectilePosition` minus `0.3` along `angle`:

```ts
client.playerData.pos = {
  x: projPos.x - Math.cos(angle) * 0.3,
  y: projPos.y - Math.sin(angle) * 0.3,
};
```

**This is a real collision.** Once we rewrite `projectilePosition`, that
inference becomes garbage (it would teleport `playerData.pos` next to the enemy),
and `playerData.pos` feeds other consumers. See the mitigation in §Target.

## Target design

### 6.1 `client/src/bridge/DllAimBus.ts` (new)

Mirror `DllThreatBus.ts` exactly.

```ts
export interface DllAim {
  armed: boolean;
  mode: 0 | 1;          // 0 = at-target, 1 = at-mouse
  targetId: number;
  tx: number; ty: number;
  px: number; py: number;
  standoffTiles: number;
  maxOffsetTiles: number;
  stamp: number;        // DLL GetTickCount64() low 32 bits — DO NOT compare to Date.now()
}

// Bump only in lockstep with AIM_SCHEMA_VERSION in internal/src/core/ipc/IpcBridge.h.
export const AIM_SCHEMA_VERSION = 1;

export function publishDllAim(aim: DllAim | null): void;
/** Latest aim state, or null if none / older than maxAgeMs (local receive clock). */
export function getDllAim(maxAgeMs?: number): DllAim | null;   // default 250
export function getDllAimAgeMs(): number | null;

/**
 * The ONE decoder for the compact aim wire string. Its inverse is
 * IpcMessages::EncodeAim in internal/src/core/ipc/IpcMessages.cpp.
 *
 *   "1;<armed>;<mode>;<targetId>;<tx>;<ty>;<px>;<py>;<standoff>;<maxOffset>;<stamp>"
 *
 * EXACTLY 11 ';'-separated tokens; field order is authoritative here and there.
 * A version other than AIM_SCHEMA_VERSION is rejected loud (console.warn, returns
 * null) so killaura fails closed rather than misreading.
 */
export function decodeAimPayload(payload: string): DllAim | null;
```

Decoder rules (all failures return `null`, never a partial object):
* `segs.length !== 11` → null.
* `Number(segs[0]) !== AIM_SCHEMA_VERSION` → `console.warn` once-ish + null.
* any of `tx,ty,px,py,standoffTiles,maxOffsetTiles` not `Number.isFinite` → null.
* `armed = segs[1] === '1'`; `mode = segs[2] === '1' ? 1 : 0`.
* `targetId`/`stamp` must be finite integers; otherwise null.

Freshness uses the **local receive time** (`Date.now()` recorded in the slot),
exactly like `DllThreatBus.getDllThreats`. The DLL `stamp` is carried through for
diagnostics only — it is a `GetTickCount64` value from another process and must
never be compared against `Date.now()`.

### 6.2 Contract additions

`client/src/bridge/contract.ts`:
* Add `Aim: 'aim',` to `DllMessageType` (keep the alphabetical-ish grouping with
  the other incoming types) and mention it in the doc comment at `:29-33`
  ("Incoming (DLL→client): … Threats, Aim.").
* Add these five keys to `DLL_FEATURE_KEYS` (the list is sorted — insert them
  between `'internalUnloadDll'` and `'pjdodgeDebugOverlay'`):
  ```
  'killauraEnabled', 'killauraMaxOffsetTiles', 'killauraMode',
  'killauraRangeTiles', 'killauraStandoffTiles',
  ```
  These are consumed by `FeatureCommandRegistry.cpp` once plan 85 lands. The DLL
  already tolerates unknown keys (`internal/src/features/control/FeatureCommandRegistry.cpp:9-10`),
  so shipping them early is safe.

### 6.3 `InternalBridge` dispatch

`client/src/bridge/InternalBridge.ts`:
* extend the import at `:21` to also pull `decodeAimPayload, publishDllAim` from
  `./DllAimBus.js`;
* add `case DllMessageType.Aim: this.handleAim(msg); break;` to the switch at
  `:244-269`;
* add, next to `handleThreats`:
  ```ts
  private handleAim(msg: DllMessage): void {
    const payload = typeof msg.aim === 'string' ? msg.aim : '';
    publishDllAim(decodeAimPayload(payload));
  }
  ```

### 6.4 `client/plugins/api.ts` re-exports

Add to the type block: `export type { DllAim } from '../src/bridge/DllAimBus.js';`
Add to the value block: `export { getDllAim, getDllAimAgeMs } from '../src/bridge/DllAimBus.js';`

### 6.5 `client/plugins/killaura.ts` (new bundled plugin)

Modelled on `client/plugins/auto-aim.ts` (settings + `sendDllFeature` + hooks).

Settings (each pushes to the DLL via `sendDllFeature`):

| Setting | Type | Default | DLL key |
|---|---|---|---|
| `aimMode` | select `target` / `mouse` | `target` | `killauraMode` (0/1) |
| `rangeTiles` | number | `8` | `killauraRangeTiles` |
| `standoffTiles` | number | `0.35` | `killauraStandoffTiles` |
| `maxOffsetTiles` | number | `12` | `killauraMaxOffsetTiles` |
| `rewriteOutbound` | boolean | `true` | (client-side only) |

`ctx.onEnabledChange` and `ctx.on('clientConnected')` push
`sendDllFeature('killauraEnabled', ctx.enabled)` plus the four values;
`ctx.registerCleanup` pushes `killauraEnabled = false`.

**The PLAYERSHOOT hook** — the whole rewrite, with every guard:

```ts
ctx.hookPacket('PLAYERSHOOT', (client, packet) => {
  if (!ctx.enabled) return;
  if (!ctx.getSetting<boolean>('rewriteOutbound')) return;
  if (!packet.isDefined) return;                       // unknown shape -> never touch

  const aim = getDllAim(250);                          // fail-closed on staleness
  if (!aim || !aim.armed || aim.targetId === 0) return;

  const angle = packet.data.angle;
  const player = packet.data.playerPosition;
  const proj   = packet.data.projectilePosition;
  if (typeof angle !== 'number' || !Number.isFinite(angle)) return;
  if (!player || !proj) return;
  if (!Number.isFinite(player.x) || !Number.isFinite(player.y)) return;

  // The ONE shot-origin formula. Mirrors KillAura::ComputeShotOrigin in
  // internal/src/features/combat/killaura/KillAura.cpp. Using the PACKET'S OWN
  // angle makes it mode-agnostic: it is correct whether the player aims at the
  // target or at the mouse.
  const ox = aim.tx - Math.cos(angle) * aim.standoffTiles;
  const oy = aim.ty - Math.sin(angle) * aim.standoffTiles;
  if (!Number.isFinite(ox) || !Number.isFinite(oy)) return;

  // HARD CAP. Never displace the origin further than the DLL allows.
  const dx = ox - player.x, dy = oy - player.y;
  if (dx * dx + dy * dy > aim.maxOffsetTiles * aim.maxOffsetTiles) return;

  if (!armIfSerializeIsIdentity(client, packet)) return;   // see below

  packet.data.projectilePosition = { x: ox, y: oy };
  packet.modified = true;
  stats.rewrites++;
});
```

**Serialize-identity self-check (`armIfSerializeIsIdentity`).** Once per
connection, before the *first* rewrite: serialize the **unmodified** packet and
compare byte-for-byte against `packet.rawBytes`. If they differ, the PLAYERSHOOT
definition has drifted from the live game and `serialize()` would corrupt the
shot — so **permanently disarm for this connection** and log once. This is the
direct mitigation for the hazard documented at
`client/src/proxy/ClientConnection.ts:143-149`.

```ts
let armState: 'unknown' | 'armed' | 'refused' = 'unknown';
function armIfSerializeIsIdentity(client: ClientConnection, packet: Packet): boolean {
  if (armState === 'armed')   return true;
  if (armState === 'refused') return false;
  const rebuilt = (client as any).proxy?.packetFactory?.serialize?.(packet)
               ?? ctxPacketFactorySerialize(packet);
  const ok = Buffer.isBuffer(rebuilt) && rebuilt.equals(packet.rawBytes);
  armState = ok ? 'armed' : 'refused';
  ctx.log(ok
    ? 'PLAYERSHOOT serialize round-trip is byte-identical — origin rewrite ARMED'
    : 'PLAYERSHOOT serialize round-trip MISMATCH — origin rewrite REFUSED (stale packet definition)');
  return ok;
}
```
Reset `armState = 'unknown'` in `ctx.on('clientConnected')`.
If reaching `packetFactory` from the plugin is awkward, add a
`serializeForCheck(packet): Buffer` passthrough to `PluginContext` next to
`createPacket` (`client/src/plugins/PluginContext.ts:321`) and re-export nothing
new — keep it minimal and documented as "diagnostic round-trip only".

**StateManager collision fix.** `client/src/state/StateManager.ts:211-231` infers
`playerData.pos` from `projectilePosition`. Because `Proxy.firePacketHooks`
(`client/src/proxy/Proxy.ts:217-228`) runs handlers in registration order and
`StateManager.attach` (`:58-70`) registers at startup — before any plugin — the
StateManager handler sees the **original** value and is unaffected by our later
rewrite. **Do not change StateManager.** Instead:
* register the killaura hook **without** `prepend` (the default), so ordering is
  preserved, and
* add a one-line comment in `killaura.ts` recording *why* order matters, citing
  `StateManager.ts:219-228`.

Also expose diagnostics via `ctx.setData`/`ctx.broadcastData`
(`client/src/plugins/PluginContext.ts:246-256`) once a second:
`{ armed, targetId, rewrites, refused, aimAgeMs }`.

### 6.6 Round-trip test

New `client/src/bridge/__tests__/aimPayload.roundtrip.test.ts`, modelled on
`threatPayload.roundtrip.test.ts`. It must assert:
* `AIM_SCHEMA_VERSION === 1`;
* a full valid payload decodes to the exact expected object;
* `armed=0` still decodes (armed:false) rather than returning null;
* version `2` returns `null`;
* a 10-token or 12-token payload returns `null`;
* `NaN`/`inf` in any float token returns `null`.

`client/tsconfig.json` excludes `src/**/__tests__/**`, so this file cannot break
the build.

## Steps

1. **Create the bus.** Add `client/src/bridge/DllAimBus.ts` per §6.1. Nothing
   imports it yet.
   → `cd client && npx tsc --noEmit -p tsconfig.json`

2. **Extend the contract.** Edit `client/src/bridge/contract.ts`: add
   `Aim: 'aim',` to `DllMessageType`, update the doc comment at `:29-33`, and
   insert the five `killaura*` keys into `DLL_FEATURE_KEYS` in sorted position.
   → `cd client && npx tsc --noEmit -p tsconfig.json`

3. **Dispatch the message.** Edit `client/src/bridge/InternalBridge.ts` per §6.3
   (import, switch case, `handleAim`).
   *Inert until the DLL sends `type:"aim"`.*
   → `cd client && npx tsc --noEmit -p tsconfig.json`

4. **Open the plugin boundary.** Edit `client/plugins/api.ts` per §6.4.
   → `cd client && npx tsc --noEmit -p tsconfig.json`

5. **Serialize round-trip helper.** If the plugin cannot reach
   `proxy.packetFactory`, add a `serializeForCheck(packet: Packet): Buffer`
   method to `client/src/plugins/PluginContext.ts` next to `createPacket`
   (`:321`), documented as diagnostic-only, and re-export nothing.
   → `cd client && npx tsc --noEmit -p tsconfig.json`

6. **Write the plugin.** Create `client/plugins/killaura.ts` per §6.5, including
   all guards, the arm/refuse self-check, and the diagnostics broadcast.
   Default `ctx.enabled` to **off**.
   → `cd client && npx tsc --noEmit -p tsconfig.json && npm run build`

7. **Round-trip test.** Create
   `client/src/bridge/__tests__/aimPayload.roundtrip.test.ts` per §6.6.
   → `cd client && npx tsc --noEmit -p tsconfig.json` (test file is excluded from
     the build; if `vitest` is installed also run `npx vitest run src/bridge`)

## Verification

```bash
cd client && npx tsc --noEmit -p tsconfig.json   # prints nothing
cd client && npm run build                       # exits 0
cd client && npx vitest run src/bridge           # optional — vitest is not a declared devDependency
```

Must return **zero** results — the outbound rewrite lives in exactly one place
and nothing else may touch `projectilePosition`:

```bash
grep -rn "projectilePosition" client/plugins/ | grep -v "client/plugins/killaura.ts"
```

Must return **zero** results — the decoder is single-sourced and plugins must go
through `plugins/api.ts`, never a deep import:

```bash
grep -rn "DllAimBus" client/plugins/
grep -rn "decodeAimPayload" client/src/ | grep -v "client/src/bridge/DllAimBus.ts" \
  | grep -v "client/src/bridge/InternalBridge.ts" | grep -v "__tests__"
```

Manual smoke test once plan 85 has also landed: enable the Killaura plugin, shoot
near an enemy, and confirm the plugin log prints
`origin rewrite ARMED` exactly once and the broadcast data shows `rewrites`
increasing. If it prints `REFUSED`, the PLAYERSHOOT definition in
`client/data/packet-definitions.json` needs re-verifying against the live build —
that is the self-check doing its job, **not** something to force past.

## Out of scope

* **Do not** rewrite `PLAYERSHOOT.angle`, `playerPosition`, `shotId`,
  `bulletId`, or `time`. Origin only. Rewriting `playerPosition` is a position
  lie that will get the account flagged; the whole design deliberately keeps it
  honest.
* **Do not** synthesize `ENEMYHIT`. The game client emits it once the LOCAL
  bullet overlaps the enemy — that is plan 87's job, in the DLL.
* **Do not** block or delay PLAYERSHOOT (`packet.send` stays `true` always).
* **Do not** modify `client/src/state/StateManager.ts` — hook ordering already
  protects it (see §6.5).
* **Do not** modify `client/src/proxy/ClientConnection.ts` or `Proxy.ts`. The
  `modified` → `serialize()` path already exists and is sufficient.
* **Do not** touch `client/plugins/auto-aim.ts`, `auto-nexus.ts`, or
  `o3-helper.ts`.
* **Do not** touch anything under `internal/`.
