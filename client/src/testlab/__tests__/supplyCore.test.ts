/**
 * Tests for src/testlab/supplyCore.ts (TESTLAB_PRIVATE_ONLY).
 * Pure decision logic only — the plugin shell is exercised in game.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  supplyCoreMarker,
  supplyLocalDay,
  createAllowed,
  decideCreate,
  CREATE_CLASS_TYPES,
  DEFAULT_CAP_PER_DAY,
  type SupplyLedgerEntry,
} from '../supplyCore.js';

const DAY = '2026-09-22';
function entry(ts: number, outcome: SupplyLedgerEntry['outcome']): SupplyLedgerEntry {
  return { ts, day: supplyLocalDay(ts), outcome };
}

test('marker carries the private-only marker string', () => {
  assert.ok(supplyCoreMarker().includes('TESTLAB_PRIVATE_ONLY'));
});

test('wizard class type is the TutorialRunner-proven 782', () => {
  assert.equal(CREATE_CLASS_TYPES.wizard, 782);
});

test('supplyLocalDay formats local YYYY-MM-DD', () => {
  const d = new Date(2026, 8, 22, 15, 30);
  assert.equal(supplyLocalDay(d.getTime()), '2026-09-22');
});

test('decideCreate fires only after the grace window with no world entry', () => {
  const mapInfoAt = 1_000_000;
  // No MAPINFO yet: never.
  assert.equal(decideCreate({ mapInfoAt: null, worldEnteredAt: null, now: mapInfoAt + 60_000 }), false);
  // Within grace: not yet.
  assert.equal(decideCreate({ mapInfoAt, worldEnteredAt: null, now: mapInfoAt + 10_000 }), false);
  // Past grace with no world: fire.
  assert.equal(decideCreate({ mapInfoAt, worldEnteredAt: null, now: mapInfoAt + 26_000 }), true);
  // Custom grace honoured.
  assert.equal(decideCreate({ mapInfoAt, worldEnteredAt: null, now: mapInfoAt + 6_000, graceMs: 5_000 }), true);
  // World entered at any point: never, even past grace.
  assert.equal(decideCreate({ mapInfoAt, worldEnteredAt: mapInfoAt + 5_000, now: mapInfoAt + 60_000 }), false);
});

test('createAllowed: empty ledger allows', () => {
  const now = new Date(2026, 8, 22, 12, 0).getTime();
  assert.deepEqual(createAllowed([], now), { allowed: true, reason: 'ok' });
});

test('createAllowed: only sent entries charge the cap', () => {
  const noon = new Date(2026, 8, 22, 12, 0).getTime();
  const ledger = [entry(noon - 60 * 60_000, 'sent'), entry(noon - 30 * 60_000, 'sent')];
  // Two sent, cap 3: allowed.
  assert.equal(createAllowed(ledger, noon, 3, 0).allowed, true);
  // Third sent charges to the cap; a fourth is refused.
  const full = [...ledger, entry(noon - 20 * 60_000, 'sent')];
  const verdict = createAllowed(full, noon, 3, 0);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /daily cap reached \(3\/3\)/);
});

test('createAllowed: skipped entries do not charge but do enforce the gap', () => {
  const noon = new Date(2026, 8, 22, 12, 0).getTime();
  const skippedRecently = [entry(noon - 2 * 60_000, 'skipped-cap')];
  const verdict = createAllowed(skippedRecently, noon, 3, 10 * 60_000);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /backoff/);
  // Same ledger, past the gap: allowed (skip did not charge).
  assert.equal(createAllowed(skippedRecently, noon + 11 * 60_000, 3, 10 * 60_000).allowed, true);
});

test('createAllowed: cap 0 disables the entire path', () => {
  const noon = new Date(2026, 8, 22, 12, 0).getTime();
  const verdict = createAllowed([], noon, 0);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /disabled/);
});

test('createAllowed: other days do not count against today', () => {
  const noon = new Date(2026, 8, 22, 12, 0).getTime();
  const yesterday = [entry(new Date(2026, 8, 21, 12, 0).getTime(), 'sent'), entry(new Date(2026, 8, 21, 13, 0).getTime(), 'sent'), entry(new Date(2026, 8, 21, 14, 0).getTime(), 'sent')];
  assert.equal(createAllowed(yesterday, noon, DEFAULT_CAP_PER_DAY, 0).allowed, true);
});
