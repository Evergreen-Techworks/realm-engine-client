import { RealmEngine } from '@realmengine/sdk';
import OryxRunner from './oryx-runner.mjs';

const LOOP_MS = 100;
const TARGET_RADIUS = 8;
const TARGET_RELEASE_RADIUS = 12;
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
const BEACON_MIN_SAVING  = 8;    // only teleport when it cuts at least this much off the trip
const BEACON_RETRY_MS    = 5000;  // never spam TELEPORT — one attempt per window
const BEACON_VERIFY_MS   = 3000;  // settle time before judging whether an attempt worked
const BEACON_MOVED_TILES = 8;     // moved at least this far ⇒ the teleport really happened
// Prefer the actual game-data class. Name fallback supports older snapshots,
// but never accepts guardian enemies or explicitly inactive destinations.
const BEACON_NAME_OK = /^(teleport|active|actual active|captured)\s+beacon\b|\bbeacon(?:\s*\([^)]*\))?$/i;
const BEACON_NAME_BAD = /guardian|inactive|decoy|anchor|patrol/i;
// ── Bosses protected by their adds ───────────────────────────────────────────
// Some bosses cannot usefully be damaged while their adds live: the Lich is healed
// by them, the Ghost King's 300000-HP first form only gives way once its ghosts are
// dead (user report 2026-09-14: "you need to kill the additional mobs before killing
// boss"). objects.xml cannot express either; it is server behaviour. So each known
// boss is one entry here, keyed by object TYPE (verified against RE_ASSETS/data/
// objects.xml for game 86ad651b, old and "New" ids both), never by name, so an
// unrelated object sharing a name cannot be pulled in. `adds` lists tiers in kill
// order; enemies within a tier go nearest first. A boss with no entry is fought
// directly. Whatever the protection mechanism, a boss the server marks Invulnerable,
// Invincible or in Stasis is already untargetable, and its adds are cleared by
// handleBossAdds without an entry.
const BOSS_ADD_RULES = [
  { // 0x091b "Lich" (DisplayId none), 0x091c "Actual Lich", 0x55B0 "New Actual Lich" (DisplayId Lich).
    // Which add heals is unconfirmed, so the Bearer goes first and both die before the Lich.
    name: 'Lich', bosses: [0x091b, 0x091c, 0x55B0],
    adds: [[0x091d, 0x55B1] /* Phylactery Bearer */, [0x091e, 0x55B2] /* Haunted Spirit */],
  },
  { // 0x0928 "Ghost King" / 0x5598 "New Ghost King" (300000 HP first form), 0x092d "Actual Ghost
    // King" / 0x559A "New Actual Ghost King" (5000 HP), DisplayId Ghost King. Its adds are the
    // type block authored with it: Small/Medium/Large Ghost (1000/4000/8000 HP). Ghost Master
    // (0x0929 / 0x5599, 100000 HP, 1 XP) is left out: nothing shows it must die, and its HP is
    // that of a controller, not an add. Unconfirmed in game.
    name: 'Ghost King', bosses: [0x0928, 0x092d, 0x5598, 0x559A],
    adds: [[0x092a, 0x092b, 0x092c, 0x559B, 0x559C, 0x559D] /* Small, Medium, Large Ghost */],
  },
];
// An add this close to its own boss protects it. Tight on purpose: the earlier 12 tiles plus
// "any enemy beside a healing boss" sent the farmer after mobs that had nothing to do with it.
const DEPENDENT_RADIUS = 8;
const SKIPPED_REALM_TYPES = new Set([
  ...BOSS_ADD_RULES.flatMap(rule => [...rule.bosses, ...rule.adds.flat()]),
  0x0929, 0x5599,
]);
// An arrived event whose boss is dead or gone may hold the farmer for adds and loot, but
// never longer than this (an untargetable object beside the corpse used to pin it forever).
const EVENT_HOLD_MAX_MS = 60000;
// An encounter with nothing targetable, neither boss nor add, ends after this long...
const ENCOUNTER_WAIT_MS = 30000;
// ...and after this many such endings, with the boss never once targetable, it is skipped.
const ENCOUNTER_MAX_ATTEMPTS = 2;
// Beyond visibility a committed quest is kept while the server still names it
// (QUESTOBJECTID). Without that signal, it is kept this long unseen before re-picking.
const QUEST_UNSEEN_COMMIT_MS = 60000;

export default class Farmer {
  constructor() {
    this.mapName = '';
    this.oryx = new OryxRunner(this, RealmEngine);
    this.mapUnsubscribe = null;
    this.navigationUnsubscribe = null;
    this.navigationGoal = null;
    this.unreachablePositions = [];
    this.beaconSkipReason = null;
    this.zoneGoal = null;
    this.centerTripDone = false;
    this.bossEncounter = null;
    this.bossMissingAt = null;
    this.eventGoal = null;
    this.eventArrived = false;
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
    this.eventHoldSince = null;      // when an arrived event's boss was first seen dead or gone
    this.encounterGiveUps = new Map(); // boss objectId -> encounters that ended with nothing targetable
  }

  setFiring(enabled) {
    if (this.firing === enabled) return;
    this.firing = enabled;
    RealmEngine.combat.setAutoFire(enabled);
  }

  subscribeNavigation() {
    this.navigationUnsubscribe?.();
    this.navigationUnsubscribe = RealmEngine.dodge.onNavigationStatus?.(status => this.handleNavigationStatus(status)) ?? null;
  }

  canNavigate(position) {
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return false;
    const now = Date.now();
    this.unreachablePositions = this.unreachablePositions.filter(entry => entry.until > now);
    return !this.unreachablePositions.some(entry => Math.hypot(entry.x - position.x, entry.y - position.y) < 2);
  }

  navigateToPosition(position) {
    if (!this.canNavigate(position)) return false;
    const accepted = RealmEngine.dodge.navigateToPosition(position);
    if (accepted !== false) {
      const owners = new Map();
      for (const name of ['questGoal', 'eventGoal', 'zoneGoal', 'searchBeaconGoal', 'centerGoal', 'bossEncounter']) {
        const goal = this[name];
        if (goal?.position && Math.hypot(goal.position.x - position.x, goal.position.y - position.y) < 0.25) owners.set(name, goal);
      }
      this.navigationGoal = { x: position.x, y: position.y, owners };
    }
    return accepted;
  }

  handleNavigationStatus(status) {
    if (status.state !== 'unreachable' || !this.navigationGoal
      || Math.hypot(status.position.x - this.navigationGoal.x, status.position.y - this.navigationGoal.y) >= 0.25) return;
    const failed = this.navigationGoal;
    this.navigationGoal = null;
    if (status.reason !== 'map_changed') {
      this.unreachablePositions.push({ x: failed.x, y: failed.y, until: Date.now() + 30000 });
      if (this.unreachablePositions.length > 64) this.unreachablePositions.shift();
    }
    const matches = goal => goal?.position && Math.hypot(goal.position.x - failed.x, goal.position.y - failed.y) < 0.25;
    const owned = name => {
      const original = failed.owners.get(name);
      return original && this[name] && (original === this[name]
        || (original.objectId > 0 && original.objectId === this[name].objectId));
    };
    for (const name of ['questGoal', 'eventGoal', 'zoneGoal', 'searchBeaconGoal', 'centerGoal']) {
      if (!owned(name)) continue;
      this[name] = null;
      if (name === 'centerGoal') this.centerTripDone = true;
      if (name === 'eventGoal') {
        this.eventArrived = false; this.eventMissingAt = null; this.eventHoldSince = null;
      }
    }
    if (owned('bossEncounter')) {
      this.bossEncounter = null;
      this.updateTarget(0, false);
    }
    this.questMissingAt = 0;
    const bag = RealmEngine.loot.getBags().find(entry => entry.objectId === this.lootBagId);
    if (matches(bag)) this.lootBagId = 0;
    if (matches({ position: this.nexusSearchGoal })) this.nexusSearchGoal = null;
    this.lastGoalAt = 0;
    RealmEngine.dodge.clearWaypoint();
  }

  onStart() {
    this.chatUnsubscribe = RealmEngine.chat?.onMessage?.(event => this.oryx.onMessage(event));
    this.mapUnsubscribe = RealmEngine.events.onMapChanged(() => this.resetMap(RealmEngine.world.getName()));
    this.resetMap(RealmEngine.world.getName());
    this.subscribeNavigation();
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
    this.navigationUnsubscribe?.();
    this.navigationUnsubscribe = null;
    this.navigationGoal = null;
    this.chatUnsubscribe?.();
    this.chatUnsubscribe = null;
    this.mapUnsubscribe?.();
    this.mapUnsubscribe = null;
    RealmEngine.dodge.clearWaypoint();
    RealmEngine.dodge.clearEnemyLock();
    RealmEngine.combat.stopAiming();
    this.setFiring(false);
    RealmEngine.ui.status(null);
  }

  resetMap(name) {
    this.navigationGoal = null;
    this.unreachablePositions = [];
    if (this.navigationUnsubscribe) this.subscribeNavigation();
    this.mapName = name;
    this.oryx.reset(name);
    this.beaconSkipReason = null;
    this.zoneGoal = null;
    this.centerTripDone = false;
    this.bossEncounter = null;
    this.bossMissingAt = null;
    this.eventGoal = null;
    this.eventArrived = false;
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
    this.eventHoldSince = null;
    this.encounterGiveUps = new Map();
    // A destination is scoped to the map that created it. Drop the old Realm
    // quest/loot route before Nexus installs its forward-search corridor.
    RealmEngine.dodge.clearWaypoint();
    RealmEngine.dodge.clearEnemyLock();
    RealmEngine.combat.stopAiming();
    this.setFiring(false);
  }

  // Targetable adds of `boss` that must die first, best first: only the add types of
  // that boss's BOSS_ADD_RULES entry, within DEPENDENT_RADIUS of it. Empty for a boss
  // with no entry.
  bossGuards(boss, enemies) {
    const rule = boss?.position ? BOSS_ADD_RULES.find((r) => r.bosses.includes(boss.objectType)) : null;
    if (!rule) return [];
    const tier = (e) => rule.adds.findIndex((types) => types.includes(e.objectType));
    const px = RealmEngine.self.getX();
    const py = RealmEngine.self.getY();
    return enemies.filter((e) => e.objectId !== boss.objectId && e.hp > 0 && e.isTargetable && tier(e) >= 0
        && Math.hypot(e.position.x - boss.position.x, e.position.y - boss.position.y) <= DEPENDENT_RADIUS)
      .sort((a, b) => tier(a) - tier(b)
        || Number(b.objectId === this.lockId) - Number(a.objectId === this.lockId)
        || Math.hypot(a.position.x - px, a.position.y - py) - Math.hypot(b.position.x - px, b.position.y - py));
  }

  shouldSkipRealmEnemy(enemy) {
    return SKIPPED_REALM_TYPES.has(enemy?.objectType)
      && RealmEngine.world.isRealm() && RealmEngine.self.getLevel() >= 20;
  }

  updateTarget(preferredId = 0, enabled = true) {
    const px = RealmEngine.self.getX();
    const py = RealmEngine.self.getY();
    const all = enabled ? RealmEngine.enemies.getAll() : [];
    const eligible = all
      .filter((e) => e.hp > 0 && !this.shouldSkipRealmEnemy(e) && this.canNavigate(e.position) && (e.isTargetable || e.objectId === this.lockId)
        && Math.hypot(e.position.x - px, e.position.y - py)
          <= (e.objectId === this.lockId ? TARGET_RELEASE_RADIUS : TARGET_RADIUS))
      // Something we can damage beats a bigger thing we cannot, even the preferred or locked one.
      .sort((a, b) => Number(b.isTargetable) - Number(a.isTargetable)
        || Number(b.objectId === preferredId) - Number(a.objectId === preferredId)
        || Number(b.objectId === this.lockId) - Number(a.objectId === this.lockId)
        || b.maxHp - a.maxHp || b.hp - a.hp
        || Math.hypot(a.position.x - px, a.position.y - py)
          - Math.hypot(b.position.x - px, b.position.y - py));
    // The pick may be a boss protected by its own adds: those die first, but only ones we
    // can hold a lock on from here. Anything farther is walked to by the encounter, not locked.
    const guard = this.bossGuards(eligible[0], all)
      .find((e) => Math.hypot(e.position.x - px, e.position.y - py) <= TARGET_RELEASE_RADIUS);
    const target = guard ?? eligible[0] ?? null;
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

  // `guards`, when given, are the adds to clear in order (bossGuards); otherwise any
  // targetable add near the boss is cleared, nearest first.
  handleBossAdds(enemies, boss, label, waitingStatus = 'waiting for adds or vulnerable boss', guards = null) {
    // Keep add-clearing inside the encounter, even if an add or a dodge pulls
    // the player outward. Navigation returns to the boss's eight-tile ring.
    const center = boss.position;
    const distance = RealmEngine.self.distanceTo(center);
    if (distance > 14) {
      this.updateTarget(0, false);
      const dx = RealmEngine.self.getX() - center.x, dy = RealmEngine.self.getY() - center.y;
      this.navigateToPosition({ x: center.x + dx / distance * 8, y: center.y + dy / distance * 8 });
      RealmEngine.ui.status(`${label}: returning to boss area`);
      return;
    }
    const add = guards ? guards.find(e => !this.shouldSkipRealmEnemy(e)) : enemies.filter(e => !this.shouldSkipRealmEnemy(e) && e.objectId !== boss.objectId && e.hp > 0 && e.isTargetable
      && Math.hypot(e.position.x - center.x, e.position.y - center.y) <= 12)
      .sort((a, b) => Number(b.objectId === this.lockId) - Number(a.objectId === this.lockId)
        || RealmEngine.self.distanceTo(a.position) - RealmEngine.self.distanceTo(b.position))[0];
    if (!add) {
      this.updateTarget(0, false); RealmEngine.dodge.clearWaypoint();
      RealmEngine.ui.status(`${label}: ${waitingStatus}`);
      return;
    }
    if (RealmEngine.self.distanceTo(add.position) > (this.lockId === add.objectId ? 12 : 8)) {
      this.updateTarget(0, false); this.navigateToPosition(add.position);
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
    if (this.shouldSkipRealmEnemy(quest)
      || this.shouldSkipRealmEnemy(this.bossEncounter)
      || (this.bossEncounter && this.shouldSkipRealmEnemy(RealmEngine.world.objects.getById(this.bossEncounter.objectId)))) {
      this.endBossEncounter(false);
      RealmEngine.dodge.clearWaypoint();
      return false;
    }
    if (this.bossEncounter && !this.canNavigate(this.bossEncounter.position)) {
      this.endBossEncounter(false);
      return false;
    }
    if (quest && !this.canNavigate(quest.position)) return false;
    if (quest && this.objectIsDead(quest.objectId)) {
      this.endBossEncounter(false);
      RealmEngine.dodge.clearWaypoint();
      if (quest.isEventBoss && this.eventArrived) {
        RealmEngine.ui.status(`${quest.name}: defeated — waiting for loot or next phase`);
        return true;
      }
      return false;
    }
    const enemies = RealmEngine.enemies.getAll();
    if (!this.bossEncounter && quest) {
      const boss = enemies.find(e => e.objectId === quest.objectId && e.hp > 0);
      const anchor = boss ?? (quest.isEventBoss ? quest : null);
      if (anchor && RealmEngine.self.distanceTo(anchor.position) <= 12
        && (this.encounterGiveUps.get(anchor.objectId) ?? 0) < ENCOUNTER_MAX_ATTEMPTS)
        this.bossEncounter = { objectId: anchor.objectId, objectType: anchor.objectType, position: { ...anchor.position }, name: anchor.name,
          isEventBoss: !!anchor.isEventBoss, everTargetable: false, waitingSince: null, phaseMissingAt: null };
    }
    if (!this.bossEncounter) return false;
    const boss = enemies.find(e => e.objectId === this.bossEncounter.objectId);
    if (this.objectIsDead(this.bossEncounter.objectId)) {
      this.endBossEncounter(false); return false;
    }
    if (boss) {
      this.bossEncounter.position = { ...boss.position }; this.bossMissingAt = null;
      if (boss.isTargetable) {
        this.bossEncounter.everTargetable = true;
        this.bossEncounter.phaseMissingAt = null;
      }
    } else {
      if (this.bossMissingAt === null) this.bossMissingAt = now;
      const changedQuest = quest && quest.objectId !== this.bossEncounter.objectId;
      if (changedQuest || now - this.bossMissingAt >= (quest?.isEventBoss ? 30000 : QUEST_MISSING_GRACE_MS)) {
        this.endBossEncounter(!changedQuest); return false;
      }
    }
    if (!boss || !boss.isTargetable) {
      if (this.bossEncounter.isEventBoss && this.bossEncounter.everTargetable) {
        if (this.bossEncounter.phaseMissingAt === null) this.bossEncounter.phaseMissingAt = now;
        if (now - this.bossEncounter.phaseMissingAt < QUEST_MISSING_GRACE_MS) {
          if (this.lockId && this.lockId !== this.bossEncounter.objectId) this.updateTarget(0, false);
          this.setFiring(false);
          RealmEngine.dodge.clearWaypoint();
          RealmEngine.ui.status(`${this.bossEncounter.name}: waiting through brief boss transition`);
          return true;
        }
      }
      // Nothing on the boss to damage. Targetable adds keep the wait useful; with none,
      // a present-but-untargetable boss is waited on for ENCOUNTER_WAIT_MS at most.
      const center = this.bossEncounter.position;
      const addAlive = enemies.some((e) => e.objectId !== this.bossEncounter.objectId && e.hp > 0 && e.isTargetable
        && Math.hypot(e.position.x - center.x, e.position.y - center.y) <= 12);
      if (addAlive) this.bossEncounter.waitingSince = null;
      else if (this.bossEncounter.waitingSince === null) this.bossEncounter.waitingSince = now;
      else if (boss && now - this.bossEncounter.waitingSince >= ENCOUNTER_WAIT_MS) {
        this.endBossEncounter(true); return false;
      }
      this.handleBossAdds(enemies, this.bossEncounter, this.bossEncounter.name,
        boss ? 'waiting for adds or vulnerable boss' : 'waiting for encounter visibility');
      return true;
    }
    // A vulnerable boss can still be protected by its adds; clear those first.
    const guards = this.bossGuards(boss, enemies);
    if (guards.length) {
      this.handleBossAdds(enemies, this.bossEncounter, this.bossEncounter.name, 'waiting for adds', guards);
      return true;
    }
    const distance = RealmEngine.self.distanceTo(boss.position);
    if (distance > (this.lockId === boss.objectId ? 12 : 8)) {
      this.updateTarget(0, false); this.navigateToPosition(boss.position);
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

  // End the current boss encounter. One that timed out without its boss ever being
  // targetable is a failed attempt; after ENCOUNTER_MAX_ATTEMPTS that boss is no longer
  // engaged, and an event goal for it is finished so the next event is chosen instead
  // of re-creating the same empty encounter every 30 seconds.
  endBossEncounter(failedAttempt) {
    const encounter = this.bossEncounter;
    this.bossEncounter = null; this.bossMissingAt = null; this.updateTarget(0, false);
    if (!failedAttempt || !encounter || encounter.everTargetable) return;
    const attempts = (this.encounterGiveUps.get(encounter.objectId) ?? 0) + 1;
    this.encounterGiveUps.set(encounter.objectId, attempts);
    if (attempts < ENCOUNTER_MAX_ATTEMPTS) return;
    RealmEngine.log.info(`Realm Farmer: giving up on ${encounter.name} — nothing targetable in ${attempts} attempts.`);
    if (this.eventGoal?.objectId === encounter.objectId) {
      this.finishedEvents.add(encounter.objectId);
      this.eventGoal = null; this.eventArrived = false; this.eventMissingAt = null; this.eventHoldSince = null;
    }
  }

  objectIsDead(objectId) {
    if (RealmEngine.world.objects.isDead?.(objectId)) return true;
    const object = RealmEngine.world.objects.getById(objectId)
      ?? RealmEngine.enemies.getAll().find(enemy => enemy.objectId === objectId);
    return !!object && object.hp <= 0 && object.maxHp > 0;
  }

  // A boss encounter whose boss is not known to be dead. User decision 2026-09-14:
  // while one is on, only white bags interrupt; everything else waits for the kill or
  // for the encounter to end, and the boss lock is kept.
  bossFightActive() {
    return !!this.bossEncounter && !this.objectIsDead(this.bossEncounter.objectId);
  }

  bagIsUseful(bag) {
    return (bag.rarity === 'white' && bag.items.length > 0)
      || bag.items.some((item) =>
        RealmEngine.loot.isUT(item.objectType)
        || RealmEngine.loot.isST(item.objectType)
        || RealmEngine.loot.isUsefulStatPot(item.objectType)
        || RealmEngine.loot.isEquipmentUpgrade(item.objectType));
  }

  chooseLootBag(whiteOnly = false) {
    const px = RealmEngine.self.getX();
    const py = RealmEngine.self.getY();
    return RealmEngine.loot.getNearbyBags(LOOT_RADIUS)
      .filter((bag) => this.canNavigate(bag.position) && this.bagIsUseful(bag) && (!whiteOnly || bag.rarity === 'white'))
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

  // `whiteOnly`: a boss fight is on. Only a white bag may take movement; other bags and
  // inventory upgrades wait and are picked up again once it is over.
  handleLoot(now, whiteOnly = false) {
    if (!whiteOnly && this.useInventoryUpgradesAndPots(now)) return true;
    let bag = this.lootBagId
      ? RealmEngine.loot.getBags().find((b) => b.objectId === this.lootBagId && this.bagIsUseful(b)
        && (!whiteOnly || b.rarity === 'white'))
      : null;
    if (!bag) {
      bag = this.chooseLootBag(whiteOnly);
      this.lootBagId = bag?.objectId ?? 0;
      this.lootArrivedAt = 0;
    }
    if (!bag) return false;

    const distance = RealmEngine.self.distanceTo(bag.position);
    if (distance > BAG_ARRIVE) {
      this.navigateToPosition(bag.position);
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
    const known = RealmEngine.world.tiles.getAll();
    const tiles = known.filter((t) => !t.isBlocking && !t.damaging);
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
    // Skip goals the player can never stand on: a tile holding a square-blocking
    // object (tree, rock, wall prop), and an open tile walled in on all four sides.
    // NoWalk ground, deep water with a Speed value included, is already isBlocking.
    // isOccupied is not used: it counts every tracked entity, the player included.
    const cell = (x, y) => Math.floor(x) * 65536 + Math.floor(y);
    const closed = new Set();
    for (const o of RealmEngine.world.objects?.getAll?.() ?? []) {
      if (o?.blocksMovement && Number.isFinite(o.position?.x) && Number.isFinite(o.position?.y)) {
        closed.add(cell(o.position.x, o.position.y));
      }
    }
    for (const t of known) if (t.isBlocking || t.damaging) closed.add(cell(t.position.x, t.position.y));
    const standable = ({ position: { x, y } }) => !closed.has(cell(x, y))
      && !(closed.has(cell(x - 1, y)) && closed.has(cell(x + 1, y))
        && closed.has(cell(x, y - 1)) && closed.has(cell(x, y + 1)));
    return tiles.sort((a, b) => Math.hypot(a.position.x - desired.x, a.position.y - desired.y)
      - Math.hypot(b.position.x - desired.x, b.position.y - desired.y)).find(standable)?.position ?? null;
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
    if (this.eventArrived || this.bossEncounter || this.lootBagId) {
      this.beaconSkipReason = 'encounter/loot owns movement';
      return false;
    }
    if (this.beaconPending) return true;
    if (now - this.lastBeaconAt < BEACON_RETRY_MS) {
      this.beaconSkipReason = `teleport retry in ${Math.ceil((BEACON_RETRY_MS - (now - this.lastBeaconAt)) / 1000)}s`;
      return false;
    }
    // The server's own cooldown also makes canTeleport() false. Report it
    // honestly (and keep re-evaluating): once it clears, the normal beacon
    // choice runs again, so we only teleport if it is still worth doing.
    const tpCooldownMs = RealmEngine.walking.teleportCooldownRemainingMs?.() ?? 0;
    if (tpCooldownMs > 0) {
      this.beaconSkipReason = `server teleport cooldown, ${Math.ceil(tpCooldownMs / 1000)}s left`;
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
    this.navigateToPosition(this.centerGoal.position);
    RealmEngine.ui.status('Level 20: travelling to central Realm');
    return true;
  }

  getEventGoal(now) {
    if (this.shouldSkipRealmEnemy(this.eventGoal)) {
      this.finishedEvents.add(this.eventGoal.objectId);
      this.eventGoal = null; this.eventArrived = false; this.eventMissingAt = null; this.eventHoldSince = null;
      this.endBossEncounter(false);
      RealmEngine.dodge.clearWaypoint();
    }
    if (now - this.eventScanAt >= 1000 || !this.eventScanAt) {
      this.eventScanAt = now;
      this.eventCandidates = RealmEngine.world.objects.getAll().filter(o => o.isEventBoss && !this.shouldSkipRealmEnemy(o)
        && Number.isFinite(o.position?.x) && Number.isFinite(o.position?.y)
        && !(o.hp <= 0 && o.maxHp > 0)
        && !RealmEngine.world.objects.isDead?.(o.objectId));
    }
    if (this.eventGoal) {
      const distance = RealmEngine.self.distanceTo(this.eventGoal.position);
      if (distance <= 12) this.eventArrived = true;
      const live = RealmEngine.world.objects.getById(this.eventGoal.objectId);
      const dead = RealmEngine.world.objects.isDead?.(this.eventGoal.objectId)
        || (live && live.hp <= 0 && live.maxHp > 0);
      if (live && !dead) { this.eventGoal = live; this.eventMissingAt = null; this.eventHoldSince = null; }
      else if (dead || this.eventArrived || distance <= 12) {
        // One object can be just a phase/controller. Stay local if the event
        // replaces it, rather than treating that object's death as travel permission.
        const replacement = this.eventArrived && this.eventCandidates.find(o =>
          o.objectId !== this.eventGoal.objectId && !this.finishedEvents.has(o.objectId)
          && !RealmEngine.world.objects.isDead?.(o.objectId)
          && Math.hypot(o.position.x-this.eventGoal.position.x, o.position.y-this.eventGoal.position.y) <= 20);
        if (replacement) {
          this.finishedEvents.add(this.eventGoal.objectId);
          this.eventGoal = replacement; this.eventMissingAt = null; this.eventHoldSince = null; this.bossEncounter = null;
          this.updateTarget(0, false); RealmEngine.dodge.clearWaypoint();
          RealmEngine.log.info(`Realm Farmer: continuing nearby event phase — ${replacement.name}`);
          return this.eventGoal;
        }
        const addsAlive = !dead && this.eventArrived && RealmEngine.enemies.getAll().some(e =>
          !this.shouldSkipRealmEnemy(e) && e.objectId !== this.eventGoal.objectId && e.hp > 0 && e.isTargetable
          && Math.hypot(e.position.x-this.eventGoal.position.x, e.position.y-this.eventGoal.position.y) <= 12);
        if (this.eventArrived && this.eventHoldSince === null) this.eventHoldSince = now;
        const overHold = this.eventHoldSince !== null && now - this.eventHoldSince >= EVENT_HOLD_MAX_MS;
        if (addsAlive && !overHold) this.eventMissingAt = null;
        else if (this.eventMissingAt === null) this.eventMissingAt = now;
        // A remote kill can switch immediately. After arrival, allow time for
        // phase swaps and delayed bag spawns; handleLoot still runs every loop.
        const waitMs = this.eventArrived ? (dead ? 10000 : 30000) : (dead ? 0 : 30000);
        if (overHold || (!addsAlive && this.eventMissingAt !== null && now - this.eventMissingAt >= waitMs)) {
          RealmEngine.log.info(`Realm Farmer: event ended — ${this.eventGoal.name}; selecting another boss.`);
          this.finishedEvents.add(this.eventGoal.objectId);
          this.eventGoal = null; this.eventArrived = false; this.eventMissingAt = null; this.eventHoldSince = null;
          this.bossEncounter = null;
          this.updateTarget(0, false); RealmEngine.dodge.clearWaypoint();
        }
      } else this.eventMissingAt = null;
    }
    if (!this.eventGoal) {
      this.eventGoal = this.eventCandidates.filter(o => !this.shouldSkipRealmEnemy(o) && !this.finishedEvents.has(o.objectId) && this.canNavigate(o.position)
        && !RealmEngine.world.objects.isDead?.(o.objectId))
        .sort((a,b) => RealmEngine.self.distanceTo(a.position) - RealmEngine.self.distanceTo(b.position))[0] ?? null;
      if (this.eventGoal) {
        this.eventHoldSince = null;
        this.eventArrived = RealmEngine.self.distanceTo(this.eventGoal.position) <= 12;
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
      this.searchBeaconGoal = RealmEngine.world.objects.getBeacons().filter(b => b.objectClass === 'Beacon' && this.canNavigate(b.position)
        && !BEACON_NAME_BAD.test(b.name) && RealmEngine.self.distanceTo(b.position) > 8
        && now - (this.searchBeaconVisits.get(b.objectId) ?? -Infinity) > 30000)
        .sort((a,b) => (this.searchBeaconVisits.get(a.objectId) ?? 0) - (this.searchBeaconVisits.get(b.objectId) ?? 0)
          || RealmEngine.self.distanceTo(a.position) - RealmEngine.self.distanceTo(b.position))[0] ?? null;
    }
    if (this.searchBeaconGoal) {
      if (this.tryBeaconTeleport(now, this.searchBeaconGoal)) return;
      this.navigateToPosition(this.searchBeaconGoal.position);
      RealmEngine.ui.status('Realm Farmer: searching other beacon areas for purple/white bosses');
    } else {
      RealmEngine.dodge.clearWaypoint();
      RealmEngine.ui.status('Realm Farmer: waiting for purple/white boss markers');
    }
  }

  getQuestGoal(now) {
    // Commit to the selected quest while travelling. Realm quest ids and tracked
    // entities can change as visibility/nearest-region changes, so an object merely
    // leaving the snapshot is not evidence the boss disappeared.
    if (this.questGoal && (this.shouldSkipRealmEnemy(this.questGoal) || this.objectIsDead(this.questGoal.objectId)
      || (this.questGoal.hp <= 0 && this.questGoal.maxHp > 0))) {
      this.questGoal = null; this.questMissingAt = 0;
    }
    if (this.questGoal) {
      const distance = RealmEngine.self.distanceTo(this.questGoal.position);
      // Follow the live object, and its live position, whenever it is tracked.
      const live = RealmEngine.world.objects.getById(this.questGoal.objectId);
      if (live) {
        this.questGoal = live;
        this.questMissingAt = 0;
        return live;
      }
      if (distance > QUEST_VISIBLE_RANGE) {
        // BEYOND VISIBILITY its absence proves nothing, so the protocol decides: the
        // server names the current quest (QUESTOBJECTID). While that is still ours,
        // keep the commitment however long the walk. Once it names another quest (or
        // none) the coordinate is stale: after a short grace for a flip, re-pick.
        // Without that signal, re-pick after QUEST_UNSEEN_COMMIT_MS rather than
        // walking to a dead boss's last coordinate indefinitely.
        const serverQuestId = RealmEngine.world.objects.getQuestTargetId?.();
        const known = typeof serverQuestId === 'number';
        if (known && serverQuestId === this.questGoal.objectId) {
          this.questMissingAt = 0;
          return this.questGoal;
        }
        if (!this.questMissingAt) this.questMissingAt = now;
        if (now - this.questMissingAt < (known ? QUEST_MISSING_GRACE_MS : QUEST_UNSEEN_COMMIT_MS)) return this.questGoal;
      } else {
        // WITHIN VISIBILITY the object SHOULD be in the snapshot, so a sustained
        // absence is the kill it looks like. (The gate used to be QUEST_AREA_ARRIVE,
        // 4 tiles, but quest mobs die from weapon range, 5-8 tiles out, so the
        // liveness check never ran on the kill that mattered.)
        if (!this.questMissingAt) this.questMissingAt = now;
        if (now - this.questMissingAt < QUEST_MISSING_GRACE_MS) return this.questGoal;
      }
      this.questGoal = null;
      this.questMissingAt = 0;
    }

    const quest = RealmEngine.world.objects.getQuestObject();
    if (!quest || this.shouldSkipRealmEnemy(quest) || !this.canNavigate(quest.position) || RealmEngine.world.objects.isDead?.(quest.objectId)
      || (quest.hp <= 0 && quest.maxHp > 0)
      || !Number.isFinite(quest.position?.x) || !Number.isFinite(quest.position?.y)) return null;
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
      .filter((portal) => portal.isRealm && this.canNavigate(portal.position))
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
      this.navigateToPosition(this.nexusSearchGoal);
      RealmEngine.ui.status('Searching for Realm portal: walking forward');
      return;
    }
    this.nexusSearchGoal = null;
    const distance = RealmEngine.self.distanceTo(portal.position);
    if (distance > PORTAL_RANGE) {
      this.navigateToPosition(portal.position);
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
    if (this.oryx.tick(now)) return LOOP_MS;
    this.verifyBeaconTeleport(now);

    if (RealmEngine.world.isNexus()) {
      this.handleNexus(now);
      return LOOP_MS;
    }

    // A useful bag takes movement ownership before combat. Do not clear and
    // recreate its waypoint by running target selection during the detour.
    if (this.eventGoal && this.objectIsDead(this.eventGoal.objectId)) {
      this.getEventGoal(now);
      // The packet already sent cannot be cancelled, but stop waiting for the
      // old destination and route to the new event from wherever we land.
      this.beaconPending = null;
    }
    if (this.beaconPending) return LOOP_MS;
    // During a live boss fight only a white bag may take over (bossFightActive).
    if (this.handleLoot(now, this.bossFightActive())) {
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
          this.navigateToPosition(quest.position);
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
        this.navigateToPosition(this.zoneGoal.position);
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
