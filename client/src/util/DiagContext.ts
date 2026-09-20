/**
 * DiagContext — item 4b's "current context" marker. A plain string assignment
 * (no timing, no allocation beyond the string itself) set immediately before
 * a packet hook or a script's onLoop() runs, and cleared after. When the
 * event-loop monitor (diag/EventLoopDiag.ts) sees a sample over 100ms in a
 * window, it names whatever this held at flush time — an approximation (the
 * slow stretch may have moved on by the time the histogram flushes), which is
 * exactly the tradeoff the investigation's design called for: "near-zero
 * cost, one object write" over precise attribution.
 */
export const DiagContext = {
  current: 'idle',
};
