import type { PluginContext } from '../src/plugins/PluginContext.js';
import { sendDllFeature } from '../src/bridge/DllFeatureBus.js';

/**
 * Collider Manipulation — tunes the local player's collisionRadiusMultiplier in
 * the injected DLL (PlayerCollider). Lowering it shrinks the player's collider,
 * which helps the auto dodge; the game default is 1.0 (no change).
 *
 * The DLL re-applies the value every frame (PlayerCollider::Tick from
 * LocalPlayer), so it survives map/location changes automatically — the client
 * only sends the value on change / (re)connect, and disables (restoring the
 * game value) when the plugin is turned off.
 *
 * This is independent of the auto dodge: zDodge no longer drives the collider.
 */

// Below 0.70 keeps the dodge effective; above it the warning fires (see
// the slider's warnWhen, which compares against the hidden `warnThreshold`).
const WARN_THRESHOLD = 0.70;

export function register(ctx: PluginContext) {
  ctx.name = 'Collider Manipulation';
  ctx.category = 'movement';

  function clamp01(v: unknown): number {
    const n = Number(v);
    if (!Number.isFinite(n)) return 1.0;
    return Math.max(0, Math.min(1, n));
  }

  // Hidden constant that powers the >0.70 warning on the slider. warnWhen
  // compares two settings, so this holds the threshold the slider is checked
  // against (warn when warnThreshold < multiplier, i.e. multiplier > 0.70).
  ctx.registerSetting('warnThreshold', {
    label: 'Warning threshold', type: 'number', value: WARN_THRESHOLD, hidden: true,
  }, () => { /* constant — never changes */ });

  ctx.registerSetting('multiplier', {
    label: 'Collision radius multiplier',
    type: 'range',
    value: 0.5,
    min: 0,
    max: 1,
    step: 0.05,
    warnWhen: {
      key: 'warnThreshold',
      cmp: 'lt',
      message: 'Recommended to keep value below 0.70 for maximum benefit. Greater than 0.70 could make the auto dodge dangerous.',
    },
  }, (v: number) => {
    if (ctx.enabled) sendDllFeature('colliderMultiplier', clamp01(v));
  });

  function applyEnabled(enabled: boolean): void {
    if (enabled) {
      sendDllFeature('colliderMultiplier', clamp01(ctx.getSetting<number>('multiplier')));
      sendDllFeature('colliderEnabled', true);
    } else {
      // Disabling restores the game's original collisionRadiusMultiplier.
      sendDllFeature('colliderEnabled', false);
    }
  }

  ctx.onEnabledChange(applyEnabled);

  // New game session — re-push state so the DLL (fresh player object) gets it.
  ctx.on('clientConnected', () => {
    if (ctx.enabled) applyEnabled(true);
  });

  ctx.on('clientDisconnected', () => {
    sendDllFeature('colliderEnabled', false);
  });

  ctx.hookCommand('cm', (client, _cmd, args) => {
    if (args.length > 0) {
      const val = parseFloat(args[0]);
      if (!isNaN(val) && val >= 0 && val <= 1) {
        ctx.updateSetting('multiplier', val);
        if (ctx.enabled) sendDllFeature('colliderMultiplier', clamp01(val));
        ctx.sendNotification(client, ctx.name, `Collider multiplier set to ${val.toFixed(2)}`);
        return;
      }
    }
    ctx.enabled = !ctx.enabled;
    applyEnabled(ctx.enabled);
    ctx.sendNotification(client, ctx.name, `Collider Manipulation ${ctx.enabled ? 'ON' : 'OFF'} (${ctx.getSetting<number>('multiplier')})`);
  });

  ctx.log('Loaded — adjust the collision radius multiplier (/cm [0.0-1.0] to configure).');
}
