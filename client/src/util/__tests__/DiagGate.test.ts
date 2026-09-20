import { existsSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiagGate } from '../DiagGate.js';

// item 4b, ground rule A: the client mirrors the native DiagTiming flag by
// polling the same file the DLL does (RE_ASSETS/diag-timing.flag — see
// internal/src/core/logging/DiagTiming.h). This is the "off = no output"
// precondition every other [Diag/*] emitter in this task depends on: if
// DiagGate.on() is false, none of them ever call record()/Logger.log at all.
const FLAG_PATH = join(tmpdir(), 'diag-timing.flag');

describe('DiagGate', () => {
  beforeEach(() => {
    try { rmSync(FLAG_PATH); } catch { /* not present */ }
    DiagGate._resetPollForTests();
  });

  afterEach(() => {
    try { rmSync(FLAG_PATH); } catch { /* not present */ }
    DiagGate._resetPollForTests();
  });

  it('is off when the flag file is absent (the default, shipped state)', () => {
    expect(existsSync(FLAG_PATH)).toBe(false);
    expect(DiagGate.on()).toBe(false);
  });

  it('turns on once the flag file exists', () => {
    writeFileSync(FLAG_PATH, '');
    DiagGate._resetPollForTests(); // force an immediate re-check instead of waiting 2s
    expect(DiagGate.on()).toBe(true);
  });

  it('turns off again once the flag file is removed', () => {
    writeFileSync(FLAG_PATH, '');
    DiagGate._resetPollForTests();
    expect(DiagGate.on()).toBe(true);
    rmSync(FLAG_PATH);
    DiagGate._resetPollForTests();
    expect(DiagGate.on()).toBe(false);
  });
});
