import { expect, it, vi } from 'vitest';
import { chat } from '@realmengine/sdk';
import { install } from '../index.js';
import type { BridgeDeps } from '../../BridgeDeps.js';

it('preserves server boss object identity and omits it from player-originated text', () => {
  const hooks = new Map<string, Function[]>();
  install({ proxy: { hookPacket: (name: string, handler: Function) => {
    hooks.set(name, [...(hooks.get(name) ?? []), handler]);
  } } } as unknown as BridgeDeps);
  const received = vi.fn(); const unsubscribe = chat.onMessage(received);
  const client = { playerData: { name: 'Player' } };
  const emit = (name: string, data: object) => {
    for (const hook of hooks.get(name) ?? []) hook(client, { name, isDefined: true, data });
  };
  try {
    emit('TEXT', { name: '#Oryx', objectId: 42, text: 'Boss cue' });
    expect(received).toHaveBeenLastCalledWith(expect.objectContaining({ sourceObjectId: 42, message: 'Boss cue' }));
    emit('TEXT', { name: '#Oryx', objectId: -1, text: 'No source' });
    expect(received.mock.calls.at(-1)?.[0].sourceObjectId).toBeUndefined();
    emit('PLAYERTEXT', { objectId: 42, text: 'Boss cue' });
    expect(received.mock.calls.at(-1)?.[0].sourceObjectId).toBeUndefined();
  } finally { unsubscribe(); }
});
