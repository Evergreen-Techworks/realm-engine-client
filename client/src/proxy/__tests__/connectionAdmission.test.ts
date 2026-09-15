import { describe, expect, it } from 'vitest';
import { initialAdmission, reduceAdmission } from '../ConnectionAdmission.js';

describe('connection admission', () => {
  it('waits at queue zero and only explicit readiness loads', () => {
    let state = reduceAdmission(initialAdmission(), { type: 'begin', generation: 1 });
    state = reduceAdmission(state, { type: 'queue', generation: 1, position: 3 });
    expect(state.phase).toBe('queued');
    state = reduceAdmission(state, { type: 'queue', generation: 1, position: 0 });
    expect(state.phase).toBe('admission-pending');
    expect(reduceAdmission(state, { type: 'map-loaded', generation: 1 }).phase).toBe('loaded');
  });
  it('ignores stale events and terminal generation updates', () => {
    const state = reduceAdmission(initialAdmission(), { type: 'begin', generation: 2 });
    expect(reduceAdmission(state, { type: 'queue', generation: 1, position: 0 })).toBe(state);
    const cancelled = reduceAdmission(state, { type: 'cancel', generation: 2 });
    expect(reduceAdmission(cancelled, { type: 'queue', generation: 2, position: 1 })).toBe(cancelled);
    expect(reduceAdmission(cancelled, { type: 'map-loaded', generation: 2 })).toBe(cancelled);
    expect(reduceAdmission(cancelled, { type: 'begin', generation: 3 }).phase).toBe('connecting');
  });
  it('distinguishes semantic portal refusal and transport retry', () => {
    const state = reduceAdmission(initialAdmission(), { type: 'begin', generation: 1 });
    expect(reduceAdmission(state, { type: 'portal-refused', generation: 1, portalId: 7, retryAt: 8000, reason: 'verified-full' })).toMatchObject({ phase: 'entry-refused', portalId: 7, source: 'server' });
    expect(reduceAdmission(state, { type: 'transport-retry', generation: 1, retryAt: 5000, reason: 'silent-close' })).toMatchObject({ phase: 'connecting', source: 'transport' });
  });
});
