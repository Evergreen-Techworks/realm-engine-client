import { RealmEngine } from '@realmengine/sdk';
import Farmer from '../farmer/index.mjs';

const LOOP_MS = 100;
const normalize = (value) => String(value ?? '').toLowerCase().replace(/[^a-z]/g, '');

// Reuse the coordinated item actions, loot priority, Nexus entry, and teleport
// confirmation from Farmer. Only Shady Sect Leader quests interrupt biome patrol.
export default class DeadChurchFarmer extends Farmer {
  constructor() {
    super();
    this.destination = null;
    this.patrolGoal = null;
    this.visited = new Map();
    this.patrolCells = new Map();
    this.exploreCells = new Map();
    this.patrolRetryAfter = new Map();
    this.patrolGoalKey = null;
    this.patrolHeading = null;
    this.patrolBestDistance = Infinity;
    this.patrolProgressAt = 0;
    this.patrolExploring = false;
    this.tileKeys = new Set();
    this.biomeTiles = [];
    this.walkableTiles = [];
    this.tilesAt = 0;
    this.travelDone = false;
    this.leaderQuest = null;
    this.leaderArrived = false;
    this.leaderMissingAt = null;
    this.finishedLeaders = new Set();
  }

  onStart() {
    super.onStart();
    RealmEngine.ui.status('Dead Church Farmer: locating beacon');
    RealmEngine.log.info('Dead Church Farmer: biome mobs only; white bags take priority.');
  }

  resetMap(name) {
    super.resetMap(name);
    this.destination = null; this.patrolGoal = null;
    this.visited.clear(); this.patrolCells.clear(); this.exploreCells.clear();
    this.patrolRetryAfter.clear(); this.patrolGoalKey = null; this.patrolHeading = null;
    this.patrolBestDistance = Infinity; this.patrolProgressAt = 0; this.patrolExploring = false;
    this.tileKeys.clear(); this.biomeTiles = []; this.walkableTiles = [];
    this.tilesAt = 0; this.travelDone = false;
    this.leaderQuest = null; this.leaderArrived = false; this.leaderMissingAt = null; this.finishedLeaders.clear();
  }

  refreshTiles(now) {
    if (now - this.tilesAt < 1000) return;
    this.tilesAt = now;
    // Patrol, target acquisition, and loot only need the local neighborhood.
    // Avoid allocating and sorting the entire explored Realm every second.
    const tiles = RealmEngine.world.tiles.getNearby(32);
    this.walkableTiles = tiles.filter((t) => !t.isBlocking && !t.isOccupied && !t.damaging);
    this.biomeTiles = tiles.filter((t) => normalize(t.name).includes('deadchurch')
      && !t.isBlocking && !t.isOccupied && !t.damaging);
    this.tileKeys = new Set(tiles.filter((t) => normalize(t.name).includes('deadchurch'))
      .map((t) => `${Math.floor(t.position.x)}:${Math.floor(t.position.y)}`));
    this.rememberCells(this.walkableTiles, this.exploreCells, 'explore');
    this.rememberCells(this.biomeTiles, this.patrolCells, 'biome');
    // Mark only places physically visited, including movement during combat
    // and loot detours. Selecting a future waypoint never counts as a visit.
    const player = { x: RealmEngine.self.getX(), y: RealmEngine.self.getY() };
    for (const [prefix, cells] of [['explore', this.exploreCells], ['biome', this.patrolCells]]) {
      const key = this.cellKey(player, prefix);
      if (cells.has(key)) this.visited.set(key, now);
    }
  }

  cellKey(pos, prefix) {
    return `${prefix}:${Math.floor(pos.x / 6)}:${Math.floor(pos.y / 6)}`;
  }

  rememberCells(tiles, memory, prefix) {
    // One walkable representative per 6x6 area keeps persistent coverage small.
    const local = new Map();
    for (const tile of tiles) {
      const p = tile.position;
      const key = this.cellKey(p, prefix);
      const center = { x: Math.floor(p.x / 6) * 6 + 3, y: Math.floor(p.y / 6) * 6 + 3 };
      const score = Math.hypot(p.x - center.x, p.y - center.y);
      if (!local.has(key) || score < local.get(key).score) local.set(key, { position: { ...p }, score });
    }
    for (const [key, cell] of local) memory.set(key, cell.position);
  }

  pausePatrol(now) {
    // Combat/loot time must not expire the destination we intend to resume.
    this.patrolProgressAt = now;
    if (this.patrolGoal) this.patrolBestDistance = RealmEngine.self.distanceTo(this.patrolGoal);
  }

  inBiome(pos) {
    return this.tileKeys.has(`${Math.floor(pos.x)}:${Math.floor(pos.y)}`);
  }

  isBiomeMob(enemy) {
    if (enemy.group) return normalize(enemy.group) === 'deadchurchmobs';
    return normalize(enemy.biome) === 'deadchurch'
      || normalize(enemy.group) === 'deadchurchmobs'
      || /^dead church /i.test(enemy.name) || enemy.objectType === 0xc1de;
  }

  chooseBeacon(position) {
    // Boss detours can use any real beacon nearest the boss. Ordinary biome
    // travel still selects the Dead Church beacon specifically.
    if (position && this.leaderQuest) return super.chooseBeacon(position);
    return RealmEngine.world.objects.getBeacons().filter((b) =>
      (b.objectClass === 'Beacon' || /^dead church beacon\b/i.test(b.name))
      && /dead\s*church|gothic/i.test(b.name)
      && !/guardian|captured|inactive/i.test(b.name))
      .sort((a, b) => RealmEngine.self.distanceTo(a.position) - RealmEngine.self.distanceTo(b.position))[0] ?? null;
  }

  bagIsUseful(bag) {
    // Keep already-selected white bags eligible when dodging carries us outside
    // the biome. Other biomes' drops do not become cross-map detours.
    return bag.rarity === 'white' && bag.items.length > 0
      && (bag.objectId === this.lootBagId || this.inBiome(bag.position));
  }

  observeLeaderQuest() {
    const quest = RealmEngine.world.objects.getQuestObject();
    if (this.leaderQuest || !quest || this.finishedLeaders.has(quest.objectId)
        || normalize(quest.name) !== 'shadysectleader'
        || !Number.isFinite(quest.position?.x) || !Number.isFinite(quest.position?.y)) return;
    this.leaderQuest = { ...quest, position: { ...quest.position } };
    this.leaderArrived = false;
    this.leaderMissingAt = null;
    RealmEngine.log.info('Dead Church: Shady Sect Leader quest detected — interrupting patrol.');
  }

  handleLeaderQuest(now) {
    if (!this.leaderQuest) return false;
    this.pausePatrol(now);
    const enemies = RealmEngine.enemies.getAll();
    let enemy = enemies.find(e => e.objectId === this.leaderQuest.objectId);
    // Encounter phases may replace the quest entity. Reacquire a nearby live
    // leader before interpreting the old object's disappearance/death.
    if (!enemy || enemy.hp <= 0) {
      const replacement = enemies.filter(e => e.hp > 0 && normalize(e.name) === 'shadysectleader'
        && RealmEngine.self.distanceTo(e.position) <= 32)
        .sort((a, b) => RealmEngine.self.distanceTo(a.position) - RealmEngine.self.distanceTo(b.position))[0];
      if (replacement) {
        this.finishedLeaders.add(this.leaderQuest.objectId); // superseded phase marker
        enemy = replacement; this.leaderQuest.objectId = replacement.objectId;
      }
    }
    if (enemy && enemy.hp > 0) {
      this.leaderQuest.position = { ...enemy.position };
      this.leaderMissingAt = null;
    }
    const distance = RealmEngine.self.distanceTo(this.leaderQuest.position);
    if (distance <= 12) this.leaderArrived = true;
    const clearingAdds = this.leaderArrived && (!enemy || (enemy.hp > 0 && !enemy.isTargetable));
    const adds = clearingAdds ? enemies.filter(e => e.objectId !== this.leaderQuest.objectId
      && normalize(e.name) !== 'shadysectleader' && e.hp > 0 && e.isTargetable
      && Math.hypot(e.position.x - this.leaderQuest.position.x,
        e.position.y - this.leaderQuest.position.y) <= 12
      && RealmEngine.self.distanceTo(e.position) <= 32)
      .sort((a, b) => Number(b.objectId === this.lockId) - Number(a.objectId === this.lockId)
        || RealmEngine.self.distanceTo(a.position) - RealmEngine.self.distanceTo(b.position)) : [];
    // Active adds are evidence the encounter is still ongoing, even when the
    // boss hides and the server temporarily points its quest marker elsewhere.
    if (!enemy && adds.length) this.leaderMissingAt = now;
    const currentQuest = RealmEngine.world.objects.getQuestObject();
    const questMovedOn = currentQuest && currentQuest.objectId !== this.leaderQuest.objectId
      && normalize(currentQuest.name) !== 'shadysectleader';
    // A hidden phase or chamber transition is not evidence of a kill. Missing
    // bosses require a sustained absence AND an explicit different quest.
    if ((enemy && enemy.hp <= 0) || (!enemy && this.leaderArrived)) {
      if (this.leaderMissingAt === null) this.leaderMissingAt = now;
      if ((enemy && enemy.hp <= 0 && now - this.leaderMissingAt >= 3000)
          || (questMovedOn && now - this.leaderMissingAt >= 30000)) {
        this.finishedLeaders.add(this.leaderQuest.objectId);
        this.leaderQuest = null; this.leaderArrived = false; this.leaderMissingAt = null;
        this.updateTarget(0, false); RealmEngine.dodge.clearWaypoint();
        if (!this.inBiome({ x: RealmEngine.self.getX(), y: RealmEngine.self.getY() })) this.travelDone = false;
        RealmEngine.log.info('Dead Church: leader dead or absent after the quest moved on — resuming biome farming.');
        return false;
      }
    } else if (!enemy) this.leaderMissingAt = null;
    if (clearingAdds) {
      this.handleBossAdds(adds, this.leaderQuest, 'Dead Church leader');
      return true;
    }
    if (enemy && enemy.hp > 0 && distance <= (this.lockId === enemy.objectId ? 12 : 8)) {
      RealmEngine.dodge.clearWaypoint();
      if (this.lockId !== enemy.objectId) {
        this.updateTarget(0, false);
        this.lockId = enemy.objectId;
        RealmEngine.dodge.lockEnemy(enemy.objectId);
        RealmEngine.combat.aimAt(enemy.objectId);
      }
      this.setFiring(enemy.isTargetable);
      RealmEngine.ui.status('Dead Church: fighting Shady Sect Leader');
      return true;
    }
    this.updateTarget(0, false);
    if ((!enemy && this.leaderArrived) || (enemy && enemy.hp <= 0)) {
      RealmEngine.dodge.clearWaypoint();
      RealmEngine.ui.status('Dead Church: waiting for Shady Sect Leader phase');
    } else {
      if (!this.leaderArrived && this.tryBeaconTeleport(now, this.leaderQuest)) return true;
      RealmEngine.dodge.navigateToPosition(this.leaderQuest.position);
      RealmEngine.ui.status(`Dead Church: travelling to Shady Sect Leader (${distance.toFixed(0)} tiles)`);
    }
    return true;
  }

  fightMob() {
    const target = RealmEngine.enemies.getAll().filter((e) => this.isBiomeMob(e)
      && this.inBiome(e.position) && e.hp > 0
      && (e.isTargetable || e.objectId === this.lockId)
      && RealmEngine.self.distanceTo(e.position) <= (e.objectId === this.lockId ? 12 : 8))
      .sort((a, b) => Number(b.objectId === this.lockId) - Number(a.objectId === this.lockId)
        || RealmEngine.self.distanceTo(a.position) - RealmEngine.self.distanceTo(b.position))[0];
    if (!target) { this.updateTarget(0, false); return false; }
    RealmEngine.dodge.clearWaypoint();
    if (this.lockId !== target.objectId) {
      this.lockId = target.objectId;
      RealmEngine.dodge.lockEnemy(target.objectId);
      RealmEngine.combat.aimAt(target.objectId);
    }
    this.setFiring(target.isTargetable);
    RealmEngine.ui.status(`Dead Church: farming ${target.name}`);
    return true;
  }

  patrol(now, exploring = false) {
    const cells = exploring ? this.exploreCells : this.patrolCells;
    if (this.patrolExploring !== exploring) this.patrolGoal = null;
    this.patrolExploring = exploring;
    if (this.patrolGoal) {
      const distance = RealmEngine.self.distanceTo(this.patrolGoal);
      if (distance <= 1.5) {
        this.visited.set(this.patrolGoalKey, now);
        this.patrolGoal = null;
      } else {
        if (distance < this.patrolBestDistance - 0.5) {
          this.patrolBestDistance = distance; this.patrolProgressAt = now;
        }
        if (now - this.patrolProgressAt > 20000) {
          // Failed travel is not coverage. Defer this area so a blocked target
          // cannot monopolize patrol, then let later exploration retry it.
          this.patrolRetryAfter.set(this.patrolGoalKey, now + 60000);
          this.patrolGoal = null;
        }
      }
    }
    if (!this.patrolGoal) {
      const px = RealmEngine.self.getX(), py = RealmEngine.self.getY();
      const candidates = [];
      for (const [key, position] of cells) {
        const distance = RealmEngine.self.distanceTo(position);
        if (distance < 4 || (this.patrolRetryAfter.get(key) ?? 0) > now) continue;
        const visitedAt = this.visited.get(key);
        const heading = this.patrolHeading;
        const forward = heading ? ((position.x - px) * heading.x + (position.y - py) * heading.y) / distance : 0;
        candidates.push({ key, position, visitedAt,
          score: distance - 12 * forward });
      }
      candidates.sort((a, b) => Number(a.visitedAt !== undefined) - Number(b.visitedAt !== undefined)
        || (a.visitedAt !== undefined && b.visitedAt !== undefined
          ? Math.floor(a.visitedAt / 30000) - Math.floor(b.visitedAt / 30000) : 0)
        || a.score - b.score);
      const next = candidates[0];
      this.patrolGoal = next ? { ...next.position } : null;
      this.patrolGoalKey = next?.key ?? null;
      if (next) {
        const d = RealmEngine.self.distanceTo(next.position);
        this.patrolHeading = { x: (next.position.x - px) / d, y: (next.position.y - py) / d };
        this.patrolBestDistance = d; this.patrolProgressAt = now;
      }
    }
    if (this.patrolGoal) RealmEngine.dodge.navigateToPosition(this.patrolGoal);
    else RealmEngine.dodge.clearWaypoint();
    RealmEngine.ui.status(exploring ? 'Dead Church: exploring to discover the beacon'
      : this.patrolGoal ? `Dead Church: ${this.visited.has(this.patrolGoalKey) ? 'revisiting cleared areas' : 'exploring unvisited biome areas'}`
      : 'Dead Church: waiting for another walkable patrol area');
  }

  onLoop() {
    const now = Date.now();
    const map = RealmEngine.world.getName();
    if (map !== this.mapName) this.resetMap(map);
    if (RealmEngine.world.isNexus()) { this.handleNexus(now); return LOOP_MS; }
    if (!RealmEngine.world.isRealm()) {
      this.updateTarget(0, false); RealmEngine.dodge.clearWaypoint();
      RealmEngine.ui.status('Dead Church Farmer: waiting for a Realm'); return LOOP_MS;
    }
    this.refreshTiles(now);
    this.observeLeaderQuest();
    this.verifyBeaconTeleport(now);
    if (this.beaconPending) return LOOP_MS;
    if (this.handleLoot(now)) { this.pausePatrol(now); this.updateTarget(0, false); return LOOP_MS; }
    if (this.handleLeaderQuest(now)) return LOOP_MS;
    const beacon = this.chooseBeacon();
    if (beacon) {
      if (!this.destination) this.patrolGoal = null;
      this.destination = beacon;
    }
    if (!this.destination) {
      this.updateTarget(0, false);
      // A known biome tile gives us a real discovery direction if the beacon
      // itself has not streamed. Never invent a beacon coordinate.
      const tile = this.biomeTiles.slice().sort((a, b) => RealmEngine.self.distanceTo(a.position)
        - RealmEngine.self.distanceTo(b.position))[0];
      if (tile) RealmEngine.dodge.navigateToPosition(tile.position);
      else { this.patrol(now, true); return LOOP_MS; }
      RealmEngine.ui.status('Dead Church Farmer: approaching known biome terrain to locate beacon');
      return LOOP_MS;
    }
    if (!this.travelDone) {
      this.updateTarget(0, false);
      const d = RealmEngine.self.distanceTo(this.destination.position);
      if (d > 4) {
        if (beacon && this.tryBeaconTeleport(now, { position: this.destination.position })) return LOOP_MS;
        if (!beacon) this.beaconSkipReason = 'destination beacon is no longer tracked';
        RealmEngine.dodge.navigateToPosition(this.destination.position);
        RealmEngine.ui.status(`Dead Church: walking to beacon (${d.toFixed(0)} tiles) — ${this.beaconSkipReason}`);
        return LOOP_MS;
      }
      this.travelDone = true; RealmEngine.dodge.clearWaypoint();
    }
    if (this.fightMob()) this.pausePatrol(now);
    else this.patrol(now);
    return LOOP_MS;
  }
}
