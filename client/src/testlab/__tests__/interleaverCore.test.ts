import { describe, it, expect } from 'vitest';
import {
  TESTLAB_PRIVATE_ONLY,
  interleaverCoreMarker,
  mulberry32,
  generateSchedule,
  blockIndexFor,
  InterleaverStateMachine,
  type InterleaverConfig,
} from '../interleaverCore.js';

const SEEDS = [1, 2, 42, 1_700_000_000_000, 987654321, 0xdeadbeef];

describe('TESTLAB_PRIVATE_ONLY marker', () => {
  it('is the literal string and the accessor returns it', () => {
    expect(TESTLAB_PRIVATE_ONLY).toBe('TESTLAB_PRIVATE_ONLY');
    expect(interleaverCoreMarker()).toBe('TESTLAB_PRIVATE_ONLY');
  });
});

describe('mulberry32', () => {
  it('is deterministic: same seed produces the same sequence', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it('produces values in [0, 1)', () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 200; i++) {
      const v = rand();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('generateSchedule — reproducibility and balance', () => {
  it('is reproducible: same seed, same count -> identical schedule', () => {
    for (const seed of SEEDS) {
      expect(generateSchedule(seed, 40)).toEqual(generateSchedule(seed, 40));
    }
  });

  it('is prefix-stable: a shorter schedule is a prefix of a longer one for the same seed', () => {
    for (const seed of SEEDS) {
      const long = generateSchedule(seed, 41);
      const short = generateSchedule(seed, 17);
      expect(long.slice(0, 17)).toEqual(short);
    }
  });

  it('splits exactly evenly over any even number of blocks', () => {
    for (const seed of SEEDS) {
      for (let count = 2; count <= 60; count += 2) {
        const schedule = generateSchedule(seed, count);
        const a = schedule.filter((arm) => arm === 'A').length;
        const b = schedule.filter((arm) => arm === 'B').length;
        expect(a).toBe(count / 2);
        expect(b).toBe(count / 2);
      }
    }
  });

  it('never repeats the same arm more than twice in a row', () => {
    for (const seed of SEEDS) {
      const schedule = generateSchedule(seed, 100);
      let run = 1;
      for (let i = 1; i < schedule.length; i++) {
        run = schedule[i] === schedule[i - 1] ? run + 1 : 1;
        expect(run).toBeLessThanOrEqual(2);
      }
    }
  });

  it('truncates cleanly for an odd count without disturbing earlier arms', () => {
    for (const seed of SEEDS) {
      const even = generateSchedule(seed, 10);
      const odd = generateSchedule(seed, 9);
      expect(odd).toEqual(even.slice(0, 9));
    }
  });
});

describe('blockIndexFor', () => {
  it('is 0 at the start time and stays 0 until the block elapses', () => {
    expect(blockIndexFor(1000, 3, 1000)).toBe(0);
    expect(blockIndexFor(1000, 3, 1000 + 179_000)).toBe(0);
  });

  it('advances exactly at the block boundary', () => {
    const start = 1000;
    const blockMs = 3 * 60_000;
    expect(blockIndexFor(start, 3, start + blockMs - 1)).toBe(0);
    expect(blockIndexFor(start, 3, start + blockMs)).toBe(1);
    expect(blockIndexFor(start, 3, start + blockMs * 2)).toBe(2);
  });

  it('clamps to block 0 for a `now` before start (clock skew)', () => {
    expect(blockIndexFor(10_000, 3, 0)).toBe(0);
  });

  it('treats blockMinutes < 1 as 1 rather than dividing by zero/negative', () => {
    expect(blockIndexFor(0, 0, 60_000)).toBe(1);
    expect(blockIndexFor(0, -5, 60_000)).toBe(1);
  });
});

function config(overrides: Partial<InterleaverConfig> = {}): InterleaverConfig {
  return { key: 'udodgeEnemyStandoff', valueA: 'off', valueB: 'auto', blockMinutes: 3, seed: 42, ...overrides };
}

describe('InterleaverStateMachine — refuses when A === B', () => {
  it('refuses to start and makes no state change', () => {
    const machine = new InterleaverStateMachine(config({ valueA: 'off', valueB: 'off' }));
    const outcome = machine.start(0, 'off');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/valueA equals valueB/);
    expect(machine.getPhase()).toBe('idle');
  });
});

describe('InterleaverStateMachine — start', () => {
  it('captures the pre-flip value and returns the block-0 arm', () => {
    const machine = new InterleaverStateMachine(config());
    const outcome = machine.start(0, 'off');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(['A', 'B']).toContain(outcome.arm);
      expect([config().valueA, config().valueB]).toContain(outcome.value);
      expect(outcome.block).toBe(0);
    }
    expect(machine.getPhase()).toBe('running');
  });

  it('refuses a second start while already running', () => {
    const machine = new InterleaverStateMachine(config());
    machine.start(0, 'off');
    const second = machine.start(1000, 'off');
    expect(second.ok).toBe(false);
  });

  it('is deterministic for a given seed: same seed -> same starting arm', () => {
    const a = new InterleaverStateMachine(config({ seed: 12345 })).start(0, 'off');
    const b = new InterleaverStateMachine(config({ seed: 12345 })).start(0, 'off');
    expect(a).toEqual(b);
  });
});

describe('InterleaverStateMachine — clock-driven flips at block boundaries', () => {
  it('does not flip before a block boundary is crossed', () => {
    const machine = new InterleaverStateMachine(config({ blockMinutes: 3 }));
    machine.start(0, 'off');
    expect(machine.tick(60_000)).toBeNull();
    expect(machine.tick(2 * 60_000)).toBeNull();
  });

  it('flips exactly once per crossed block boundary, alternating per the schedule', () => {
    const machine = new InterleaverStateMachine(config({ blockMinutes: 3, seed: 99 }));
    const start = machine.start(0, 'off');
    expect(start.ok).toBe(true);
    const blockMs = 3 * 60_000;

    const flip1 = machine.tick(blockMs);
    expect(flip1).not.toBeNull();
    expect(flip1!.block).toBe(1);
    // Never flips twice for a call that stays inside the same block.
    expect(machine.tick(blockMs + 30_000)).toBeNull();

    const flip2 = machine.tick(blockMs * 2);
    expect(flip2).not.toBeNull();
    expect(flip2!.block).toBe(2);

    const schedule = [
      (start as { ok: true; arm: 'A' | 'B' }).arm,
      flip1!.arm,
      flip2!.arm,
    ];
    // Consecutive arms from the pure schedule generator obey the same invariant.
    expect(schedule[0] === schedule[1] && schedule[1] === schedule[2]).toBe(false);
  });

  it('does nothing when called while idle (never started)', () => {
    const machine = new InterleaverStateMachine(config());
    expect(machine.tick(1_000_000)).toBeNull();
  });

  it('does nothing once stopped', () => {
    const machine = new InterleaverStateMachine(config({ blockMinutes: 1 }));
    machine.start(0, 'off');
    machine.stop();
    expect(machine.tick(10 * 60_000)).toBeNull();
  });
});

describe('InterleaverStateMachine — restore on stop from any state', () => {
  it('from idle (never started): no-op, never throws', () => {
    const machine = new InterleaverStateMachine(config());
    expect(() => machine.stop()).not.toThrow();
    expect(machine.stop()).toBeNull();
    expect(machine.getPhase()).toBe('idle');
  });

  it('from running: returns the originally-captured value and moves to restoring', () => {
    const machine = new InterleaverStateMachine(config());
    machine.start(0, 'off');
    machine.tick(10 * 60_000); // flip a few times first
    const restore = machine.stop();
    expect(restore).toEqual({ value: 'off' });
    expect(machine.getPhase()).toBe('restoring');
  });

  it('finishStop moves restoring -> idle', () => {
    const machine = new InterleaverStateMachine(config());
    machine.start(0, 'off');
    machine.stop();
    machine.finishStop();
    expect(machine.getPhase()).toBe('idle');
  });

  it('calling stop() again after it already consumed the value is a safe no-op', () => {
    const machine = new InterleaverStateMachine(config());
    machine.start(0, 'off');
    expect(machine.stop()).toEqual({ value: 'off' });
    expect(() => machine.stop()).not.toThrow();
    expect(machine.stop()).toBeNull();
    expect(machine.getPhase()).toBe('idle');
  });

  it('restores the value captured at start even if start() used a non-default value (e.g. previously left mid-flip)', () => {
    const machine = new InterleaverStateMachine(config());
    machine.start(0, 'auto');
    expect(machine.stop()).toEqual({ value: 'auto' });
  });
});
