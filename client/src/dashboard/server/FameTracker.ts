/**
 * Pure state machine tracking per-session fame accumulation across reconnect
 * segments. Extracted from DevServer to own fame bookkeeping independently.
 *
 * Usage:
 * - Call `startSegment()` on each client connect.
 * - Call `getSessionStats(fame)` each poll tick (the 500ms player-data interval).
 * - Call `commitSegmentAndScheduleReset()` on disconnect (grace timer expired).
 * - Call `cancelPendingReset()` on reconnect before the hard-reset fires.
 * - Call `reset()` to wipe everything (full session end).
 */
export class FameTracker {
  private static readonly FAME_INIT_WAIT_MS = 5_000;
  private static readonly FAME_RESET_MS = 120_000;

  private sessionStartedAt = 0;
  /** Fame at the start of the current reconnect segment. Null until first non-zero reading. */
  private fameSectionStart: number | null = null;
  /** Fame accumulated from all prior reconnect segments this session. */
  private fameAccumulated: number = 0;
  /** Last observed fame value — captured each poll so disconnect handler can commit it. */
  private lastKnownFame: number = 0;
  /** Fallback timer: accept 0-fame baseline if no positive value arrives within FAME_INIT_WAIT_MS. */
  private fameInitTimer: ReturnType<typeof setTimeout> | null = null;
  /** Hard-reset timer: wipe accumulated fame if player doesn't reconnect within FAME_RESET_MS. */
  private fameResetTimer: ReturnType<typeof setTimeout> | null = null;

  /** Full reset — wipe all accumulated fame and timers. */
  reset(): void {
    this.sessionStartedAt = 0;
    this.fameSectionStart = null;
    this.fameAccumulated = 0;
    this.lastKnownFame = 0;
    if (this.fameInitTimer) { clearTimeout(this.fameInitTimer); this.fameInitTimer = null; }
  }

  /**
   * Begin a new reconnect segment. Commits the previous segment's fame into fameAccumulated,
   * then waits for the first real (non-zero) fame reading before anchoring the new baseline.
   * A fallback timer accepts a zero baseline after FAME_INIT_WAIT_MS if nothing better arrives.
   */
  startSegment(): void {
    // Commit whatever was gained in the segment that just ended
    if (this.fameSectionStart != null) {
      this.fameAccumulated += Math.max(0, this.lastKnownFame - this.fameSectionStart);
    }
    this.fameSectionStart = null;
    if (this.fameInitTimer) { clearTimeout(this.fameInitTimer); this.fameInitTimer = null; }
    // Fallback: if currentFame never rises above 0 (e.g. new character), accept 0 as baseline
    this.fameInitTimer = setTimeout(() => {
      this.fameInitTimer = null;
      if (this.fameSectionStart == null) {
        this.fameSectionStart = this.lastKnownFame;
      }
    }, FameTracker.FAME_INIT_WAIT_MS);
  }

  /**
   * Compute session stats from the current fame reading.
   * Call this each poll tick — it also anchors the segment baseline on the first
   * non-zero fame and tracks sessionStartedAt.
   */
  getSessionStats(currentFame: number): { uptimeMs: number; fameGained: number; averageFpm: number } {
    const now = Date.now();
    if (!this.sessionStartedAt) this.sessionStartedAt = now;
    // Track last seen fame every poll so disconnect handler can commit accurately
    if (Number.isFinite(currentFame) && currentFame > 0) this.lastKnownFame = currentFame;
    // Anchor segment baseline once we have a real non-zero value
    if (this.fameSectionStart == null && Number.isFinite(currentFame) && currentFame > 0) {
      this.fameSectionStart = currentFame;
      if (this.fameInitTimer) { clearTimeout(this.fameInitTimer); this.fameInitTimer = null; }
    }
    const sectionGain = (this.fameSectionStart != null && Number.isFinite(currentFame))
      ? Math.max(0, currentFame - this.fameSectionStart)
      : 0;
    const fameGained = this.fameAccumulated + sectionGain;
    const uptimeMs = Math.max(0, now - this.sessionStartedAt);
    const averageFpm = uptimeMs > 0 ? (fameGained / (uptimeMs / 60000)) : 0;
    return { uptimeMs, fameGained, averageFpm };
  }

  /**
   * Called when the disconnect grace timer fires and no clients remain.
   * Commits the current segment and schedules a hard fame reset.
   */
  commitSegmentAndScheduleReset(): void {
    // Commit the current fame segment into fameAccumulated
    if (this.fameSectionStart != null) {
      const segGain = Math.max(0, this.lastKnownFame - this.fameSectionStart);
      this.fameAccumulated += segGain;
    }
    this.fameSectionStart = null;
    if (this.fameInitTimer) { clearTimeout(this.fameInitTimer); this.fameInitTimer = null; }
    this.sessionStartedAt = 0;
    // Don't wipe fameAccumulated yet — player may reconnect (server change, dungeon).
    // Schedule a hard reset: if they haven't reconnected in FAME_RESET_MS, clear it.
    if (this.fameResetTimer) clearTimeout(this.fameResetTimer);
    this.fameResetTimer = setTimeout(() => {
      this.fameResetTimer = null;
      this.fameAccumulated = 0;
      this.lastKnownFame = 0;
    }, FameTracker.FAME_RESET_MS);
  }

  /** Cancel a pending hard-reset (called on reconnect within the grace window). */
  cancelPendingReset(): void {
    if (this.fameResetTimer) {
      clearTimeout(this.fameResetTimer);
      this.fameResetTimer = null;
    }
  }

  /** Restart uptime tracking (called on fresh connect after full disconnect). */
  restartUptime(): void {
    this.sessionStartedAt = 0;
  }
}
