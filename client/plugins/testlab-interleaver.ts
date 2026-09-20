/**
 * Test Lab A/B — TESTLAB_PRIVATE_ONLY.
 *
 * Private-build-only in-session switch interleaver: flips ANY Auto Dodge
 * setting registered on the live plugin — including `dodgeMode` itself —
 * between value A and value B every few minutes while the owner or the
 * farmer plays, so a single noisy session can still A/B-compare it. Every
 * flip is stamped into the Test Lab recording (`arm` records) and the reader
 * attributes hits/near-passes to whichever arm was active. Never changes
 * gameplay behaviour on its own: with this plugin disabled (the default)
 * nothing here runs, and it only ever runs an A/B it was explicitly started
 * for.
 *
 * `target` is a free-text Auto Dodge setting key, not a fixed list — the key
 * and both requested values are validated against that setting's LIVE
 * definition (type, legal `select` options, numeric bounds, which
 * `dodgeMode`s it even applies in) through the general read-only
 * `describeOtherPluginSetting` cross-plugin hook (see PluginContext.ts) — the
 * plugin is a second line of defence: it does not trust a validator any
 * caller of the per-run plugin config may already run before starting.
 *
 * Thin by design: this file only (a) validates the refuse-to-start
 * conditions, (b) drives a clock (`RuntimeScheduler`) and hands `now` to the
 * pure state machine (`src/testlab/interleaverCore.ts`), and (c) applies
 * whatever value/mark/log the state machine hands back. The schedule
 * generation, the idle/running/restoring state machine, and the free-text
 * validation/coercion — the parts with real logic worth unit-testing — live
 * entirely in that pure core.
 *
 * Every stop, for any reason, is logged (`ctx.log`, so it lands in the
 * persistent client log even with no dashboard open) and the reason is
 * written into the `ab.stop` mark, so a run that ends unexpectedly is never
 * silent.
 *
 * This file, its pure core and their tests are listed in
 * `client/private-only.json` and must be removable from customer builds by
 * deleting exactly those paths — nothing outside those paths imports them,
 * so removing them (or excluding them from bundling; see
 * `scripts/build-prod.mjs`) can't leave a dangling reference.
 */
import type { PluginContext } from './api.js';
import { RuntimeScheduler } from './api.js';
import {
  InterleaverStateMachine,
  TESTLAB_PRIVATE_ONLY,
  interleaverCoreMarker,
  isTargetGateSatisfied,
  validateTarget,
  SETTLE_MS,
  type InterleaverConfig,
  type SettingValue,
} from '../src/testlab/interleaverCore.js';
import { buildArmRecord } from '../src/testlab/recorderCore.js';

export { TESTLAB_PRIVATE_ONLY };

const AUTO_DODGE_PLUGIN_ID = 'auto-dodge';
/** Flipping this one changes the whole dodge engine, not just a parameter —
 *  see the settle-delay handling in `applyFlip`. */
const DODGE_MODE_KEY = 'dodgeMode';

/** How often the plugin checks whether a block boundary has been crossed
 *  (and, mid-run, whether the target/recorder are still valid). `blockMinutes`
 *  is clamped to >= 1 (60s), so 5s gives at most 5s of flip slack relative to
 *  the schedule — plenty tight for a multi-minute block. */
const TICK_MS = 5000;

/** Default target/values shown on first load — a real, known Auto Dodge
 *  switch, not special-cased in any way once the run starts. The owner can
 *  type in any other registered Auto Dodge setting key instead. */
const DEFAULT_TARGET_KEY = 'udodgeEnemyStandoff';
const DEFAULT_VALUE_A = 'off';
const DEFAULT_VALUE_B = 'auto';

/** Every reason this plugin can stop an active run for. Always logged (see
 *  `stopRun`) and always written into the `ab.stop` mark's value. */
type StopReason =
  | 'disabled-by-user'
  | 'target-invalid'
  | 'recorder-disabled'
  | 'plugin-unload'
  | 'app-shutdown'
  | `error:${string}`;

/**
 * Same globalThis bus-slot KEY `testlab-recorder.ts` populates
 * (`BUS_SLOT_KEY` there) — duplicated here deliberately, not imported ("use
 * that slot, do not import the recorder module"): PluginManager dynamically
 * imports every plugin file fresh, so importing `testlab-recorder.ts`'s
 * `mark()` would risk depending on which module instance happens to run it.
 * Reading the shared `globalThis` slot directly works regardless. The
 * record SHAPE (`buildArmRecord`) is still shared via `recorderCore.ts`
 * (a pure, stateless file with no module-instance problem, and — like this
 * plugin — private-only) rather than re-implemented here, so the two
 * plugins can never disagree on what an `arm` record looks like.
 */
const RECORDER_BUS_SLOT_KEY = '__realmengine_testlabRecorderBus_v1';
interface RecorderBusSlot {
  writer: { writeLine(record: unknown): void } | null;
  enabled: boolean;
}

function recorderBusSlot(): RecorderBusSlot | undefined {
  return (globalThis as unknown as Record<string, unknown>)[RECORDER_BUS_SLOT_KEY] as RecorderBusSlot | undefined;
}

function recorderEnabled(): boolean {
  return !!recorderBusSlot()?.enabled;
}

/** Mirrors testlab-recorder.ts's exported `mark()`: no-op when the recorder
 *  is disabled/not registered, never throws. */
function mark(key: string, value: unknown): void {
  try {
    const slot = recorderBusSlot();
    if (!slot?.enabled || !slot.writer) return;
    slot.writer.writeLine(buildArmRecord(Date.now(), key, value));
  } catch {
    // Never let a caller of mark() see an exception from the recorder.
  }
}

export function register(ctx: PluginContext) {
  ctx.name = 'Test Lab A/B';
  ctx.category = 'utility';
  ctx.enabled = false; // default DISABLED — starts only via the normal plugin toggle.

  // Ties this file's marker to a real, non-dead call site (see
  // testlab-recorder.ts's identical comment for why).
  ctx.setData('testlabPrivateOnlyMarkers', [TESTLAB_PRIVATE_ONLY, interleaverCoreMarker()]);

  ctx.registerSetting('target', {
    label: 'Auto Dodge setting to interleave',
    type: 'text',
    value: DEFAULT_TARGET_KEY,
  });

  ctx.registerSetting('valueA', {
    label: 'Value A',
    type: 'text',
    value: DEFAULT_VALUE_A,
  });

  ctx.registerSetting('valueB', {
    label: 'Value B',
    type: 'text',
    value: DEFAULT_VALUE_B,
  });

  ctx.registerSetting('blockMinutes', {
    label: 'Minutes per block',
    type: 'number',
    value: 3,
    min: 1,
  });

  const scheduler = new RuntimeScheduler();
  let stopTicking: (() => void) | null = null;
  let machine: InterleaverStateMachine | null = null;
  /** The target key the ACTIVE run is flipping — captured at start, not
   *  re-read from the `target` setting later, so editing that text field
   *  mid-run can't make a stop/tick act on a different key than the one
   *  actually running. */
  let runningTargetKey: string | null = null;
  /** Pending "write the arm mark" timer from a `dodgeMode` flip's settle
   *  delay (see `applyFlip`). Cleared on every subsequent flip and on stop
   *  so a stale mark can never fire after the run has moved on or ended. */
  let pendingSettleTimer: ReturnType<typeof setTimeout> | null = null;
  // Guards against the recursive onEnabledChange(false) call that our own
  // `ctx.enabled = false` (used to revert a refused start, or a mid-run
  // self-stop) triggers.
  let selfDisabling = false;

  function clearPendingSettle(): void {
    if (pendingSettleTimer) {
      clearTimeout(pendingSettleTimer);
      pendingSettleTimer = null;
    }
  }

  function applyFlip(targetKey: string, value: SettingValue, block: number, seed: number): void {
    ctx.updateOtherPluginSetting(AUTO_DODGE_PLUGIN_ID, targetKey, value);
    ctx.log(`[TestLabAB] ${targetKey}=${value} block=${block} seed=${seed}`);
    clearPendingSettle();
    if (targetKey === DODGE_MODE_KEY) {
      // Flipping the dodge engine itself needs a moment to actually take
      // effect before the mark's timestamp means anything — see SETTLE_MS's
      // doc comment. The Test Lab reader already drops a 5s washout after
      // every mark, so this delay is additive, not a substitute for that.
      pendingSettleTimer = setTimeout(() => {
        pendingSettleTimer = null;
        mark(targetKey, value);
      }, SETTLE_MS);
      pendingSettleTimer.unref?.();
    } else {
      mark(targetKey, value);
    }
  }

  function refuseStart(reason: string): void {
    ctx.dashboardLog(`[TestLabAB] Refusing to start: ${reason}`);
    selfDisabling = true;
    ctx.enabled = false;
  }

  /**
   * The one place that ends an active run: restores the pre-flip value (if
   * any), writes the `ab.stop` mark with the reason, and — critically per
   * the whole point of this task — ALWAYS logs why, even when nothing was
   * actually running (so a caller never has to guess whether this no-op'd).
   * Never throws.
   */
  function stopRun(reason: StopReason): void {
    clearPendingSettle();
    stopTicking?.();
    stopTicking = null;
    if (!machine || runningTargetKey === null) {
      machine = null;
      runningTargetKey = null;
      return;
    }
    const targetKey = runningTargetKey;
    let restoredValue: SettingValue | undefined;
    try {
      const restore = machine.stop();
      if (restore) {
        restoredValue = restore.value;
        ctx.updateOtherPluginSetting(AUTO_DODGE_PLUGIN_ID, targetKey, restore.value);
        mark('ab.stop', { key: targetKey, restored: restore.value, reason });
        machine.finishStop();
      } else {
        mark('ab.stop', { key: targetKey, restored: null, reason });
      }
      ctx.log(`[TestLabAB] stopped reason=${reason} restored=${restoredValue ?? 'n/a'}`);
    } catch (err) {
      // A stop must never throw, even if the restore/mark/log path does.
      try {
        ctx.log(`[TestLabAB] stopped reason=${reason} restored=error (${err instanceof Error ? err.message : String(err)})`);
      } catch {
        /* genuinely nothing more we can do */
      }
    } finally {
      machine = null;
      runningTargetKey = null;
    }
  }

  /** A mid-run self-stop: stop the run, then flip the dashboard toggle off
   *  to match (mirrors `refuseStart`'s use of `selfDisabling`). */
  function selfStop(reason: StopReason): void {
    stopRun(reason);
    selfDisabling = true;
    ctx.enabled = false;
  }

  function doStart(): void {
    const targetKey = String(ctx.getSetting<string>('target') ?? '').trim();
    const rawValueA = ctx.getSetting<string>('valueA');
    const rawValueB = ctx.getSetting<string>('valueB');
    const blockMinutesRaw = Number(ctx.getSetting<number>('blockMinutes'));
    const blockMinutes = Number.isFinite(blockMinutesRaw) ? Math.max(1, blockMinutesRaw) : 3;

    if (!recorderEnabled()) {
      refuseStart('Test Lab Recorder is not enabled — no data would be attributed to an arm.');
      return;
    }
    if (!targetKey) {
      refuseStart('No target setting key given.');
      return;
    }

    const description = ctx.describeOtherPluginSetting(AUTO_DODGE_PLUGIN_ID, targetKey);
    const gatingValue = description?.visibleWhen
      ? ctx.getOtherPluginSetting(AUTO_DODGE_PLUGIN_ID, description.visibleWhen.key)
      : undefined;
    const outcome = validateTarget({ targetKey, description, rawValueA, rawValueB, gatingValue });
    if (!outcome.ok) {
      refuseStart(outcome.reason);
      return;
    }

    const currentValue = ctx.getOtherPluginSetting<SettingValue>(AUTO_DODGE_PLUGIN_ID, targetKey);
    if (currentValue === undefined) {
      refuseStart(`Could not read Auto Dodge's current "${targetKey}" value (plugin not loaded?).`);
      return;
    }

    const seed = Date.now(); // recording start time — logged so the schedule is reproducible.
    const config: InterleaverConfig = { key: targetKey, valueA: outcome.valueA, valueB: outcome.valueB, blockMinutes, seed };
    const nextMachine = new InterleaverStateMachine(config);
    const startOutcome = nextMachine.start(seed, currentValue);
    if (!startOutcome.ok) {
      refuseStart(startOutcome.reason);
      return;
    }

    machine = nextMachine;
    runningTargetKey = targetKey;
    mark('ab.start', { key: targetKey, a: outcome.valueA, b: outcome.valueB, blockMinutes, seed });
    applyFlip(targetKey, startOutcome.value, startOutcome.block, seed);

    stopTicking = scheduler.scheduleRepeating(TICK_MS, () => {
      if (!machine || runningTargetKey === null) return;
      try {
        if (!recorderEnabled()) {
          selfStop('recorder-disabled');
          return;
        }
        const liveDescription = ctx.describeOtherPluginSetting(AUTO_DODGE_PLUGIN_ID, runningTargetKey);
        if (!liveDescription) {
          selfStop('target-invalid');
          return;
        }
        if (liveDescription.visibleWhen) {
          const liveGatingValue = ctx.getOtherPluginSetting(AUTO_DODGE_PLUGIN_ID, liveDescription.visibleWhen.key);
          if (!isTargetGateSatisfied(liveDescription, liveGatingValue)) {
            selfStop('target-invalid');
            return;
          }
        }
        const flip = machine.tick(Date.now());
        if (flip) applyFlip(runningTargetKey, flip.value, flip.block, seed);
      } catch (err) {
        selfStop(`error:${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  ctx.onEnabledChange((enabled) => {
    if (selfDisabling) {
      selfDisabling = false;
      return;
    }
    if (enabled) doStart();
    else stopRun('disabled-by-user');
  });

  // `ctx.registerCleanup` fires on plugin unload/hot-reload, but NOT on a
  // real client shutdown (src/index.ts's `shutdown()` never calls
  // PluginManager.unloadPlugin/runCleanup for loaded plugins). A crash also
  // can't run any of this. So the switch is restored on: disable (above), unload (below),
  // AND our own process-exit listeners (below) — the last is the only way
  // to actually catch SIGINT/SIGTERM/normal exit in this codebase today.
  function shutdownRestore(): void {
    try {
      stopRun('app-shutdown');
    } catch {
      /* never let a shutdown hook throw */
    }
  }
  process.on('exit', shutdownRestore);
  process.on('SIGINT', shutdownRestore);
  process.on('SIGTERM', shutdownRestore);

  ctx.registerCleanup(() => {
    process.off('exit', shutdownRestore);
    process.off('SIGINT', shutdownRestore);
    process.off('SIGTERM', shutdownRestore);
    stopRun('plugin-unload');
  });
}
