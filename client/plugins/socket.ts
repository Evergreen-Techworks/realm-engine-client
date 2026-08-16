import type { PluginContext } from './api.js';
import type { ClientConnection } from './api.js';
import { RuntimeScheduler } from './api.js';
import { sendDllFeature } from './api.js';

/**
 * Socket plugin.
 *
 * Toggles ClientConnection.lagMode. All packets in both directions are queued
 * inside ClientConnection. On deactivation the queue is flushed in order, which
 * is RC4-safe.
 *
 * Controls:
 *   Dashboard "Socket" button     - full lag toggle / flush
 *   Dashboard "Hotkey" setting    - full lag toggle / flush
 *   /lag                          - full lag toggle
 *   /lagdrop                      - drop full lag queue
 */
export function register(ctx: PluginContext) {
  ctx.name = 'Socket';
  ctx.category = 'network';

  let lagging = false;
  let hotkey = 'L';
  const clients = new Set<ClientConnection>();

  ctx.on('clientConnected', (client) => {
    clients.add(client);
    flushHotkeyToInternal();
  });
  ctx.on('clientDisconnected', (client) => {
    client.lagMode = false;
    client.dropLagQueue();
    clients.delete(client);
    flushHotkeyToInternal();
  });

  ctx.registerSetting('toggle', {
    label: 'Socket',
    type: 'button',
    value: null,
  }, () => toggleLag());

  ctx.registerSetting('hotkey', {
    label: 'Hotkey',
    type: 'text',
    value: hotkey,
  }, (val: string) => {
    hotkey = String(val || '').trim();
    flushHotkeyToInternal();
  });

  ctx.registerSetting('status', {
    label: 'Full Lag',
    type: 'text',
    value: 'OFF',
    hidden: true,
  });

  function updateStats(): void {
    let totalPkts = 0;
    let totalBytes = 0;
    for (const client of clients) {
      totalPkts += client.lagQueueSize;
      totalBytes += client.lagQueueBytes;
    }
    ctx.updateSetting(
      'status',
      lagging ? `ON - ${totalPkts} pkts, ${(totalBytes / 1024).toFixed(2)} KB` : 'OFF',
    );
  }

  const scheduler = new RuntimeScheduler();
  const stopTicker = scheduler.scheduleRepeating(500, () => {
    if (lagging) updateStats();
  });

  ctx.registerCleanup(() => {
    stopTicker();
    sendDllFeature('socketHotkeyActive', false);
    scheduler.stop();
    for (const client of clients) {
      client.lagMode = false;
      client.dropLagQueue();
    }
  });

  function activateLag(): void {
    lagging = true;
    for (const client of clients) client.lagMode = true;
    updateStats();
    ctx.log('Full lag ON');
  }

  function flushAll(): void {
    lagging = false;
    let total = 0;
    for (const client of clients) {
      client.lagMode = false;
      total += client.flushLagQueue();
    }
    updateStats();
    ctx.log(`Full lag OFF - flushed ${total} packets`);
  }

  function dropAll(): void {
    lagging = false;
    let total = 0;
    for (const client of clients) {
      client.lagMode = false;
      total += client.dropLagQueue();
    }
    updateStats();
    ctx.log(`Full lag OFF - dropped ${total} packets`);
  }

  function toggleLag(): void {
    if (lagging) flushAll();
    else activateLag();
  }

  function flushHotkeyToInternal(): void {
    sendDllFeature('socketHotkeyActive', ctx.enabled && clients.size > 0);
    sendDllFeature('socketHotkey', hotkey.trim());
  }

  ctx.onEnabledChange((enabled) => {
    if (!enabled && lagging) dropAll();
    flushHotkeyToInternal();
  });

  ctx.hookCommand('lag', (client, _cmd, args) => {
    if (args[0] === 'drop') {
      dropAll();
      ctx.sendNotification(client, 'Socket', 'Full queue dropped');
      return;
    }
    toggleLag();
    ctx.sendNotification(client, 'Socket', lagging ? 'Full lag ON' : 'Full lag OFF - flushed');
  });

  ctx.hookCommand('lagdrop', (client) => {
    dropAll();
    ctx.sendNotification(client, 'Socket', 'Full queue dropped');
  });

  ctx.log('Loaded - /lag, /lagdrop');
}
