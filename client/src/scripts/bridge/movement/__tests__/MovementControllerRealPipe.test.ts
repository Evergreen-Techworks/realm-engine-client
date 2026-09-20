import { afterEach, expect, it } from 'vitest';
import { MovementController } from '../MovementController.js';
import { setDllFeatureSender } from '../../../../bridge/DllFeatureBus.js';
import { InternalBridge } from '../../../../bridge/InternalBridge.js';
import { BRIDGE } from '../../../../bridge/contract.js';
import type { BridgeDeps } from '../../BridgeDeps.js';

/**
 * task-NAV1, end-to-end through the real DLL bridge (not the DllFeatureBus mock
 * MovementControllerReconnect.test.ts uses). This is what actually distinguishes
 * the fix: before it, `sendDllFeature` reported success as soon as a sender was
 * registered, never checking whether `InternalBridge.send()` reached the pipe —
 * so a mocked sendDllFeature can't tell old from new behaviour here, only a real
 * InternalBridge with a real (fake) socket can. Modelled on the "hidden-helper
 * types on the real DLL pipe" block in hiddenHelperTypes.test.ts.
 */

type FakeSocket = { destroyed: boolean; frames: Buffer[]; write(b: Buffer): boolean; destroy(): void };
type BridgeInternals = { socket: FakeSocket | null; handleMessage(msg: unknown): void; disconnect(): void };

function fakeSocket(): FakeSocket {
  return {
    destroyed: false,
    frames: [],
    write(b) { this.frames.push(b); return true; },
    destroy() { this.destroyed = true; },
  };
}

/** Simulates the DLL connecting and completing the hello handshake. */
function connect(bridge: InternalBridge): FakeSocket {
  const internals = bridge as unknown as BridgeInternals;
  const sock = fakeSocket();
  internals.socket = sock;
  internals.handleMessage({ type: 'hello', version: BRIDGE.PROTOCOL_VERSION, protocol: BRIDGE.PROTOCOL_TAG });
  return sock;
}

/** scriptNavigationGoal values written to one pipe session, in order. */
function goalValues(sock: FakeSocket): string[] {
  const out: string[] = [];
  for (const frame of sock.frames) {
    const msg = JSON.parse(frame.subarray(4).toString('utf8'));
    if (msg.type === 'setFeature' && msg.key === 'scriptNavigationGoal') out.push(msg.value);
  }
  return out;
}

afterEach(() => setDllFeatureSender(null));

it('gate: a goal requested while the bridge pipe is down reaches the DLL once it connects', () => {
  const bridge = new InternalBridge('test');
  setDllFeatureSender((key, value) => bridge.setFeature(key, value));
  const movement = new MovementController(
    { clientRef: { current: { connected: true } }, dllBridge: bridge } as unknown as BridgeDeps,
  );
  try {
    // No DLL connected yet — this is live run 2 (script starts before the pipe is up).
    expect(movement.navigateTo(105.4, 67.5)).toBe(false);
    expect(movement.getTarget()).toBeNull();

    // The DLL connects. The script's loop re-requests the same destination.
    const sock = connect(bridge);
    expect(movement.navigateTo(105.4, 67.5)).toBe(true);
    expect(movement.getTarget()).toEqual({ x: 105.4, y: 67.5 });
    expect(goalValues(sock)).toHaveLength(1);
    expect(goalValues(sock)[0].endsWith(',105.4,67.5')).toBe(true);
  } finally {
    bridge.stop();
  }
});

it('gate: a goal in flight is reissued with a fresh id when the real pipe drops and reconnects', () => {
  const bridge = new InternalBridge('test');
  setDllFeatureSender((key, value) => bridge.setFeature(key, value));
  const movement = new MovementController(
    { clientRef: { current: { connected: true } }, dllBridge: bridge } as unknown as BridgeDeps,
  );
  try {
    const first = connect(bridge);
    expect(movement.navigateTo(10, 20)).toBe(true);
    const firstId = Number(goalValues(first)[0].split(',')[0]);

    // DLL drops the pipe and a re-injected DLL connects. The script never
    // re-calls navigateTo (still the same goal from its point of view).
    (bridge as unknown as BridgeInternals).disconnect();
    const second = connect(bridge);

    const values = goalValues(second);
    expect(values).toHaveLength(1); // exactly one reissue, not a replay of stale state
    const secondId = Number(values[0].split(',')[0]);
    expect(secondId).toBeGreaterThan(firstId);
    expect(values[0]).toBe(`${secondId},10,20`);
  } finally {
    bridge.stop();
  }
});
