import { RealmEngine } from '@realmengine/sdk';

const LOOP_MS = 100;
const TARGET_RADIUS = 8;
const LOOT_RADIUS = 24;
const BAG_ARRIVE = 0.7;
const BAG_SETTLE_MS = 750;
const ITEM_ACTION_MS = 1300;
const PORTAL_RANGE = 1.2;
const PORTAL_RETRY_MS = 3000;
// Realm portals are straight ahead of the Nexus arrival point. Commit to one
// long corridor instead of issuing short, periodically regenerated waypoints;
// the portal tracker takes over as soon as an open Realm enters visibility.
const NEXUS_FORWARD_DISTANCE = 96;
const QUEST_MISSING_GRACE_MS = 3000;
const QUEST_AREA_ARRIVE = 4;
// Inside this radius the quest object is comfortably inside the local snapshot —
// the loot scan below already trusts that snapshot out to LOOT_RADIUS = 24 tiles.
// So within it, a sustained absence is real evidence the target DIED, rather than
// evidence it is merely too far away to be tracked.
const QUEST_VISIBLE_RANGE = 12;
// ── Beacon teleport ──────────────────────────────────────────────────────────
// A quest target can sit across terrain the nav window cannot route around — a
// wide lake, most often. Realms are dotted with teleport beacons, so when one is
// much closer to the boss than we are, riding it beats the walk.
const BEACON_MIN_SAVING  = 30;    // only teleport when it cuts at least this much off the trip
const BEACON_RETRY_MS    = 5000;  // never spam TELEPORT — one attempt per window
const BEACON_VERIFY_MS   = 1500;  // settle time before judging whether an attempt worked
const BEACON_MOVED_TILES = 8;     // moved at least this far ⇒ the teleport really happened
// getBeacons() categorises by NAME SUBSTRING (GameDataLoader: id.includes('beacon')),
// so it ALSO returns "Beacon Guardian <biome>" — the boss that guards the beacon —
// along with its minions, decoys, orbs, patrol points and attack anchors. Teleporting
// onto one of those would drop us into a boss fight. Only these families are real
// destinations, and anything Guardian-flavoured is rejected outright.
const BEACON_NAME_OK  = /^(teleport|active|actual active|captured)\s+beacon\b/i;
const BEACON_NAME_BAD = /guardian/i;

export default class Farmer {
  constructor() {
    this.mapName = '';
    this.zoneGoal = null;
    this.lootBagId = 0;
    this.lootArrivedAt = 0;
    this.lastItemActionAt = 0;
    this.lastPortalUseAt = 0;
    this.nexusSearchGoal = null;
    this.lockId = 0;
    this.patrolStep = 0;
    this.lastGoalAt = 0;
    this.firing = null;
    this.questGoal = null;
    this.questMissingAt = 0;
    this.lastBeaconAt = 0;
    this.beaconPending = null;       // attempt awaiting verification
    this.beaconUnsupported = false;  // set once a verified attempt did nothing — SESSION-wide,
                                     // because "the server ignores TELEPORT to a beacon" is a
                                     // fact about the server, not about this map.
    this.beaconListedFor = '';       // map whose beacon candidates we already logged
  }

  setFiring(enabled) {
    if (this.firing === enabled) return;
    this.firing = enabled;
    RealmEngine.combat.setAutoFire(enabled);
  }

  onStart() {
    RealmEngine.dodge.setMode('unified');
    RealmEngine.dodge.setSafeWalk(true);
    RealmEngine.dodge.setLockFollow(false);
    RealmEngine.dodge.setAutopilot(false);
    RealmEngine.dodge.clearEnemyLock();
    // KillAura is deliberately NOT enabled. It runs its own target selection and
    // sits at the TOP of the aim precedence chain (autoaim/shoot/AimHooks.h: the
    // KillAura override "wins whenever it is active, including when AutoAim's
    // master toggle is off"), so with it on our lock was set and then ignored —
    // shots went to KillAura's pick instead of the quest target. updateTarget()
    // below owns the target: dodge.lockEnemy() drives the UDodge orbit and
    // combat.aimAt() locks AutoAim onto the SAME id (SetLockTarget also forces
    // AutoAim into Locked mode). This requires the Auto Aim plugin to be enabled
    // — it owns AutoAim's master switch, which no script API can set.
    RealmEngine.combat.setKillAura(false);
    this.setFiring(false);
    RealmEngine.ui.status('Farmer starting');
    RealmEngine.log.info('Farmer started with Unified Dodge, safe-walk, loot detours, and target switching.');
  }

  onStop() {
    RealmEngine.dodge.clearWaypoint();
    RealmEngine.dodge.clearEnemyLock();
    RealmEngine.combat.stopAiming();
    this.setFiring(false);
    RealmEngine.ui.status(null);
  }

  resetMap(name) {
    this.mapName = name;
    this.zoneGoal = null;
    this.lootBagId = 0;
    this.lootArrivedAt = 0;
    this.lockId = 0;
    this.patrolStep = 0;
    this.lastGoalAt = 0;
    this.nexusSearchGoal = null;
    this.questGoal = null;
    this.questMissingAt = 0;
    this.lastBeaconAt = 0;
    this.beaconPending = null;
    // A destination is scoped to the map that created it. Drop the old Realm
    // quest/loot route before Nexus installs its forward-search corridor.
    RealmEngine.dodge.clearWaypoint();
    RealmEngine.dodge.clearEnemyLock();
  }

  updateTarget(preferredId = 0, enabled = true) {
    const px = RealmEngine.self.getX();
    const py = RealmEngine.self.getY();
    const eligible = enabled ? RealmEngine.enemies.getAll()
      .filter((e) => e.isTargetable && Math.hypot(e.position.x - px, e.position.y - py) <= TARGET_RADIUS)
      .sort((a, b) => Number(b.objectId === preferredId) - Number(a.objectId === preferredId)
        || b.maxHp - a.maxHp || b.hp - a.hp
        || Math.hypot(a.position.x - px, a.position.y - py)
          - Math.hypot(b.position.x - px, b.position.y - py)) : [];
    const target = eligible[0] ?? null;
    if (!target) {
      this.setFiring(false);
      if (this.lockId) {
        this.lockId = 0;
        RealmEngine.dodge.clearEnemyLock();
        RealmEngine.combat.stopAiming();
      }
      return null;
    }
    if (target.objectId !== this.lockId) {
      this.lockId = target.objectId;
      RealmEngine.dodge.lockEnemy(target.objectId);
      RealmEngine.combat.aimAt(target.objectId);
    }
    this.setFiring(true);
    return target;
  }

  bagIsUseful(bag) {
    return (bag.rarity === 'white' && bag.items.length > 0)
      || bag.items.some((item) =>
        RealmEngine.loot.isUT(item.objectType)
        || RealmEngine.loot.isST(item.objectType)
        || RealmEngine.loot.isUsefulStatPot(item.objectType)
        || RealmEngine.loot.isEquipmentUpgrade(item.objectType));
  }

  chooseLootBag() {
    const px = RealmEngine.self.getX();
    const py = RealmEngine.self.getY();
    return RealmEngine.loot.getNearbyBags(LOOT_RADIUS)
      .filter((bag) => this.bagIsUseful(bag))
      .sort((a, b) => Number(b.rarity === 'white') - Number(a.rarity === 'white')
        || Number(b.items.some((item) => RealmEngine.loot.isUT(item.objectType) || RealmEngine.loot.isST(item.objectType)))
          - Number(a.items.some((item) => RealmEngine.loot.isUT(item.objectType) || RealmEngine.loot.isST(item.objectType)))
        || Math.hypot(a.position.x - px, a.position.y - py)
        - Math.hypot(b.position.x - px, b.position.y - py))[0] ?? null;
  }

  useInventoryUpgradesAndPots(now) {
    if (now - this.lastItemActionAt < ITEM_ACTION_MS) return false;
    const items = RealmEngine.inventory.getAll();
    for (let slot = 4; slot < items.length; slot++) {
      const type = Number(items[slot]);
      if (type <= 0) continue;
      if (RealmEngine.loot.isUsefulStatPot(type)) {
        RealmEngine.inventory.useItem(slot);
        this.lastItemActionAt = now;
        return true;
      }
      if (RealmEngine.loot.isEquipmentUpgrade(type)) {
        const equipSlot = RealmEngine.loot.getEquipmentSlot(type);
        if (equipSlot >= 0) {
          RealmEngine.inventory.swapSlots(slot, equipSlot);
          this.lastItemActionAt = now;
          return true;
        }
      }
    }
    return false;
  }

  handleLoot(now) {
    this.useInventoryUpgradesAndPots(now);
    let bag = this.lootBagId
      ? RealmEngine.loot.getBags().find((b) => b.objectId === this.lootBagId && this.bagIsUseful(b))
      : null;
    if (!bag) {
      bag = this.chooseLootBag();
      this.lootBagId = bag?.objectId ?? 0;
      this.lootArrivedAt = 0;
    }
    if (!bag) return false;

    const distance = RealmEngine.self.distanceTo(bag.position);
    if (distance > BAG_ARRIVE) {
      RealmEngine.dodge.navigateToPosition(bag.position);
      RealmEngine.ui.status(`Loot detour (${distance.toFixed(1)} tiles)`);
      return true;
    }

    RealmEngine.dodge.clearWaypoint();
    if (!this.lootArrivedAt) this.lootArrivedAt = now;
    RealmEngine.ui.status(bag.rarity === 'white' ? 'Collecting white bag' : 'Waiting for Auto Loot');
    if (now - this.lootArrivedAt < BAG_SETTLE_MS || now - this.lastItemActionAt < ITEM_ACTION_MS) return true;

    // White bags are rare and may contain items that are not a numerical tier
    // upgrade. Preserve every item instead of applying the ordinary gear filter.
    if (bag.rarity === 'white') {
      const sent = RealmEngine.loot.pickupId(bag.objectId, { maxDistance: 1.0, useBackpack: true });
      if (sent > 0) {
        this.lastItemActionAt = now;
        return true;
      }
    }

    // Auto Loot gets first chance. If it is disabled or the item remains, use
    // useful pots in place and equip compatible upgrades directly from the bag.
    for (const item of bag.items) {
      if ((RealmEngine.loot.isUT(item.objectType) || RealmEngine.loot.isST(item.objectType))
          && RealmEngine.loot.pickup(bag, item.slotIndex, { useBackpack: true })) {
        this.lastItemActionAt = now;
        return true;
      }
      if (RealmEngine.loot.isUsefulStatPot(item.objectType)
          && RealmEngine.loot.useFromBag(bag, item.slotIndex)) {
        this.lastItemActionAt = now;
        return true;
      }
      if (RealmEngine.loot.isEquipmentUpgrade(item.objectType)
          && RealmEngine.loot.equipFromBag(bag, item.slotIndex)) {
        this.lastItemActionAt = now;
        return true;
      }
    }
    this.lootBagId = 0;
    return false;
  }

  computeRealmGoal(level) {
    const tiles = RealmEngine.world.tiles.getAll().filter((t) => !t.isBlocking && !t.damaging);
    if (!tiles.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const tile of tiles) {
      minX = Math.min(minX, tile.position.x); minY = Math.min(minY, tile.position.y);
      maxX = Math.max(maxX, tile.position.x); maxY = Math.max(maxY, tile.position.y);
    }
    // With no active quest, move inward until the server offers another one.
    // Leveling direction comes from quests now; no bottom-right heuristic.
    const base = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    const desired = base;
    return tiles.sort((a, b) => Math.hypot(a.position.x - desired.x, a.position.y - desired.y)
      - Math.hypot(b.position.x - desired.x, b.position.y - desired.y))[0]?.position ?? null;
  }

  // Real teleport destinations only — see BEACON_NAME_OK/BAD. Logs the candidate
  // split once per realm so the live name families are visible in the log (the
  // game data has five, and which ones actually spawn is not documented anywhere).
  chooseBeacon(questPosition) {
    const all = RealmEngine.world.objects.getBeacons();
    const usable = all.filter((b) => {
      const name = String(b?.name ?? '');
      return BEACON_NAME_OK.test(name) && !BEACON_NAME_BAD.test(name)
        && Number.isFinite(b.position?.x) && Number.isFinite(b.position?.y);
    });
    if (this.beaconListedFor !== this.mapName) {
      this.beaconListedFor = this.mapName;
      const names = [...new Set(all.map((b) => String(b?.name ?? '?')))].join(', ');
      RealmEngine.log.info(`Farmer: ${all.length} beacon-category objects here, `
        + `${usable.length} usable as teleport targets · ${names || 'none'}`);
    }
    if (!usable.length) return null;
    return usable.sort((a, b) =>
      Math.hypot(a.position.x - questPosition.x, a.position.y - questPosition.y)
      - Math.hypot(b.position.x - questPosition.x, b.position.y - questPosition.y))[0];
  }

  // Resolve the previous attempt. A TELEPORT the server ignored looks exactly like
  // one it honoured, except that we did not move — so measure that directly. One
  // wasted attempt is the entire cost of discovering whether this works at all.
  verifyBeaconTeleport(now) {
    const pending = this.beaconPending;
    if (!pending || now - pending.at < BEACON_VERIFY_MS) return;
    this.beaconPending = null;
    const moved = Math.hypot(RealmEngine.self.getX() - pending.x,
                             RealmEngine.self.getY() - pending.y);
    if (moved >= BEACON_MOVED_TILES) {
      RealmEngine.log.info(`Farmer: beacon teleport confirmed — moved ${moved.toFixed(0)} `
        + `tiles to "${pending.name}".`);
      return;
    }
    this.beaconUnsupported = true;
    RealmEngine.log.info(`Farmer: beacon teleport did nothing (moved ${moved.toFixed(1)} tiles) — `
      + `the server did not honour TELEPORT to "${pending.name}". Walking from here on.`);
  }

  tryBeaconTeleport(now, quest) {
    if (this.beaconUnsupported || this.beaconPending) return false;
    if (now - this.lastBeaconAt < BEACON_RETRY_MS) return false;
    if (!RealmEngine.walking.canTeleport()) {
      // Say so once per map. Without this the whole feature is a silent no-op when
      // MAPINFO withholds allowPlayerTeleport, which is indistinguishable from
      // "there were no beacons" or "it never got far enough to try".
      if (this.beaconListedFor !== this.mapName) {
        this.beaconListedFor = this.mapName;
        RealmEngine.log.info('Farmer: beacon teleport skipped — this map does not allow teleport.');
      }
      return false;
    }

    const beacon = this.chooseBeacon(quest.position);
    if (!beacon) return false;

    const myDistance = RealmEngine.self.distanceTo(quest.position);
    const beaconDistance = Math.hypot(beacon.position.x - quest.position.x,
                                      beacon.position.y - quest.position.y);
    const saving = myDistance - beaconDistance;
    if (saving < BEACON_MIN_SAVING) return false;

    this.lastBeaconAt = now;
    RealmEngine.log.info(`Farmer: beacon TP -> "${beacon.name}" #${beacon.objectId} · `
      + `me->boss ${myDistance.toFixed(0)}, beacon->boss ${beaconDistance.toFixed(0)} `
      + `(saves ${saving.toFixed(0)})`);
    if (!RealmEngine.walking.teleportToBeacon(beacon.objectId)) return false;
    this.beaconPending = {
      at: now,
      name: beacon.name,
      x: RealmEngine.self.getX(),
      y: RealmEngine.self.getY(),
    };
    RealmEngine.ui.status(`Beacon teleport → ${beacon.name}`);
    return true;
  }

  getQuestGoal(now) {
    // Commit to the selected quest COORDINATE while travelling. Realm quest ids
    // and tracked entities can change as visibility/nearest-region changes; that
    // is not evidence the original boss disappeared. Only reconsider once the
    // target is close enough that the local snapshot would definitely hold it.
    if (this.questGoal) {
      const distance = RealmEngine.self.distanceTo(this.questGoal.position);
      // BEYOND VISIBILITY: the object is legitimately missing from the snapshot out
      // here, so its absence proves nothing. Hold the committed coordinate and do
      // not even look — this is the commitment the comment above describes.
      if (distance > QUEST_VISIBLE_RANGE) {
        this.questMissingAt = 0;
        return this.questGoal;
      }

      // WITHIN VISIBILITY: the object SHOULD be in the snapshot, so follow its live
      // position while it exists and treat a sustained absence as the kill it is.
      //
      // This gate used to be QUEST_AREA_ARRIVE (4 tiles), which is the bug: a quest
      // mob is normally killed from WEAPON RANGE, 5-8 tiles out (updateTarget above
      // engages out to TARGET_RADIUS = 8), which is farther than 4. So on the kill
      // that actually mattered the liveness check never ran, and the script stayed
      // committed to a corpse's coordinate — walking to a dead target and only
      // releasing it after arriving inside 4 tiles and burning the grace. Widening
      // the gate to visibility range costs nothing (absence inside it is always
      // meaningful) and leaves the long-range travel commitment untouched.
      const live = RealmEngine.world.objects.getById(this.questGoal.objectId);
      if (live) {
        this.questGoal = live;
        this.questMissingAt = 0;
        return live;
      }
      if (!this.questMissingAt) this.questMissingAt = now;
      if (now - this.questMissingAt < QUEST_MISSING_GRACE_MS) return this.questGoal;
      this.questGoal = null;
      this.questMissingAt = 0;
    }

    const quest = RealmEngine.world.objects.getQuestObject();
    if (!quest || !Number.isFinite(quest.position?.x) || !Number.isFinite(quest.position?.y)) return null;
    this.questGoal = quest;
    return quest;
  }

  handleNexus(now) {
    const portals = RealmEngine.world.objects.getOpenPortals()
      .filter((portal) => portal.isRealm)
      .sort((a, b) => RealmEngine.self.distanceTo(a.position) - RealmEngine.self.distanceTo(b.position)
        || a.playerCount - b.playerCount);
    const portal = portals[0];
    if (!portal) {
      if (!this.nexusSearchGoal) {
        this.nexusSearchGoal = {
          x: RealmEngine.self.getX(),
          y: RealmEngine.self.getY() - NEXUS_FORWARD_DISTANCE,
        };
      }
      RealmEngine.dodge.navigateToPosition(this.nexusSearchGoal);
      RealmEngine.ui.status('Searching for Realm portal: walking forward');
      return;
    }
    this.nexusSearchGoal = null;
    const distance = RealmEngine.self.distanceTo(portal.position);
    if (distance > PORTAL_RANGE) {
      RealmEngine.dodge.navigateToPosition(portal.position);
      RealmEngine.ui.status(`Walking to ${portal.name} (${portal.playerCount}/85)`);
    } else {
      RealmEngine.dodge.clearWaypoint();
      RealmEngine.ui.status(`Entering ${portal.name} (${portal.playerCount}/85)`);
      if (now - this.lastPortalUseAt >= PORTAL_RETRY_MS) {
        this.lastPortalUseAt = now;
        portal.enter();
      }
    }
  }

  onLoop() {
    const now = Date.now();
    const map = RealmEngine.world.getName();
    if (map !== this.mapName) this.resetMap(map);
    this.verifyBeaconTeleport(now);

    if (RealmEngine.world.isNexus()) {
      this.updateTarget();
      this.handleNexus(now);
      return LOOP_MS;
    }

    const quest = RealmEngine.world.isRealm() ? this.getQuestGoal(now) : null;
    const questDistance = quest ? RealmEngine.self.distanceTo(quest.position) : Infinity;
    // Navigation owns movement while travelling. On arrival, release it before
    // arming combat so UDodge's boss orbit—not the old waypoint—owns steering.
    if (quest && questDistance <= QUEST_AREA_ARRIVE) {
      RealmEngine.dodge.clearWaypoint();
    }
    const target = this.updateTarget(quest?.objectId ?? 0,
      !quest || questDistance <= QUEST_AREA_ARRIVE);

    if (this.handleLoot(now)) return LOOP_MS;

    if (RealmEngine.world.isRealm()) {
      const level = RealmEngine.self.getLevel();
      if (quest) {
        this.zoneGoal = null;
        const distance = RealmEngine.self.distanceTo(quest.position);
        if (distance > QUEST_AREA_ARRIVE) {
          // A beacon much nearer the boss beats walking, and beats it by the most
          // exactly where walking is worst: across water and around map-scale
          // obstacles the bounded nav window cannot plan around at all.
          if (this.tryBeaconTeleport(now, quest)) return LOOP_MS;
          RealmEngine.dodge.navigateToPosition(quest.position);
        }
        RealmEngine.ui.status(level < 20
          ? `${distance > QUEST_AREA_ARRIVE ? 'Leveling' : 'Fighting'}: ${quest.name} → (${quest.position.x.toFixed(0)}, ${quest.position.y.toFixed(0)}) · ${distance.toFixed(0)} tiles`
          : `${distance > QUEST_AREA_ARRIVE ? 'Maxing' : 'Fighting'}: ${quest.name} → (${quest.position.x.toFixed(0)}, ${quest.position.y.toFixed(0)}) · ${distance.toFixed(0)} tiles`);
        return LOOP_MS;
      }
      const reached = this.zoneGoal
        && RealmEngine.self.distanceTo(this.zoneGoal.position) <= 1.5;
      const stale = now - this.lastGoalAt >= 15000;
      if (!this.zoneGoal || reached || stale || (level >= 20) !== (this.zoneGoal.level20 === true)) {
        const position = this.computeRealmGoal(level);
        this.zoneGoal = position ? { position, level20: level >= 20 } : null;
        this.lastGoalAt = now;
      }
      if (this.zoneGoal) {
        RealmEngine.dodge.navigateToPosition(this.zoneGoal.position);
        RealmEngine.ui.status(level >= 20
          ? `Maxing: walking toward center for a new quest${target ? ` · ${target.name}` : ''}`
          : `Leveling: walking toward center for a new quest${target ? ` · ${target.name}` : ''}`);
      } else {
        RealmEngine.ui.status('Learning Realm map bounds');
      }
    } else {
      // In dungeons, preserve any red-dot/manual waypoint owned by the native
      // planner. Farmer only supplies combat target selection and loot detours.
      RealmEngine.ui.status(target ? `Dungeon combat: ${target.name}` : 'Dungeon: following selected waypoint');
    }
    return LOOP_MS;
  }
}
