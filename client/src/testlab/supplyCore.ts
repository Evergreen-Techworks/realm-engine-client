/**
 * Test Lab character supply — pure decision core (TESTLAB_PRIVATE_ONLY;
 * never ships in a customer build — listed in client/private-only.json).
 *
 * The lab account's characters die routinely (the lab ends runs on death
 * by design). Until 2026-09-22 every death needed a hand-made replacement,
 * which stalled unattended testing for hours at a time. This core decides
 * WHEN an automated CREATE may fire and WHO allows it; the plugin shell
 * (plugins/testlab-supply.ts) owns the wires.
 *
 * Detection contract (mirrors runnerCore's never-in-world evidence): with
 * zero living characters the game connects, receives MAPINFO and then sits
 * at character select forever — admission never reaches 'loaded'. So:
 * MAPINFO + no 'loaded' within the grace window = an account that needs a
 * character. The CREATE packet is injected on the game's OWN connection
 * (client.sendToServer), the same wire the real character-select screen
 * uses — no headless protocol to replicate (the 2026-09-22 headless
 * attempts died on DECA's token binding; the game's own auth just works).
 *
 * Owner rules honoured (2026-09-21 "we need a character cap"): a hard
 * per-local-day cap and a minimum gap between attempts — same policy shape
 * as the python door this replaces (lib/character.py: 3/day, 30-min
 * backoff). Cap 0 disables the whole path.
 */
export const TESTLAB_PRIVATE_ONLY = 'TESTLAB_PRIVATE_ONLY';

/** Marker proving the core is present in a private build (manifest scans). */
export function supplyCoreMarker(): string {
  return `testlab-supply-core-v1:${TESTLAB_PRIVATE_ONLY}`;
}

/** How long after MAPINFO with no world entry before we create (the
 * runner's world-wait is 180 s; grace + create + load must fit inside). */
export const DEFAULT_GRACE_MS = 25_000;
/** Hard per-local-day ceiling on injected CREATEs (owner rule). */
export const DEFAULT_CAP_PER_DAY = 3;
/** Minimum gap between supply attempts, success or not (owner rule). */
export const DEFAULT_MIN_GAP_MS = 10 * 60_000;

/** classType ids the supply may create. WIZARD = 782 (TutorialRunner.ts). */
export const CREATE_CLASS_TYPES = { wizard: 782 } as const;

/** One ledger line per supply decision. Only 'sent' counts against the cap. */
export interface SupplyLedgerEntry {
  ts: number;
  /** Local calendar day (supplyLocalDay) the attempt belongs to. */
  day: string;
  outcome: 'sent' | 'skipped-disabled' | 'skipped-cap' | 'skipped-gap';
  mapName?: string;
}

/** Local YYYY-MM-DD for a ms timestamp — the cap's day boundary. */
export function supplyLocalDay(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Cap + pacing gate. `entries` is the append-only ledger; only 'sent'
 * entries charge the cap, but ANY today-entry (including skips) enforces
 * the gap, so a disabled/skipped loop cannot spin.
 */
export function createAllowed(
  entries: SupplyLedgerEntry[],
  now: number,
  capPerDay: number = DEFAULT_CAP_PER_DAY,
  minGapMs: number = DEFAULT_MIN_GAP_MS,
): { allowed: boolean; reason: string } {
  if (capPerDay <= 0) return { allowed: false, reason: 'disabled (cap 0)' };
  const day = supplyLocalDay(now);
  const today = entries.filter((e) => e.day === day);
  const charged = today.filter((e) => e.outcome === 'sent');
  if (charged.length >= capPerDay) {
    return { allowed: false, reason: `daily cap reached (${charged.length}/${capPerDay})` };
  }
  const last = today[today.length - 1];
  if (last && now - last.ts < minGapMs) {
    return { allowed: false, reason: `backoff (${Math.ceil((minGapMs - (now - last.ts)) / 60_000)} min left)` };
  }
  return { allowed: true, reason: 'ok' };
}

/**
 * The behavioural trigger: a MAPINFO arrived, the world was never entered,
 * and the grace window has elapsed. worldEnteredAt clears the trigger the
 * moment admission reaches 'loaded' (or CREATESUCCESS arrives).
 */
export function decideCreate(args: {
  mapInfoAt: number | null;
  worldEnteredAt: number | null;
  now: number;
  graceMs?: number;
}): boolean {
  const grace = args.graceMs ?? DEFAULT_GRACE_MS;
  if (args.worldEnteredAt !== null) return false;
  if (args.mapInfoAt === null) return false;
  return args.now - args.mapInfoAt >= grace;
}
