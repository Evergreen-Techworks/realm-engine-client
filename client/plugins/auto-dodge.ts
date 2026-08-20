import type { PluginContext } from './api.js';
import { sendDllFeature } from './api.js';

// Maps the dashboard string value to the C++ TestTAB::DodgeMode enum.
// Off=0, XDodge=1, RolloutGrid=2, RolloutQuad=3, zDodge=4, RePP=5,
// PJDodge=6, UDodge (Unified)=7.
// XDodge uses A* (goal-directed) with BFS fallback (immediate escape),
// ported from XRebuild/XDriver decompile. RE-Sim does per-input forward
// simulation; the two RE-Sim modes differ only in broad-phase backend
// (grid vs quadtree) so they can be A/B-compared. zDodge is an
// intent-preserving slide-assist dodge. RePP (RE++) is the next-gen
// reactive dodge. PJDodge is the predictive controller (exact segment CCD,
// survival-first candidate selection, intent ladder, escape search).
// Unified (UDodge) merges PJDodge's predictive core with RePP's field
// escape and autopilot goal layer.
const DODGE_VALUES = ['off', 'xdodge', 'rollout-grid', 'rollout-quad', 'zdodge', 're-plus-plus', 'pj-dodge', 'unified'] as const;
type ActiveDodgeMode = Exclude<(typeof DODGE_VALUES)[number], 'off'>;
type SettingConfig = Parameters<PluginContext['registerSetting']>[1];
type SettingCallback = Parameters<PluginContext['registerSetting']>[2];

function modeToIdx(v: string): number {
  const i = DODGE_VALUES.indexOf(v as (typeof DODGE_VALUES)[number]);
  return Math.max(0, i);
}

function autoLockModeToIdx(v: string): number {
  if (v === 'closest') return 1;
  if (v === 'aim') return 2;
  return 0;
}

export function register(ctx: PluginContext) {
  ctx.name = 'Auto Dodge';
  ctx.category = 'combat';

  function flush(forceOff = false) {
    const off = forceOff || !ctx.enabled;
    const mode = off ? 0 : modeToIdx(ctx.getSetting<string>('dodgeMode'));
    sendDllFeature('autoDodgeMode', mode);
  }

  // `mode` may be a single dodge mode or several — settings shown for the RE-Sim
  // family pass both broad-phase variants so they stay visible across grid/quad.
  function registerModeSetting(
    mode: ActiveDodgeMode | ActiveDodgeMode[],
    key: string,
    config: SettingConfig,
    onChange?: SettingCallback,
  ) {
    const visibleWhen = Array.isArray(mode)
      ? { key: 'dodgeMode', values: mode }
      : { key: 'dodgeMode', value: mode };
    ctx.registerSetting(key, { ...config, visibleWhen }, onChange);
  }

  // The two RE-Sim broad-phase modes share one settings group.
  const ROLLOUT_MODES: ActiveDodgeMode[] = ['rollout-grid', 'rollout-quad'];

  ctx.registerSetting('dodgeMode', {
    label: 'Dodge mode',
    type: 'select',
    value: 'xdodge',
    options: [
      { label: 'Off', value: 'off' },
      { label: 'RE-Plus', value: 'xdodge' },
      { label: 'RE-Sim (Grid)', value: 'rollout-grid' },
      { label: 'RE-Sim (Quadtree)', value: 'rollout-quad' },
      { label: 'zDodge', value: 'zdodge' },
      { label: 'RE++', value: 're-plus-plus' },
      { label: 'PJDodge', value: 'pj-dodge' },
      { label: 'Unified (RE++ x PJDodge)', value: 'unified' },
    ],
  }, () => flush());

  // Cap FPS to 60 while Auto Dodge is on (the fps-setter behaviour, baked
  // in — no separate plugin needed). On → targetFrameRate 60; off →
  // restore uncapped (-1), but only if WE applied the cap.
  let _fpsCapApplied = false;
  function applyDodgeFps(on: boolean) {
    if (!ctx.getSetting<boolean>('capFps60')) {
      if (_fpsCapApplied) { sendDllFeature('targetFrameRate', -1); _fpsCapApplied = false; }
      return;
    }
    if (on) { sendDllFeature('targetFrameRate', 60); _fpsCapApplied = true; }
    else if (_fpsCapApplied) { sendDllFeature('targetFrameRate', -1); _fpsCapApplied = false; }
  }
  ctx.registerSetting('capFps60', {
    label: 'Cap FPS to 60 while dodging',
    type: 'boolean',
    value: true,
  }, () => applyDodgeFps(ctx.enabled));

  // ── RE-Plus settings ─────────────────────────────────────────────────────
  registerModeSetting('xdodge', 'xdodgeHitScale', {
    label: '[RE-Plus] Hit scale', advanced: true,
    type: 'range', value: 1, min: 0.5, max: 2, step: 0.05,
  }, (v: number) => sendDllFeature('xdodgeHitScale', v));

  registerModeSetting('xdodge', 'xdodgeRebuildN', {
    label: '[RE-Plus] Rebuild every N frames', advanced: true,
    type: 'range', value: 3, min: 1, max: 10, step: 1,
  }, (v: number) => sendDllFeature('xdodgeRebuildN', v));

  registerModeSetting('xdodge', 'xdodgePlanStepMs', {
    label: '[RE-Plus] Plan step (ms)', advanced: true,
    type: 'range', value: 50, min: 10, max: 200, step: 5,
  }, (v: number) => sendDllFeature('xdodgePlanStepMs', v));

  // ── A* pathfinder settings ────────────────────────────────────────────────
  registerModeSetting('xdodge', 'xdodgeDangerPenalty', {
    label: 'Danger sensitivity (lower = tighter / threads closer)',
    type: 'range', value: 2, min: 0, max: 5, step: 0.1,
  }, (v: number) => sendDllFeature('xdodgeDangerPenalty', v));

  registerModeSetting('xdodge', 'xdodgeStayPenalty', {
    label: 'Stay-in-place cost (inert — kept for protocol sync)', advanced: true,
    type: 'range', value: 0.5, min: 0, max: 2, step: 0.05,
  }, (v: number) => sendDllFeature('xdodgeStayPenalty', v));

  // ── Future-sample look-ahead (XDriver IsSafeCandidateStrong) ──────────────
  registerModeSetting('xdodge', 'xdodgeFutureSample', {
    label: '[Future] Extended look-ahead',
    advanced: true,
    type: 'select',
    value: 'on',
    options: [
      { label: 'On', value: 'on' },
      { label: 'Off', value: 'off' },
    ],
  }, (v: string) => sendDllFeature('xdodgeFutureSample', v === 'on' ? 1 : 0));

  registerModeSetting('xdodge', 'xdodgeFutureHorizon', {
    label: '[Future] Horizon (ms)', advanced: true,
    type: 'range', value: 2500, min: 500, max: 5000, step: 100,
  }, (v: number) => sendDllFeature('xdodgeFutureHorizon', v));

  registerModeSetting('xdodge', 'xdodgeFutureStride', {
    label: '[Future] Sample stride (ms)', advanced: true,
    type: 'range', value: 50, min: 8, max: 200, step: 2,
  }, (v: number) => sendDllFeature('xdodgeFutureStride', v));

  // ── Hitbox settings ────────────────────────────────────────────────────────
  registerModeSetting('xdodge', 'dodgeHitScale', {
    label: 'Dodge hitbox scale', advanced: true,
    type: 'range', value: 1, min: 0.5, max: 2, step: 0.05,
  }, (v: number) => sendDllFeature('dodgeHitScale', v));

  // ── Weighted-field + A* goal tier (additive over the immediate BFS) ───────
  // All four are independent. With every one 'off' the dodge is the exact
  // BFS-only build; the immediate BFS reflex is never affected by them.
  const onOff = (label: string, def: 'on' | 'off' = 'on') => ({
    label, advanced: true, type: 'select' as const, value: def,
    options: [{ label: 'On', value: 'on' }, { label: 'Off', value: 'off' }],
  });

  // ── zDodge settings ───────────────────────────────────────────────────────
  registerModeSetting('zdodge', 'zdodgeReactWindowMs', {
    label: '[zDodge] React window (ms)',
    type: 'range', value: 1200, min: 100, max: 2500, step: 25,
  }, (v: number) => sendDllFeature('zdodgeReactWindowMs', v));
  registerModeSetting('zdodge', 'zdodgeMaxMoveTiles', {
    label: '[zDodge] Max assist distance (tiles)',
    type: 'range', value: 0.55, min: 0.2, max: 4, step: 0.05,
  }, (v: number) => sendDllFeature('zdodgeMaxMoveTiles', v));
  registerModeSetting('zdodge', 'zdodgePlayerRadius', {
    label: '[zDodge] Player radius', advanced: true,
    type: 'range', value: 0.05, min: 0, max: 1, step: 0.01,
  }, (v: number) => sendDllFeature('zdodgePlayerRadius', v));
  registerModeSetting('zdodge', 'zdodgeProjectileHitScale', {
    label: '[zDodge] Projectile hit scale', advanced: true,
    type: 'range', value: 0.9, min: 0, max: 3, step: 0.05,
  }, (v: number) => sendDllFeature('zdodgeProjectileHitScale', v));
  registerModeSetting('zdodge', 'zdodgeProjectileRadiusFallback', {
    label: '[zDodge] Projectile fallback radius', advanced: true,
    type: 'range', value: 0.02, min: 0, max: 1, step: 0.01,
  }, (v: number) => sendDllFeature('zdodgeProjectileRadiusFallback', v));
  registerModeSetting('zdodge', 'zdodgeClearanceTiles', {
    label: '[zDodge] Clearance tiles', advanced: true,
    type: 'range', value: 0.03, min: 0, max: 1, step: 0.01,
  }, (v: number) => sendDllFeature('zdodgeClearanceTiles', v));
  registerModeSetting('zdodge', 'zdodgeSampleStepMs', {
    label: '[zDodge] Sample step (ms)', advanced: true,
    type: 'range', value: 40, min: 8, max: 100, step: 1,
  }, (v: number) => sendDllFeature('zdodgeSampleStepMs', v));
  registerModeSetting('zdodge', 'zdodgePerpWeight', {
    label: '[zDodge] Perpendicular weight', advanced: true,
    type: 'range', value: 6, min: 0, max: 10, step: 0.1,
  }, (v: number) => sendDllFeature('zdodgePerpWeight', v));
  registerModeSetting('zdodge', 'zdodgeIntentWeight', {
    label: '[zDodge] Intent weight', advanced: true,
    type: 'range', value: 2.5, min: 0, max: 10, step: 0.1,
  }, (v: number) => sendDllFeature('zdodgeIntentWeight', v));
  registerModeSetting('zdodge', 'zdodgeClearanceWeight', {
    label: '[zDodge] Clearance weight', advanced: true,
    type: 'range', value: 1.5, min: 0, max: 5, step: 0.1,
  }, (v: number) => sendDllFeature('zdodgeClearanceWeight', v));
  registerModeSetting('zdodge', 'zdodgeBackpedalPenalty', {
    label: '[zDodge] Backpedal penalty', advanced: true,
    type: 'range', value: 3, min: 0, max: 10, step: 0.1,
  }, (v: number) => sendDllFeature('zdodgeBackpedalPenalty', v));
  registerModeSetting('zdodge', 'zdodgeEnemyAvoidanceRadius', {
    label: '[zDodge] Enemy no-go radius', advanced: true,
    type: 'range', value: 2, min: 0, max: 3, step: 0.05,
  }, (v: number) => sendDllFeature('zdodgeEnemyAvoidanceRadius', v));
  registerModeSetting('zdodge', 'zdodgeDamageThresholdPct', {
    label: '[zDodge] Damage threshold pct', advanced: true,
    type: 'range', value: 0, min: 0, max: 1, step: 0.01,
  }, (v: number) => sendDllFeature('zdodgeDamageThresholdPct', v));
  registerModeSetting('zdodge', 'zdodgeDebugOverlay', onOff('[zDodge] Debug overlay', 'on'),
    (v: string) => sendDllFeature('zdodgeDebugOverlay', v === 'on' ? 1 : 0));
  registerModeSetting('zdodge', 'zdodgeCandidateOverlay', onOff('[zDodge] Candidate points', 'on'),
    (v: string) => sendDllFeature('zdodgeCandidateOverlay', v === 'on' ? 1 : 0));

  // ── RE++ settings ─────────────────────────────────────────────────────────
  registerModeSetting('re-plus-plus', 'reppReactWindowMs', {
    label: '[RE++] React window (ms)',
    type: 'range', value: 650, min: 100, max: 2500, step: 25,
  }, (v: number) => sendDllFeature('reppReactWindowMs', v));
  registerModeSetting('re-plus-plus', 'reppMaxMoveTiles', {
    label: '[RE++] Max assist distance (tiles)',
    type: 'range', value: 1, min: 0.2, max: 4, step: 0.05,
  }, (v: number) => sendDllFeature('reppMaxMoveTiles', v));
  registerModeSetting('re-plus-plus', 'reppHitScale', {
    label: '[RE++] Hit scale', advanced: true,
    type: 'range', value: 1, min: 0.5, max: 2, step: 0.05,
  }, (v: number) => sendDllFeature('reppHitScale', v));
  registerModeSetting('re-plus-plus', 'reppDangerWeight', {
    label: '[RE++] Danger weight',
    type: 'range', value: 2, min: 0, max: 5, step: 0.1,
  }, (v: number) => sendDllFeature('reppDangerWeight', v));
  registerModeSetting('re-plus-plus', 'reppMode', {
    label: '[RE++] Mode',
    type: 'select',
    value: 'assist',
    options: [
      { label: 'Assist', value: 'assist' },
      { label: 'Autopilot', value: 'autopilot' },
    ],
  }, (v: string) => sendDllFeature('reppMode', v === 'autopilot' ? 1 : 0));
  registerModeSetting('re-plus-plus', 'reppFollowLantern',
    onOff('[RE++][Autopilot] Follow stand-on object (lantern) — perf cost', 'off'),
    (v: string) => sendDllFeature('reppFollowLantern', v === 'on' ? 1 : 0));
  registerModeSetting('re-plus-plus', 'reppStandOnType', {
    label: '[RE++][Autopilot] Stand-on objType (0=off; e.g. Moonlight Village lantern)',
    advanced: true,
    type: 'range', value: 0, min: 0, max: 65535, step: 1,
  }, (v: number) => sendDllFeature('reppStandOnType', v));
  registerModeSetting('re-plus-plus', 'reppAvoidHazards', onOff('[RE++] Avoid hazards', 'on'),
    (v: string) => sendDllFeature('reppAvoidHazards', v === 'on' ? 1 : 0));
  registerModeSetting('re-plus-plus', 'reppDebugOverlay', onOff('[RE++] Debug overlay', 'on'),
    (v: string) => sendDllFeature('reppDebugOverlay', v === 'on' ? 1 : 0));

  // ── PJDodge settings ──────────────────────────────────────────────────────
  registerModeSetting('pj-dodge', 'pjdodgeHorizonMs', {
    label: '[PJDodge] Prediction horizon (ms)',
    type: 'range', value: 600, min: 300, max: 1200, step: 25,
  }, (v: number) => sendDllFeature('pjdodgeHorizonMs', v));
  registerModeSetting('pj-dodge', 'pjdodgeLeadMs', {
    label: '[PJDodge] Command lead (ms — latency compensation)', advanced: true,
    type: 'range', value: 40, min: 0, max: 150, step: 5,
  }, (v: number) => sendDllFeature('pjdodgeLeadMs', v));
  registerModeSetting('pj-dodge', 'pjdodgeHitScale', {
    label: '[PJDodge] Hit scale (1 = exact game hitbox)', advanced: true,
    type: 'range', value: 1, min: 0.5, max: 1.5, step: 0.05,
  }, (v: number) => sendDllFeature('pjdodgeHitScale', v));
  registerModeSetting('pj-dodge', 'pjdodgeSafeWalk', onOff('[PJDodge] Safe walk (avoid damaging ground)', 'on'),
    (v: string) => sendDllFeature('pjdodgeSafeWalk', v === 'on' ? 1 : 0));
  registerModeSetting('pj-dodge', 'pjdodgeSpeedScale', onOff('[PJDodge] Match intent speed on gentle overrides', 'on'),
    (v: string) => sendDllFeature('pjdodgeSpeedScale', v === 'on' ? 1 : 0));
  registerModeSetting('pj-dodge', 'pjdodgePredictionAccuracy',
    onOff('[PJDodge] Prediction accuracy (per-shot clock calibration)', 'on'),
    (v: string) => sendDllFeature('pjdodgePredictionAccuracy', v === 'on' ? 1 : 0));
  registerModeSetting('pj-dodge', 'pjdodgeDebugOverlay', onOff('[PJDodge] Debug overlay', 'on'),
    (v: string) => sendDllFeature('pjdodgeDebugOverlay', v === 'on' ? 1 : 0));
  registerModeSetting('pj-dodge', 'pjdodgeLockFollow',
    onOff('[PJDodge] Lock follow (walk toward lock target)', 'off'),
    (v: string) => sendDllFeature('pjdodgeLockFollow', v === 'on' ? 1 : 0));

  // ── UDodge (Unified) settings ─────────────────────────────────────────────
  registerModeSetting('unified', 'udodgeLaneTiles', {
    label: '[UDodge] Danger lane length (tiles)',
    type: 'range', value: 12, min: 2, max: 16, step: 0.5,
  }, (v: number) => sendDllFeature('udodgeLaneTiles', v));
  registerModeSetting('unified', 'udodgeStepTiles', {
    label: '[UDodge] Step distance (tiles, 0 = auto: one server tick)', advanced: true,
    type: 'range', value: 0, min: 0, max: 3, step: 0.1,
  }, (v: number) => sendDllFeature('udodgeStepTiles', v));
  registerModeSetting('unified', 'udodgeHitScale', {
    label: '[UDodge] Hit scale (1 = exact game hitbox)', advanced: true,
    type: 'range', value: 1, min: 0.5, max: 1.5, step: 0.05,
  }, (v: number) => sendDllFeature('udodgeHitScale', v));
  registerModeSetting('unified', 'udodgeReactMargin', {
    label: '[UDodge] Reaction margin (tiles — wider = dodge sooner/smoother)',
    type: 'range', value: 0.6, min: 0.05, max: 2.0, step: 0.05,
  }, (v: number) => sendDllFeature('udodgeReactMargin', v));
  registerModeSetting('unified', 'udodgeSafeWalk', onOff('[UDodge] Safe walk (avoid damaging ground)', 'on'),
    (v: string) => sendDllFeature('udodgeSafeWalk', v === 'on' ? 1 : 0));
  registerModeSetting('unified', 'udodgeSpeedScale', onOff('[UDodge] Match intent speed on gentle overrides', 'on'),
    (v: string) => sendDllFeature('udodgeSpeedScale', v === 'on' ? 1 : 0));
  registerModeSetting('unified', 'udodgeFieldEscape',
    onOff('[UDodge] Field escape (Dijkstra route around walls when boxed in)', 'on'),
    (v: string) => sendDllFeature('udodgeFieldEscape', v === 'on' ? 1 : 0));
  registerModeSetting('unified', 'udodgeLockFollow',
    onOff('[UDodge] Lock follow (walk toward lock target)', 'off'),
    (v: string) => sendDllFeature('udodgeLockFollow', v === 'on' ? 1 : 0));
  registerModeSetting('unified', 'udodgeFollowLantern',
    onOff('[UDodge][Autopilot] Follow stand-on object (lantern) — perf cost', 'off'),
    (v: string) => sendDllFeature('udodgeFollowLantern', v === 'on' ? 1 : 0));
  registerModeSetting('unified', 'udodgeStandOnType', {
    label: '[UDodge][Autopilot] Stand-on objType (0=off; e.g. Moonlight Village lantern)',
    advanced: true,
    type: 'range', value: 0, min: 0, max: 65535, step: 1,
  }, (v: number) => sendDllFeature('udodgeStandOnType', v));
  registerModeSetting('unified', 'udodgeDebugOverlay', onOff('[UDodge] Debug overlay', 'on'),
    (v: string) => sendDllFeature('udodgeDebugOverlay', v === 'on' ? 1 : 0));
  registerModeSetting('unified', 'udodgeDrawPath', onOff('[UDodge] Draw planned route overlay', 'on'),
    (v: string) => sendDllFeature('udodgeDrawPath', v === 'on' ? 1 : 0));
  registerModeSetting('unified', 'udodgeOrbitRange', {
    label: '[UDodge][Autopilot] Orbit range (tiles, 0 = auto from weapon range)',
    type: 'range', value: 0, min: 0, max: 16, step: 0.5,
  }, (v: number) => sendDllFeature('udodgeOrbitRange', v));
  registerModeSetting('unified', 'udodgePlanRadius', {
    label: '[UDodge] Plan window radius (grid cells — smaller = cheaper)', advanced: true,
    type: 'range', value: 20, min: 8, max: 40, step: 1,
  }, (v: number) => sendDllFeature('udodgePlanRadius', v));

  registerModeSetting('xdodge', 'xdodgeAstar', onOff('[Goal] Smart goal pathing'),
    (v: string) => sendDllFeature('xdodgeAstar', v === 'on' ? 1 : 0));
  registerModeSetting('xdodge', 'xdodgeWeighting', onOff('[Goal] Weighted danger field'),
    (v: string) => sendDllFeature('xdodgeWeighting', v === 'on' ? 1 : 0));
  registerModeSetting('xdodge', 'xdodgeSmartGoal', onOff('[Goal] Smart goal position'),
    (v: string) => sendDllFeature('xdodgeSmartGoal', v === 'on' ? 1 : 0));
  registerModeSetting('xdodge', 'xdodgePerpBias', onOff('[Goal] Perpendicular sidestep bias'),
    (v: string) => sendDllFeature('xdodgePerpBias', v === 'on' ? 1 : 0));
  registerModeSetting('xdodge', 'xdodgeSpeedMatch', onOff('Speed match (anti rubber-band)'),
    (v: string) => sendDllFeature('xdodgeSpeedMatch', v === 'on' ? 1 : 0));
  registerModeSetting('xdodge', 'xdodgeLockFollow', onOff('Lock-follow (Shift+Click enemy to track)'),
    (v: string) => sendDllFeature('xdodgeLockFollow', v === 'on' ? 1 : 0));

  // Auto enemy lock — picks a target automatically when no manual
  // Shift+Click lock is set. Manual lock always wins. Pattern mirrors
  // auto-aim's mode select. Indices match DangerPlanner::SetAutoLockMode:
  // 0 = off, 1 = closest enemy, 2 = whatever auto-aim is targeting (so
  // Highest-HP / Closest-to-Mouse are delegated to the auto-aim plugin's
  // own mode).
  registerModeSetting('xdodge', 'enemyAutoLock', {
    label: 'Auto enemy lock',
    type: 'select',
    value: 'off',
    options: [
      { label: 'Off', value: 'off' },
      { label: 'Closest enemy', value: 'closest' },
      { label: 'Auto-aim target', value: 'aim' },
    ],
  }, (v: string) => sendDllFeature(
    'xdodgeAutoLock',
    autoLockModeToIdx(v)
  ));
  registerModeSetting('xdodge', 'xdodgeWalkCache', onOff('Walkability cache (perf / AutoNexus)'),
    (v: string) => sendDllFeature('xdodgeWalkCache', v === 'on' ? 1 : 0));
  registerModeSetting('xdodge', 'xdodgeWallAvoid', onOff('[Goal] Wall avoidance (clearance + corner-clip)'),
    (v: string) => sendDllFeature('xdodgeWallAvoid', v === 'on' ? 1 : 0));
  registerModeSetting('xdodge', 'xdodgeArbiter', onOff('[Goal] Orbit↔Survive arbiter (flee when area untenable)'),
    (v: string) => sendDllFeature('xdodgeArbiter', v === 'on' ? 1 : 0));
  registerModeSetting('xdodge', 'xdodgeBfsBias', onOff('Strategic escape bias (head toward goal)'),
    (v: string) => sendDllFeature('xdodgeBfsBias', v === 'on' ? 1 : 0));
  registerModeSetting('xdodge', 'xdodgeCcd', onOff('CCD-exact tight reflex (razor-tight)'),
    (v: string) => sendDllFeature('xdodgeCcd', v === 'on' ? 1 : 0));
  registerModeSetting('xdodge', 'xdodgeCcdPad', {
    label: 'CCD pad (tiles — command-latency margin)', advanced: true,
    type: 'range', value: 0.03, min: 0, max: 0.5, step: 0.01,
  }, (v: number) => sendDllFeature('xdodgeCcdPad', v));
  // Catalog observation toggle. The learned hitbox INFLATION it used to
  // apply is now hard-zeroed in the DLL (it was making the dodge refuse
  // tight gaps after a session), so toggling this only controls whether
  // the catalog still records observations — there's no movement effect.
  registerModeSetting('xdodge', 'xdodgeCatalog', onOff('Per-type bullet learning (inert — no longer inflates hitbox)', 'off'),
    (v: string) => sendDllFeature('xdodgeCatalog', v === 'on' ? 1 : 0));
  registerModeSetting('xdodge', 'xdodgeLosGoal', onOff('[Lock] Keep line-of-sight to enemy'),
    (v: string) => sendDllFeature('xdodgeLosGoal', v === 'on' ? 1 : 0));
  registerModeSetting('xdodge', 'xdodgeWasdYield', onOff('Yield to manual WASD (no fighting your input)'),
    (v: string) => sendDllFeature('xdodgeWasdYield', v === 'on' ? 1 : 0));
  registerModeSetting('xdodge', 'xdodgeAvoidEnemies', onOff('Never stand on enemies / bosses (avoid contact damage)'),
    (v: string) => sendDllFeature('xdodgeAvoidEnemies', v === 'on' ? 1 : 0));
  // Ghost-hit protection: an independent swept-collision check in the DLL
  // catches bullets the game's per-tick collision skipped (the cause of
  // "ghost-hit deaths" with speedhack on) and synthesises a PLAYERHIT
  // packet so AutoNexus reacts before HP drops past threshold. On by
  // default — ghost-hit deaths outweigh the theoretical detectability of
  // the synthetic packets we emit; users can disable per-server if needed.
  registerModeSetting('xdodge', 'xdodgeGhostHit', onOff('Ghost-hit protection (sync hits the game missed)'),
    (v: string) => sendDllFeature('xdodgeGhostHit', v === 'on' ? 1 : 0));
  registerModeSetting('xdodge', 'xdodgeLateralPref', onOff('[Goal] Anti-flee + sidestep bias (no backwards sprinting)'),
    (v: string) => sendDllFeature('xdodgeLateralPref', v === 'on' ? 1 : 0));
  registerModeSetting('xdodge', 'xdodgeGoalSticky', onOff('[Goal] Path stickiness (no flipping between equal paths)'),
    (v: string) => sendDllFeature('xdodgeGoalSticky', v === 'on' ? 1 : 0));
  registerModeSetting('xdodge', 'xdodgeDrawPath', onOff('Draw planned path on screen (debug)', 'off'),
    (v: string) => sendDllFeature('xdodgeDrawPath', v === 'on' ? 1 : 0));

  // ── RE-Sim (Rollout) settings ─────────────────────────────────────────────
  // Forward input-simulation dodge: per candidate heading, roll the player
  // forward N ticks and CCD-test the swept path against predicted bullets,
  // using a uniform-grid broad-phase. Active when Dodge mode = RE-Sim.
  registerModeSetting(ROLLOUT_MODES, 'rolloutHorizonTicks', {
    label: '[RE-Sim] Horizon (ticks)',
    type: 'range', value: 4, min: 1, max: 8, step: 1,
  }, (v: number) => sendDllFeature('rolloutHorizonTicks', v));
  registerModeSetting(ROLLOUT_MODES, 'rolloutSampleStepMs', {
    label: '[RE-Sim] Sample step (ms)', advanced: true,
    type: 'range', value: 25, min: 10, max: 60, step: 5,
  }, (v: number) => sendDllFeature('rolloutSampleStepMs', v));
  registerModeSetting(ROLLOUT_MODES, 'rolloutHeadings', {
    label: '[RE-Sim] Candidate headings',
    type: 'range', value: 16, min: 8, max: 24, step: 1,
  }, (v: number) => sendDllFeature('rolloutHeadings', v));
  registerModeSetting(ROLLOUT_MODES, 'rolloutHitScale', {
    label: '[RE-Sim] Hit scale', advanced: true,
    type: 'range', value: 1, min: 0.5, max: 2, step: 0.05,
  }, (v: number) => sendDllFeature('rolloutHitScale', v));
  registerModeSetting(ROLLOUT_MODES, 'rolloutIntentWeight', {
    label: '[RE-Sim] Intent weight (pull toward goal)',
    type: 'range', value: 1, min: 0, max: 3, step: 0.1,
  }, (v: number) => sendDllFeature('rolloutIntentWeight', v));
  registerModeSetting(ROLLOUT_MODES, 'rolloutRebuildN', {
    label: '[RE-Sim] Rebuild every N frames', advanced: true,
    type: 'range', value: 2, min: 1, max: 10, step: 1,
  }, (v: number) => sendDllFeature('rolloutRebuildN', v));
  registerModeSetting(ROLLOUT_MODES, 'rolloutAvoidEnemies', onOff('[RE-Sim] Never stand on enemies / bosses'),
    (v: string) => sendDllFeature('rolloutAvoidEnemies', v === 'on' ? 1 : 0));
  registerModeSetting(ROLLOUT_MODES, 'rolloutWasdYield', onOff('[RE-Sim] Yield to manual WASD'),
    (v: string) => sendDllFeature('rolloutWasdYield', v === 'on' ? 1 : 0));
  registerModeSetting(ROLLOUT_MODES, 'rolloutCommitDwell', onOff('[RE-Sim] Commit dwell (no direction flip-flop)'),
    (v: string) => sendDllFeature('rolloutCommitDwell', v === 'on' ? 1 : 0));
  registerModeSetting(ROLLOUT_MODES, 'rolloutDrawPath', onOff('[RE-Sim] Draw candidate rollouts (debug)', 'off'),
    (v: string) => sendDllFeature('rolloutDrawPath', v === 'on' ? 1 : 0));

  function syncModeSettings() {
    sendDllFeature('xdodgeHitScale',       ctx.getSetting<number>('xdodgeHitScale'));
    sendDllFeature('xdodgeRebuildN',       ctx.getSetting<number>('xdodgeRebuildN'));
    sendDllFeature('xdodgePlanStepMs',     ctx.getSetting<number>('xdodgePlanStepMs'));
    sendDllFeature('xdodgeDangerPenalty',  ctx.getSetting<number>('xdodgeDangerPenalty'));
    sendDllFeature('xdodgeStayPenalty',    ctx.getSetting<number>('xdodgeStayPenalty'));
    const fs = ctx.getSetting<string>('xdodgeFutureSample');
    sendDllFeature('xdodgeFutureSample',   fs === 'on' ? 1 : 0);
    sendDllFeature('xdodgeFutureHorizon',  ctx.getSetting<number>('xdodgeFutureHorizon'));
    sendDllFeature('xdodgeFutureStride',   ctx.getSetting<number>('xdodgeFutureStride'));
    sendDllFeature('dodgeHitScale',        ctx.getSetting<number>('dodgeHitScale'));
    for (const k of ['xdodgeAstar', 'xdodgeWeighting', 'xdodgeSmartGoal', 'xdodgePerpBias', 'xdodgeSpeedMatch', 'xdodgeLockFollow', 'xdodgeWalkCache', 'xdodgeWallAvoid', 'xdodgeArbiter', 'xdodgeBfsBias', 'xdodgeCcd', 'xdodgeCatalog', 'xdodgeLosGoal', 'xdodgeWasdYield', 'xdodgeLateralPref', 'xdodgeGoalSticky', 'xdodgeAvoidEnemies', 'xdodgeGhostHit', 'xdodgeDrawPath'] as const)
      sendDllFeature(k, ctx.getSetting<string>(k) === 'on' ? 1 : 0);
    sendDllFeature('xdodgeCcdPad', ctx.getSetting<number>('xdodgeCcdPad'));
    const al = ctx.getSetting<string>('enemyAutoLock');
    sendDllFeature('xdodgeAutoLock', autoLockModeToIdx(al));
    // RE-Sim (Rollout) settings.
    sendDllFeature('rolloutHorizonTicks',  ctx.getSetting<number>('rolloutHorizonTicks'));
    sendDllFeature('rolloutSampleStepMs',  ctx.getSetting<number>('rolloutSampleStepMs'));
    sendDllFeature('rolloutHeadings',      ctx.getSetting<number>('rolloutHeadings'));
    sendDllFeature('rolloutHitScale',      ctx.getSetting<number>('rolloutHitScale'));
    sendDllFeature('rolloutIntentWeight',  ctx.getSetting<number>('rolloutIntentWeight'));
    sendDllFeature('rolloutRebuildN',      ctx.getSetting<number>('rolloutRebuildN'));
    for (const k of ['rolloutAvoidEnemies', 'rolloutWasdYield', 'rolloutCommitDwell', 'rolloutDrawPath'] as const)
      sendDllFeature(k, ctx.getSetting<string>(k) === 'on' ? 1 : 0);
    // zDodge settings.
    sendDllFeature('zdodgeReactWindowMs', ctx.getSetting<number>('zdodgeReactWindowMs'));
    sendDllFeature('zdodgeMaxMoveTiles', ctx.getSetting<number>('zdodgeMaxMoveTiles'));
    sendDllFeature('zdodgePlayerRadius', ctx.getSetting<number>('zdodgePlayerRadius'));
    sendDllFeature('zdodgeProjectileRadiusFallback', ctx.getSetting<number>('zdodgeProjectileRadiusFallback'));
    sendDllFeature('zdodgeDamageThresholdPct', ctx.getSetting<number>('zdodgeDamageThresholdPct'));
    for (const k of ['zdodgeDebugOverlay', 'zdodgeCandidateOverlay'] as const)
      sendDllFeature(k, ctx.getSetting<string>(k) === 'on' ? 1 : 0);
    // RE++ settings.
    sendDllFeature('reppReactWindowMs', ctx.getSetting<number>('reppReactWindowMs'));
    sendDllFeature('reppMaxMoveTiles', ctx.getSetting<number>('reppMaxMoveTiles'));
    sendDllFeature('reppHitScale', ctx.getSetting<number>('reppHitScale'));
    sendDllFeature('reppDangerWeight', ctx.getSetting<number>('reppDangerWeight'));
    sendDllFeature('reppMode', ctx.getSetting<string>('reppMode') === 'autopilot' ? 1 : 0);
    sendDllFeature('reppStandOnType', ctx.getSetting<number>('reppStandOnType'));
    for (const k of ['reppFollowLantern', 'reppAvoidHazards', 'reppDebugOverlay'] as const)
      sendDllFeature(k, ctx.getSetting<string>(k) === 'on' ? 1 : 0);
    // PJDodge settings.
    sendDllFeature('pjdodgeHorizonMs', ctx.getSetting<number>('pjdodgeHorizonMs'));
    sendDllFeature('pjdodgeLeadMs', ctx.getSetting<number>('pjdodgeLeadMs'));
    sendDllFeature('pjdodgeHitScale', ctx.getSetting<number>('pjdodgeHitScale'));
    for (const k of ['pjdodgeSafeWalk', 'pjdodgeSpeedScale', 'pjdodgePredictionAccuracy', 'pjdodgeDebugOverlay', 'pjdodgeLockFollow'] as const)
      sendDllFeature(k, ctx.getSetting<string>(k) === 'on' ? 1 : 0);
    // UDodge (unified) settings.
    sendDllFeature('udodgeLaneTiles', ctx.getSetting<number>('udodgeLaneTiles'));
    sendDllFeature('udodgeStepTiles', ctx.getSetting<number>('udodgeStepTiles'));
    sendDllFeature('udodgeHitScale', ctx.getSetting<number>('udodgeHitScale'));
    sendDllFeature('udodgeReactMargin', ctx.getSetting<number>('udodgeReactMargin'));
    sendDllFeature('udodgeStandOnType', ctx.getSetting<number>('udodgeStandOnType'));
    sendDllFeature('udodgeOrbitRange', ctx.getSetting<number>('udodgeOrbitRange'));
    sendDllFeature('udodgePlanRadius', ctx.getSetting<number>('udodgePlanRadius'));
    for (const k of ['udodgeSafeWalk', 'udodgeSpeedScale',
                     'udodgeFieldEscape', 'udodgeLockFollow', 'udodgeFollowLantern',
                     'udodgeDebugOverlay', 'udodgeDrawPath'] as const)
      sendDllFeature(k, ctx.getSetting<string>(k) === 'on' ? 1 : 0);
    // Re-apply the 60fps cap here too. The onEnabledChange / clientConnected
    // handlers were the only places setting targetFrameRate, so if the cap
    // landed before the DLL was ready (or the player was already in-game
    // when the plugin loaded) it never re-fired and the user had to toggle
    // the setting off/on. This pushes it on every settings resync.
    applyDodgeFps(ctx.enabled);
  }

  ctx.onEnabledChange((enabled) => {
    flush(!enabled);
    applyDodgeFps(enabled);          // dodge on → 60fps, off → restore
  });

  ctx.on('clientConnected', () => {
    flush();
    syncModeSettings();
    applyDodgeFps(ctx.enabled);
  });
  ctx.on('clientDisconnected', () => {
    flush(true);
    applyDodgeFps(false);
  });

  // Re-sync everything on every realm/dungeon entry. The proxy↔game
  // socket typically persists across realm hops so clientConnected
  // doesn't re-fire, but the DLL can reset state (notably the FPS cap)
  // on a world reload — so the 60fps lock would silently drop off.
  // Debounced 300ms so a normal portal sequence (multiple MAPINFOs in
  // <1s) re-syncs once, not three times.
  let _mapinfoDebounce: ReturnType<typeof setTimeout> | null = null;
  ctx.hookPacket('MAPINFO', () => {
    try {
      if (_mapinfoDebounce) clearTimeout(_mapinfoDebounce);
      _mapinfoDebounce = setTimeout(() => {
        _mapinfoDebounce = null;
        // syncModeSettings touches the DLL bridge; if the pipe is mid-
        // reconnect any throw here would otherwise reach Node as an
        // unhandled error in a setTimeout callback (= process crash).
        try { if (ctx.enabled) syncModeSettings(); }
        catch (err) { ctx.log('MAPINFO resync failed: ' + (err as Error).message); }
      }, 300);
    } catch (err) {
      // Belt-and-suspenders: a throw inside a packet hook propagates up
      // through the proxy and can take the whole socket down.
      ctx.log('MAPINFO hook error: ' + (err as Error).message);
    }
  });

  ctx.registerCleanup(() => {
    flush(true);
    applyDodgeFps(false);           // restore uncapped on unload
  });
}
