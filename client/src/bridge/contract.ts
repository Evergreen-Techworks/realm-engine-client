/**
 * contract.ts — the single TypeScript source of truth for the DLL↔client
 * bridge wire contract.
 *
 * Messages are plaintext length-prefixed JSON dispatched purely by `type` —
 * there is no per-message `seq`/`mac` signing and no mutual-auth handshake.
 *
 * Every value here is emitted on (or matched against) the named pipe the
 * injected DLL speaks, so it MUST byte-match the C++ side:
 *   - pipe name / protocol version : internal/src/core/ipc/ (fixed constants)
 *   - message `type` strings       : internal/src/core/ipc/IpcMessages.cpp
 *   - feature keys                 : internal/src/features/control/FeatureCommandRegistry.cpp
 *
 * When a game patch forces a change on the C++ side, update the matching file
 * above AND this module together. This does NOT unify across the language
 * boundary (no shared-schema codegen) — it centralizes the TS mirror and
 * documents its C++ counterpart. Do not change any emitted value: the DLL
 * matches these strings verbatim.
 */

/** Pipe name / protocol identifiers. `hello` carries `version`/`protocol`. */
export const BRIDGE = {
  DEV_PIPE_NAME: '\\\\.\\pipe\\lfg-dev-bridge',
  PROTOCOL_VERSION: 3,
  PROTOCOL_TAG: 'bridge-v3',
} as const;

/**
 * Message `type` strings exchanged with the DLL — all plaintext, no `seq`/`mac`.
 * Incoming (DLL→client): Hello, Heartbeat, HeartbeatResp, Player, HotkeyEvent,
 * UnresolvedClasses, Threats, Aim.
 * Outgoing (client→DLL): SetFeature (plus Heartbeat/HeartbeatResp).
 * Each must match a builder in IpcMessages.cpp.
 */
export const DllMessageType = {
  Hello: 'hello',
  Heartbeat: 'heartbeat',
  HeartbeatResp: 'heartbeatResp',
  Player: 'player',
  HotkeyEvent: 'hotkeyEvent',
  UnresolvedClasses: 'unresolvedClasses',
  Threats: 'threats',
  Aim: 'aim',
  SetFeature: 'setFeature',
} as const;
export type DllMessageType = typeof DllMessageType[keyof typeof DllMessageType];

/**
 * Feature keys `sendDllFeature` accepts, sorted. This union drives
 * sendDllFeature's parameter type, so a typo is a compile error — but it is
 * NOT the full set the DLL handles: see DLL_ONLY_FEATURE_KEYS below.
 *
 * The DLL swallows unknown keys by design (FeatureCommandRegistry.cpp:9-10),
 * so a key added here without a matching handler fails SILENTLY. Run
 * `node scripts/check-bridge-contract.mjs` (part of `npm test`) after any
 * change to either side.
 */
export const DLL_FEATURE_KEYS = [
  'autoAbilityEnabled', 'autoAbilityMpPct', 'autoAbilityWizardMode', 'autoAimEnabled',
  'autoAimIgnoreWalls', 'autoAimMode', 'autoAimPrioritizeBosses', 'autoDodgeMode',
  'autoNexusDebugDraw', 'autoNexusEnabled', 'autoNexusPredictedTimeMs', 'autoNexusProjPredict',
  'autoNexusTilePredict',
  'cameraAngleActive', 'cameraAngleValue', 'cameraCentered', 'cameraCenteringActive',
  'cameraZoomActive', 'cameraZoomValue', 'clientClassType', 'clientDefense',
  'clientSpeed', 'colliderEnabled', 'colliderMultiplier', 'dodgeHitScale',
  'followEntityActive', 'followEntityName', 'internalUnloadDll',
  'killauraEnabled', 'killauraMode',
  'killauraRangeTiles', 'killauraStandoffTiles', 'pjdodgeDebugOverlay',
  'pjdodgeHitScale', 'pjdodgeHorizonMs', 'pjdodgeLeadMs', 'pjdodgeLockFollow',
  'pjdodgePredictionAccuracy', 'pjdodgeSafeWalk', 'pjdodgeSpeedScale', 'playerColliderSceneReset',
  'playerNoclipActive', 'playerNoclipEnabled', 'playerNoclipHotkey', 'projectileNoclipEnabled',
  'reppAvoidHazards', 'reppDangerWeight', 'reppDebugOverlay', 'reppFollowLantern',
  'reppHitScale', 'reppMaxMoveTiles', 'reppMode', 'reppReactWindowMs',
  'reppStandOnType', 'rolloutAvoidEnemies', 'rolloutCommitDwell', 'rolloutDrawPath',
  'rolloutHeadings', 'rolloutHitScale', 'rolloutHorizonTicks', 'rolloutIntentWeight',
  'rolloutRebuildN', 'rolloutSampleStepMs', 'rolloutWasdYield', 'showPluginFloatingText',
  'skinOverrideEnabled', 'skinOverrideId', 'socketHotkey', 'socketHotkeyActive',
  'speedHackMult', 'targetFrameRate', 'udodgeAutopilot', 'udodgeDebugOverlay', 'udodgeDrawPath',
  'udodgeFieldEscape', 'udodgeFollowLantern', 'udodgeHitScale', 'udodgeLaneTiles',
  'udodgeLockFollow', 'udodgeOrbitRange', 'udodgePlanRadius',
  'udodgeReactMargin', 'udodgeSafeWalk', 'udodgeSpeedScale', 'udodgeStandOnType',
  'udodgeStepTiles', 'xdodgeArbiter', 'xdodgeAstar',
  'xdodgeAutoLock', 'xdodgeAvoidEnemies', 'xdodgeBfsBias', 'xdodgeCatalog',
  'xdodgeCcd', 'xdodgeCcdPad', 'xdodgeDangerPenalty', 'xdodgeDebugPredLongMs',
  'xdodgeDrawPath', 'xdodgeDrawProjPred', 'xdodgeFutureHorizon', 'xdodgeFutureSample',
  'xdodgeFutureStride', 'xdodgeGhostHit', 'xdodgeGoalSticky', 'xdodgeHitScale',
  'xdodgeLateralPref', 'xdodgeLockFollow', 'xdodgeLosGoal', 'xdodgePerpBias',
  'xdodgePlanStepMs', 'xdodgeRebuildN', 'xdodgeSmartGoal', 'xdodgeSpeedMatch',
  'xdodgeStayPenalty', 'xdodgeWalkCache', 'xdodgeWallAvoid', 'xdodgeWasdYield',
  'xdodgeWeighting', 'zdodgeBackpedalPenalty', 'zdodgeCandidateOverlay', 'zdodgeClearanceTiles',
  'zdodgeClearanceWeight', 'zdodgeDamageThresholdPct', 'zdodgeDebugOverlay', 'zdodgeEnemyAvoidanceRadius',
  'zdodgeIntentWeight', 'zdodgeMaxMoveTiles', 'zdodgePerpWeight', 'zdodgePlayerRadius',
  'zdodgeProjectileHitScale', 'zdodgeProjectileRadiusFallback', 'zdodgeReactWindowMs', 'zdodgeSampleStepMs',
] as const;
export type DllFeatureKey = typeof DLL_FEATURE_KEYS[number];

/**
 * Feature keys the DLL's FeatureCommandRegistry.cpp handles but that NOTHING in
 * the client sends today. Listed here so `scripts/check-bridge-contract.mjs`
 * can tell "intentionally DLL-side only" apart from "someone forgot to add a
 * key" — the latter is a silent bug, because the DLL swallows unknown keys by
 * design (FeatureCommandRegistry.cpp:9-10).
 *
 * Three sub-groups, kept in one list because the checker only needs the set:
 *   - in-game-UI only  : the ImGui Combat/Test tab owns them, there is no
 *                        dashboard control (autoFire*, autoBreakWalls*,
 *                        overlayEnabled, walkTarget*)
 *   - untyped sender   : sent via InternalBridge.setFeature (not sendDllFeature),
 *                        so it deliberately bypasses DllFeatureKey
 *                        (pluginToggleHotkeys — DevServer.ts:2897)
 *   - legacy dodge     : honoured by the DLL, no live sender anywhere
 *
 * Adding a dashboard control for one of these means MOVING it into
 * DLL_FEATURE_KEYS, not duplicating it.
 */
export const DLL_ONLY_FEATURE_KEYS = [
  'autoBreakWallsEnabled', 'autoBreakWallsProbeTiles', 'autoBreakWallsTimeoutMs',
  'autoDodgeHitboxPadding', 'autoDodgeHorizonMs', 'autoDodgeWallAvoid',
  'autoFireEnabled', 'autoFireHotkey',
  'dodgeHitAversion', 'dodgeIdleMinGain', 'dodgeReplanOnSpawn', 'dodgeStickiness',
  'killauraDriveAimEnabled', 'killauraOverlayEnabled',
  'dodgeStrategicBias', 'dodgeStrategicNearWaypoint', 'dodgeTightLeash',
  'dodgeWasdLookahead',
  'overlayEnabled', 'pluginToggleHotkeys',
  'walkTargetActive', 'walkTargetX', 'walkTargetY',
  'xdodgeNotifyHit', 'xdodgeSearchRadius',
] as const;

/**
 * Keys `sendDllFeature` accepts that the DLL does NOT currently handle. Every
 * entry here is a live bug: the send succeeds, the DLL swallows it silently
 * (FeatureCommandRegistry.cpp:9-10), and the feature does nothing.
 *
 * KNOWN-BROKEN (do not add to without an owner):
 *   followEntityActive / followEntityName — client/plugins/auto-follow.ts sends
 *   both; there is no handler in FeatureCommandRegistry.cpp and no caller of
 *   DangerPlanner::SetExternalGoal outside TestTAB. The Auto Follow plugin is a
 *   no-op. Fix = either implement the DLL handler or delete the plugin; that is
 *   a product decision, tracked separately.
 */
export const KNOWN_UNHANDLED_FEATURE_KEYS = [
  'followEntityActive', 'followEntityName',
] as const;
