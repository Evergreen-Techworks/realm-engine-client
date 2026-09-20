import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileSyncMock = vi.fn();

vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  spawn: vi.fn(),
}));

const { terminateGameProcessByPid } = await import('../GameLauncher.js');

function tasklistCsvRow(imageName: string, pid: number): string {
  return `"${imageName}","${pid}","Console","1","12,345 K"`;
}

describe('terminateGameProcessByPid', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it('refuses a PID whose live image name is not the game, and never calls taskkill', () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'tasklist') return tasklistCsvRow('notepad.exe', 4321);
      throw new Error(`unexpected command ${cmd}`);
    });

    const result = terminateGameProcessByPid(4321);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/notepad\.exe/);
    // Only the tasklist lookup ran — taskkill was never invoked.
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock.mock.calls[0][0]).toBe('tasklist');
  });

  it('refuses a PID that is not running at all', () => {
    execFileSyncMock.mockImplementation(() => '');
    const result = terminateGameProcessByPid(999);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not running/);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('kills a matching PID by /PID, never by /IM', () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'tasklist') return tasklistCsvRow('RotMG Exalt.exe', 4321);
      if (cmd === 'taskkill') return '';
      throw new Error(`unexpected command ${cmd}`);
    });

    const result = terminateGameProcessByPid(4321);

    expect(result.ok).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    const taskkillCall = execFileSyncMock.mock.calls.find((c) => c[0] === 'taskkill');
    expect(taskkillCall).toBeTruthy();
    const args = taskkillCall![1] as string[];
    expect(args).toEqual(['/PID', '4321', '/F']);
    expect(args).not.toContain('/IM');
  });

  it('matches image names case-insensitively and ignores surrounding whitespace/NBSP', () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'tasklist') return tasklistCsvRow('ROTMG EXALT.EXE', 1);
      if (cmd === 'taskkill') return '';
      throw new Error('unexpected');
    });
    const result = terminateGameProcessByPid(1, 'RotMG Exalt.exe');
    expect(result.ok).toBe(true);
  });

  it('rejects an invalid pid without touching the OS at all', () => {
    expect(terminateGameProcessByPid(0).ok).toBe(false);
    expect(terminateGameProcessByPid(-5).ok).toBe(false);
    expect(terminateGameProcessByPid(NaN).ok).toBe(false);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('accepts a caller-supplied expected image name for a non-default target', () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'tasklist') return tasklistCsvRow('SomeOtherGame.exe', 55);
      if (cmd === 'taskkill') return '';
      throw new Error('unexpected');
    });
    const result = terminateGameProcessByPid(55, 'SomeOtherGame.exe');
    expect(result.ok).toBe(true);
  });
});
