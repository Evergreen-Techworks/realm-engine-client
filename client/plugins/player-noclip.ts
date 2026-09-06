import type { PluginContext, ClientConnection } from './api.js';
import { sendDllFeature, RuntimeScheduler } from './api.js';

/**
 * Player Noclip.
 *
 * The DLL side only silences the game's own walkability gate; the rubberbanding
 * that remains is the server reconciling the move. So while noclip is on we also
 * hold the connection (ClientConnection.lagMode, same mechanism as the Socket
 * plugin) so no Move packet reaches the server.
 *
 * That is not free — a held socket past ~20s gets you dropped — so the hold is
 * hard-capped at MAX_HOLD_S, after which the socket is released and noclip turns
 * itself off. An in-game floating-text counter ramps green -> red as the budget
 * burns down.
 */
const MAX_HOLD_S = 20;

export function register(ctx: PluginContext) {
  ctx.name = 'Player Noclip';
  ctx.category = 'movement';

  let noclipEnabled = false;
  let hotkey = 'N';

  const clients = new Set<ClientConnection>();
  // Only the connections we personally put into lagMode, so releasing never
  // flushes a queue the Socket plugin owns.
  const held = new Set<ClientConnection>();
  const scheduler = new RuntimeScheduler();
  let heldSince = 0;
  let stopTicker: (() => void) | null = null;

  function notify(text: string, rgb: string): void {
    sendDllFeature('showPluginFloatingText', `${text}|#${rgb}`);
  }

  /** green (20DC00) -> red (FF0019) across the hold budget. */
  function rampColor(fraction: number): string {
    const k = Math.min(1, Math.max(0, fraction));
    const ch = (from: number, to: number) =>
      Math.round(from + (to - from) * k).toString(16).padStart(2, '0');
    return `${ch(0x20, 0xff)}${ch(0xdc, 0x00)}${ch(0x00, 0x19)}`;
  }

  function tick(): void {
    const secs = Math.round((Date.now() - heldSince) / 1000);
    if (secs >= MAX_HOLD_S) {
      releaseSocket();
      setNoclipEnabled(false);
      notify(`Noclip off - ${MAX_HOLD_S}s socket limit`, 'ff0019');
      ctx.log(`Auto-disabled: socket held ${MAX_HOLD_S}s`);
      return;
    }
    notify(`Noclip - socket closed ${secs}s`, rampColor(secs / MAX_HOLD_S));
  }

  function holdSocket(): void {
    for (const client of clients) {
      if (!client.lagMode) {
        client.lagMode = true;
        held.add(client);
      }
    }
    if (heldSince) return;
    heldSince = Date.now();
    stopTicker = scheduler.scheduleRepeating(1000, tick);
    tick();
  }

  function releaseSocket(): void {
    for (const client of held) {
      client.lagMode = false;
      client.flushLagQueue();
    }
    held.clear();
    if (!heldSince) return;
    heldSince = 0;
    stopTicker?.();
    stopTicker = null;
  }

  function flush(forceOff = false): void {
    const active = !forceOff && ctx.enabled;
    const on = active && noclipEnabled;
    sendDllFeature('playerNoclipActive', active);
    sendDllFeature('playerNoclipEnabled', on);
    sendDllFeature('playerNoclipHotkey', hotkey.trim());
    if (on) holdSocket();
    else releaseSocket();
  }

  function setNoclipEnabled(enabled: boolean) {
    noclipEnabled = enabled;
    if (!ctx.updateSetting('noclipEnabled', enabled))
      flush();
  }

  ctx.registerSetting('noclipEnabled', {
    label: 'Noclip enabled',
    type: 'boolean',
    value: noclipEnabled,
  }, (val: boolean) => {
    noclipEnabled = val;
    flush();
  });

  ctx.registerSetting('hotkey', {
    label: 'Hotkey',
    type: 'text',
    value: hotkey,
  }, (val: string) => {
    hotkey = String(val || '').trim();
    flush();
  });

  ctx.registerSetting('toggleNoclip', {
    label: 'Toggle Noclip',
    type: 'button',
    value: null,
  }, () => {
    setNoclipEnabled(!noclipEnabled);
  });

  ctx.onEnabledChange((enabled) => {
    flush(!enabled);
  });
  ctx.on('clientConnected', (client) => {
    clients.add(client);
    flush();
  });
  ctx.on('clientDisconnected', (client) => {
    clients.delete(client);
    held.delete(client);
    client.lagMode = false;
    flush(true);
  });

  ctx.registerCleanup(() => {
    flush(true);
    scheduler.stop();
  });
}
