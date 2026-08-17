import type { PluginContext } from '../src/plugins/PluginContext.js';
import {
  DEFENSE_UNSET,
  openShared,
  readPosition,
} from '../src/native/rotmg-shared.js';
import { sendDllFeature } from '../src/bridge/DllFeatureBus.js';

/**
 * Auto-aim: enable/mode are driven over the DLL pipe.
 * Shared memory is only used for optional read-only telemetry like position polling.
 * Pushes defense and objectType from NEWTICK so native combat helpers use client-authoritative stats.
 */
export function register(ctx: PluginContext) {
  ctx.name = 'Auto Aim';
  ctx.category = 'combat';
  let loggedSharedOpen = false;
  let loggedBridgeTelemetry = false;

  let aimModeIdx = 0;
  function syncControlState() {
    sendDllFeature('autoAimMode', aimModeIdx);
    sendDllFeature('autoAimEnabled', ctx.enabled);
  }

  function syncProjectileNoclipState(forceOff = false) {
    sendDllFeature(
      'projectileNoclipEnabled',
      !forceOff && ctx.enabled && ctx.getSetting<boolean>('projectileNoclip') === true,
    );
  }

  ctx.registerSetting('aimMode', {
    label: 'Aim mode',
    type: 'select',
    value: 'player',
    options: [
      { label: 'Closest to player', value: 'player' },
      { label: 'Highest HP', value: 'hp' },
      { label: 'Closest to mouse', value: 'mouse' },
    ],
  }, (val: string) => {
    aimModeIdx = val === 'hp' ? 1 : val === 'mouse' ? 2 : 0;
    // #region agent log
    // #endregion
    syncControlState();
  });

  ctx.registerSetting('prioritizeBosses', {
    label: 'Prioritize bosses',
    type: 'boolean',
    value: false,
  }, (val: boolean) => {
    sendDllFeature('autoAimPrioritizeBosses', val);
  });

  ctx.registerSetting('ignoreWalls', {
    label: 'Ignore walls / no-HP-bar',
    type: 'boolean',
    value: true,
  }, (val: boolean) => {
    sendDllFeature('autoAimIgnoreWalls', val);
  });

  ctx.registerSetting('projectileNoclip', {
    label: 'Projectile noclip',
    type: 'boolean',
    value: false,
  }, () => {
    syncProjectileNoclipState();
  });

  ctx.onEnabledChange((enabled) => {
    syncControlState();
    syncProjectileNoclipState(!enabled);
  });

  let posTimer: ReturnType<typeof setInterval> | null = null;

  function syncAimModeIdx() {
    const m = ctx.getSetting<string>('aimMode');
    aimModeIdx = m === 'hp' ? 1 : m === 'mouse' ? 2 : 0;
  }

  function startPosPoll() {
    if (posTimer) return;
    posTimer = setInterval(() => {
      if (!ctx.enabled) return;
      const pos = readPosition();
      if (!pos) return;
      ctx.setData('internalPos', pos);
      ctx.broadcastData('internalPos', pos);
    }, 16);
  }

  function tryOpenTelemetry() {
    const opened = openShared();
    if (!loggedSharedOpen) {
      loggedSharedOpen = true;
      // #region agent log
      // #endregion
    }
    return opened;
  }

  ctx.hookPacket('NEWTICK', (client, packet) => {
    if (!packet.isDefined) return;
    const pd = client.playerData;
    const def = pd.defense + pd.defenseBonus;
    const cls = pd.classType ?? 0;
    syncControlState();
    if (!loggedBridgeTelemetry) {
      loggedBridgeTelemetry = true;
      // #region agent log
      // #endregion
    }
    if (!posTimer && tryOpenTelemetry()) startPosPoll();
    sendDllFeature('clientDefense', def);
    sendDllFeature('clientClassType', cls);
    // Server-authoritative SPD (base + bonus) for the DLL's dodge move budget.
    // The in-DLL SPD read broke on the 2026-08 layout shift; this is name/offset
    // independent. Clamped to a sane range so a transient bad tick can't poison it.
    const spd = pd.speed + pd.speedBonus;
    if (Number.isFinite(spd) && spd >= 0 && spd <= 200)
      sendDllFeature('clientSpeed', spd | 0);
  });

  function syncFilterState() {
    sendDllFeature('autoAimPrioritizeBosses', ctx.getSetting<boolean>('prioritizeBosses'));
    sendDllFeature('autoAimIgnoreWalls', ctx.getSetting<boolean>('ignoreWalls'));
  }

  ctx.on('clientConnected', () => {
    syncAimModeIdx();
    syncControlState();
    syncFilterState();
    syncProjectileNoclipState();
    if (tryOpenTelemetry()) startPosPoll();
  });
  ctx.on('clientDisconnected', () => {
    sendDllFeature('clientDefense', DEFENSE_UNSET);
    sendDllFeature('clientClassType', 0);
    syncProjectileNoclipState(true);
  });

  ctx.hookCommand('aa', (client, _cmd, args) => {
    if (args.length > 0) {
      const mode = args[0].toLowerCase();
      if (mode === 'player' || mode === 'p' || mode === 'close') {
        ctx.updateSetting('aimMode', 'player');
        ctx.sendNotification(client, ctx.name, 'Aim mode: Closest to player');
        return;
      } else if (mode === 'hp' || mode === 'health' || mode === 'h') {
        ctx.updateSetting('aimMode', 'hp');
        ctx.sendNotification(client, ctx.name, 'Aim mode: Highest HP');
        return;
      } else if (mode === 'mouse' || mode === 'cursor' || mode === 'm') {
        ctx.updateSetting('aimMode', 'mouse');
        ctx.sendNotification(client, ctx.name, 'Aim mode: Closest to mouse');
        return;
      }
    }
    ctx.enabled = !ctx.enabled;
    ctx.sendNotification(client, ctx.name, `Auto Aim ${ctx.enabled ? 'ON' : 'OFF'}`);
  });

  ctx.registerCleanup(() => {
    if (posTimer) {
      clearInterval(posTimer);
      posTimer = null;
    }
    sendDllFeature('autoAimEnabled', false);
    sendDllFeature('autoAimMode', 0);
    syncProjectileNoclipState(true);
    sendDllFeature('clientDefense', DEFENSE_UNSET);
    sendDllFeature('clientClassType', 0);
    // Do not unmap shared memory — auto-dodge / auto-ability may still be using it.
  });
}
