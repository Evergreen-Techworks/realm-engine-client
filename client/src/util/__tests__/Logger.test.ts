import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect } from 'vitest';
import { loggerDirectory } from '../Logger.js';

describe('Logger.loggerDirectory', () => {
  it('is the directory of Logger\'s own log file (dirname of join(tmpdir(), "realm-engine-proxy.log"))', () => {
    expect(loggerDirectory()).toBe(dirname(join(tmpdir(), 'realm-engine-proxy.log')));
  });

  it('is stable across calls — the same value every time, not a fresh tmpdir() read', () => {
    expect(loggerDirectory()).toBe(loggerDirectory());
  });
});
