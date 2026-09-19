/**
 * Test Lab A/B — TESTLAB_PRIVATE_ONLY.
 *
 * Private-build-only in-session switch interleaver: flips ONE Auto Dodge
 * switch between value A and value B every few minutes while the owner or
 * the farmer plays, so a single noisy session can still A/B-compare a
 * switch — every flip is stamped into the Test Lab recording (`arm`
 * records) and the reader attributes hits/near-passes to whichever arm was
 * active. Never changes gameplay behaviour on its own: with this plugin
 * disabled (the default) nothing here runs.
 *
 * Thin by design: this file only (a) validates the refuse-to-start
 * conditions, (b) drives a clock (`RuntimeScheduler`) and hands `now` to the
 * pure state machine (`src/testlab/interleaverCore.ts`), and (c) applies
 * whatever value/mark/log the state machine hands back. The schedule
 * generation and idle/running/restoring state machine — the part with real
 * logic worth unit-testing — lives entirely in that pure core.
 *
 * This file, its pure core and their tests are listed in
 * `client/private-only.json` and must be removable from customer builds by
 * deleting exactly those paths. See that file's header comment and
 * task-A5a-report.md for the removability proof.
 */
import type { PluginContext } from './api.js';
import { RuntimeScheduler } from './api.js';
import {
  InterleaverStateMachine,
  TESTLAB_PRIVATE_ONLY,
  interleaverCoreMarker,
  type InterleaverConfig,
} from '../src/testlab/interleaverCore.js';
import { buildArmRecord } from '../src/testlab/recorderCore.js';

export { TESTLAB_PRIVATE_ONLY };

const AUTO_DODGE_PLUGIN_ID = 'auto-dodge';
const DODGE_MODE_KEY = 'dodgeMode';
const UNIFIED_MODE_VALUE = 'unified';

/** How often the plugin checks whether a block boundary has been crossed.
 *  `blockMinutes` is clamped to >= 1 (60s), so 5s gives at most 5s of flip
 *  slack relative to the schedule — plenty tight for a multi-minute block. */
const TICK_MS = 5000;

/** Per-target defaults: value A is the switch's off value, value B is its
 *  on value. Keys and legal values read from `client/plugins/auto-dodge.ts`
 *  `registerModeSetting('unified', ...)` — Enemy standoff and Frame budget
 *  are 'off'/'auto' selects; Route commitment and Fallback sidestep are
 *  plain 'off'/'on' selects (`onOff(...)`). Kept as a literal table here
 *  (not re-derived from auto-dodge.ts) so this plugin never needs to import
 *  it — see "cross-plugin wiring" below for why a value import isn't used
 *  either. */
const TARGET_DEFS: Record<string, { label: string; off: string; on: string }> = {
  udodgeEnemyStandoff: { label: '[UDodge] Enemy standoff', off: 'off', on: 'auto' },
  udodgeRouteCommit: { label: '[UDodge] Route commitment', off: 'off', on: 'on' },
  udodgeFallbackSidestep: { label: '[UDodge] Fallback sidestep', off: 'off', on: 'on' },
  udodgeFrameBudget: { label: '[UDodge] Frame budget', off: 'off', on: 'auto' },
};
const DEFAULT_TARGET = 'udodgeEnemyStandoff';

/**
 * Same globalThis bus-slot KEY `testlab-recorder.ts` populates
 * (`BUS_SLOT_KEY` there) — duplicated here per this task's brief ("use that
 * slot, do not import the recorder module"): PluginManager dynamically
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

  ctx.registerSetting(
    'target',
    {
      label: 'Switch to interleave',
      type: 'select',
      value: DEFAULT_TARGET,
      options: Object.entries(TARGET_DEFS).map(([value, def]) => ({ label: def.label, value })),
    },
    (value: string) => {
      const def = TARGET_DEFS[value] ?? TARGET_DEFS[DEFAULT_TARGET];
      // Re-default A/B to the new target's off/on values. Free-text so an
      // owner can still override to a non-default legal value if needed.
      ctx.updateSetting('valueA', def.off);
      ctx.updateSetting('valueB', def.on);
    },
  );

  ctx.registerSetting('valueA', {
    label: 'Value A',
    type: 'text',
    value: TARGET_DEFS[DEFAULT_TARGET].off,
  });

  ctx.registerSetting('valueB', {
    label: 'Value B',
    type: 'text',
    value: TARGET_DEFS[DEFAULT_TARGET].on,
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
  // Guards against the recursive onEnabledChange(false) call that our own
  // `ctx.enabled = false` (used to revert a refused start) triggers.
  let selfDisabling = false;

  function applyFlip(targetKey: string, value: string, block: number, seed: number): void {
    ctx.updateOtherPluginSetting(AUTO_DODGE_PLUGIN_ID, targetKey, value);
    mark(targetKey, value);
    ctx.log(`[TestLabAB] ${targetKey}=${value} block=${block} seed=${seed}`);
  }

  function refusalReason(targetKey: string, valueA: string, valueB: string): string | null {
    if (!recorderEnabled()) {
      return 'Test Lab Recorder is not enabled — no data would be attributed to an arm.';
    }
    const dodgeMode = ctx.getOtherPluginSetting<string>(AUTO_DODGE_PLUGIN_ID, DODGE_MODE_KEY);
    if (dodgeMode !== UNIFIED_MODE_VALUE) {
      return `Dodge mode is not Unified (currently "${dodgeMode ?? 'unknown'}").`;
    }
    if (valueA === valueB) {
      return `Value A and Value B are both "${valueA}" — nothing to compare.`;
    }
    if (!(targetKey in TARGET_DEFS)) {
      return `Unknown target switch "${targetKey}".`;
    }
    return null;
  }

  function refuseStart(reason: string): void {
    ctx.dashboardLog(`[TestLabAB] Refusing to start: ${reason}`);
    selfDisabling = true;
    ctx.enabled = false;
  }

  function doStart(): void {
    const targetKey = ctx.getSetting<string>('target');
    const valueA = ctx.getSetting<string>('valueA');
    const valueB = ctx.getSetting<string>('valueB');
    const blockMinutesRaw = Number(ctx.getSetting<number>('blockMinutes'));
    const blockMinutes = Number.isFinite(blockMinutesRaw) ? Math.max(1, blockMinutesRaw) : 3;

    const reason = refusalReason(targetKey, valueA, valueB);
    if (reason) {
      refuseStart(reason);
      return;
    }

    const currentValue = ctx.getOtherPluginSetting<string>(AUTO_DODGE_PLUGIN_ID, targetKey);
    if (currentValue === undefined) {
      refuseStart(`Could not read Auto Dodge's current "${targetKey}" value (plugin not loaded?).`);
      return;
    }

    const seed = Date.now(); // recording start time — logged so the schedule is reproducible.
    const config: InterleaverConfig = { key: targetKey, valueA, valueB, blockMinutes, seed };
    const nextMachine = new InterleaverStateMachine(config);
    const outcome = nextMachine.start(seed, String(currentValue));
    if (!outcome.ok) {
      refuseStart(outcome.reason);
      return;
    }

    machine = nextMachine;
    mark('ab.start', { key: targetKey, a: valueA, b: valueB, blockMinutes, seed });
    applyFlip(targetKey, outcome.value, outcome.block, seed);

    stopTicking = scheduler.scheduleRepeating(TICK_MS, () => {
      if (!machine) return;
      const flip = machine.tick(Date.now());
      if (flip) applyFlip(targetKey, flip.value, flip.block, seed);
    });
  }

  function doStop(): void {
    stopTicking?.();
    stopTicking = null;
    if (!machine) return;
    const targetKey = ctx.getSetting<string>('target');
    const restore = machine.stop();
    if (restore) {
      ctx.updateOtherPluginSetting(AUTO_DODGE_PLUGIN_ID, targetKey, restore.value);
      mark('ab.stop', { key: targetKey, restored: restore.value });
      machine.finishStop();
    }
    machine = null;
  }

  ctx.onEnabledChange((enabled) => {
    if (selfDisabling) {
      selfDisabling = false;
      return;
    }
    if (enabled) doStart();
    else doStop();
  });

  // `ctx.registerCleanup` fires on plugin unload/hot-reload, but NOT on a
  // real client shutdown (src/index.ts's `shutdown()` never calls
  // PluginManager.unloadPlugin/runCleanup for loaded plugins — verified by
  // reading it; see task-A5a-report.md). A crash also can't run any of
  // this. So the switch is restored on: disable (above), unload (below),
  // AND our own process-exit listeners (below) — the last is the only way
  // to actually catch SIGINT/SIGTERM/normal exit in this codebase today.
  function shutdownRestore(): void {
    try {
      doStop();
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
    doStop();
  });
}
