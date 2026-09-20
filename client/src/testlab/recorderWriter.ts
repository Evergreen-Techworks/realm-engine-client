/**
 * Test Lab packet recorder — buffered JSONL writer + retention.
 *
 * TESTLAB_PRIVATE_ONLY: this file is listed in `client/private-only.json` and
 * must be deletable from customer builds. Separated from recorderCore.ts
 * (which has no fs/os imports) because this module's whole job is the
 * filesystem side: batching writes so an ENEMYSHOOT burst (dozens/sec) never
 * causes a synchronous write per packet, and keeping `<tmpdir>/testlab/`
 * under a size cap.
 *
 * The base directory is NOT resolved here via `os.tmpdir()` — an earlier
 * version of this file did that, on the belief (still written into
 * `DiagGate.ts` and contract-packets-jsonl.md) that `os.tmpdir()` always
 * resolves to RE_ASSETS in the portable build. Measured in the first real
 * Test Lab session (2026-09-19), that belief was false: the recorder's own
 * `tmpdir()` call landed in the real Windows temp folder while the client
 * log (`Logger.ts`) landed elsewhere in the same running process. Rather
 * than re-derive "wherever the log went" a second time and risk the same
 * divergence again, every caller here must pass that directory in explicitly
 * — the plugin (`testlab-recorder.ts`) gets it from `Logger.loggerDirectory()`,
 * the single source of truth, so this file's own path can never disagree
 * with the client log's. The live path is `<Logger dir>\testlab\packets-....jsonl`,
 * beside `<Logger dir>\realm-engine-proxy.log` (contract-packets-jsonl.md).
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';

/** See recorderCore.ts's TESTLAB_PRIVATE_ONLY doc comment — same purpose, same string. */
export const TESTLAB_PRIVATE_ONLY = 'TESTLAB_PRIVATE_ONLY';

export function writerPrivateOnlyMarker(): string {
  return TESTLAB_PRIVATE_ONLY;
}

export const TESTLAB_DIR_NAME = 'testlab';
const FILE_PREFIX = 'packets-';
const FILE_SUFFIX = '.jsonl';
/** Only files matching this are ever considered by {@link enforceRetention} — nothing else under RE_ASSETS is touched. */
const OWN_FILE_PATTERN = /^packets-.*\.jsonl$/;

const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_FLUSH_BYTES = 64 * 1024;
const DEFAULT_RETENTION_BYTES = 500 * 1024 * 1024;

/** `YYYYMMDDTHHMMSSZ`, UTC — matches the contract's file-naming rule exactly. */
export function formatUtcCompact(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
  );
}

/** `baseDir` is the caller's resolved base directory — see this file's header
 *  comment for why there is no `tmpdir()` default here any more. */
export function testlabDir(baseDir: string): string {
  return join(baseDir, TESTLAB_DIR_NAME);
}

/** File: `<baseDir>/testlab/packets-<YYYYMMDDTHHMMSSZ>.jsonl` — one per client start. */
export function packetsFilePath(startedAt: Date, baseDir: string): string {
  return join(testlabDir(baseDir), `${FILE_PREFIX}${formatUtcCompact(startedAt)}${FILE_SUFFIX}`);
}

export interface RetentionResult {
  deleted: string[];
  keptBytes: number;
}

/**
 * Delete this recorder's own `packets-*.jsonl` files in `dir`, oldest
 * (mtime) first, until the remaining total is at or under `maxTotalBytes`.
 * Only ever looks at files matching {@link OWN_FILE_PATTERN} in exactly this
 * directory — never recurses, never touches the proxy log, config, profile,
 * or anything else under RE_ASSETS. Never throws: a missing directory,
 * a file that vanishes mid-sweep, or a permission error just ends the sweep
 * early with whatever was accomplished.
 */
export function enforceRetention(dir: string, maxTotalBytes: number = DEFAULT_RETENTION_BYTES): RetentionResult {
  const deleted: string[] = [];
  try {
    if (!existsSync(dir)) return { deleted, keptBytes: 0 };

    const files = readdirSync(dir)
      .filter((name) => OWN_FILE_PATTERN.test(name))
      .map((name) => {
        try {
          const full = join(dir, name);
          const st = statSync(full);
          return { name, full, size: st.size, mtimeMs: st.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((f): f is { name: string; full: string; size: number; mtimeMs: number } => f !== null)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    let total = files.reduce((sum, f) => sum + f.size, 0);
    for (const f of files) {
      if (total <= maxTotalBytes) break;
      try {
        unlinkSync(f.full);
        deleted.push(f.name);
        total -= f.size;
      } catch {
        // Leave it in place; retention must never throw.
      }
    }
    return { deleted, keptBytes: total };
  } catch {
    return { deleted, keptBytes: 0 };
  }
}

export interface BufferedJsonlWriterOptions {
  /** Default 1000ms — "flush about once a second". */
  flushIntervalMs?: number;
  /** Default 64KiB — "flush ... at 64 KB". */
  flushBytes?: number;
  /** Default 500MB retention cap, enforced once before this file's first byte is written. */
  retentionBytes?: number;
}

/**
 * Buffers JSON lines in memory and appends them to `filePath` in batches: on
 * a ~1s timer, once the buffer crosses `flushBytes`, or on an explicit
 * `flushSync()`/`close()`. `writeLine` never touches the filesystem directly
 * — it only ever pushes onto the in-memory buffer and, at most, triggers a
 * batched flush of everything buffered so far. That is the "never a sync
 * write per packet" rule: a burst of dozens of ENEMYSHOOT/sec still produces
 * at most a handful of small appendFileSync calls per second, not dozens.
 *
 * Runs the retention sweep exactly once, immediately before this file's
 * directory/first bytes are actually created, so old sessions are pruned
 * before a new one starts growing the folder. A writer that never buffers
 * anything (e.g. because the plugin stays disabled all session) never
 * creates the directory or the file at all.
 */
export class BufferedJsonlWriter {
  private buffer: string[] = [];
  private bufferedBytes = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private retentionDone = false;
  private dirEnsured = false;
  private closed = false;
  private droppedErrorCount = 0;
  private readonly flushBytes: number;
  private readonly retentionBytes: number;

  constructor(
    private readonly filePath: string,
    opts: BufferedJsonlWriterOptions = {},
  ) {
    this.flushBytes = opts.flushBytes ?? DEFAULT_FLUSH_BYTES;
    this.retentionBytes = opts.retentionBytes ?? DEFAULT_RETENTION_BYTES;
    const intervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.timer = setInterval(() => this.flushSync(), intervalMs);
    // A pending flush timer must never be the reason the process can't exit.
    this.timer.unref?.();
  }

  /** Count of swallowed exceptions (bad JSON, disk errors) — never thrown, only counted. */
  get errorCount(): number {
    return this.droppedErrorCount;
  }

  get bufferedLineCount(): number {
    return this.buffer.length;
  }

  /**
   * Append one record to the in-memory buffer. Never throws: a value that
   * can't be JSON-serialized (e.g. a BigInt or a circular structure) is
   * dropped and counted, not raised, because nothing on the packet path may
   * throw.
   */
  writeLine(record: unknown): void {
    if (this.closed) return;
    try {
      const line = JSON.stringify(record);
      if (typeof line !== 'string') {
        this.droppedErrorCount++;
        return;
      }
      this.buffer.push(line);
      this.bufferedBytes += Buffer.byteLength(line, 'utf8') + 1;
      if (this.bufferedBytes >= this.flushBytes) this.flushSync();
    } catch {
      this.droppedErrorCount++;
    }
  }

  /**
   * Append everything buffered to disk in one batched write and clear the
   * buffer. Safe to call from the timer, a size trip, or a caller — never
   * throws (a disk error is swallowed and counted, and the lines already
   * taken out of the buffer are dropped rather than retried forever).
   */
  flushSync(): void {
    if (this.buffer.length === 0) return;
    const lines = this.buffer;
    this.buffer = [];
    this.bufferedBytes = 0;
    try {
      this.ensureReady();
      appendFileSync(this.filePath, lines.join('\n') + '\n');
    } catch {
      this.droppedErrorCount++;
    }
  }

  private ensureReady(): void {
    const dir = dirname(this.filePath);
    if (!this.retentionDone) {
      this.retentionDone = true;
      enforceRetention(dir, this.retentionBytes);
    }
    if (!this.dirEnsured) {
      this.dirEnsured = true;
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Final flush, then stop the timer for good. Call on plugin disable/unload
   * and process shutdown. Idempotent — a second call is a no-op.
   */
  close(): void {
    if (this.closed) return;
    this.flushSync();
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
