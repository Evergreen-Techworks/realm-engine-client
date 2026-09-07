import type { PluginContext, ClientConnection, Packet } from './api.js';
import { sendDllFeature, StatType } from './api.js';

// Auto Nexus reacts only to server health and server-confirmed damage. Client
// collision reports, projectile forecasts, AoE geometry and guessed regeneration
// cannot charge HP or trigger an escape.
const SAFE_ZONE_MAPS = new Set([
  'Nexus', 'Vault',
  'Guild Hall', 'Guild Hall 2', 'Guild Hall 3', 'Guild Hall 4', 'Guild Hall 5',
  'Cloth Bazaar', 'Nexus Explanation', 'Vault Explanation', 'Guild Explanation',
  'Daily Quest Room', 'Daily Login Room',
  'Pet Yard', 'Pet Yard 2', 'Pet Yard 3', 'Pet Yard 4', 'Pet Yard 5',
].map(name => name.toLowerCase()));

interface NexusState {
  hp: number | null;
  maxHp: number;
  safe: boolean;
  escaped: boolean;
  retry: ReturnType<typeof setInterval> | null;
}

export function register(ctx: PluginContext) {
  ctx.name = 'Auto Nexus';
  ctx.category = 'combat';
  let thresholdPct = 25;
  let showNotification = true;
  let retryCount = 4;
  let retryMs = 400;
  let states = new WeakMap<ClientConnection, NexusState>();
  const timers = new Set<ReturnType<typeof setInterval>>();

  ctx.registerSetting('ForceAutoNexusHealth', {
    label: 'Nexus Health', type: 'range', value: thresholdPct, min: 0, max: 100, step: 1,
  }, (v: number) => { if (Number.isFinite(v)) thresholdPct = Math.max(0, Math.min(100, v)); });
  ctx.registerSetting('ShowChatMessageOnNexus', {
    label: 'Show Chat Message on Nexus', advanced: true, type: 'boolean', value: true,
  }, (v: boolean) => { showNotification = v === true; });
  ctx.registerSetting('EscapeRetryCount', {
    label: 'Escape Retries', advanced: true, type: 'range', value: 4, min: 0, max: 10, step: 1,
  }, (v: number) => { retryCount = Math.max(0, Math.min(10, Math.trunc(Number(v) || 0))); });
  ctx.registerSetting('EscapeRetryIntervalMs', {
    label: 'Escape Retry Interval', advanced: true, type: 'range', value: 400, min: 100, max: 2000, step: 50,
  }, (v: number) => { retryMs = Math.max(100, Math.min(2000, Math.trunc(Number(v) || 400))); });

  // Native Auto Nexus publishes forecasts; it does not send ESCAPE itself.
  // Disarm its scanner too, including when old settings are restored on startup.
  function disableForecasts(): void {
    sendDllFeature('autoNexusEnabled', false);
    sendDllFeature('autoNexusProjPredict', false);
    sendDllFeature('autoNexusTilePredict', false);
    sendDllFeature('autoNexusDebugDraw', false);
  }
  disableForecasts();
  ctx.onEnabledChange(() => {
    disableForecasts();
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    states = new WeakMap(); // re-enable must not reuse health from before the pause
  });
  ctx.on('clientConnected', disableForecasts);
  ctx.registerCleanup(() => {
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    disableForecasts();
  });

  function stateFor(client: ClientConnection): NexusState {
    let state = states.get(client);
    if (!state) {
      state = { hp: null, maxHp: 0, safe: SAFE_ZONE_MAPS.has(
        String(client.playerData?.mapName ?? '').trim().toLowerCase()), escaped: false, retry: null };
      states.set(client, state);
    }
    return state;
  }
  function stopRetry(state: NexusState): void {
    if (state.retry) { clearInterval(state.retry); timers.delete(state.retry); state.retry = null; }
  }
  function reset(client: ClientConnection, safe: boolean): void {
    const state = stateFor(client); stopRetry(state);
    state.hp = null; state.maxHp = 0; state.safe = safe; state.escaped = false;
  }
  ctx.on('clientDisconnected', client => { stopRetry(stateFor(client)); states.delete(client); });
  ctx.hookPacket('MAPINFO', (client, packet) => {
    if (!packet.isDefined) return;
    reset(client, SAFE_ZONE_MAPS.has(String(packet.data.name ?? '').trim().toLowerCase()));
    disableForecasts();
  });
  ctx.hookPacket('CREATESUCCESS', client => { reset(client, stateFor(client).safe); });

  function escape(client: ClientConnection, state: NexusState, reason: string): void {
    if (state.escaped || !client.connected) return;
    state.escaped = true;
    const detail = `Confirmed HP ${state.hp ?? 'unknown'}/${state.maxHp}; threshold ${thresholdPct}%`;
    ctx.log(`AUTO NEXUS — ${detail} — ${reason}`);
    if (showNotification) ctx.sendNotification(client, 'AutoNexus', `${detail}\n${reason}`);
    const send = () => {
      const packet = ctx.createPacket('ESCAPE'); packet.modified = true;
      client.sendToServer(packet);
    };
    send();
    let remaining = retryCount;
    if (remaining <= 0) return;
    state.retry = setInterval(() => {
      if (!ctx.enabled || !client.connected || !state.escaped || remaining <= 0) { stopRetry(state); return; }
      send();
      if (--remaining <= 0) stopRetry(state);
    }, retryMs);
    timers.add(state.retry);
  }
  function check(client: ClientConnection, state: NexusState, reason: string): void {
    if (!ctx.enabled || state.safe || state.escaped || state.hp === null || state.maxHp <= 0) return;
    if (state.hp <= state.maxHp * thresholdPct / 100) escape(client, state, reason);
  }
  function syncMaxHp(client: ClientConnection, state: NexusState): void {
    const max = client.playerData.effectiveMaxHealth;
    if (Number.isFinite(max) && max > 0) state.maxHp = max;
  }
  function statusHealth(client: ClientConnection, packet: Packet, statuses: any[]): void {
    if (!packet.isDefined) return;
    const state = stateFor(client);
    syncMaxHp(client, state);
    const own = statuses.find(status => status?.objectId === client.objectId);
    const hpStat = own?.data?.find((stat: any) => stat.id === StatType.HP);
    if (hpStat && typeof hpStat.value === 'number' && Number.isFinite(hpStat.value)) {
      state.hp = Math.max(0, hpStat.value);
    } else if (state.hp === null && Number.isFinite(client.playerData.health) && client.playerData.health > 0) {
      // Hot reload can begin between full HP updates. Seed once from the last
      // server HP; delta ticks without HP must not undo confirmed DAMAGE.
      state.hp = client.playerData.health;
    }
    check(client, state, 'server health update');
  }
  // These hooks run after StateManager so effective max HP includes gear/exalts.
  // Read HP from the packet itself; do not replace a confirmed zero with max HP.
  ctx.hookPacket('NEWTICK', (client, packet) => {
    statusHealth(client, packet, packet.data.statuses ?? []);
  });
  ctx.hookPacket('UPDATE', (client, packet) => {
    statusHealth(client, packet, (packet.data.newObjs ?? []).map((o: any) => o.status));
  });
  ctx.hookPacket('DAMAGE', (client, packet) => {
    if (!packet.isDefined || packet.data.targetId !== client.objectId) return;
    const state = stateFor(client); syncMaxHp(client, state);
    if (state.hp === null && Number.isFinite(client.playerData.health) && client.playerData.health > 0) state.hp = client.playerData.health;
    if (packet.data.kill === true) {
      state.hp = 0;
    } else {
      const damage = packet.data.damageAmount;
      if (typeof damage !== 'number' || !Number.isFinite(damage) || damage <= 0 || state.hp === null) return;
      state.hp = Math.max(0, state.hp - damage);
    }
    check(client, state, 'server-confirmed damage');
  });
  // Never suppress server packets or hold outgoing hit reports. A DEATH packet
  // is still delivered normally; no prediction can turn it into a saved life.

  ctx.hookCommand('an', (client, _cmd, args) => {
    if (args.length) {
      const value = Number(args[0]);
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        ctx.sendNotification(client, 'AutoNexus', 'Usage: /an [0-100]'); return;
      }
      thresholdPct = value;
      ctx.updateSetting('ForceAutoNexusHealth', value);
    }
    ctx.sendNotification(client, 'AutoNexus', `Confirmed-health mode; nexus at ${thresholdPct}% HP`);
  });
  ctx.hookCommand('reset', (client) => {
    const state = stateFor(client);
    ctx.sendNotification(client, 'AutoNexus', `Confirmed HP ${state.hp ?? 'unknown'}/${state.maxHp}; no prediction ledger to reset`);
  });
  ctx.hookCommand('nexus', (client) => escape(client, stateFor(client), '/nexus command'));
  ctx.log(`Loaded — confirmed-health mode; nexus at ${thresholdPct}% HP; prediction disabled`);
}
