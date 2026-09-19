import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatBuildInfoLine, formatCommit, readBuildInfoFile } from '../buildInfo.js';

// Startup marker line (Test Lab task A2): `[Main] build: version=<v> commit=<c>
// date=<ISO-8601 UTC now>`. build-info.json is stamped in the git worktree
// (scripts/stamp-build-info.mjs) since C:\realm-engine, the build source, is not
// a git repo — reading it back here must never throw, missing or malformed.

describe('readBuildInfoFile', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'build-info-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads a clean commit', () => {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'build-info.json'), JSON.stringify({ commit: 'f2c0a2d', dirty: false }));
    expect(readBuildInfoFile(root)).toEqual({ commit: 'f2c0a2d', dirty: false });
  });

  it('reads a dirty commit', () => {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'build-info.json'), JSON.stringify({ commit: 'f2c0a2d', dirty: true }));
    expect(readBuildInfoFile(root)).toEqual({ commit: 'f2c0a2d', dirty: true });
  });

  it('returns null when the file is missing, never throws', () => {
    expect(readBuildInfoFile(join(root, 'nope'))).toBeNull();
  });

  it('returns null on malformed JSON, never throws', () => {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'build-info.json'), '{not json');
    expect(readBuildInfoFile(root)).toBeNull();
  });

  it('returns null when commit is missing or blank', () => {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'build-info.json'), JSON.stringify({ dirty: false }));
    expect(readBuildInfoFile(root)).toBeNull();
    writeFileSync(join(root, 'data', 'build-info.json'), JSON.stringify({ commit: '  ', dirty: false }));
    expect(readBuildInfoFile(root)).toBeNull();
  });
});

describe('formatCommit', () => {
  it('appends -dirty when dirty', () => {
    expect(formatCommit({ commit: 'f2c0a2d', dirty: true })).toBe('f2c0a2d-dirty');
  });

  it('is bare when clean', () => {
    expect(formatCommit({ commit: 'f2c0a2d', dirty: false })).toBe('f2c0a2d');
  });

  it('is unknown when there is no info', () => {
    expect(formatCommit(null)).toBe('unknown');
  });
});

describe('formatBuildInfoLine', () => {
  it('formats the exact startup marker contract', () => {
    const now = new Date('2026-09-19T04:12:03.456Z');
    expect(formatBuildInfoLine('1.0.19', { commit: 'f2c0a2d', dirty: false }, now))
      .toBe('build: version=1.0.19 commit=f2c0a2d date=2026-09-19T04:12:03.456Z');
  });

  it('marks a dirty worktree', () => {
    const now = new Date('2026-09-19T04:12:03.456Z');
    expect(formatBuildInfoLine('1.0.19', { commit: 'f2c0a2d', dirty: true }, now))
      .toBe('build: version=1.0.19 commit=f2c0a2d-dirty date=2026-09-19T04:12:03.456Z');
  });

  it('falls back to commit=unknown when build-info.json is missing', () => {
    const now = new Date('2026-09-19T04:12:03.456Z');
    expect(formatBuildInfoLine('1.0.19', null, now))
      .toBe('build: version=1.0.19 commit=unknown date=2026-09-19T04:12:03.456Z');
  });

  it('falls back to version=unknown when the env var is unset', () => {
    const now = new Date('2026-09-19T04:12:03.456Z');
    expect(formatBuildInfoLine('', null, now))
      .toBe('build: version=unknown commit=unknown date=2026-09-19T04:12:03.456Z');
  });
});
