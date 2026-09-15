import { describe, expect, it } from 'vitest';
import { HealthEvidence } from '../../../plugins/auto-nexus/healthEvidence.js';

function seeded() {
  const evidence = new HealthEvidence();
  evidence.reset(1);
  evidence.observeHp(800, 0);
  return evidence;
}

describe('bounded comparison health evidence, not confirmed-health authority', () => {
  it('replaces identified pending damage once instead of double charging', () => {
    const evidence = seeded();
    evidence.observeHit('1:owner:1:7:1', 100, 12000, 1);
    expect(evidence.snapshot(1)).toMatchObject({ confirmedHp: 800, pendingDamage: 100, predictedHp: 700 });
    evidence.observeDamage('1:owner:1:7:1', 100, 2);
    evidence.observeDamage('1:owner:1:7:1', 100, 3);
    evidence.observeHit('1:owner:1:7:1', 100, 12000, 4);
    expect(evidence.snapshot(4)).toMatchObject({ confirmedHp: 700, pendingDamage: 0, predictedHp: 700 });
  });

  it.each([700, 750])('retires at most explicit HP loss to %s and retains acknowledgement history', hp => {
    const evidence = seeded();
    evidence.observeHit('shot', 100, 12000, 1);
    evidence.observeHp(hp, 2);
    expect(evidence.snapshot(2)).toMatchObject({ confirmedHp: hp, pendingDamage: hp - 700,
      predictedHp: 700, certainty: 'ambiguous' });
    evidence.observeDamage('shot', 100, 3);
    expect(evidence.snapshot(3)).toMatchObject({ confirmedHp: 700, pendingDamage: 0, predictedHp: 700 });
  });

  it('preserves debt during healing and equal HP samples', () => {
    const evidence = seeded();
    evidence.observeHit('shot', 100, 12000, 1);
    evidence.observeHp(850, 2);
    evidence.observeHp(850, 3);
    expect(evidence.snapshot(3)).toMatchObject({ confirmedHp: 850, pendingDamage: 100,
      predictedHp: 750, certainty: 'ambiguous' });
  });

  it('acknowledges losses in receipt order and retains partial remainder', () => {
    const evidence = seeded();
    evidence.observeHit('first', 100, 12000, 1);
    evidence.observeHit('second', 100, 12000, 2);
    evidence.observeHp(650, 3);
    evidence.observeDamage('first', 100, 4);
    expect(evidence.snapshot(4)).toMatchObject({ confirmedHp: 650, pendingDamage: 50, predictedHp: 600 });
    evidence.observeDamage('second', 100, 5);
    expect(evidence.snapshot(5)).toMatchObject({ confirmedHp: 600, pendingDamage: 0 });
  });

  it('handles DAMAGE before PLAYERHIT and ignores stale HP without resurrecting zero', () => {
    const evidence = seeded();
    evidence.observeDamage('shot', 100, 1);
    evidence.observeHit('shot', 100, 12000, 2);
    expect(evidence.snapshot(2)).toMatchObject({ confirmedHp: 700, pendingDamage: 0 });
    evidence.observeHp(0, 5);
    evidence.observeHp(800, 4);
    expect(evidence.snapshot(5)).toMatchObject({ confirmedHp: 0, predictedHp: 0, certainty: 'ambiguous' });
  });

  it('does not invent a match for unattributed DAMAGE or HP-before-hit ordering', () => {
    const evidence = seeded();
    evidence.observeHp(700, 1);
    evidence.observeHit('late', 100, 12000, 2);
    evidence.observeDamage(null, 100, 3);
    expect(evidence.snapshot(3).certainty).toBe('ambiguous');
    expect(evidence.snapshot(3).confirmedHp).toBe(700);
  });

  it('expiry drops prediction debt, not confirmed HP, and late acknowledgements stay ambiguous', () => {
    const evidence = seeded();
    evidence.observeHit('expired', 100, 10, 1);
    expect(evidence.snapshot(11)).toMatchObject({ confirmedHp: 800, pendingDamage: 0 });
    evidence.observeDamage('expired', 100, 12);
    expect(evidence.snapshot(12).certainty).toBe('ambiguous');
    expect(evidence.snapshot(12).confirmedHp).toBe(800);
  });

  it('resets all evidence across generation changes', () => {
    const evidence = seeded();
    evidence.observeHit('old', 100, 12000, 1);
    evidence.reset(2);
    expect(evidence.snapshot(2)).toEqual({ confirmedHp: null, pendingDamage: 0, predictedHp: null,
      certainty: 'identified', healthAt: null });
  });

  it('bounds pending and acknowledgement state and rejects invalid values', () => {
    const evidence = seeded();
    for (let index = 0; index < 5000; index++) evidence.observeHit(`shot:${index}`, 1, 12000, 1);
    expect(evidence.snapshot(2).pendingDamage).toBeLessThanOrEqual(4096);
    expect(evidence.snapshot(2).certainty).toBe('ambiguous');
    for (const value of [NaN, Infinity, -1]) {
      evidence.observeHp(value, 3);
      evidence.observeHit('invalid', value, 12000, 3);
      evidence.observeDamage('invalid', value, 3);
    }
    expect(Number.isFinite(evidence.snapshot(3).pendingDamage)).toBe(true);
  });

  it.each([NaN, Infinity, -1])('rejects invalid event time %s without overwriting healthAt', atMs => {
    const evidence = seeded();
    evidence.observeHp(500, atMs);
    evidence.observeHit('invalid', 100, 12000, atMs);
    evidence.observeDamage('invalid', 100, atMs);
    expect(evidence.snapshot(1)).toEqual({ confirmedHp: 800, pendingDamage: 0, predictedHp: 800,
      certainty: 'identified', healthAt: 0 });
  });
});
