import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../DiagRateLimit.js';

// item 4b / ground-rule F: one-off >threshold diagnostic lines (a slow bridge
// command, a slow event-loop sample, a slow Auto Nexus write) must stay to
// "a handful per 5s" even under load. This is the gate that enforces that.

describe('RateLimiter', () => {
  it('allows up to max events per window, then drops the rest', () => {
    const rl = new RateLimiter(3, 5000);
    expect(rl.allow(0)).toBe(true);
    expect(rl.allow(1)).toBe(true);
    expect(rl.allow(2)).toBe(true);
    expect(rl.allow(3)).toBe(false); // 4th in the same window
    expect(rl.allow(4999)).toBe(false);
  });

  it('resets the budget once the window rolls over', () => {
    const rl = new RateLimiter(2, 5000);
    expect(rl.allow(0)).toBe(true);
    expect(rl.allow(1)).toBe(true);
    expect(rl.allow(2)).toBe(false);
    expect(rl.allow(5000)).toBe(true); // new window
    expect(rl.allow(5001)).toBe(true);
    expect(rl.allow(5002)).toBe(false);
  });
});
