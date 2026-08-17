import type { PluginContext } from '../api.js';
import type { ClientConnection } from '../api.js';
import { SAFE_ZONE_MAPS, BELT_SLOT_BASE, clampPct } from './constants.js';
import { loadPotIds } from './catalog.js';
import { findBeltSlot, findInventorySlot } from './slots.js';
import { sendUseItem } from './useitem.js';

/**
 * Auto Drink — autopot from potion belt (slot 1000000+i) + inventory (slots 4-11).
 *
 * Drinks HP/MP pots when current health/mana drops below configurable thresholds.
 * Tries the potion belt first (since belt pots are a stack), falling back to
 * inventory pots.
 *
 * This is the client's single autopot (auto-nexus only escapes, it no longer
 * drinks). The configured HP threshold is used as-is; if auto-nexus's threshold
 * is set at or above it, the dashboard flags the setting (red label + alert) via
 * the `warnWhen` on the HP threshold setting, but nothing is auto-adjusted.
 *
 * Directory plugin: this `index.ts` is the entry point the loader discovers
 * (plugin id = folder name `auto-drink`). The core features live alongside it in
 * focused modules — `catalog` (pot ids), `slots` (belt/inventory lookup),
 * `useitem` (the USEITEM packet), `guard` (nexus threshold floor), `constants`.
 */

interface AutoDrinkState {
  lastHpDrinkAt: number;
  lastMpDrinkAt: number;
}

export function register(ctx: PluginContext) {
  ctx.name = 'Auto Drink';
  ctx.category = 'automation';

  const { hpPots, mpPots } = loadPotIds(ctx);
  const states = new WeakMap<ClientConnection, AutoDrinkState>();

  let enableHp = true;
  let enableMp = true;
  let hpThresholdPct = 70;
  let mpThresholdPct = 50;
  let drinkCooldownMs = 350;
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
  ctx.registerSetting('drinkCooldownMs', {
    label: 'Drink cooldown (ms)', type: 'number', value: drinkCooldownMs, min: 150, max: 2000, step: 50,
  }, (v: number) => { drinkCooldownMs = Math.max(150, Math.min(2000, Math.trunc(Number(v) || 350))); });
  ctx.registerSetting('preferBelt', { label: 'Prefer potion belt', type: 'boolean', value: preferBelt },
    (v: boolean) => { preferBelt = v === true; });

  function getState(client: ClientConnection): AutoDrinkState {
    let s = states.get(client);
    if (!s) {
      s = { lastHpDrinkAt: 0, lastMpDrinkAt: 0 };
      states.set(client, s);
    }
    return s;
  }

  function inSafeZone(client: ClientConnection): boolean {
    return SAFE_ZONE_MAPS.has(client.playerData.mapName);
  }

  function tryDrink(
    client: ClientConnection,
    state: AutoDrinkState,
    enabled: boolean,
    cur: number,
    max: number,
    thresholdPct: number,
    idSet: Set<number>,
    lastKey: 'lastHpDrinkAt' | 'lastMpDrinkAt',
    label: string,
  ): boolean {
    if (!enabled || max <= 0 || idSet.size === 0) return false;
    if ((cur / max) * 100 > thresholdPct) return false;

    const now = Date.now();
    if (now - state[lastKey] < drinkCooldownMs) return false;

    const found = preferBelt
      ? (findBeltSlot(client, idSet) ?? findInventorySlot(client, idSet))
      : (findInventorySlot(client, idSet) ?? findBeltSlot(client, idSet));
    if (!found) return false;

    sendUseItem(ctx, client, found.slotId, found.itemType);
    state[lastKey] = now;
    const where = found.slotId >= BELT_SLOT_BASE ? `belt[${found.slotId - BELT_SLOT_BASE}]` : `inv[${found.slotId}]`;
    ctx.log(`Drink ${label} from ${where}`);
    return true;
  }

  ctx.hookPacket('NEWTICK', (client) => {
    if (!ctx.enabled) return;
    if (!client?.connected || !client.objectId) return;
    if (inSafeZone(client)) return;

    const pd = client.playerData;
    const state = getState(client);

    // maxHealth/maxMana are the gearless base; add the gear bonus for the true max
    // (matches auto-nexus) so the % matches the in-game HP/MP bar.
    tryDrink(client, state, enableHp, pd.health, pd.maxHealth + pd.healthBonus, hpThresholdPct, hpPots, 'lastHpDrinkAt', 'HP');
    tryDrink(client, state, enableMp, pd.mana, pd.maxMana + pd.manaBonus, mpThresholdPct, mpPots, 'lastMpDrinkAt', 'MP');
  });

  ctx.hookPacket('MAPINFO', (client) => {
    const s = getState(client);
    s.lastHpDrinkAt = 0;
    s.lastMpDrinkAt = 0;
  });

  ctx.log(`Loaded ${hpPots.size} HP pot ids, ${mpPots.size} MP pot ids.`);
}
