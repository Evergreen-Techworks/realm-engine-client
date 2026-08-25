# 28 — DevServer Decomposition

## Goal
Extract the 4085-line `DevServer` class into focused service modules, each
owning one responsibility. After this plan, `DevServer` is a thin coordinator
that wires services together and handles WebSocket dispatch, while account
management, game launching, fame tracking, trade sessions, and plugin config
persistence live in their own files. No behavioral changes.

## Dependencies
None -- parallel-safe. No other plan touches `DevServer.ts` or creates files
in `client/src/dashboard/server/`.

Files touched:
- `client/src/dashboard/server/DevServer.ts` (extract from)
- `client/src/dashboard/server/AccountService.ts` (NEW)
- `client/src/dashboard/server/GameLauncher.ts` (NEW)
- `client/src/dashboard/server/FameTracker.ts` (NEW)
- `client/src/dashboard/server/TradeSession.ts` (NEW)
- `client/src/dashboard/server/PluginConfigService.ts` (NEW)

## Current state
`DevServer.ts` (4085 lines, 71 private methods) is a god object responsible
for:

1. **HTTP server + WebSocket server** (core responsibility, stays)
2. **Account management** (~17 methods): `readDashboardAccounts`,
   `normalizeDashboardAccountRecord`, `generateDashboardAccountId`,
   `readAllDashboardAccountOverviewCaches`, `verifyDecaAccount`,
   `verifyDecaAccountOnce`, etc. Lines ~486-668, ~1593-1721.
3. **Game launching** (~10 methods): `launchGame`, `launchGameWithCredentials`,
   `getRotmgPath`, `isSingleClientOnlyEnabled`,
   `getRunningRotmgExaltProcessCount`, `getSingleClientLaunchBlockError`,
   `ensureSteamAppIdFile`, `clampLaunchWindowSize`,
   `buildCredentialLaunchWindowExtras`. Lines ~1439-1878.
4. **DLL injection**: `tryInjectDll` (lines 1211-1232).
5. **Fame tracking** (~5 methods/fields): `resetSessionStats`,
   `startFameSegment`, fame accumulation logic, `fameSectionStart`,
   `fameAccumulated`, `lastKnownFame`. Lines ~668-700.
6. **Trade session**: `tradeSession` state object, `resetTradeSession`,
   `observeTradePacket`. Lines ~1163-1177, ~3314-3375.
7. **Plugin config persistence** (~5 methods): `buildPluginConfigSnapshot`,
   `applyPluginConfigSnapshot`, `tryAutoLoadDefaultPluginConfig`,
   `writeAutosaveSnapshot`, `scheduleAutosave`. Lines ~915-1016.
8. **WebSocket message dispatch**: `handleWsConnection` (lines 3526-3958) --
   a single method with a massive switch/if-else chain.
9. **Config persistence**: `saveConfig`, `buildConfigMessage`,
   `broadcastConfig`. Lines ~1879-1900.
10. **Broadcast helpers**: `broadcastInternalState`, `broadcastGameClientState`,
    `broadcastClientList`, etc. Lines ~1916-1960.

### Why decompose
- **Testability**: none of these services can be tested independently.
- **Navigation**: 4085 lines makes finding the right method difficult.
- **Separation of concerns**: account management, game launching, and fame
  tracking share zero state but are entangled in one class.

## Target design

### Service extraction pattern
Each extracted service is a plain TypeScript class that:
1. Receives its dependencies via constructor injection (config paths,
   logger, broadcast callbacks).
2. Exposes public methods that DevServer delegates to.
3. Does NOT import DevServer or know about WebSocket.

DevServer keeps:
- HTTP server setup and routing
- WebSocket server setup and the `handleWsConnection` dispatch
- Service wiring (constructing services, passing callbacks)
- Broadcast helpers (thin methods that stringify + send to all WS clients)
- Config load/save (simple JSON persistence)

### New files

**`AccountService.ts`** (~250 lines)
Extracted from DevServer:
- `readDashboardAccounts()`
- `normalizeDashboardAccountRecord()`
- `generateDashboardAccountId()`
- `readAllDashboardAccountOverviewCaches()`
- `getDashboardAccountOverviewCacheFile()`
- Account CRUD operations (add, update, delete, reorder)
- `verifyDecaAccount()` / `verifyDecaAccountOnce()`

Constructor takes: `accountsFilePath: string`, `cacheDir: string`.

**`GameLauncher.ts`** (~350 lines)
Extracted from DevServer:
- `launchGame()`
- `launchGameWithCredentials()`
- `getRotmgPath()` / detected path
- `isSingleClientOnlyEnabled()`
- `getRunningRotmgExaltProcessCount()` / `getRunningProcessCount()`
- `terminateProcessByImageName()`
- `getSingleClientLaunchBlockError()`
- `ensureSteamAppIdFile()`
- `clampLaunchWindowSize()`
- `buildCredentialLaunchWindowExtras()`
- `tryInjectDll()`

Constructor takes: config reference, injector paths, proxy reference.

**`FameTracker.ts`** (~80 lines)
Extracted from DevServer:
- `resetSessionStats()`
- `startFameSegment()`
- Fame accumulation state (`fameSectionStart`, `fameAccumulated`,
  `lastKnownFame`, `fameInitTimer`)
- `getSessionFame(): number`
- `onFameUpdate(currentFame: number)`

Constructor takes: nothing (pure state machine).

**`TradeSession.ts`** (~80 lines)
Extracted from DevServer:
- `tradeSession` state object
- `resetTradeSession()`
- `observeTradePacket(pkt)`
- `getTradeState()`

Constructor takes: nothing (pure state machine).

**`PluginConfigService.ts`** (~150 lines)
Extracted from DevServer:
- `buildPluginConfigSnapshot()`
- `applyPluginConfigSnapshot()`
- `tryAutoLoadDefaultPluginConfig()`
- `writeAutosaveSnapshot()`
- `scheduleAutosave()`
- Config directory management

Constructor takes: `configsDir: string`, `pluginManager: PluginManager`.

## Steps

### Step 1 -- Extract FameTracker
Create `client/src/dashboard/server/FameTracker.ts` with the fame tracking
state machine. Move the 5 fame-related fields and methods from DevServer.
In DevServer, replace with `private fameTracker = new FameTracker()` and
delegate.

**Verify:** `cd /home/jesse/realm-engine-client/client && npm run build`

### Step 2 -- Extract TradeSession
Create `client/src/dashboard/server/TradeSession.ts`. Move the trade session
state and the 3 trade-related methods. In DevServer, replace with
`private tradeSession = new TradeSession()` and delegate.

**Verify:** `cd /home/jesse/realm-engine-client/client && npm run build`

### Step 3 -- Extract AccountService
Create `client/src/dashboard/server/AccountService.ts`. Move account CRUD
methods and Deca account verification. In DevServer, replace with
`private accounts = new AccountService(...)` and delegate.

This is the largest extraction. Ensure the DevServer WS dispatch handler
delegates account-related messages to `this.accounts.*` methods.

**Verify:** `cd /home/jesse/realm-engine-client/client && npm run build`

### Step 4 -- Extract GameLauncher
Create `client/src/dashboard/server/GameLauncher.ts`. Move game launch,
process detection, and DLL injection methods. In DevServer, replace with
`private launcher = new GameLauncher(...)` and delegate.

**Verify:** `cd /home/jesse/realm-engine-client/client && npm run build`

### Step 5 -- Extract PluginConfigService
Create `client/src/dashboard/server/PluginConfigService.ts`. Move plugin
config snapshot and autosave methods. In DevServer, replace with
`private pluginConfigs = new PluginConfigService(...)` and delegate.

**Verify:** `cd /home/jesse/realm-engine-client/client && npm run build`

### Step 6 -- Final cleanup
1. Verify DevServer is now < 2500 lines (target: ~2000 lines for the
   remaining HTTP/WS/broadcast/config core).
2. Remove any dead imports from DevServer.ts.
3. Ensure all extracted services are imported and wired correctly.

**Verify:** `cd /home/jesse/realm-engine-client/client && npm run build`

## Verification
```bash
# Must typecheck clean
cd /home/jesse/realm-engine-client/client && npm run build

# Protocol tests still pass
cd /home/jesse/realm-engine-client/client/packages/protocol && npm test

# DevServer should be substantially smaller:
wc -l client/src/dashboard/server/DevServer.ts
# Expected: < 2500 lines (down from 4085)

# New service files should exist:
ls client/src/dashboard/server/AccountService.ts \
   client/src/dashboard/server/GameLauncher.ts \
   client/src/dashboard/server/FameTracker.ts \
   client/src/dashboard/server/TradeSession.ts \
   client/src/dashboard/server/PluginConfigService.ts

# No duplicate method definitions:
grep -c 'resetSessionStats\|observeTradePacket\|readDashboardAccounts\|launchGame\b\|writeAutosaveSnapshot' client/src/dashboard/server/DevServer.ts
# Expected: 1 each (the delegation call only, not the implementation)
```

## Out of scope
- Splitting the WebSocket message dispatch into a separate handler class --
  that is a further decomposition that can come after this plan.
- Splitting the HTTP route handler -- the HTTP API surface is small and
  contained in one method.
- Extracting the `PacketInspector` or `PacketLab` -- those are already
  separate classes.
- Merging the two packet protocol stacks -- explicitly deferred (see
  00-overview.md).
- Adding tests to the extracted services -- desirable but orthogonal.
