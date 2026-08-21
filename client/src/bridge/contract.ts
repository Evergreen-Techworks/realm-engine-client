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
 * UnresolvedClasses, Threats.
 * Outgoing (client→DLL): SetFeature, ClearTiles, NoWalkInit, TileUpdate
 * (plus Heartbeat/HeartbeatResp). Each must match a builder in IpcMessages.cpp.
 */
export const DllMessageType = {
  Hello: 'hello',
  Heartbeat: 'heartbeat',
  HeartbeatResp: 'heartbeatResp',
  Player: 'player',
  HotkeyEvent: 'hotkeyEvent',
  UnresolvedClasses: 'unresolvedClasses',
  Threats: 'threats',
  SetFeature: 'setFeature',
  ClearTiles: 'clearTiles',
  NoWalkInit: 'noWalkInit',
  TileUpdate: 'tileUpdate',
} as const;
export type DllMessageType = typeof DllMessageType[keyof typeof DllMessageType];

/**
 * The full set of `sendDllFeature` feature keys, sorted. Exhaustive — the union
 * below drives sendDllFeature's parameter type, so a typo is a compile error.
 * Every key here is consumed by the DLL's FeatureCommandRegistry.cpp (via its
 * FH_* handler tables / FeatureCommand::Is). Keep this list in sync with that
 * file after any game patch.
 */
export const DLL_FEATURE_KEYS = [
  'autoAbilityEnabled', 'autoAbilityMpPct', 'autoAbilityWizardMode', 'autoAimEnabled',
  'autoAimIgnoreWalls', 'autoAimMode', 'autoAimPrioritizeBosses', 'autoDodgeMode',
  'autoNexusDebugDraw', 'autoNexusEnabled', 'autoNexusPredictedTimeMs', 'autoNexusProjPredict',
  'autoNexusTilePredict',
  'cameraAngleActive', 'cameraAngleValue', 'cameraCentered', 'cameraCenteringActive',
  'cameraZoomActive', 'cameraZoomValue', 'clientClassType', 'clientDefense',
  'clientSpeed', 'colliderEnabled', 'colliderMultiplier', 'dodgeHitScale',
  'followEntityActive', 'followEntityName', 'internalUnloadDll', 'pjdodgeDebugOverlay',
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
