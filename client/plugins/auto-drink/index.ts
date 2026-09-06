import type { PluginContext, ClientConnection } from '../api.js';
import { SAFE_ZONE_MAPS, BELT_SLOT_BASE, FALLBACK_POT_AMOUNT, clampPct } from './constants.js';
import { loadPotIds } from './catalog.js';
import { findSlots } from './slots.js';
import { sendUseItem } from './useitem.js';

/**
 * Auto Drink — autopot from potion belt (slot 1000000+i) + inventory (slots 4-11).
 *
 * Drinks HP/MP pots when current health/mana drops below configurable thresholds.
 * Tries the potion belt first (since belt pots are a stack), falling back to
 * inventory pots.
 *
 * Two things decide whether this saves a character or not:
 *
 *  - Volume. One pot per server tick is ~5 pots/sec at best, and a single pot is
 *    a small slice of a geared character's HP. Each pass sizes the burst from the
 *    actual HP deficit and the potion's own `<Activate amount>`, so a deep hit is
 *    answered with as many pots as it takes rather than one.
 *  - Latency. Server HP only refreshes on NEWTICK, so a tick-driven plugin can be
 *    a full 200 ms late. A short poll runs alongside NEWTICK, and pots already
 *    sent are tracked locally (with a TTL) so the poll credits them instead of
 *    re-drinking.
 *
 * This is the client's single autopot (auto-nexus only escapes, it no longer
 * drinks). The configured HP threshold is used as-is; if auto-nexus's threshold
 * is set at or above it, the dashboard flags the setting (red label + alert) via
 * the `warnWhen` on the HP threshold setting, but nothing is auto-adjusted.
 *
 * Directory plugin: this `index.ts` is the entry point the loader discovers
 * (plugin id = folder name `auto-drink`). The core features live alongside it in
 * focused modules: `catalog` (pot ids + restore amounts), `slots` (belt/bag
 * lookup), `useitem` (the USEITEM packet), `constants`.
 */

/** A pot already sent whose heal the server has not reported back yet. */
interface InFlightHeal {
  amount: number;
  at: number;
}

interface AutoDrinkState {
  lastHpDrinkAt: number;
  lastMpDrinkAt: number;
  inFlightHp: InFlightHeal[];
  inFlightMp: InFlightHeal[];
  /** Timestamps of USEITEMs sent in the last second, for the send-rate ceiling. */
  recentSends: number[];
}

/** How long a sent pot counts toward predicted HP before it is assumed lost. */
const IN_FLIGHT_TTL_MS = 1000;
/** Floor between drinks even in panic, so the poll cannot machine-gun USEITEMs. */
const PANIC_MIN_GAP_MS = 80;
/** Poll period. Fast enough to beat the ~200 ms server tick, cheap enough to run always. */
const POLL_MS = 60;
/** Refill target sits this far above the threshold so we do not hover on the line. */
const REFILL_HEADROOM_PCT = 15;
/**
 * Hard ceiling on USEITEMs per second across HP and MP combined. The in-flight
 * ledger already stops a burst from repeating while pots are landing, but a
 * flood of USEITEM is what the server closes the connection over, so this bounds
 * the case where the drinks are sent and never take effect.
 */
const MAX_USEITEMS_PER_SEC = 8;

export function register(ctx: PluginContext) {
  ctx.name = 'Auto Drink';
  ctx.category = 'automation';

  const { hpPots, mpPots, amounts } = loadPotIds(ctx);
  const states = new WeakMap<ClientConnection, AutoDrinkState>();

  let enableHp = true;
  let enableMp = true;
  let hpThresholdPct = 70;
  let mpThresholdPct = 50;
  let hpPanicPct = 35;
  let drinkCooldownMs = 350;
  let maxBurst = 3;
  let preferBelt = true;

  ctx.registerSetting('enableHp', { label: 'Drink HP pots', type: 'boolean', value: enableHp },
    (v: boolean) => { enableHp = v === true; });
  ctx.registerSetting('enableMp', { label: 'Drink MP pots', type: 'boolean', value: enableMp },
    (v: boolean) => { enableMp = v === true; });
  ctx.registerSetting('hpThresholdPct', {
    label: 'HP threshold %', type: 'range', value: hpThresholdPct, min: 10, max: 95, step: 5,
    warnWhen: {
      pluginId: 'auto-nexus',
      key: 'ForceAutoNexusHealth',
      cmp: 'gte',
      message: 'Auto Nexus % is at or above Auto Drink % — you may nexus before a pot can heal you. Set Auto Nexus % below Auto Drink %.',
    },
  }, (v: number) => { hpThresholdPct = clampPct(v); });
  ctx.registerSetting('mpThresholdPct', {
    label: 'MP threshold %', type: 'range', value: mpThresholdPct, min: 10, max: 95, step: 5,
  }, (v: number) => { mpThresholdPct = clampPct(v); });
  ctx.registerSetting('hpPanicPct', {
    label: 'HP panic % (ignore cooldown)', type: 'range', value: hpPanicPct, min: 0, max: 90, step: 5,
  }, (v: number) => { hpPanicPct = Math.max(0, Math.min(90, Math.trunc(Number(v) || 0))); });
  ctx.registerSetting('maxBurst', {
    label: 'Max pots per pass', type: 'range', value: maxBurst, min: 1, max: 6, step: 1,
  }, (v: number) => { maxBurst = Math.max(1, Math.min(6, Math.trunc(Number(v) || 1))); });
  ctx.registerSetting('drinkCooldownMs', {
    label: 'Drink cooldown (ms)', type: 'number', value: drinkCooldownMs, min: 150, max: 2000, step: 50,
  }, (v: number) => { drinkCooldownMs = Math.max(150, Math.min(2000, Math.trunc(Number(v) || 350))); });
  ctx.registerSetting('preferBelt', { label: 'Prefer potion belt', type: 'boolean', value: preferBelt },
    (v: boolean) => { preferBelt = v === true; });

  function getState(client: ClientConnection): AutoDrinkState {
    let s = states.get(client);
    if (!s) {
      s = { lastHpDrinkAt: 0, lastMpDrinkAt: 0, inFlightHp: [], inFlightMp: [], recentSends: [] };
      states.set(client, s);
    }
    return s;
  }

  function inSafeZone(client: ClientConnection): boolean {
    return SAFE_ZONE_MAPS.has(client.playerData.mapName);
  }

  /** USEITEMs still inside the one-second send window. */
  function sendBudget(state: AutoDrinkState): number {
    const cutoff = Date.now() - 1000;
    let expired = 0;
    while (expired < state.recentSends.length && state.recentSends[expired] <= cutoff) expired++;
    if (expired > 0) state.recentSends.splice(0, expired);
    return MAX_USEITEMS_PER_SEC - state.recentSends.length;
  }

  /** Total heal still credited to pots the server has not confirmed. */
  function inFlightTotal(list: InFlightHeal[]): number {
    const cutoff = Date.now() - IN_FLIGHT_TTL_MS;
    let expired = 0;
    while (expired < list.length && list[expired].at <= cutoff) expired++;
    if (expired > 0) list.splice(0, expired);
    let total = 0;
    for (const h of list) total += h.amount;
    return total;
  }

  function tryDrink(
    client: ClientConnection,
    state: AutoDrinkState,
    enabled: boolean,
    serverCur: number,
    max: number,
    thresholdPct: number,
    panicPct: number,
    idSet: Set<number>,
    inFlight: InFlightHeal[],
    lastKey: 'lastHpDrinkAt' | 'lastMpDrinkAt',
    label: string,
  ): boolean {
    if (!enabled || max <= 0 || idSet.size === 0) return false;

    const cur = Math.min(max, serverCur + inFlightTotal(inFlight));
    const pct = (cur / max) * 100;
    if (pct > thresholdPct) return false;

    const now = Date.now();
    const panic = pct <= panicPct;
    const minGap = panic ? PANIC_MIN_GAP_MS : drinkCooldownMs;
    if (now - state[lastKey] < minGap) return false;

    const targetPct = Math.min(100, thresholdPct + REFILL_HEADROOM_PCT);
    const deficit = (max * targetPct) / 100 - cur;
    if (deficit <= 0) return false;

    const budget = Math.min(maxBurst, sendBudget(state));
    if (budget <= 0) return false;

    const slots = findSlots(client, idSet, budget, preferBelt);
    if (slots.length === 0) return false;

    let healed = 0;
    let used = 0;
    for (const found of slots) {
      if (healed >= deficit) break;
      sendUseItem(ctx, client, found.slotId, found.itemType);
      state.recentSends.push(now);
      const amount = amounts.get(found.itemType) ?? FALLBACK_POT_AMOUNT;
      inFlight.push({ amount, at: now });
      healed += amount;
      used++;
    }
    if (used === 0) return false;

    state[lastKey] = now;
    const first = slots[0];
    const where = first.slotId >= BELT_SLOT_BASE
      ? `belt[${first.slotId - BELT_SLOT_BASE}]`
      : `inv[${first.slotId}]`;
    ctx.log(`Drink ${used}x ${label} from ${where}${panic ? ' (panic)' : ''}`
      + ` at ${Math.round(cur)}/${max} (${Math.round(pct)}%)`);
    return true;
  }

  function evaluate(client: ClientConnection | null): void {
    if (!ctx.enabled) return;
    if (!client?.connected || !client.objectId) return;
    if (inSafeZone(client)) return;

    const pd = client.playerData;
    const state = getState(client);

    tryDrink(client, state, enableHp, pd.health, pd.effectiveMaxHealth,
      hpThresholdPct, hpPanicPct, hpPots, state.inFlightHp, 'lastHpDrinkAt', 'HP');
    // MP gets no panic tier: running dry costs an ability, not the character.
    tryDrink(client, state, enableMp, pd.mana, pd.effectiveMaxMana,
      mpThresholdPct, -1, mpPots, state.inFlightMp, 'lastMpDrinkAt', 'MP');
  }

  let activeClient: ClientConnection | null = null;

  ctx.hookPacket('NEWTICK', (client) => {
    activeClient = client;
    evaluate(client);
  });

  const pollTimer = setInterval(() => {
    try { evaluate(activeClient); } catch (err) { ctx.log(`poll failed: ${(err as Error).message}`); }
  }, POLL_MS);
  ctx.registerCleanup(() => clearInterval(pollTimer));

  ctx.on('clientDisconnected', (client) => {
    if (activeClient === client) activeClient = null;
  });

  ctx.hookPacket('MAPINFO', (client) => {
    const s = getState(client);
    s.lastHpDrinkAt = 0;
    s.lastMpDrinkAt = 0;
    s.inFlightHp.length = 0;
    s.inFlightMp.length = 0;
    s.recentSends.length = 0;
  });

  ctx.log(`Loaded ${hpPots.size} HP pot ids, ${mpPots.size} MP pot ids, ${amounts.size} restore amounts.`);
}
