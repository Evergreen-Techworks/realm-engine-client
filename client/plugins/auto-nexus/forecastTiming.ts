/** Ignore stale scans and past predictions instead of turning them into fresh hits. */
export function remainingHitMs(hitMs: number, ageMs: number | null): number | null {
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > 100
      || !Number.isFinite(hitMs) || hitMs < 0 || ageMs > hitMs + 32) return null;
  return Math.max(0, hitMs - ageMs);
}
