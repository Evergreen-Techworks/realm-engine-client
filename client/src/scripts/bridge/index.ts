import { BridgeSelf } from './self/Self.js';
import { BridgeWalking } from './walking/Walking.js';
import { BridgeDodge } from './dodge/Dodge.js';
import { MovementController } from './movement/MovementController.js';
import { BridgeCombat } from './combat/Combat.js';
import { BridgePlayers } from './players/Players.js';
import { BridgeEnemies } from './enemies/Enemies.js';
import { BridgeInventory } from './inventory/Inventory.js';
import { BridgeVault } from './vault/Vault.js';
import { BridgeVaultChest } from './vault/VaultChest.js';
import { BridgeGiftChest } from './vault/GiftChest.js';
import { BridgeWorld } from './world/World.js';
import { BridgeTiles } from './world/tiles/Tiles.js';
import { BridgeObjects } from './world/objects/Objects.js';
import { BridgeProjectiles } from './world/projectiles/Projectiles.js';
import { BridgeLog } from './log/Log.js';
import { BridgeSettings } from './settings/Settings.js';
import { BridgeTiming } from './timing/Timing.js';
import { install as installChat } from './chat/index.js';
import { install as installParty } from './party/index.js';
import { install as installTrade } from './trade/index.js';
import { install as installEvents } from './events/index.js';
import { install as installInventoryNs } from './inventory/index.js';
import { install as installLoot } from './loot/index.js';
import { install as installDiscord } from './discord/index.js';
import { install as installGuild } from './guild/index.js';
import { installScriptUiBridge } from './scriptUi/ScriptUi.js';
import type { ScriptPanelRegistry } from './scriptUi/ScriptPanels.js';
import type { BridgeDeps } from './BridgeDeps.js';
import {
  chat, party, trade, events, inventory, guild, GuildRank,
  INVENTORY_MAIN_SLOT_COUNT, INVENTORY_BACKPACK_SLOT_COUNT, INVENTORY_TOTAL_SLOT_COUNT,
  loot, discord, DiscordWebhook,
  Self, Walking, Combat, Players, Enemies, Inventory, Vault, World, Tiles, Objects, Projectiles, Dodge,
  Log, Settings, Timing, RealmEngine, Position, StatusEffect, Panel, uiPanel,
  TreeScript, Root, Branch, Leaf, leaf, branch, when, not, always, cooldown, once, sequence, parallel,
} from '@realmengine/sdk';

export type { BridgeDeps, ScriptLogLevel } from './BridgeDeps.js';
export type { ScriptPanelRegistry } from './scriptUi/ScriptPanels.js';

export class SDKBridge {
  static panelRegistry: ScriptPanelRegistry | undefined;

  static install(deps: BridgeDeps): void {
    const movement = new MovementController(deps);
    BridgeVaultChest.install(deps);
    BridgeGiftChest.install(deps);
    BridgeVault.install(deps);

    BridgeSelf.install(deps);
    BridgeWalking.install(deps, movement);
    BridgeDodge.install(movement);
    BridgeCombat.install(deps);
    BridgePlayers.install(deps);
    BridgeEnemies.install(deps);
    BridgeInventory.install(deps);
    BridgeWorld.install(deps);
    BridgeTiles.install(deps);
    BridgeObjects.install(deps);
    BridgeProjectiles.install(deps);
    BridgeLog.install(deps);
    BridgeSettings.install(deps);
    BridgeTiming.install(deps);
    installChat(deps);
    installParty(deps);
    installTrade(deps);
    installEvents(deps);
    installInventoryNs(deps);
    installLoot(deps);
    installDiscord(deps);
    installGuild(deps);

    // Expose all patched SDK exports via globalThis so user scripts importing
    // @realmengine/sdk from the deployed Documents stub get the live patched objects.
    (globalThis as any).__realmengineSDK = {
      chat, party, trade, events, inventory,
      INVENTORY_MAIN_SLOT_COUNT, INVENTORY_BACKPACK_SLOT_COUNT, INVENTORY_TOTAL_SLOT_COUNT,
      loot, discord, DiscordWebhook, guild, GuildRank,
      Self, Walking, Combat, Players, Enemies, Inventory, Vault, World, Tiles, Objects, Projectiles, Dodge,
      Log, Settings, Timing, RealmEngine, Position, StatusEffect, Panel, uiPanel,
      TreeScript, Root, Branch, Leaf, leaf, branch, when, not, always, cooldown, once, sequence, parallel,
    };

    SDKBridge.panelRegistry = installScriptUiBridge(deps);
  }
}
