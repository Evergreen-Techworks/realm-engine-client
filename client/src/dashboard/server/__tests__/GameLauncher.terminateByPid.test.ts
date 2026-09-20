import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileSyncMock = vi.fn();

vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  spawn: vi.fn(),
}));

const { terminateGameProcessTree, TERMINATE_VERIFY_MS, TERMINATE_VERIFY_POLL_MS } = await import('../GameLauncher.js');
import type { TerminateProcessClock } from '../GameLauncher.js';

/** A clock/sleep seam that advances virtual time instantly instead of
 *  waiting on real timers -- lets a test simulate a process that takes
 *  seconds to exit (or never does) without the test itself taking seconds. */
function makeFakeClock(): { clock: TerminateProcessClock; elapsedMs: () => number } {
  let t = 0;
  return {
    clock: {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    },
    elapsedMs: () => t,
  };
}

/** A literal U+00A0 (non-breaking space), built with no escape sequence in
 *  this file's own source so there is nothing here that could visually pass
 *  for a plain space in a diff. */
const NBSP = String.fromCharCode(160);

function tasklistCsvRow(imageName: string, pid: number): string {
  return `"${imageName}","${pid}","Console","1","12,345 K"`;
}

/**
 * Drives a scripted sequence of tasklist/taskkill calls: `beforeImage` answers
 * the first tasklist lookup for a pid, `afterImage` (default: same as before,
 * i.e. "taskkill did nothing") answers the re-query after taskkill.
 */
function scriptTasklist(
  responsesByPid: Record<number, { before: string | null; after?: string | null }>,
): void {
  const calls: Record<number, number> = {};
  execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === 'taskkill') return '';
    if (cmd !== 'tasklist') throw new Error(`unexpected command ${cmd}`);
    const filter = args[1]; // "PID eq <n>"
    const pid = Number(filter.replace(/\D/g, ''));
    const entry = responsesByPid[pid];
    if (!entry) throw new Error(`no script for pid ${pid}`);
    const callN = (calls[pid] = (calls[pid] ?? 0) + 1);
    // 'after' in entry: distinguishes "explicitly set (even to null)" from
    // "omitted, so reuse 'before'" — a plain `??` would treat an explicit
    // `after: null` the same as "not provided" and silently fall back.
    const image = callN === 1 ? entry.before : 'after' in entry ? (entry.after as string | null) : entry.before;
    return image === null ? '' : tasklistCsvRow(image, pid);
  });
}

describe('terminateGameProcessTree', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it('refuses a PID whose live image name is not the game, and never calls taskkill', async () => {
    scriptTasklist({ 4321: { before: 'notepad.exe' } });

    const result = await terminateGameProcessTree([{ pid: 4321, expectedImageName: 'RotMG Exalt.exe' }]);

    expect(result.ok).toBe(false);
    expect(result.survivingPids).toEqual([4321]);
    expect(result.terminatedPids).toEqual([]);
    expect(result.error).toMatch(/notepad\.exe/);
    // Only the one tasklist lookup ran — taskkill was never invoked.
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock.mock.calls[0][0]).toBe('tasklist');
  });

  it('treats a PID that is not running at all as already-done, not a failure', async () => {
    scriptTasklist({ 999: { before: null } });
    const result = await terminateGameProcessTree([{ pid: 999, expectedImageName: 'RotMG Exalt.exe' }]);
    expect(result.ok).toBe(true);
    expect(result.terminatedPids).toEqual([]);
    expect(result.survivingPids).toEqual([]);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1); // no taskkill for a pid that was never running.
  });

  it('kills a matching PID by /PID /T, never by /IM, and verifies it is actually gone', async () => {
    scriptTasklist({ 4321: { before: 'RotMG Exalt.exe', after: null } });

    const result = await terminateGameProcessTree([{ pid: 4321, expectedImageName: 'RotMG Exalt.exe' }]);

    expect(result.ok).toBe(true);
    expect(result.terminatedPids).toEqual([4321]);
    const taskkillCall = execFileSyncMock.mock.calls.find((c) => c[0] === 'taskkill');
    expect(taskkillCall).toBeTruthy();
    const args = taskkillCall![1] as string[];
    expect(args).toEqual(['/PID', '4321', '/T', '/F']);
    expect(args).not.toContain('/IM');
    // tasklist before + taskkill + tasklist after (gone on the first poll check) = 3 calls.
    expect(execFileSyncMock).toHaveBeenCalledTimes(3);
  });

  it('matches image names case-insensitively and ignores surrounding whitespace/NBSP', async () => {
    scriptTasklist({ 1: { before: `  ROTMG${NBSP}EXALT.EXE  `, after: null } });
    const result = await terminateGameProcessTree([{ pid: 1, expectedImageName: `RotMG${NBSP}Exalt.exe` }]);
    expect(result.ok).toBe(true);
  });

  it('rejects an invalid pid without touching the OS at all', async () => {
    const result = await terminateGameProcessTree([
      { pid: 0, expectedImageName: 'RotMG Exalt.exe' },
      { pid: -5, expectedImageName: 'RotMG Exalt.exe' },
      { pid: NaN, expectedImageName: 'RotMG Exalt.exe' },
    ]);
    expect(result.ok).toBe(true); // nothing to do is not a failure
    expect(result.terminatedPids).toEqual([]);
    expect(result.survivingPids).toEqual([]);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('handles a launcher pid + a separately-tracked child pid: both verified and killed independently', async () => {
    scriptTasklist({
      100: { before: 'RotMG Exalt.exe', after: null },
      200: { before: 'RotMGExalt.exe', after: null },
    });
    const result = await terminateGameProcessTree([
      { pid: 100, expectedImageName: 'RotMG Exalt.exe' },
      { pid: 200, expectedImageName: 'RotMGExalt.exe' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.terminatedPids.sort()).toEqual([100, 200]);
  });

  it('a child pid that turns out to be a different image is left alone while the launcher is still killed', async () => {
    scriptTasklist({
      100: { before: 'RotMG Exalt.exe', after: null },
      200: { before: 'someUnrelated.exe' },
    });
    const result = await terminateGameProcessTree([
      { pid: 100, expectedImageName: 'RotMG Exalt.exe' },
      { pid: 200, expectedImageName: 'RotMGExalt.exe' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.terminatedPids).toEqual([100]);
    expect(result.survivingPids).toEqual([200]);
  });

  // ── The verify-poll + fallback seam (item B: 2026-09-20 live run left pid
  // 19684 running — "still running after taskkill /T" from a single
  // immediate re-check, no fallback attempted). Each test below drives a
  // fake clock so the poll loop (up to TERMINATE_VERIFY_MS, every
  // TERMINATE_VERIFY_POLL_MS) never actually waits on a real timer. ──

  it('a slow-to-exit process (alive for 3s, then gone) is still reported terminated, not a false survivor', async () => {
    const { clock, elapsedMs } = makeFakeClock();
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'taskkill') return 'SUCCESS: Sent termination signal to the process tree.';
      if (cmd !== 'tasklist') throw new Error(`unexpected command ${cmd}`);
      const pid = Number(String(args[1]).replace(/\D/g, ''));
      if (pid !== 4321) throw new Error(`unexpected pid ${pid}`);
      return elapsedMs() < 3000 ? tasklistCsvRow('RotMG Exalt.exe', pid) : '';
    });

    const result = await terminateGameProcessTree([{ pid: 4321, expectedImageName: 'RotMG Exalt.exe' }], clock);

    expect(result.ok).toBe(true);
    expect(result.terminatedPids).toEqual([4321]);
    expect(result.survivingPids).toEqual([]);
    // Never touched the (much narrower) fallback kill — the tree kill alone worked, just slowly.
    expect(execFileSyncMock.mock.calls.filter((c) => c[0] === 'taskkill')).toHaveLength(1);
    expect(elapsedMs()).toBeLessThan(TERMINATE_VERIFY_MS);
  });

  it('a taskkill that itself fails (e.g. access denied) falls back to a single /PID /F on the same verified pid, and succeeds', async () => {
    const { clock } = makeFakeClock();
    let fallbackRan = false;
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'tasklist') return fallbackRan ? '' : tasklistCsvRow('RotMG Exalt.exe', 4321);
      if (cmd !== 'taskkill') throw new Error(`unexpected command ${cmd}`);
      if (args.includes('/T')) {
        const err = new Error('Command failed') as Error & { stderr?: string };
        err.stderr = 'ERROR: Access is denied.';
        throw err;
      }
      // Fallback: /PID <n> /F, no /T.
      expect(args).toEqual(['/PID', '4321', '/F']);
      fallbackRan = true;
      return 'SUCCESS: The process has been terminated.';
    });

    const result = await terminateGameProcessTree([{ pid: 4321, expectedImageName: 'RotMG Exalt.exe' }], clock);

    expect(result.ok).toBe(true);
    expect(result.terminatedPids).toEqual([4321]);
    // The access-denied attempt is surfaced (not sensitive) even though the run overall succeeded.
    expect(result.error).toMatch(/access is denied/i);
    expect(fallbackRan).toBe(true);
  });

  it('still alive after the tree kill AND the fallback: false, with taskkill output captured in the error/detail', async () => {
    const { clock, elapsedMs } = makeFakeClock();
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'tasklist') return tasklistCsvRow('RotMG Exalt.exe', 4321); // never goes away
      if (cmd !== 'taskkill') throw new Error(`unexpected command ${cmd}`);
      if (args.includes('/T')) return 'SUCCESS: Sent termination signal to the process tree.';
      return 'SUCCESS: Sent termination signal to the process.'; // "succeeds" but the pid lingers anyway
    });

    const result = await terminateGameProcessTree([{ pid: 4321, expectedImageName: 'RotMG Exalt.exe' }], clock);

    expect(result.ok).toBe(false);
    expect(result.survivingPids).toEqual([4321]);
    expect(result.terminatedPids).toEqual([]);
    expect(result.error).toMatch(/still running/);
    expect(result.error).toMatch(/SUCCESS: Sent termination signal to the process\./);
    // Both the tree-kill wait and the fallback wait ran their full budget.
    expect(elapsedMs()).toBeGreaterThanOrEqual(TERMINATE_VERIFY_MS * 2);
  });

  it(`polls every ${TERMINATE_VERIFY_POLL_MS}ms up to ${TERMINATE_VERIFY_MS}ms before giving up on one attempt`, async () => {
    const { clock, elapsedMs } = makeFakeClock();
    let pollCount = 0;
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'taskkill') return 'SUCCESS';
      if (cmd !== 'tasklist') throw new Error(`unexpected command ${cmd}`);
      const pid = Number(String(args[1]).replace(/\D/g, ''));
      if (pid !== 1) throw new Error(`unexpected pid ${pid}`);
      pollCount++;
      return tasklistCsvRow('RotMG Exalt.exe', 1); // never gone
    });

    await terminateGameProcessTree([{ pid: 1, expectedImageName: 'RotMG Exalt.exe' }], clock);

    // One "before" check + (TERMINATE_VERIFY_MS / TERMINATE_VERIFY_POLL_MS + 1) checks per attempt (tree kill + fallback).
    const perAttempt = TERMINATE_VERIFY_MS / TERMINATE_VERIFY_POLL_MS + 1;
    expect(pollCount).toBe(1 /* before */ + perAttempt /* tree kill wait */ + 1 /* fallback re-check */ + perAttempt /* fallback wait */);
    expect(elapsedMs()).toBe(TERMINATE_VERIFY_MS * 2);
  });
});
