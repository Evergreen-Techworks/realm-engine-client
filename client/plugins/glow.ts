import type { PluginContext } from '../src/plugins/PluginContext.js';
import type { ClientConnection } from '../src/proxy/ClientConnection.js';

const STAT_GLOWING = 59;
const STAT_SUPPORTER = 99;
const RED_GLOW_VALUE = 100;
const PURPLE_GLOW_VALUE = 1;

type StatusStat = { id: number; value: number | string };
type ObjectStatus = { objectId?: number; data?: StatusStat[] };
type GlowMode = 'off' | 'red' | 'purple';

interface ClientGlowState {
  originalGlowing: number;
  originalSupporter: number;
  appliedMode: GlowMode;
}

function toInt(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}

function upsertStat(stats: StatusStat[], id: number, value: number): boolean {
  const existing = stats.find((stat) => stat.id === id);
  if (existing) {
    if (toInt(existing.value) === value) return false;
    existing.value = value;
    return true;
  }
  stats.push({ id, value });
  return true;
}

export function register(ctx: PluginContext) {
  ctx.name = 'Glow';
  ctx.category = 'visual';

  const clientState = new Map<ClientConnection, ClientGlowState>();

  function getClientState(client: ClientConnection): ClientGlowState {
    let state = clientState.get(client);
    if (!state) {
      state = { originalGlowing: 0, originalSupporter: 0, appliedMode: 'off' };
      clientState.set(client, state);
    }
    return state;
  }

  function getMode(): GlowMode {
    const enableGlow = !!ctx.getSetting<boolean>('enableGlow');
    const purpleGlow = !!ctx.getSetting<boolean>('purpleGlow');
    if (enableGlow) return 'red';
    if (purpleGlow) return 'purple';
    return 'off';
  }

  function rewriteStatus(client: ClientConnection, status: ObjectStatus | undefined): boolean {
    if (!status || Number(status.objectId) !== client.objectId) return false;

    const state = getClientState(client);
    const stats = Array.isArray(status.data) ? status.data : [];
    status.data = stats;

    for (const stat of stats) {
      if (stat.id === STAT_GLOWING) {
        state.originalGlowing = toInt(stat.value);
      } else if (stat.id === STAT_SUPPORTER) {
        state.originalSupporter = toInt(stat.value);
      }
    }

    const mode = getMode();
    if (mode === 'off' && state.appliedMode === 'off') {
      return false;
    }
    let changed = false;

    if (mode === 'red') {
      changed = upsertStat(stats, STAT_GLOWING, RED_GLOW_VALUE) || changed;
      changed = upsertStat(stats, STAT_SUPPORTER, state.originalSupporter) || changed;
    } else if (mode === 'purple') {
      changed = upsertStat(stats, STAT_GLOWING, state.originalGlowing) || changed;
      changed = upsertStat(
        stats,
        STAT_SUPPORTER,
        state.originalSupporter > 0 ? state.originalSupporter : PURPLE_GLOW_VALUE,
      ) || changed;
    } else {
      changed = upsertStat(stats, STAT_GLOWING, state.originalGlowing) || changed;
      changed = upsertStat(stats, STAT_SUPPORTER, state.originalSupporter) || changed;
    }

    state.appliedMode = mode;
    return changed;
  }

  ctx.registerSetting('enableGlow', {
    label: 'Enable Red Player Glow',
    type: 'boolean',
    value: true,
  });

  ctx.registerSetting('purpleGlow', {
    label: 'Purple Glow',
    type: 'boolean',
    value: false,
  });

  ctx.on('clientConnected', (client) => {
    clientState.set(client, { originalGlowing: 0, originalSupporter: 0, appliedMode: 'off' });
  });

  ctx.on('clientDisconnected', (client) => {
    clientState.delete(client);
  });

  ctx.hookPacket('UPDATE', (client, packet) => {
    if (!packet.isDefined || !Array.isArray(packet.data.newObjs)) return;

    let changed = false;
    for (const entity of packet.data.newObjs as Array<{ status?: ObjectStatus }>) {
      changed = rewriteStatus(client, entity.status) || changed;
    }

    if (changed) {
      packet.modified = true;
    }
  });

  ctx.hookPacket('NEWTICK', (client, packet) => {
    if (!packet.isDefined || !Array.isArray(packet.data.statuses)) return;

    let changed = false;
    for (const status of packet.data.statuses as ObjectStatus[]) {
      changed = rewriteStatus(client, status) || changed;
    }

    if (changed) {
      packet.modified = true;
    }
  });

  const handleGlowCommand = (client: any, _cmd: string, args: string[]) => {
    if (args.length > 0) {
      const mode = args[0].toLowerCase();
      if (mode === 'red' || mode === 'r') {
        ctx.updateSetting('enableGlow', true);
        ctx.updateSetting('purpleGlow', false);
        ctx.enabled = true;
        ctx.sendNotification(client, ctx.name, 'Glow: Red');
        return;
      } else if (mode === 'purple' || mode === 'p') {
        ctx.updateSetting('enableGlow', false);
        ctx.updateSetting('purpleGlow', true);
        ctx.enabled = true;
        ctx.sendNotification(client, ctx.name, 'Glow: Purple');
        return;
      }
    }
    ctx.enabled = !ctx.enabled;
    ctx.sendNotification(client, ctx.name, `Player Glow ${ctx.enabled ? 'ON' : 'OFF'}`);
  };

  ctx.hookCommand('gw', handleGlowCommand);
  ctx.hookCommand('gl', handleGlowCommand);
}
