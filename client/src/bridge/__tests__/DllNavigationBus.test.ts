import { expect, it, vi } from 'vitest';
import { decodeNavigationStatus, subscribeNavigationStatus, publishNavigationStatus } from '../DllNavigationBus.js';
import { InternalBridge } from '../InternalBridge.js';

it('validates correlated navigation status without coercing malformed identities', () => {
  const status = { goalKind: 'point', goalId: 1, generation: 2, state: 'unreachable', reason: 'stuck' };
  expect(decodeNavigationStatus(status)).toEqual(status);
  for (const invalid of [{ goalId: '1' }, { generation: -1 }, { state: 'done' }, { goalKind: 'bad' }, { reason: 'x'.repeat(129) }]) {
    expect(decodeNavigationStatus({ ...status, ...invalid })).toBeNull();
  }
});
it('dispatches valid connected native status and never replays atomic movement commands', () => {
  const bridge = new InternalBridge('test');
  const received = vi.fn();
  const unsubscribe = subscribeNavigationStatus(received);
  const message = { type: 'navStatus', goalKind: 'point', goalId: 1, generation: 2, state: 'routing', reason: '' };
  (bridge as any).handleMessage(message);
  expect(received).not.toHaveBeenCalled();
  (bridge as any).connected = true;
  (bridge as any).handleMessage({ ...message, goalId: Infinity });
  expect(received).not.toHaveBeenCalled();
  (bridge as any).handleMessage(message);
  expect(received).toHaveBeenCalledOnce();
  bridge.setFeature('scriptNavigationGoal', '1,2,3');
  expect((bridge as any).lastSentFeatures.has('scriptNavigationGoal')).toBe(false);
  unsubscribe();
});
it('isolates throwing bus subscribers', () => {
  const removeThrower = subscribeNavigationStatus(() => { throw new Error('script failure'); });
  const listener = vi.fn();
  const removeListener = subscribeNavigationStatus(listener);
  expect(() => publishNavigationStatus({ goalKind: 'point', goalId: 1, generation: 1, state: 'routing', reason: '' })).not.toThrow();
  expect(listener).toHaveBeenCalledOnce();
  removeThrower(); removeListener();
});
