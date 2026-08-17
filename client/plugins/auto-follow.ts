import type { PluginContext } from '../src/plugins/PluginContext.js';
import { sendDllFeature } from '../src/bridge/DllFeatureBus.js';

/**
 * Auto Follow plugin.
 *
 * Follow is handled entirely inside the DLL: the dashboard only sends the
 * target name + active flag over IPC. The DLL resolves the entity each frame
 * and feeds DangerPlanner::SetExternalGoal, so XDodge's A* pursues the target
 * AND dodges projectiles in one motion (movement + dodging at all times).
 *
 * There is intentionally NO client-side movement here — no WASD/background-key
 * injection, no dogebawt memory writes, no pathfinding. Any such injection
 * fights the DLL's NativeMoveTo and causes the teleport/stutter behaviour.
 */
export function register(ctx: PluginContext) {
  ctx.name = 'Auto Follow';

  let followName = '';

  function pushState(): void {
    const active = ctx.enabled && followName.length > 0;
    sendDllFeature('followEntityName', followName);
    sendDllFeature('followEntityActive', active);
  }

  ctx.registerSetting('followName', {
    label: 'Follow Player',
    type: 'text',
    value: followName,
  }, (val: string) => {
    followName = (val || '').trim();
    ctx.log(followName ? `Follow target set: "${followName}"` : 'Follow disabled');
    pushState();
  });

  ctx.onEnabledChange(() => pushState());

  // Re-assert state whenever the DLL (re)connects so a fresh session picks up
  // the current target. The bridge also replays feature state on reconnect,
  // but sending here keeps the dashboard and DLL in sync deterministically.
  ctx.on('clientConnected', () => pushState());
  ctx.on('clientDisconnected', () => {
    // Session is ending; make sure follow doesn't resume unexpectedly.
    sendDllFeature('followEntityActive', false);
  });

  ctx.hookCommand('af', (client, _cmd, args) => {
    if (args.length > 0) {
      followName = args.join(' ').trim();
      ctx.updateSetting('followName', followName);
      ctx.enabled = true;
      pushState();
      ctx.sendNotification(client, ctx.name, `Following player: ${followName}`);
      return;
    }
    ctx.enabled = !ctx.enabled;
    pushState();
    ctx.sendNotification(client, ctx.name, `Auto Follow ${ctx.enabled ? 'ON' : 'OFF'}${followName ? ` (${followName})` : ''}`);
  });

  ctx.log('Loaded - /af [player] or set "Follow Player" in dashboard.');
}
