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

  ctx.on('clientConnected', (client) => {
    store.reset(client);
  });

  ctx.log(`Loaded ${catalog.size} lootable item defs across ${BAG_TYPES.size} bag types.`);
}
