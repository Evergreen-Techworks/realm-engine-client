import { randomUUID } from 'crypto';
import type { ClientConnection } from '../proxy/ClientConnection.js';
import { GAME_PORT } from '../constants/GameId.js';

/**
 * Per-connection state, persisted across reconnects.
 * Ported from KRelayBetter's State.cs.
 */
export class State {
  readonly guid: string;
  client: ClientConnection;
  accountId = '';
  conTargetAddress = '54.241.208.233'; // Default: USWest
  conTargetPort = GAME_PORT;
  /** GameId from HELLO/RECONNECT. Used as a coarse "current map" identifier. */
  gameId = -2;
  conRealKey: Buffer = Buffer.alloc(0);
  /** When true, ReconnectHandler will replace the HELLO key (even if conRealKey is empty). */
  pendingKeyRestore = false;
  /** Access token from the HELLO packet, used for API calls. */
  accessToken = '';
  /** Raw decrypted HELLO bytes captured on first connection — used as template for reconnects. */
  helloTemplate: Buffer | null = null;
  /** Byte offset of the `key` field (int16 length prefix) within helloTemplate. */
  helloKeyOffset = -1;

  /** Dynamic key-value store for plugins. */
  private store = new Map<string, any>();

  constructor(client: ClientConnection) {
    this.guid = randomUUID().replace(/-/g, '');
    this.client = client;
  }

  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }

  set(key: string, value: any): void {
    this.store.set(key, value);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  /** Copy all plugin store entries from another state (used across reconnects). */
  copyStoreFrom(other: State): void {
    for (const [k, v] of other.store) {
      this.store.set(k, v);
    }
  }
}
