import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileSyncMock = vi.fn();

vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  spawn: vi.fn(),
}));

const { terminateGameProcessTree } = await import('../GameLauncher.js');

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

  it('refuses a PID whose live image name is not the game, and never calls taskkill', () => {
    scriptTasklist({ 4321: { before: 'notepad.exe' } });

    const result = terminateGameProcessTree([{ pid: 4321, expectedImageName: 'RotMG Exalt.exe' }]);

    expect(result.ok).toBe(false);
    expect(result.survivingPids).toEqual([4321]);
    expect(result.terminatedPids).toEqual([]);
    expect(result.error).toMatch(/notepad\.exe/);
    // Only the one tasklist lookup ran — taskkill was never invoked.
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock.mock.calls[0][0]).toBe('tasklist');
  });

  it('treats a PID that is not running at all as already-done, not a failure', () => {
    scriptTasklist({ 999: { before: null } });
    const result = terminateGameProcessTree([{ pid: 999, expectedImageName: 'RotMG Exalt.exe' }]);
    expect(result.ok).toBe(true);
    expect(result.terminatedPids).toEqual([]);
    expect(result.survivingPids).toEqual([]);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1); // no taskkill for a pid that was never running.
  });

  it('kills a matching PID by /PID /T, never by /IM, and verifies it is actually gone', () => {
    scriptTasklist({ 4321: { before: 'RotMG Exalt.exe', after: null } });

    const result = terminateGameProcessTree([{ pid: 4321, expectedImageName: 'RotMG Exalt.exe' }]);

    expect(result.ok).toBe(true);
    expect(result.terminatedPids).toEqual([4321]);
    const taskkillCall = execFileSyncMock.mock.calls.find((c) => c[0] === 'taskkill');
    expect(taskkillCall).toBeTruthy();
    const args = taskkillCall![1] as string[];
    expect(args).toEqual(['/PID', '4321', '/T', '/F']);
    expect(args).not.toContain('/IM');
    // tasklist before + taskkill + tasklist after = 3 calls.
    expect(execFileSyncMock).toHaveBeenCalledTimes(3);
  });

  it('reports gameTerminated:false when the PID survives the taskkill /T (verified by re-query)', () => {
    scriptTasklist({ 4321: { before: 'RotMG Exalt.exe', after: 'RotMG Exalt.exe' } });

    const result = terminateGameProcessTree([{ pid: 4321, expectedImageName: 'RotMG Exalt.exe' }]);

    expect(result.ok).toBe(false);
    expect(result.survivingPids).toEqual([4321]);
    expect(result.terminatedPids).toEqual([]);
    expect(result.error).toMatch(/still running/);
  });

  it('matches image names case-insensitively and ignores surrounding whitespace/NBSP', () => {
    scriptTasklist({ 1: { before: `  ROTMG${NBSP}EXALT.EXE  `, after: null } });
    const result = terminateGameProcessTree([{ pid: 1, expectedImageName: `RotMG${NBSP}Exalt.exe` }]);
    expect(result.ok).toBe(true);
  });

  it('rejects an invalid pid without touching the OS at all', () => {
    const result = terminateGameProcessTree([
      { pid: 0, expectedImageName: 'RotMG Exalt.exe' },
      { pid: -5, expectedImageName: 'RotMG Exalt.exe' },
      { pid: NaN, expectedImageName: 'RotMG Exalt.exe' },
    ]);
    expect(result.ok).toBe(true); // nothing to do is not a failure
    expect(result.terminatedPids).toEqual([]);
    expect(result.survivingPids).toEqual([]);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('handles a launcher pid + a separately-tracked child pid: both verified and killed independently', () => {
    scriptTasklist({
      100: { before: 'RotMG Exalt.exe', after: null },
      200: { before: 'RotMGExalt.exe', after: null },
    });
    const result = terminateGameProcessTree([
      { pid: 100, expectedImageName: 'RotMG Exalt.exe' },
      { pid: 200, expectedImageName: 'RotMGExalt.exe' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.terminatedPids.sort()).toEqual([100, 200]);
  });

  it('a child pid that turns out to be a different image is left alone while the launcher is still killed', () => {
    scriptTasklist({
      100: { before: 'RotMG Exalt.exe', after: null },
      200: { before: 'someUnrelated.exe' },
    });
    const result = terminateGameProcessTree([
      { pid: 100, expectedImageName: 'RotMG Exalt.exe' },
      { pid: 200, expectedImageName: 'RotMGExalt.exe' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.terminatedPids).toEqual([100]);
    expect(result.survivingPids).toEqual([200]);
  });
});
