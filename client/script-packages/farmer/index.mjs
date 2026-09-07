import { RealmEngine } from '@realmengine/sdk';

const LOOP_MS = 100;
const TARGET_RADIUS = 8;
const TARGET_RELEASE_RADIUS = 12;
const LOOT_RADIUS = 24;
const BAG_ARRIVE = 0.7;
const BAG_SETTLE_MS = 750;
const ITEM_ACTION_MS = 1300;
const PORTAL_RANGE = 1.2;
const PORTAL_RETRY_MS = 3000;
const NEXUS_RETRY_MS = 3000;
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
const BEACON_MIN_SAVING  = 8;    // only teleport when it cuts at least this much off the trip
const BEACON_RETRY_MS    = 5000;  // never spam TELEPORT — one attempt per window
const BEACON_VERIFY_MS   = 3000;  // settle time before judging whether an attempt worked
const BEACON_MOVED_TILES = 8;     // moved at least this far ⇒ the teleport really happened
// Prefer the actual game-data class. Name fallback supports older snapshots,
// but never accepts guardian enemies or explicitly inactive destinations.
const BEACON_NAME_OK = /^(teleport|active|actual active|captured)\s+beacon\b|\bbeacon(?:\s*\([^)]*\))?$/i;
const BEACON_NAME_BAD = /guardian|inactive|decoy|anchor|patrol/i;

export default class Farmer {
  constructor() {
    this.mapName = '';
    this.lastCastleEscapeAt = null;
    this.beaconSkipReason = null;
    this.zoneGoal = null;
    this.centerTripDone = false;
    this.bossEncounter = null;
    this.bossMissingAt = null;
    this.eventGoal = null;
    this.eventMissingAt = null;
    this.eventScanAt = 0;
    this.eventCandidates = [];
    this.finishedEvents = new Set();
    this.searchBeaconVisits = new Map();
    this.searchBeaconGoal = null;
    this.centerGoal = null;
    this.lootBagId = 0;
    this.lootArrivedAt = 0;
    this.lastItemActionAt = 0;
    this.lastPortalUseAt = 0;
    this.nexusSearchGoal = null;
    this.nexusReady = false;
    this.nexusPortalId = 0;
    this.lockId = 0;
    this.patrolStep = 0;
    this.lastGoalAt = 0;
    this.firing = null;
    this.questGoal = null;
    this.questMissingAt = 0;
    this.lastBeaconAt = 0;
    this.beaconPending = null;       // attempt awaiting verification
    this.beaconRetryAfter = new Map();
    this.beaconListedFor = '';       // map whose beacon candidates we already logged
  }

  setFiring(enabled) {
    if (this.firing === enabled) return;
    this.firing = enabled;
    RealmEngine.combat.setAutoFire(enabled);
  }

  onStart() {
    RealmEngine.dodge.clearWaypoint();
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
    RealmEngine.ui.status('Realm Farmer starting');
    RealmEngine.log.info('Realm Farmer started with Unified Dodge, safe-walk, loot detours, and target switching.');
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
    this.lastCastleEscapeAt = null;
    this.beaconSkipReason = null;
    this.zoneGoal = null;
    this.centerTripDone = false;
    this.bossEncounter = null;
    this.bossMissingAt = null;
    this.eventGoal = null;
    this.eventMissingAt = null;
    this.eventScanAt = 0;
    this.eventCandidates = [];
    this.finishedEvents = new Set();
    this.searchBeaconVisits = new Map();
    this.searchBeaconGoal = null;
    this.centerGoal = null;
    this.lootBagId = 0;
    this.lootArrivedAt = 0;
    this.lockId = 0;
    this.patrolStep = 0;
    this.lastGoalAt = 0;
    this.nexusSearchGoal = null;
    this.nexusReady = false;
    this.nexusPortalId = 0;
    this.questGoal = null;
    this.questMissingAt = 0;
    this.lastBeaconAt = 0;
    this.beaconPending = null;
    this.beaconRetryAfter.clear();
    // A destination is scoped to the map that created it. Drop the old Realm
    // quest/loot route before Nexus installs its forward-search corridor.
    RealmEngine.dodge.clearWaypoint();
    RealmEngine.dodge.clearEnemyLock();
    RealmEngine.combat.stopAiming();
    this.setFiring(false);
  }

  updateTarget(preferredId = 0, enabled = true) {
    const px = RealmEngine.self.getX();
    const py = RealmEngine.self.getY();
    const eligible = enabled ? RealmEngine.enemies.getAll()
      .filter((e) => e.hp > 0 && (e.isTargetable || e.objectId === this.lockId)
        && Math.hypot(e.position.x - px, e.position.y - py)
          <= (e.objectId === this.lockId ? TARGET_RELEASE_RADIUS : TARGET_RADIUS))
      .sort((a, b) => Number(b.objectId === preferredId) - Number(a.objectId === preferredId)
        || Number(b.objectId === this.lockId) - Number(a.objectId === this.lockId)
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
    RealmEngine.dodge.clearWaypoint();
    if (target.objectId !== this.lockId) {
      this.lockId = target.objectId;
      RealmEngine.dodge.lockEnemy(target.objectId);
      RealmEngine.combat.aimAt(target.objectId);
    }
    this.setFiring(target.isTargetable);
    return target;
  }

  handleBossAdds(enemies, boss, label) {
    // Keep add-clearing inside the encounter, even if an add or a dodge pulls
    // the player outward. Navigation returns to the boss's eight-tile ring.
    const center = boss.position;
    const distance = RealmEngine.self.distanceTo(center);
    if (distance > 14) {
      this.updateTarget(0, false);
      const dx = RealmEngine.self.getX() - center.x, dy = RealmEngine.self.getY() - center.y;
      RealmEngine.dodge.navigateToPosition({ x: center.x + dx / distance * 8, y: center.y + dy / distance * 8 });
      RealmEngine.ui.status(`${label}: returning to boss area`);
      return;
    }
    const add = enemies.filter(e => e.objectId !== boss.objectId && e.hp > 0 && e.isTargetable
      && Math.hypot(e.position.x - center.x, e.position.y - center.y) <= 12)
      .sort((a, b) => Number(b.objectId === this.lockId) - Number(a.objectId === this.lockId)
        || RealmEngine.self.distanceTo(a.position) - RealmEngine.self.distanceTo(b.position))[0];
    if (!add) {
      this.updateTarget(0, false); RealmEngine.dodge.clearWaypoint();
      RealmEngine.ui.status(`${label}: waiting for adds or vulnerable boss`);
      return;
    }
    if (RealmEngine.self.distanceTo(add.position) > (this.lockId === add.objectId ? 12 : 8)) {
      this.updateTarget(0, false); RealmEngine.dodge.navigateToPosition(add.position);
    } else {
      RealmEngine.dodge.clearWaypoint();
      if (this.lockId !== add.objectId) {
        this.updateTarget(0, false); this.lockId = add.objectId;
        RealmEngine.dodge.lockEnemy(add.objectId); RealmEngine.combat.aimAt(add.objectId);
      }
      this.setFiring(true);
    }
    RealmEngine.ui.status(`${label}: clearing adds — ${add.name}`);
  }

  handleBossEncounter(quest, now) {
    const enemies = RealmEngine.enemies.getAll();
    if (!this.bossEncounter && quest) {
      const boss = enemies.find(e => e.objectId === quest.objectId && e.hp > 0);
      const anchor = boss ?? (quest.isEventBoss ? quest : null);
      if (anchor && RealmEngine.self.distanceTo(anchor.position) <= 12)
        this.bossEncounter = { objectId: anchor.objectId, position: { ...anchor.position }, name: anchor.name };
    }
    if (!this.bossEncounter) return false;
    const boss = enemies.find(e => e.objectId === this.bossEncounter.objectId);
    if (boss && boss.hp <= 0 && boss.maxHp > 0) {
      this.bossEncounter = null; this.bossMissingAt = null; this.updateTarget(0, false); return false;
    }
    if (boss) { this.bossEncounter.position = { ...boss.position }; this.bossMissingAt = null; }
    else {
      if (this.bossMissingAt === null) this.bossMissingAt = now;
      if (now - this.bossMissingAt >= 30000 && quest && quest.objectId !== this.bossEncounter.objectId) {
        this.bossEncounter = null; this.bossMissingAt = null; this.updateTarget(0, false); return false;
      }
    }
    if (!boss || !boss.isTargetable) {
      this.handleBossAdds(enemies, this.bossEncounter, this.bossEncounter.name);
      return true;
    }
    const distance = RealmEngine.self.distanceTo(boss.position);
    if (distance > (this.lockId === boss.objectId ? 12 : 8)) {
      this.updateTarget(0, false); RealmEngine.dodge.navigateToPosition(boss.position);
    } else {
      RealmEngine.dodge.clearWaypoint();
      if (this.lockId !== boss.objectId) {
        this.updateTarget(0, false); this.lockId = boss.objectId;
        RealmEngine.dodge.lockEnemy(boss.objectId); RealmEngine.combat.aimAt(boss.objectId);
      }
      this.setFiring(true);
    }
    RealmEngine.ui.status(`Fighting: ${boss.name}`);
    return true;
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
    if (this.useInventoryUpgradesAndPots(now)) return true;
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
    // Another sender may still be waiting for the first slot update. Keep
    // standing on the bag through that bounded wait instead of reinstalling a
    // quest waypoint between the first and second item.
    if (now - this.lastItemActionAt < 5000) return true;
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

  // Rank real destinations by distance to the travel goal, not to the player.
  chooseBeacon(questPosition) {
    const all = RealmEngine.world.objects.getBeacons();
    const usable = all.filter((b) => {
      const name = String(b?.name ?? '');
      return (b.objectClass === 'Beacon' || (!b.objectClass && BEACON_NAME_OK.test(name)))
        && !BEACON_NAME_BAD.test(name)
        && (this.beaconRetryAfter.get(b.objectId) ?? 0) <= Date.now()
        && Number.isFinite(b.position?.x) && Number.isFinite(b.position?.y);
    });
    if (this.beaconListedFor !== this.mapName) {
      this.beaconListedFor = this.mapName;
      const names = [...new Set(all.map((b) => String(b?.name ?? '?')))].join(', ');
      RealmEngine.log.info(`Realm Farmer: ${all.length} beacon-category objects here, `
        + `${usable.length} usable as teleport targets · ${names || 'none'}`);
    }
    if (!usable.length) return null;
    return usable.sort((a, b) =>
      Math.hypot(a.position.x - questPosition.x, a.position.y - questPosition.y)
      - Math.hypot(b.position.x - questPosition.x, b.position.y - questPosition.y))[0];
  }

  chooseTeleportTarget(position, now) {
    const beacon = this.chooseBeacon(position);
    const candidates = beacon ? [{ ...beacon, teleportKind: 'beacon' }] : [];
    for (const player of RealmEngine.players?.getAll?.() ?? []) {
      if (!(player.hp > 0) || !player.name || player.name === '?'
        || !Number.isFinite(player.lastUpdate) || now - player.lastUpdate > 3000
        || !Number.isFinite(player.position?.x) || !Number.isFinite(player.position?.y)
        || (this.beaconRetryAfter.get(player.objectId) ?? 0) > now) continue;
      candidates.push({ ...player, teleportKind: 'player' });
    }
    return candidates.sort((a,b) => Math.hypot(a.position.x-position.x,a.position.y-position.y)
      - Math.hypot(b.position.x-position.x,b.position.y-position.y))[0] ?? null;
  }

  // Resolve the previous attempt. A TELEPORT the server ignored looks exactly like
  // one it honoured, except that we did not move — so measure that directly. One
  // failed attempt backs off only that target; later attempts remain available.
  verifyBeaconTeleport(now) {
    const pending = this.beaconPending;
    if (!pending || now - pending.at < BEACON_VERIFY_MS) return;
    this.beaconPending = null;
    const moved = Math.hypot(RealmEngine.self.getX() - pending.x,
                             RealmEngine.self.getY() - pending.y);
    const livePlayer = pending.teleportKind === 'player'
      ? RealmEngine.players?.getAll?.().find(p => p.objectId === pending.objectId && p.hp > 0
          && Number.isFinite(p.lastUpdate) && now - p.lastUpdate <= 3000) : null;
    const landed = RealmEngine.self.distanceTo(pending.position) <= 5
      || (livePlayer && RealmEngine.self.distanceTo(livePlayer.position) <= 5);
    if (moved >= BEACON_MOVED_TILES && landed) {
      RealmEngine.log.info(`Realm Farmer: teleport confirmed — moved ${moved.toFixed(0)} `
        + `tiles to "${pending.name}".`);
      return;
    }
    this.beaconRetryAfter.set(pending.objectId, now + 30000);
    RealmEngine.log.info(`Realm Farmer: teleport did nothing (moved ${moved.toFixed(1)} tiles) — `
      + `the server did not honour TELEPORT to "${pending.name}". Retrying this target after 30 seconds.`);
  }

  tryBeaconTeleport(now, quest) {
    this.beaconSkipReason = null;
    if (this.beaconPending) return true;
    if (now - this.lastBeaconAt < BEACON_RETRY_MS) {
      this.beaconSkipReason = `teleport retry in ${Math.ceil((BEACON_RETRY_MS - (now - this.lastBeaconAt)) / 1000)}s`;
      return false;
    }
    if (!RealmEngine.walking.canTeleport()) {
      this.beaconSkipReason = "map reports teleport disabled";
      // Say so once per map. Without this the whole feature is a silent no-op when
      // MAPINFO withholds allowPlayerTeleport, which is indistinguishable from
      // "there were no beacons" or "it never got far enough to try".
      if (this.beaconListedFor !== this.mapName) {
        this.beaconListedFor = this.mapName;
        RealmEngine.log.info('Realm Farmer: beacon teleport skipped — this map does not allow teleport.');
      }
      return false;
    }

    const beacon = this.chooseTeleportTarget(quest.position, now);
    if (!beacon) {
      this.beaconSkipReason = 'no eligible beacon or player available (untracked, filtered, or retrying)';
      return false;
    }
    const retryAt = this.beaconRetryAfter.get(beacon.objectId) ?? 0;
    if (retryAt > now) {
      this.beaconSkipReason = `last teleport unconfirmed; retry in ${Math.ceil((retryAt - now) / 1000)}s`;
      return false;
    }

    const myDistance = RealmEngine.self.distanceTo(quest.position);
    const beaconDistance = Math.hypot(beacon.position.x - quest.position.x,
                                      beacon.position.y - quest.position.y);
    const saving = myDistance - beaconDistance;
    if (saving < BEACON_MIN_SAVING) {
      this.beaconSkipReason = `teleport saves ${saving.toFixed(1)} tiles; minimum ${BEACON_MIN_SAVING}`;
      return false;
    }

    this.lastBeaconAt = now;
    RealmEngine.log.info(`Realm Farmer: ${beacon.teleportKind} TP -> "${beacon.name}" #${beacon.objectId} · `
      + `me->goal ${myDistance.toFixed(0)}, target->goal ${beaconDistance.toFixed(0)} `
      + `(saves ${saving.toFixed(0)})`);
    RealmEngine.dodge.clearWaypoint();
    const sent = beacon.teleportKind === 'player'
      ? RealmEngine.walking.teleportToPlayer(beacon.name)
      : RealmEngine.walking.teleportToBeacon(beacon.objectId);
    if (!sent) {
      this.beaconRetryAfter.set(beacon.objectId, now + 30000);
      this.beaconSkipReason = 'client could not send teleport; check connection/log';
      return false;
    }
    this.beaconPending = {
      at: now,
      teleportKind: beacon.teleportKind,
      name: beacon.name,
      objectId: beacon.objectId,
      position: { ...beacon.position },
      x: RealmEngine.self.getX(),
      y: RealmEngine.self.getY(),
    };
    RealmEngine.ui.status(`${beacon.teleportKind === 'player' ? 'Player' : 'Beacon'} teleport → ${beacon.name}`);
    return true;
  }

  handleLevel20Travel(now) {
    if (RealmEngine.self.getLevel() < 20 || this.centerTripDone) return false;
    if (!this.centerGoal) {
      const size = RealmEngine.world.getSize();
      if (!(size.width > 0 && size.height > 0)) {
        RealmEngine.ui.status('Level 20: waiting for Realm dimensions');
        this.updateTarget(0, false);
        RealmEngine.dodge.clearWaypoint();
        return true;
      }
      this.centerGoal = {
        position: { x: size.width / 2, y: size.height / 2 },
        radius: Math.max(12, Math.min(size.width, size.height) * 0.15),
      };
      this.questGoal = null;
      this.questMissingAt = 0;
      this.zoneGoal = null;
      RealmEngine.log.info('Realm Farmer: level 20 — relocating to central Realm before choosing another quest.');
    }
    this.updateTarget(0, false);
    if (RealmEngine.self.distanceTo(this.centerGoal.position) <= this.centerGoal.radius) {
      this.centerTripDone = true;
      this.questGoal = null;
      this.questMissingAt = 0;
      RealmEngine.dodge.clearWaypoint();
      RealmEngine.log.info('Realm Farmer: reached central Realm; resuming farming quests.');
      return false;
    }
    if (this.tryBeaconTeleport(now, this.centerGoal)) return true;
    RealmEngine.dodge.navigateToPosition(this.centerGoal.position);
    RealmEngine.ui.status('Level 20: travelling to central Realm');
    return true;
  }

  getEventGoal(now) {
    if (now - this.eventScanAt >= 1000 || !this.eventScanAt) {
      this.eventScanAt = now;
      this.eventCandidates = RealmEngine.world.objects.getAll().filter(o => o.isEventBoss
        && Number.isFinite(o.position?.x) && Number.isFinite(o.position?.y)
        && !(o.hp <= 0 && o.maxHp > 0)
        && !RealmEngine.world.objects.isDead?.(o.objectId));
    }
    if (this.eventGoal) {
      const live = RealmEngine.world.objects.getById(this.eventGoal.objectId);
      const dead = RealmEngine.world.objects.isDead?.(this.eventGoal.objectId)
        || (live && live.hp <= 0 && live.maxHp > 0);
      if (live && !dead) { this.eventGoal = live; this.eventMissingAt = null; }
      else if (dead || RealmEngine.self.distanceTo(this.eventGoal.position) <= 12) {
        if (this.eventMissingAt === null) this.eventMissingAt = now;
        if (dead || now - this.eventMissingAt >= 30000) {
          RealmEngine.log.info(`Realm Farmer: event ended — ${this.eventGoal.name}; selecting another boss.`);
          this.finishedEvents.add(this.eventGoal.objectId);
          this.eventGoal = null; this.eventMissingAt = null; this.bossEncounter = null;
          this.updateTarget(0, false); RealmEngine.dodge.clearWaypoint();
        }
      } else this.eventMissingAt = null;
    }
    if (!this.eventGoal) {
      this.eventGoal = this.eventCandidates.filter(o => !this.finishedEvents.has(o.objectId)
        && !RealmEngine.world.objects.isDead?.(o.objectId))
        .sort((a,b) => RealmEngine.self.distanceTo(a.position) - RealmEngine.self.distanceTo(b.position))[0] ?? null;
      if (this.eventGoal) {
        this.searchBeaconGoal = null;
        RealmEngine.log.info(`Realm Farmer: purple/white boss selected — ${this.eventGoal.name}`);
      }
    }
    return this.eventGoal;
  }

  searchForEvents(now) {
    // With no event markers, retain the level-20 inward trip, then visit
    // different known beacons to expose more of the Realm instead of miniquests.
    if (this.handleLevel20Travel(now)) return;
    if (this.searchBeaconGoal && RealmEngine.self.distanceTo(this.searchBeaconGoal.position) <= 4) {
      this.searchBeaconVisits.set(this.searchBeaconGoal.objectId, now);
      this.searchBeaconGoal = null;
    }
    if (!this.searchBeaconGoal) {
      this.searchBeaconGoal = RealmEngine.world.objects.getBeacons().filter(b => b.objectClass === 'Beacon'
        && !BEACON_NAME_BAD.test(b.name) && RealmEngine.self.distanceTo(b.position) > 8
        && now - (this.searchBeaconVisits.get(b.objectId) ?? -Infinity) > 30000)
        .sort((a,b) => (this.searchBeaconVisits.get(a.objectId) ?? 0) - (this.searchBeaconVisits.get(b.objectId) ?? 0)
          || RealmEngine.self.distanceTo(a.position) - RealmEngine.self.distanceTo(b.position))[0] ?? null;
    }
    if (this.searchBeaconGoal) {
      if (this.tryBeaconTeleport(now, this.searchBeaconGoal)) return;
      RealmEngine.dodge.navigateToPosition(this.searchBeaconGoal.position);
      RealmEngine.ui.status('Realm Farmer: searching other beacon areas for purple/white bosses');
    } else {
      RealmEngine.dodge.clearWaypoint();
      RealmEngine.ui.status('Realm Farmer: waiting for purple/white boss markers');
    }
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
    this.updateTarget(0, false);
    // MAPINFO may arrive before the local player's position and HP. A route
    // created then would be anchored at (0,0), not the Nexus spawn corridor.
    if (RealmEngine.self.getHP() <= 0) {
      if (this.nexusReady || this.nexusSearchGoal) RealmEngine.dodge.clearWaypoint();
      this.nexusReady = false; this.nexusSearchGoal = null; this.nexusPortalId = 0;
      RealmEngine.ui.status('Nexus: waiting for player spawn');
      return;
    }
    if (!this.nexusReady) {
      RealmEngine.dodge.clearWaypoint();
      RealmEngine.dodge.clearEnemyLock();
      RealmEngine.combat.stopAiming();
      this.nexusReady = true;
    }
    const portals = RealmEngine.world.objects.getOpenPortals()
      .filter((portal) => portal.isRealm)
      .sort((a, b) => RealmEngine.self.distanceTo(a.position) - RealmEngine.self.distanceTo(b.position)
        || a.playerCount - b.playerCount);
    const portal = portals.find(p => p.objectId === this.nexusPortalId) ?? portals[0];
    this.nexusPortalId = portal?.objectId ?? 0;
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
    // Realm completion transfers us to the castle. Exit before loot, combat,
    // or travel can take ownership, and rate-limit retries while awaiting Nexus.
    const normalizedMap = String(map).toLowerCase().replace(/[^a-z]/g, '');
    if (normalizedMap === 'oryxscastle' || normalizedMap === 'oryxcastle') {
      this.updateTarget(0, false);
      RealmEngine.combat.stopAiming();
      RealmEngine.dodge.clearWaypoint();
      RealmEngine.ui.status("Realm Farmer: leaving Oryx's Castle for Nexus");
      if (this.lastCastleEscapeAt === null || now - this.lastCastleEscapeAt >= NEXUS_RETRY_MS) {
        this.lastCastleEscapeAt = now;
        RealmEngine.log.info("Realm Farmer: entered Oryx's Castle — returning to Nexus.");
        RealmEngine.walking.nexus();
      }
      return LOOP_MS;
    }
    this.verifyBeaconTeleport(now);

    if (RealmEngine.world.isNexus()) {
      this.handleNexus(now);
      return LOOP_MS;
    }

    // A useful bag takes movement ownership before combat. Do not clear and
    // recreate its waypoint by running target selection during the detour.
    if (this.eventGoal && RealmEngine.world.objects.isDead?.(this.eventGoal.objectId)) {
      this.getEventGoal(now);
      // The packet already sent cannot be cancelled, but stop waiting for the
      // old destination and route to the new event from wherever we land.
      this.beaconPending = null;
    }
    if (this.beaconPending) return LOOP_MS;
    if (this.handleLoot(now)) {
      this.updateTarget(0, false);
      return LOOP_MS;
    }
    const eventMode = RealmEngine.world.isRealm() && RealmEngine.self.getLevel() >= 20;
    if (eventMode && this.bossEncounter && !this.eventGoal) {
      this.bossEncounter = null; this.questGoal = null; this.updateTarget(0, false);
    }
    const quest = RealmEngine.world.isRealm()
      ? (eventMode ? this.getEventGoal(now) : this.getQuestGoal(now)) : null;
    if (eventMode && !quest) {
      this.updateTarget(0, false); this.searchForEvents(now); return LOOP_MS;
    }
    if (this.handleBossEncounter(quest, now)) return LOOP_MS;
    const questDistance = quest ? RealmEngine.self.distanceTo(quest.position) : Infinity;
    // Combat owns movement until the engaged target leaves the release radius
    // or dies. Crossing the four-tile quest arrival threshold is not a disengage.
    const target = this.updateTarget(quest?.objectId ?? 0,
      !eventMode && (!!this.lockId || !quest || questDistance <= TARGET_RADIUS));
    if (target) {
      this.lootBagId = 0;
      this.lootArrivedAt = 0;
      RealmEngine.ui.status(`Fighting: ${target.name}`);
      return LOOP_MS;
    }

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
