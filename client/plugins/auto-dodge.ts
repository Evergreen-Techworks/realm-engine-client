import type { PluginContext } from '../src/plugins/PluginContext.js';
import { sendDllFeature } from '../src/bridge/DllFeatureBus.js';

// Maps the dashboard string value to the C++ TestTAB::DodgeMode enum.
// Off=0, XDodge=1. All other modes have been removed.
// XDodge uses A* (goal-directed) with BFS fallback (immediate escape),
// ported from XRebuild/XDriver decompile.
const DODGE_VALUES = ['off', 'xdodge'] as const;

function modeToIdx(v: string): number {
  const i = DODGE_VALUES.indexOf(v as (typeof DODGE_VALUES)[number]);
  return i < 0 ? 0 : i;
}

export function register(ctx: PluginContext) {
  ctx.name = 'Auto Dodge';
  ctx.category = 'combat';

  function flush(forceOff = false) {
    const mode = forceOff ? 0 : modeToIdx(ctx.getSetting<string>('dodgeMode'));
    sendDllFeature('autoDodgeMode', mode);
  }

  ctx.registerSetting('dodgeMode', {
    label: 'Dodge mode',
    type: 'select',
    value: 'xdodge',
    options: [
      { label: 'Off', value: 'off' },
      { label: 'RE-Plus', value: 'xdodge' },
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
  ctx.registerSetting('xdodgeHitScale', {
    label: '[RE-Plus] Hit scale', advanced: true,
    type: 'range', value: 1.0, min: 0.5, max: 2.0, step: 0.05,
  }, (v: number) => sendDllFeature('xdodgeHitScale', v));

  ctx.registerSetting('xdodgeRebuildN', {
    label: '[RE-Plus] Rebuild every N frames', advanced: true,
    type: 'range', value: 3, min: 1, max: 10, step: 1,
  }, (v: number) => sendDllFeature('xdodgeRebuildN', v));

  ctx.registerSetting('xdodgePlanStepMs', {
    label: '[RE-Plus] Plan step (ms)', advanced: true,
    type: 'range', value: 50, min: 10, max: 200, step: 5,
  }, (v: number) => sendDllFeature('xdodgePlanStepMs', v));

  // ── A* pathfinder settings ────────────────────────────────────────────────
  ctx.registerSetting('xdodgeDangerPenalty', {
    label: 'Danger sensitivity (lower = tighter / threads closer)',
    type: 'range', value: 2.0, min: 0, max: 5.0, step: 0.1,
  }, (v: number) => sendDllFeature('xdodgeDangerPenalty', v));

  ctx.registerSetting('xdodgeStayPenalty', {
    label: 'Stay-in-place cost (inert — kept for protocol sync)', advanced: true,
    type: 'range', value: 0.5, min: 0, max: 2.0, step: 0.05,
  }, (v: number) => sendDllFeature('xdodgeStayPenalty', v));

  // ── Future-sample look-ahead (XDriver IsSafeCandidateStrong) ──────────────
  ctx.registerSetting('xdodgeFutureSample', {
    label: '[Future] Extended look-ahead',
    advanced: true,
    type: 'select',
    value: 'on',
    options: [
      { label: 'On', value: 'on' },
      { label: 'Off', value: 'off' },
    ],
  }, (v: string) => sendDllFeature('xdodgeFutureSample', v === 'on' ? 1 : 0));

  ctx.registerSetting('xdodgeFutureHorizon', {
    label: '[Future] Horizon (ms)', advanced: true,
    type: 'range', value: 2500, min: 500, max: 5000, step: 100,
  }, (v: number) => sendDllFeature('xdodgeFutureHorizon', v));

  ctx.registerSetting('xdodgeFutureStride', {
    label: '[Future] Sample stride (ms)', advanced: true,
    type: 'range', value: 50, min: 8, max: 200, step: 2,
  }, (v: number) => sendDllFeature('xdodgeFutureStride', v));

  // ── Hitbox settings ────────────────────────────────────────────────────────
  ctx.registerSetting('dodgeHitScale', {
    label: 'Dodge hitbox scale', advanced: true,
    type: 'range', value: 1.0, min: 0.5, max: 2.0, step: 0.05,
  }, (v: number) => sendDllFeature('dodgeHitScale', v));

  ctx.registerSetting('gameHitboxMult', {
    label: 'Game hitbox override', advanced: true,
    type: 'range', value: 1.0, min: 0.5, max: 1.0, step: 0.01,
  }, (v: number) => sendDllFeature('gameHitboxMult', v));

  // ── Weighted-field + A* goal tier (additive over the immediate BFS) ───────
  // All four are independent. With every one 'off' the dodge is the exact
  // BFS-only build; the immediate BFS reflex is never affected by them.
  const onOff = (label: string, def: 'on' | 'off' = 'on') => ({
    label, advanced: true, type: 'select' as const, value: def,
    options: [{ label: 'On', value: 'on' }, { label: 'Off', value: 'off' }],
  });

  ctx.registerSetting('xdodgeAstar', onOff('[Goal] Smart goal pathing'),
    (v: string) => sendDllFeature('xdodgeAstar', v === 'on' ? 1 : 0));
  ctx.registerSetting('xdodgeWeighting', onOff('[Goal] Weighted danger field'),
    (v: string) => sendDllFeature('xdodgeWeighting', v === 'on' ? 1 : 0));
  ctx.registerSetting('xdodgeSmartGoal', onOff('[Goal] Smart goal position'),
    (v: string) => sendDllFeature('xdodgeSmartGoal', v === 'on' ? 1 : 0));
  ctx.registerSetting('xdodgePerpBias', onOff('[Goal] Perpendicular sidestep bias'),
    (v: string) => sendDllFeature('xdodgePerpBias', v === 'on' ? 1 : 0));
  ctx.registerSetting('xdodgeSpeedMatch', onOff('Speed match (anti rubber-band)'),
    (v: string) => sendDllFeature('xdodgeSpeedMatch', v === 'on' ? 1 : 0));
  ctx.registerSetting('xdodgeLockFollow', onOff('Lock-follow (Shift+Click enemy to track)'),
    (v: string) => sendDllFeature('xdodgeLockFollow', v === 'on' ? 1 : 0));

  // Auto enemy lock — picks a target automatically when no manual
  // Shift+Click lock is set. Manual lock always wins. Pattern mirrors
  // auto-aim's mode select. Indices match DangerPlanner::SetAutoLockMode:
  // 0 = off, 1 = closest enemy, 2 = whatever auto-aim is targeting (so
  // Highest-HP / Closest-to-Mouse are delegated to the auto-aim plugin's
  // own mode).
  ctx.registerSetting('enemyAutoLock', {
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
    v === 'closest' ? 1 : v === 'aim' ? 2 : 0
  ));
  ctx.registerSetting('xdodgeWalkCache', onOff('Walkability cache (perf / AutoNexus)'),
    (v: string) => sendDllFeature('xdodgeWalkCache', v === 'on' ? 1 : 0));
  ctx.registerSetting('xdodgeWallAvoid', onOff('[Goal] Wall avoidance (clearance + corner-clip)'),
    (v: string) => sendDllFeature('xdodgeWallAvoid', v === 'on' ? 1 : 0));
  ctx.registerSetting('xdodgeArbiter', onOff('[Goal] Orbit↔Survive arbiter (flee when area untenable)'),
    (v: string) => sendDllFeature('xdodgeArbiter', v === 'on' ? 1 : 0));
  ctx.registerSetting('xdodgeBfsBias', onOff('Strategic escape bias (head toward goal)'),
    (v: string) => sendDllFeature('xdodgeBfsBias', v === 'on' ? 1 : 0));
  ctx.registerSetting('xdodgeCcd', onOff('CCD-exact tight reflex (razor-tight)'),
    (v: string) => sendDllFeature('xdodgeCcd', v === 'on' ? 1 : 0));
  ctx.registerSetting('xdodgeCcdPad', {
    label: 'CCD pad (tiles — command-latency margin)', advanced: true,
    type: 'range', value: 0.03, min: 0, max: 0.5, step: 0.01,
  }, (v: number) => sendDllFeature('xdodgeCcdPad', v));
  // Catalog observation toggle. The learned hitbox INFLATION it used to
  // apply is now hard-zeroed in the DLL (it was making the dodge refuse
  // tight gaps after a session), so toggling this only controls whether
  // the catalog still records observations — there's no movement effect.
  ctx.registerSetting('xdodgeCatalog', onOff('Per-type bullet learning (inert — no longer inflates hitbox)', 'off'),
    (v: string) => sendDllFeature('xdodgeCatalog', v === 'on' ? 1 : 0));
  ctx.registerSetting('xdodgeLosGoal', onOff('[Lock] Keep line-of-sight to enemy'),
    (v: string) => sendDllFeature('xdodgeLosGoal', v === 'on' ? 1 : 0));
  ctx.registerSetting('xdodgeWasdYield', onOff('Yield to manual WASD (no fighting your input)'),
    (v: string) => sendDllFeature('xdodgeWasdYield', v === 'on' ? 1 : 0));
  ctx.registerSetting('xdodgeAvoidEnemies', onOff('Never stand on enemies / bosses (avoid contact damage)'),
    (v: string) => sendDllFeature('xdodgeAvoidEnemies', v === 'on' ? 1 : 0));
  // Ghost-hit protection: an independent swept-collision check in the DLL
  // catches bullets the game's per-tick collision skipped (the cause of
  // "ghost-hit deaths" with speedhack on) and synthesises a PLAYERHIT
  // packet so AutoNexus reacts before HP drops past threshold. On by
  // default — ghost-hit deaths outweigh the theoretical detectability of
  // the synthetic packets we emit; users can disable per-server if needed.
  ctx.registerSetting('xdodgeGhostHit', onOff('Ghost-hit protection (sync hits the game missed)'),
    (v: string) => sendDllFeature('xdodgeGhostHit', v === 'on' ? 1 : 0));
  ctx.registerSetting('xdodgeLateralPref', onOff('[Goal] Anti-flee + sidestep bias (no backwards sprinting)'),
    (v: string) => sendDllFeature('xdodgeLateralPref', v === 'on' ? 1 : 0));
  ctx.registerSetting('xdodgeGoalSticky', onOff('[Goal] Path stickiness (no flipping between equal paths)'),
    (v: string) => sendDllFeature('xdodgeGoalSticky', v === 'on' ? 1 : 0));
  ctx.registerSetting('xdodgeDrawPath', onOff('Draw planned path on screen (debug)', 'off'),
    (v: string) => sendDllFeature('xdodgeDrawPath', v === 'on' ? 1 : 0));

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
    sendDllFeature('gameHitboxMult',       ctx.getSetting<number>('gameHitboxMult'));
    for (const k of ['xdodgeAstar', 'xdodgeWeighting', 'xdodgeSmartGoal', 'xdodgePerpBias', 'xdodgeSpeedMatch', 'xdodgeLockFollow', 'xdodgeWalkCache', 'xdodgeWallAvoid', 'xdodgeArbiter', 'xdodgeBfsBias', 'xdodgeCcd', 'xdodgeCatalog', 'xdodgeLosGoal', 'xdodgeWasdYield', 'xdodgeLateralPref', 'xdodgeGoalSticky', 'xdodgeAvoidEnemies', 'xdodgeGhostHit', 'xdodgeDrawPath'])
      sendDllFeature(k, ctx.getSetting<string>(k) === 'on' ? 1 : 0);
    sendDllFeature('xdodgeCcdPad', ctx.getSetting<number>('xdodgeCcdPad'));
    const al = ctx.getSetting<string>('enemyAutoLock');
    sendDllFeature('xdodgeAutoLock', al === 'closest' ? 1 : al === 'aim' ? 2 : 0);
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
