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

// ── Burst guard ──────────────────────────────────────────────────────────────
// A fixed threshold only helps if some server health update lands between the
// threshold and zero. In the 2026-09-12 session all three deaths had their last
// confirmed HP just ABOVE the threshold (75/775 at 9%, 43/435 at 9%, 21/147 at
// 10%) and the next damage killed before another update arrived. The burst guard
// raises the escape point to the largest HP loss the server has CONFIRMED within
// one reaction window recently: if that much can land again before we can react,
// the current HP is not safe. It uses server HP only — no forecasts, client hit
// reports, defense reads or held packets.
/** Damage that can land before an escape can take effect: one server tick plus a round trip. */
const BURST_WINDOW_MS = 400;
/** How long an observed burst keeps the escape point raised. */
const BURST_MEMORY_MS = 6000;
/** The next burst can be larger than the largest one seen. */
const BURST_MARGIN = 1.25;
/** Never raise the escape point above this share of max HP. */
const BURST_GUARD_MAX_PCT = 50;

interface NexusState {
  hp: number | null;
  maxHp: number;
  healthAt: number | null;
  safe: boolean;
  escaped: boolean;
  retry: ReturnType<typeof setInterval> | null;
  /** Confirmed HP values from the last BURST_WINDOW_MS, oldest first. */
  samples: { at: number; hp: number; maxHp: number }[];
  /** Confirmed HP losses within one BURST_WINDOW_MS, from the last BURST_MEMORY_MS. */
  bursts: { at: number; loss: number }[];
}

export function register(ctx: PluginContext) {
  ctx.name = 'Auto Nexus';
  ctx.category = 'combat';
  let thresholdPct = 25;
  let showNotification = true;
  let retryCount = 4;
  let retryMs = 400;
  let burstGuard = true;
  let states = new WeakMap<ClientConnection, NexusState>();
  const timers = new Set<ReturnType<typeof setInterval>>();

  ctx.registerSetting('ForceAutoNexusHealth', {
    label: 'Nexus Health', type: 'range', value: thresholdPct, min: 0, max: 100, step: 1,
  }, (v: number) => {
    if (!Number.isFinite(v)) return;
    const next = Math.max(0, Math.min(100, v));
    // Logged because the startup line shows the code default before the saved
    // profile applies; without this the log cannot say which threshold was live.
    if (next !== thresholdPct) ctx.log(`Nexus threshold set to ${next}% HP (was ${thresholdPct}%)`);
    thresholdPct = next;
  });
  ctx.registerSetting('BurstGuard', {
    label: 'Burst guard (nexus earlier after big confirmed hits)', type: 'boolean', value: true,
  }, (v: boolean) => { burstGuard = v === true; });
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
      state = { hp: null, maxHp: 0, healthAt: null, safe: SAFE_ZONE_MAPS.has(
        String(client.playerData?.mapName ?? '').trim().toLowerCase()), escaped: false, retry: null,
        samples: [], bursts: [] };
      states.set(client, state);
    }
    return state;
  }
  function stopRetry(state: NexusState): void {
    if (state.retry) { clearInterval(state.retry); timers.delete(state.retry); state.retry = null; }
  }
  function reset(client: ClientConnection, safe: boolean): void {
    const state = stateFor(client); stopRetry(state);
    state.hp = null; state.maxHp = 0; state.healthAt = null; state.safe = safe; state.escaped = false;
    state.samples = []; state.bursts = [];
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
    const send = () => {
      try {
        const packet = ctx.createPacket('ESCAPE'); packet.modified = true;
        client.sendToServer(packet);
      } catch (error) {
        ctx.log(`ESCAPE send failed; bounded retries remain available: ${String(error)}`);
      }
    };
    send();
    // Notification failures must never prevent the first ESCAPE or its retries.
    if (showNotification) {
      try { ctx.sendNotification(client, 'AutoNexus', `${detail}\n${reason}`); }
      catch (error) { ctx.log(`Auto Nexus notification failed: ${String(error)}`); }
    }
    let remaining = retryCount;
    if (remaining <= 0) return;
    state.retry = setInterval(() => {
      if (!ctx.enabled || !client.connected || !state.escaped || remaining <= 0) { stopRetry(state); return; }
      send();
      if (--remaining <= 0) stopRetry(state);
    }, retryMs);
    timers.add(state.retry);
  }
  /** Record a newly confirmed HP value and any loss it completes within one reaction window. */
  function noteConfirmedHp(state: NexusState, now: number): void {
    if (state.hp === null || state.maxHp <= 0) return;
    // A max-HP change (gear, death, character) makes earlier values incomparable.
    state.samples = state.samples.filter(s => now - s.at <= BURST_WINDOW_MS && s.maxHp === state.maxHp);
    const peak = state.samples.reduce((best, s) => Math.max(best, s.hp), -Infinity);
    if (peak > state.hp) state.bursts.push({ at: now, loss: peak - state.hp });
    state.samples.push({ at: now, hp: state.hp, maxHp: state.maxHp });
    state.bursts = state.bursts.filter(b => now - b.at <= BURST_MEMORY_MS);
  }
  /** HP at or below which to escape now; `guarded` when the burst guard, not the threshold, set it. */
  function escapePoint(state: NexusState, now: number): { hp: number; burst: number; guarded: boolean } {
    const threshold = state.maxHp * thresholdPct / 100;
    const burst = state.bursts.reduce((best, b) => now - b.at <= BURST_MEMORY_MS ? Math.max(best, b.loss) : best, 0);
    // A threshold of 0 is a deliberate "only at zero"; the guard does not override it.
    if (!burstGuard || thresholdPct <= 0) return { hp: threshold, burst, guarded: false };
    const guarded = Math.min(burst * BURST_MARGIN, state.maxHp * BURST_GUARD_MAX_PCT / 100);
    return guarded > threshold ? { hp: guarded, burst, guarded: true } : { hp: threshold, burst, guarded: false };
  }
  function check(client: ClientConnection, state: NexusState, reason: string): void {
    if (!ctx.enabled || state.safe || state.escaped || state.hp === null || state.maxHp <= 0) return;
    const point = escapePoint(state, Date.now());
    if (state.hp > point.hp) return;
    escape(client, state, point.guarded
      ? `${reason}; burst guard: ${point.burst} HP lost within ${BURST_WINDOW_MS}ms in the last ${BURST_MEMORY_MS / 1000}s, escaping at <=${Math.round(point.hp)} HP`
      : reason);
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
      state.healthAt = Date.now();
      noteConfirmedHp(state, state.healthAt);
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
    state.healthAt = Date.now();
    noteConfirmedHp(state, state.healthAt);
    check(client, state, 'server-confirmed damage');
  });
  ctx.hookPacket('DEATH', (client, packet) => {
    if (!packet.isDefined) return;
    const state = stateFor(client);
    const now = Date.now();
    const age = state.healthAt === null ? 'unknown' : `${now - state.healthAt}ms`;
    const killer = String(packet.data.killedBy ?? 'unknown').replace(/[\r\n]/g, ' ').slice(0,120);
    const point = state.maxHp > 0 ? escapePoint(state, now) : { hp: 0, burst: 0, guarded: false };
    ctx.log(`DEATH diagnostic — killer=${killer}; confirmed HP=${state.hp ?? 'unknown'}/${state.maxHp}`
      + `; health evidence age=${age}; threshold=${thresholdPct}%`
      + `; burstGuard=${burstGuard ? `on (escape point ${Math.round(point.hp)} HP, largest recent burst ${point.burst})` : 'off'}`
      + `; enabled=${ctx.enabled}`
      + `; safe=${state.safe}; escapeRequested=${state.escaped}; mode=confirmed-health`);
    stopRetry(state); // death is final; repeated ESCAPE cannot recover the character
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
    ctx.sendNotification(client, 'AutoNexus', `Confirmed-health mode; nexus at ${thresholdPct}% HP; burst guard ${burstGuard ? 'on' : 'off'}`);
  });
  ctx.hookCommand('reset', (client) => {
    const state = stateFor(client);
    ctx.sendNotification(client, 'AutoNexus', `Confirmed HP ${state.hp ?? 'unknown'}/${state.maxHp}; no prediction ledger to reset`);
  });
  ctx.hookCommand('nexus', (client) => escape(client, stateFor(client), '/nexus command'));
  ctx.log(`Loaded — confirmed-health mode; default nexus at ${thresholdPct}% HP until the saved profile applies; burst guard default on; prediction disabled`);
}
