import type { PluginContext } from '../src/plugins/PluginContext.js';
import { sendDllFeature } from '../src/bridge/DllFeatureBus.js';

export function register(ctx: PluginContext) {
  ctx.name = 'Camera Controls';
  ctx.category = 'visual';

  let lockZoom = false;
  let zoomValue = 8;
  let lockAngle = false;
  let angleValue = 0;
  let lockCentering = false;
  let centeredOnPlayer = true;

  function flush(forceOff = false) {
    sendDllFeature('cameraZoomActive', !forceOff && ctx.enabled && lockZoom);
    sendDllFeature('cameraZoomValue', zoomValue);
    sendDllFeature('cameraAngleActive', !forceOff && ctx.enabled && lockAngle);
    sendDllFeature('cameraAngleValue', angleValue);
    sendDllFeature('cameraCenteringActive', !forceOff && ctx.enabled && lockCentering);
    sendDllFeature('cameraCentered', centeredOnPlayer);
  }

  ctx.registerSetting('lockZoom', {
    label: 'Lock zoom',
    type: 'boolean',
    value: lockZoom,
  }, (val: boolean) => {
    lockZoom = val;
    flush();
  });

  ctx.registerSetting('zoomValue', {
    label: 'Zoom value',
    type: 'range',
    value: zoomValue,
    min: 0.5,
    max: 20,
    step: 0.1,
  }, (val: number) => {
    zoomValue = val;
    flush();
  });

  ctx.registerSetting('lockAngle', {
    label: 'Lock angle',
    type: 'boolean',
    value: lockAngle,
  }, (val: boolean) => {
    lockAngle = val;
    flush();
  });

  ctx.registerSetting('angleValue', {
    label: 'Angle (degrees)',
    type: 'number',
    value: angleValue,
  }, (val: number) => {
    angleValue = Math.trunc(val);
    flush();
  });

  ctx.registerSetting('lockCentering', {
    label: 'Force centering mode',
    type: 'boolean',
    value: lockCentering,
  }, (val: boolean) => {
    lockCentering = val;
    flush();
  });

  ctx.registerSetting('centeredOnPlayer', {
    label: 'Center on player',
    type: 'boolean',
    value: centeredOnPlayer,
  }, (val: boolean) => {
    centeredOnPlayer = val;
    flush();
  });

  ctx.onEnabledChange((enabled) => {
    flush(!enabled);
  });
  ctx.on('clientConnected', () => {
    flush();
  });
  ctx.on('clientDisconnected', () => {
    flush(true);
  });

  ctx.hookCommand('cc', (client, _cmd, args) => {
    if (args.length > 0) {
      const val = parseFloat(args[0]);
      if (!isNaN(val) && val >= 0.5 && val <= 20) {
        zoomValue = val;
        ctx.updateSetting('zoomValue', val);
        lockZoom = true;
        ctx.updateSetting('lockZoom', true);
        ctx.enabled = true;
        flush();
        ctx.sendNotification(client, ctx.name, `Camera zoom set to ${val.toFixed(1)}`);
        return;
      }
    }
    lockZoom = !lockZoom;
    ctx.updateSetting('lockZoom', lockZoom);
    flush();
    ctx.sendNotification(client, ctx.name, `Camera Zoom Lock ${lockZoom ? 'ON' : 'OFF'}`);
  });

  ctx.registerCleanup(() => {
    flush(true);
  });
}
