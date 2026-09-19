import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, utimesSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  BufferedJsonlWriter,
  enforceRetention,
  formatUtcCompact,
  packetsFilePath,
  testlabDir,
  writerPrivateOnlyMarker,
  TESTLAB_PRIVATE_ONLY,
} from '../recorderWriter.js';
import { loggerDirectory } from '../../util/Logger.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'testlab-writer-test-'));
});

describe('recorderWriter: private-only marker', () => {
  it('survives as a literal and a called function', () => {
    expect(TESTLAB_PRIVATE_ONLY).toBe('TESTLAB_PRIVATE_ONLY');
    expect(writerPrivateOnlyMarker()).toBe('TESTLAB_PRIVATE_ONLY');
  });
});

describe('recorderWriter: file naming', () => {
  it('formatUtcCompact produces YYYYMMDDTHHMMSSZ', () => {
    const d = new Date(Date.UTC(2026, 8, 19, 3, 4, 5)); // month is 0-based: 8 = September
    expect(formatUtcCompact(d)).toBe('20260919T030405Z');
  });

  it('packetsFilePath is <base>/testlab/packets-<UTC>.jsonl', () => {
    const d = new Date(Date.UTC(2026, 8, 19, 3, 4, 5));
    expect(packetsFilePath(d, '/tmp/RE_ASSETS')).toBe(join('/tmp/RE_ASSETS', 'testlab', 'packets-20260919T030405Z.jsonl'));
    expect(testlabDir('/tmp/RE_ASSETS')).toBe(join('/tmp/RE_ASSETS', 'testlab'));
  });

  // The 2026-09-19 folder-mismatch fix: the recorder must root itself at
  // Logger's own resolved directory, not at a second, independent tmpdir()
  // call. This proves the wiring accepts that value and builds the expected
  // path under it — see recorderWriter.ts's header comment and Logger.ts's
  // loggerDirectory() doc comment for why.
  it('is rooted at Logger.loggerDirectory(), not its own tmpdir() call', () => {
    const base = loggerDirectory();
    const d = new Date(Date.UTC(2026, 8, 19, 3, 4, 5));
    expect(testlabDir(base)).toBe(join(base, 'testlab'));
    expect(packetsFilePath(d, base)).toBe(join(base, 'testlab', 'packets-20260919T030405Z.jsonl'));
  });
});

describe('recorderWriter: BufferedJsonlWriter buffering', () => {
  let filePath: string;

  beforeEach(() => {
    filePath = join(dir, 'packets-20260101T000000Z.jsonl');
  });

  it('does not write to disk until flushed (no sync write per line)', () => {
    const w = new BufferedJsonlWriter(filePath, { flushIntervalMs: 60_000, flushBytes: 1024 * 1024 });
    w.writeLine({ k: 'ground', t: 1, x: 1, y: 2 });
    w.writeLine({ k: 'ground', t: 2, x: 3, y: 4 });
    expect(existsSync(filePath)).toBe(false);
    w.flushSync();
    expect(existsSync(filePath)).toBe(true);
    const lines = readFileSync(filePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ k: 'ground', t: 1, x: 1, y: 2 });
    expect(JSON.parse(lines[1])).toEqual({ k: 'ground', t: 2, x: 3, y: 4 });
    w.close();
  });

  it('auto-flushes once buffered bytes cross flushBytes', () => {
    const w = new BufferedJsonlWriter(filePath, { flushIntervalMs: 60_000, flushBytes: 50 });
    // Each line is well under 50 bytes alone; three of them should trip the threshold.
    w.writeLine({ k: 'ground', t: 1, x: 1, y: 2 });
    w.writeLine({ k: 'ground', t: 2, x: 3, y: 4 });
    w.writeLine({ k: 'ground', t: 3, x: 5, y: 6 });
    expect(existsSync(filePath)).toBe(true);
    w.close();
  });

  it('flushes remaining buffer on close()', () => {
    const w = new BufferedJsonlWriter(filePath, { flushIntervalMs: 60_000, flushBytes: 1024 * 1024 });
    w.writeLine({ k: 'ground', t: 1, x: 1, y: 2 });
    expect(existsSync(filePath)).toBe(false);
    w.close();
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('never throws on an unserializable value; counts it instead', () => {
    const w = new BufferedJsonlWriter(filePath, { flushIntervalMs: 60_000, flushBytes: 1024 * 1024 });
    const circular: any = {};
    circular.self = circular;
    expect(() => w.writeLine(circular)).not.toThrow();
    expect(w.errorCount).toBe(1);
    expect(w.bufferedLineCount).toBe(0);
    w.close();
  });

  it('disabled / never written to -> no directory, no file ever created', () => {
    const w = new BufferedJsonlWriter(filePath, { flushIntervalMs: 60_000 });
    w.close();
    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(dir)).toBe(true); // the tmpdir itself pre-existed; only the writer's own file must not appear
  });
});

describe('recorderWriter: enforceRetention', () => {
  function makeFile(name: string, bytes: number, ageMsAgo: number) {
    const p = join(dir, name);
    writeFileSync(p, 'x'.repeat(bytes));
    const t = new Date(Date.now() - ageMsAgo);
    utimesSync(p, t, t);
    return p;
  }

  it('deletes only its own packets-*.jsonl pattern, oldest first, until under the cap', () => {
    // Three own files: oldest, middle, newest. Plus an unrelated file that must survive untouched.
    makeFile('packets-20260101T000000Z.jsonl', 100, 300_000);
    makeFile('packets-20260102T000000Z.jsonl', 100, 200_000);
    makeFile('packets-20260103T000000Z.jsonl', 100, 100_000);
    makeFile('realm-engine-proxy.log', 100, 400_000);
    makeFile('other.jsonl', 100, 500_000);

    const result = enforceRetention(dir, 150); // cap forces deleting the two oldest own files

    expect(result.deleted.sort()).toEqual(['packets-20260101T000000Z.jsonl', 'packets-20260102T000000Z.jsonl']);
    expect(result.keptBytes).toBe(100);

    const remaining = readdirSync(dir).sort();
    expect(remaining).toEqual(['other.jsonl', 'packets-20260103T000000Z.jsonl', 'realm-engine-proxy.log']);
  });

  it('is a no-op under the cap', () => {
    makeFile('packets-20260101T000000Z.jsonl', 10, 1000);
    const result = enforceRetention(dir, 500 * 1024 * 1024);
    expect(result.deleted).toEqual([]);
    expect(readdirSync(dir)).toEqual(['packets-20260101T000000Z.jsonl']);
  });

  it('never throws when the directory does not exist', () => {
    const missing = join(dir, 'does-not-exist');
    expect(() => enforceRetention(missing, 10)).not.toThrow();
    expect(enforceRetention(missing, 10)).toEqual({ deleted: [], keptBytes: 0 });
  });
});
