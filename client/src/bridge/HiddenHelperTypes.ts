/**
 * Sends the objects.xml hidden-helper enemy types to the DLL, so its enemy lock
 * and auto-aim skip the same invisible spawners and triggers that
 * Enemies.getAll skips (GameDataLoader `hiddenHelper`). Native cannot classify
 * these itself: ObjectProperties does not hold the texture file.
 *
 * Wire format, parsed by EnemyClassify::ApplyTypeListMessage
 * (internal/src/features/combat/enemytracker/EnemyClassify.h):
 *   - decimal object types separated by commas, ascending and unique
 *   - a message starting with "+" appends to the DLL's list; any other message
 *     replaces it; "" clears it
 *   - one bad token (not an integer in 0..65535) rejects the whole message and
 *     the DLL keeps its previous list
 *   - FeatureCommand::value is char[4096] and IpcJson::GetString truncates a
 *     longer value without an error, which could cut the last token into a
 *     different, valid type. So each message is at most 4095 bytes, and a
 *     longer list goes out as one replace followed by "+" appends.
 */

import type { GameDataLoader } from '../game-data/GameDataLoader.js';
import { sendDllFeature } from './DllFeatureBus.js';

/** Longest `enemyHiddenHelperTypes` value the DLL receives intact (char[4096] minus the NUL). */
export const MAX_FEATURE_TEXT_BYTES = 4095;

/**
 * Encode object types as `enemyHiddenHelperTypes` messages, to be sent in order.
 * Values the DLL would reject are left out. An empty list is one "" message.
 */
export function encodeTypeListMessages(types: Iterable<number>, maxBytes = MAX_FEATURE_TEXT_BYTES): string[] {
  const sorted = [...new Set(types)]
    .filter((t) => Number.isInteger(t) && t >= 0 && t <= 0xffff)
    .sort((a, b) => a - b);
  const messages: string[] = [];
  let current = '';
  for (const type of sorted) {
    const token = String(type);
    if (current === '') {
      current = messages.length === 0 ? token : `+${token}`;
    } else if (current.length + 1 + token.length <= maxBytes) {
      current += `,${token}`;
    } else {
      messages.push(current);
      current = `+${token}`;
    }
  }
  messages.push(current);
  return messages;
}

type HiddenHelperTypeSource = Pick<GameDataLoader, 'getHiddenHelperEnemyTypes' | 'onReload'>;

/** Send the loader's current hidden-helper enemy types. False when no DLL sender is installed. */
export function sendHiddenHelperTypes(gameData: Pick<GameDataLoader, 'getHiddenHelperEnemyTypes'>): boolean {
  for (const message of encodeTypeListMessages(gameData.getHiddenHelperEnemyTypes())) {
    if (!sendDllFeature('enemyHiddenHelperTypes', message)) return false;
  }
  return true;
}

/**
 * Send the list now, on every DLL (re)connect, and whenever objects.xml reloads.
 * Returns a detach function. Call after `setDllFeatureSender`.
 *
 * The connect re-send is needed although InternalBridge replays feature state on
 * connect: it replays only the last value per key, which for a list split into
 * several messages is just the final "+" append, so a freshly injected DLL
 * would get part of the list. InternalBridge emits `authenticated` before its
 * replay; the replayed append repeats types already sent, which changes nothing.
 */
export function attachHiddenHelperTypeSync(
  gameData: HiddenHelperTypeSource,
  bridge: { on(event: 'authenticated', listener: () => void): unknown; off(event: 'authenticated', listener: () => void): unknown },
): () => void {
  const push = (): void => { sendHiddenHelperTypes(gameData); };
  const offReload = gameData.onReload(push);
  bridge.on('authenticated', push);
  push();
  return () => {
    offReload();
    bridge.off('authenticated', push);
  };
}
