/**
 * Auto Loot — automatically picks loot out of nearby bags based on tier / UT / ST
 * / potion rules, with quickslot stacking, optional stat-pot autodrink, a manual
 * potion guard, a bag-appeared notifier, and "big loot bags".
 *
 * Directory plugin: this `index.ts` is the entry point the loader discovers
 * (plugin id = folder name `auto-loot`). It wires the focused modules in this
 * folder together and registers the packet hooks; the actual logic lives in
 * those modules.
 */

import type { PluginContext } from '../api.js';
import { resolveInventoryAction } from '../api.js';
import { LootCatalog } from './catalog.js';
import { AutoLootSettings } from './settings.js';
import { StateStore } from './state.js';
import { LootRules } from './loot-rules.js';
import { BagScanner, registerBigBags } from './bags.js';
import { ManualPotionGuard } from './manual-potion-guard.js';
import { LootEngine } from './engine.js';
import { BAG_TYPES } from './constants.js';

export function register(ctx: PluginContext) {
  ctx.name = 'Auto Loot';
  ctx.category = 'automation';

  const catalog = new LootCatalog(ctx);

  const settings = new AutoLootSettings(ctx);
  settings.reloadLists();
  settings.register(catalog);

  const store = new StateStore();
  const rules = new LootRules(ctx, settings, catalog);
  const bags = new BagScanner(ctx, settings, catalog);
  const guard = new ManualPotionGuard(ctx, settings, store);
  const engine = new LootEngine(ctx, settings, catalog, store, rules, bags);

  registerBigBags(ctx, settings);

  // Manual potion guard: block/observe the player's own potion & quickslot packets.
  ctx.hookAllPackets((client, packet, fromClient) => {
    guard.handleOutgoingPacket(client, packet, fromClient);
  });

  ctx.hookPacket('NEWTICK', (client) => {
    engine.tryAutoLoot(client);
  });

  ctx.hookPacket('MAPINFO', (client) => {
    store.reset(client);
  });

  // Live evidence (2026-09-27): a rejected INVENTORYSWAP left the shared
  // inventory-action gate held for its full 5000ms fallback bound (nothing
  // client-side ever changes on a rejection, so the old read()-based settle
  // check never fired) — five seconds where a farmer pickup, an equip, and
  // Auto Loot's own retries of the exact same swap were all refused as
  // "inventory gate busy". Releasing the gate the moment the server answers
  // (success or rejection) fixes that without ever allowing two authoritative
  // inventory operations in flight at once.
  ctx.hookPacket('INVRESULT', (client, packet) => {
    if (!packet.isDefined) return;
    const fromSlot = packet.data.fromSlot as { objectId?: number; slotId?: number } | undefined;
    const toSlot = packet.data.toSlot as { objectId?: number; slotId?: number } | undefined;
    if (!fromSlot || !toSlot) return;
    resolveInventoryAction(client,
      { objectId: Number(fromSlot.objectId ?? -1), slotId: Number(fromSlot.slotId ?? -1) },
      { objectId: Number(toSlot.objectId ?? -1), slotId: Number(toSlot.slotId ?? -1) });
  });

  ctx.on('clientConnected', (client) => {
    store.reset(client);
  });

  ctx.log(`Loaded ${catalog.size} lootable item defs across ${BAG_TYPES.size} bag types.`);
}
