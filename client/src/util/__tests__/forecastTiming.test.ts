import { expect, it } from 'vitest';
import { remainingHitMs } from '../../../plugins/auto-nexus/forecastTiming.js';
it('ages future events without resurrecting expired or stale predictions', () => {
  expect(remainingHitMs(150, 50)).toBe(100);
  expect(remainingHitMs(0, 10)).toBe(0);
  expect(remainingHitMs(10, 80)).toBeNull();
  expect(remainingHitMs(500, 150)).toBeNull();
  expect(remainingHitMs(100, null)).toBeNull();
  expect(remainingHitMs(NaN, 0)).toBeNull();
});
