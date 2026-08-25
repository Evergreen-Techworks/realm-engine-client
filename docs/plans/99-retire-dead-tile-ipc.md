# 99 — Retire the dead tile-map IPC subsystem (both sides)

## Goal

After this plan, the `clearTiles` / `noWalkInit` / `tileUpdate` IPC path is gone
from both halves of the project: `IpcTileState.{h,cpp}` deleted, the three
`IpcBridge_*` tile entry points and the `IpcTileTypeEntry` struct deleted, the
65 KB + 8 KB stack buffers in the pipe thread's command dispatcher deleted, the
three message types removed from `contract.ts`, and `tileMap` removed from the
`hello` capability advertisement.

This subsystem has **zero producers and zero consumers**. The client never sends
any of the three messages; the DLL never reads the tile map it maintains. Hazard
avoidance actually flows through the live tile-properties path
(`WorldTAB::IsTileDamagingLive` → `RuntimeOffsets::Sq_DamageCached`), which is
what `BootGate`'s `SafeWalk` anchor row is about. This is dead weight sitting on
the DLL's pipe thread and in the contract both sides are supposed to trust.

**This plan touches BOTH sides and requires a C++ build.** It must be dispatched
as a C++-track plan (see the build hazard in `96-overview.md`).

## Dependencies

None — content-independent of every other plan.

Files this plan touches that other plans also touch:
- `client/src/bridge/contract.ts` — **plan 98 also edits this file**, in the
  `DLL_FEATURE_KEYS` region (lines 58+). This plan edits `DllMessageType`
  (lines 37–49). Different regions; trivial merge either way. Whichever lands
  second should re-run `node scripts/check-bridge-contract.mjs` if plan 98 has
  landed.
- `internal/il2cpp-dll-injection.vcxproj` and `.vcxproj.filters` — **plan 104
  also edits `.filters`.** This plan only removes two `IpcTileState` entries
  from each; plan 104 adds missing entries elsewhere. Land 99 first (it is
  earlier in the C++ queue) and plan 104 will see a clean file.

## Current state

### The client never sends any tile message

`client/src/bridge/contract.ts:45-47` declares them:

```ts
  SetFeature: 'setFeature',
  ClearTiles: 'clearTiles',
  NoWalkInit: 'noWalkInit',
  TileUpdate: 'tileUpdate',
```

and `contract.ts:34-35` documents them as outgoing. But:

```bash
$ cd client && grep -rn "DllMessageType.TileUpdate\|DllMessageType.NoWalkInit\|DllMessageType.ClearTiles" src plugins electron packages
# (no results)
$ cd client && grep -rn "'tileUpdate'\|'noWalkInit'\|'clearTiles'" src plugins electron
src/bridge/contract.ts:46:  NoWalkInit: 'noWalkInit',
src/bridge/contract.ts:47:  TileUpdate: 'tileUpdate',
# ClearTiles appears only as the enum member at contract.ts:45
```

The only writer to the pipe is `InternalBridge.send` / `setFeature`
(`client/src/bridge/InternalBridge.ts:135-149`), and `setFeature` always emits
`type: DllMessageType.SetFeature`. Nothing constructs a tile message.

The client *does* have the data — `client/src/state/GameWorldState.ts:96`
maintains its own `tileMap` from packets — it was simply never plumbed across.

### The DLL never reads the tile map it maintains

```bash
$ grep -rn "IpcBridge_IsTileWalkable\|IpcBridge_GetTileStats\|IpcBridge_CopyUniqueTypeEntries" internal/src \
    | grep -v "IpcBridge.h\|IpcBridge.cpp"
# (no results)
```

The three public tile APIs declared at `internal/src/core/ipc/IpcBridge.h:74-85`
have no caller outside their own forwarder bodies at `IpcBridge.cpp:56-69`.

Real hazard detection goes through a different path entirely:
`UDodgeSensors.cpp:646`, `PJDodgeSensors.cpp:319` and `ReppSensors.cpp:304` all
call `WorldTAB::IsTileDamagingLive(tx, ty)`, which reads
`RuntimeOffsets::Sq_DamageCached` / `Sq_Cover` from the live tile object
(`WorldTAB.cpp:2405-2406`).

### The dead surface, exhaustively

**Delete outright:**
- `internal/src/core/ipc/IpcTileState.h` (24 lines)
- `internal/src/core/ipc/IpcTileState.cpp` (119 lines)

**`internal/src/core/ipc/IpcBridge.h`:**
- line 6 — the "Tile APIs expose the latest tileUpdate/noWalkInit state" bullet
- line 8 — "IpcBridge owns only overlay, shutdown, tile, threat, and auth state"
  (drop the word "tile")
- lines 74–85 — `IpcBridge_IsTileWalkable`, `IpcBridge_GetTileStats`,
  `struct IpcTileTypeEntry`, `IpcBridge_CopyUniqueTypeEntries`

**`internal/src/core/ipc/IpcBridge.cpp`:**
- line 30 — `#include "IpcTileState.h"`
- lines 54–69 — the "Tile map API" section (three forwarders)
- lines 244–263 — `DispatchTileCommand`, including its
  `char typesBuf[8192]` (line 251) and `char tilesBuf[65000]` (line 257)
  stack buffers
- line 276 — `if (DispatchTileCommand(typeBuf, json)) return;` inside
  `DispatchCommand`

```cpp
// internal/src/core/ipc/IpcBridge.cpp:272-278  — the call site to prune
static void DispatchCommand(char* json)
{
    char typeBuf[64] = {};
    if (!IpcJson::GetString(json, "type", typeBuf, sizeof(typeBuf))) return;
    if (DispatchTileCommand(typeBuf, json)) return;      // <-- remove this line
    if (strcmp(typeBuf, "setFeature") == 0) DispatchSetFeature(json);
}
```

**`internal/src/core/ipc/IpcMessages.cpp:19`** — the `hello` capability list:

```cpp
return snprintf(buf, bufSize, "{\"type\":\"hello\",\"version\":3,\"protocol\":\"bridge-v3\",\"features\":[\"autoDodge\",\"autoAim\",\"tileMap\"]}");
```

`"tileMap"` advertises a capability that will no longer exist. Removing it is
**safe**: `InternalBridge.handleHello` (`client/src/bridge/InternalBridge.ts:277-293`)
reads only `msg.version` and `msg.protocol`; `grep -rn '\.features' client/src/bridge`
returns nothing.

**Project files:**
- `internal/il2cpp-dll-injection.vcxproj:33` (`ClCompile ... IpcTileState.cpp`)
- `internal/il2cpp-dll-injection.vcxproj:195` (`ClInclude ... IpcTileState.h`)
- `internal/il2cpp-dll-injection.vcxproj.filters:17`
- `internal/il2cpp-dll-injection.vcxproj.filters:132`

**Client:**
- `client/src/bridge/contract.ts:45-47` — the three enum members
- `client/src/bridge/contract.ts:33-35` — the docblock listing them as outgoing

## Target design

There is no new API. The target is subtraction:

- `IpcBridge.h` shrinks to its real responsibilities: pipe thread lifetime,
  shutdown, ghost-hit events, threat publishing, aim publishing, auth/session
  state, overlay gate, feature-override application.
- `DispatchCommand` handles exactly one message type (`setFeature`), which is
  the only one the client actually sends.
- `DllMessageType` in `contract.ts` lists only message types with a live
  producer or consumer.

**Ownership / threading:** unchanged. `IpcTileState`'s `s_tileMutex` is deleted
along with the only state it protected; nothing else on the pipe thread shares
it.

**Divergence warning:** none — the two sides agree perfectly today, that
agreement is just about a feature nobody uses. Do not "restore" the path by
adding a client sender; if tile walkability is ever needed in the DLL, the live
`WorldTAB::IsTileDamagingLive` path already exists and does not require the
client to stream 65 KB of tiles over a pipe.

## Steps

1. **Prove the path is dead one more time before deleting.** Run and record the
   output of:
   ```bash
   cd /home/jesse/realm-engine-client
   grep -rn "IpcBridge_IsTileWalkable\|IpcBridge_GetTileStats\|IpcBridge_CopyUniqueTypeEntries" internal/src | grep -v 'core/ipc/IpcBridge'
   grep -rn "tileUpdate\|noWalkInit\|clearTiles" client/src client/plugins client/electron
   ```
   Both must produce nothing beyond `client/src/bridge/contract.ts:45-47`.
   **If either produces a real consumer, STOP and report** — the premise of this
   plan is wrong.

2. **Remove the client-side message types.** Edit
   `client/src/bridge/contract.ts`: delete lines 45–47 (`ClearTiles`,
   `NoWalkInit`, `TileUpdate`) and update the `DllMessageType` docblock at lines
   33–35 so the "Outgoing (client→DLL)" sentence reads
   `Outgoing (client→DLL): SetFeature (plus Heartbeat/HeartbeatResp).`
   Verify:
   ```bash
   cd client && npx tsc --noEmit -p tsconfig.json     # exit 0, no output
   ```

3. **Remove the DLL command dispatcher.** In
   `internal/src/core/ipc/IpcBridge.cpp`: delete `DispatchTileCommand`
   (lines 244–263) and the `if (DispatchTileCommand(typeBuf, json)) return;`
   line inside `DispatchCommand`.
   Verify:
   ```bash
   bash internal/tools/wsl-build.sh Debug     # 0 Error(s)
   bash internal/tools/check-raw-access.sh    # exit 0
   ```

4. **Remove the three forwarders and the include.** In `IpcBridge.cpp`: delete
   the "Tile map API" section (lines 54–69) and `#include "IpcTileState.h"`
   (line 30). Update the file header comment (lines 4–10) to drop tile state
   from the list of what this file owns.
   Verify: same two commands as step 3.

5. **Remove the header declarations.** In `internal/src/core/ipc/IpcBridge.h`:
   delete lines 74–85 (`IpcBridge_IsTileWalkable`, `IpcBridge_GetTileStats`,
   `struct IpcTileTypeEntry`, `IpcBridge_CopyUniqueTypeEntries`) and prune the
   two header-comment bullets at lines 6 and 8.
   Verify: same two commands as step 3.

6. **Delete the files and their project entries.**
   ```bash
   rm internal/src/core/ipc/IpcTileState.h internal/src/core/ipc/IpcTileState.cpp
   ```
   Then remove from `internal/il2cpp-dll-injection.vcxproj`:
   - `<ClCompile Include="src\core\ipc\IpcTileState.cpp" />` (line 33)
   - `<ClInclude Include="src\core\ipc\IpcTileState.h" />` (line 195)

   and the two matching entries from
   `internal/il2cpp-dll-injection.vcxproj.filters` (lines 17 and 132).
   Verify: same two commands as step 3. A missed `.vcxproj` entry produces
   `MSB3191`/`C1083`; a missed `.filters` entry is silent, so double-check with
   `grep -n IpcTileState internal/il2cpp-dll-injection.vcxproj.filters` → empty.

7. **Drop `tileMap` from the hello advertisement.** In
   `internal/src/core/ipc/IpcMessages.cpp:19`, change the features array to
   `[\"autoDodge\",\"autoAim\"]`. Leave `version` and `protocol` **exactly as
   they are** — `InternalBridge.handleHello` disconnects on a mismatch.
   Verify: same two commands as step 3, plus
   `grep -n 'tileMap' internal/src/core/ipc/IpcMessages.cpp` → empty.

8. **Final sweep.** Confirm nothing references the removed symbols:
   ```bash
   grep -rn "IpcTileState\|IpcTileTypeEntry\|IpcBridge_IsTileWalkable\|IpcBridge_GetTileStats\|IpcBridge_CopyUniqueTypeEntries" internal/
   grep -rn "NoWalkInit\|TileUpdate\|ClearTiles" client/src client/plugins
   ```
   Both must be empty.
   Verify: full rebuild + guardrail.

## Verification

```bash
# C++ (one agent at a time — shared C:\rebuild)
bash internal/tools/wsl-build.sh Debug     # expect: 0 Error(s), 0 Warning(s)
bash internal/tools/check-raw-access.sh    # expect: exit 0, no output

# Client
cd client && npx tsc --noEmit -p tsconfig.json   # exit 0, no output
cd client && npm test                             # if plan 97 has landed: all green
```

Greps that must return **zero** results when this plan is complete:

```bash
grep -rn 'IpcTileState'          /home/jesse/realm-engine-client/internal/
grep -rn 'IpcTileTypeEntry'      /home/jesse/realm-engine-client/internal/
grep -rn 'tileMap'               /home/jesse/realm-engine-client/internal/src/core/ipc/
grep -rn 'tileUpdate\|noWalkInit\|clearTiles' /home/jesse/realm-engine-client/client/src /home/jesse/realm-engine-client/client/plugins
```

Runtime smoke check (optional but recommended if you can run the game): inject,
confirm `%LOCALAPPDATA%\RotMG Exalt DLL Trace.log` shows the bridge connecting
and `[IpcBridge] setFeature:` lines still arriving. The removal touches only
message types nobody sends, so feature toggles must behave identically.

## Out of scope

- **Do NOT change `BRIDGE.PROTOCOL_VERSION` (3) or `PROTOCOL_TAG`
  (`bridge-v3`).** The wire shape for every *live* message is unchanged, and a
  version bump would make an old DLL and a new client refuse each other for no
  reason (`InternalBridge.ts:280-284` disconnects on mismatch).
- **Do NOT touch `IpcJson`, `IpcFraming`, `IpcMessages::EncodeThreats` or
  `EncodeAim`.** Only the `hello` features array changes in `IpcMessages.cpp`.
- **Do NOT remove `GameWorldState.tileMap`** on the client — it is unrelated
  and has live consumers (`GameWorldState.ts:580,621-623`).
- **Do NOT touch the `SafeWalk` row in `BootGate.cpp:44`.** It looks related but
  is about the live tile-properties path, and plan 105 owns the BootGate table.
- **Do NOT re-plumb the tile map.** If you think the DLL should get client tile
  data, that is a new feature, not this plan.
