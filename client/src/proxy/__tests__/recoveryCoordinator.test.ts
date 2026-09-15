import { describe, expect, it, vi } from 'vitest';
import { RecoveryCoordinator } from '../RecoveryCoordinator.js';

function fixture(send = vi.fn()) {
  const callbacks: Array<() => void> = [];
  const cancel = vi.fn();
  const recovery = new RecoveryCoordinator({ isConnected: () => true, sendEscape: send, schedule: callback => { callbacks.push(callback); return callbacks.length; }, cancel });
  const generation = recovery.beginGeneration();
  return { recovery, generation, callbacks, cancel, send };
}
describe('generation scoped escape recovery', () => {
  it('latches before sending, bounds retries and rejects duplicate requests', () => {
    const test = fixture();
    expect(test.recovery.requestEscape(test.generation, { retries: 2, retryMs: 10 })).toBe(true);
    expect(test.recovery.requestEscape(test.generation, { retries: 2, retryMs: 10 })).toBe(false);
    test.callbacks[0]();
    test.callbacks[1]();
    expect(test.send).toHaveBeenCalledTimes(3);
    expect(test.callbacks).toHaveLength(2);
  });
  it('does not rearm after synchronous disposal', () => {
    const test = fixture();
    test.send.mockImplementation(() => test.recovery.dispose());
    expect(test.recovery.requestEscape(test.generation, { retries: 2, retryMs: 10 })).toBe(true);
    expect(test.callbacks).toHaveLength(0);
  });
  it('bounds retries even when a send throws', () => {
    const test = fixture(vi.fn(() => { throw new Error('socket closed'); }));
    expect(test.recovery.requestEscape(test.generation, { retries: 1, retryMs: 10 })).toBe(true);
    test.callbacks[0]();
    expect(test.send).toHaveBeenCalledTimes(2);
    expect(test.callbacks).toHaveLength(1);
  });
  it.each(['cancelEscape', 'acceptReconnect'] as const)('%s fences an already queued callback', method => {
    const test = fixture();
    test.recovery.requestEscape(test.generation, { retries: 2, retryMs: 10 });
    test.recovery[method](test.generation);
    test.callbacks[0]();
    expect(test.send).toHaveBeenCalledTimes(1);
  });
  it('uses process-wide identities and ignores stale callbacks after replacement', () => {
    const first = fixture();
    const second = fixture();
    expect(second.generation).toBeGreaterThan(first.generation);
    first.recovery.requestEscape(first.generation, { retries: 2, retryMs: 10 });
    first.recovery.beginGeneration();
    first.callbacks[0]();
    expect(first.send).toHaveBeenCalledTimes(1);
    expect(first.recovery.requestEscape(first.generation, { retries: 1, retryMs: 10 })).toBe(false);
  });
});
