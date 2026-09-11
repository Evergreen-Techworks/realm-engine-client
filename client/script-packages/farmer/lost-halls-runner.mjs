import OryxRunner from './oryx-runner.mjs';

const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const cell = p => `${Math.floor(p.x)},${Math.floor(p.y)}`;
const sector = p => `${Math.floor(p.x / 12)},${Math.floor(p.y / 12)}`;
const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const POT = /^(?:(?:lost halls|lh)\s+)?treasure pot(?:\s*\(lost halls\))?$/i;
const FLAME = /^(?:(?:lost halls|lh|pink|cultist)\s+)*flame$/i;
const TITAN = /^agonized titan$/i;
const DEFENDER = /^marble defender$/i;
const COLOSSUS = /^marble colossus$/i;
const CULT = /^(?:malus|argus|gaius|basaran|dirge|molek|balaam)$/i;
const VOID = /^void entity(?:\s+(?:clone|[1-4]))?$/i;
const START_PILLAR = /^(?:(?:lost halls|lh|starting|spawn)\s+)+pillar$/i;
const WALL = /^(?:(?:lost halls|lh|marble)\s+)?destructible wall(?:\s*\(lost halls\))?$/i;
const HAZARD = /spectral sentry|marble (?:eye|colossus pillar)|(?:arrow|bomb) (?:trap|shooter)/i;
const LATE_ADD = /^(?:marble core|(?:greater )?void shade|void fragment|molek|balaam)$/i;

// Uses the practice repository's distinction between main-path exploration and
// pot/treasure dead ends. No generated map or guessed 9x9 coordinates are used.
// https://github.com/LostHalls/map-reading/tree/fc342e75779638b25433f435624650186392e91f
export default class LostHallsRunner extends OryxRunner {
  constructor(farmer, sdk, mode) {
    super(farmer, sdk);
    if (!['void', 'cult'].includes(mode)) throw new Error('Unknown Lost Halls route');
    this.mode = mode;
  }

  reset(map = '') {
    super.reset(map);
    this.stage = ({ losthalls: 'halls', thevoid: 'void', void: 'void', cultisthideout: 'cult' })[norm(map)] ?? null;
    this.landmarks = new Map();
    this.flames = new Map();
    this.collectedFlames = new Set();
    this.flameRetry = new Map();
    this.flamePending = null;
    this.branchVisits = new Map();
    this.physicalVisits = new Set();
    this.exploreGoal = null;
    this.exploreAt = 0;
    this.exploreProgressAt = 0;
    this.exploreDistance = Infinity;
    this.clearAt = null;
    this.clearPosition = null;
    this.treasureHint = null;
    this.terminalAt = null;
    this.terminalQuietAt = null;
    this.vialUsed = false;
    this.titanReadyAt = null;
  }

  status(text) {
    const route = this.mode === 'cult' ? 'Lost Halls → Cult' : 'Lost Halls → Void';
    const full = `${route}: ${text}`;
    this.sdk.ui.status(full);
    if (this.statusText !== full) { this.statusText = full; this.sdk.log.info(full); }
  }

  isBoss(e) {
    if (this.stage === 'halls') return this.mode === 'cult' ? TITAN.test(e.name) : DEFENDER.test(e.name) || COLOSSUS.test(e.name);
    return this.stage === 'cult' ? CULT.test(e.name) : VOID.test(e.name);
  }

  remember(enemies, objects, now) {
    for (const object of objects) {
      if (TITAN.test(object.name) || DEFENDER.test(object.name) || COLOSSUS.test(object.name) || POT.test(object.name))
        this.landmarks.set(object.objectId, { ...object, position: { ...object.position } });
      if (!FLAME.test(object.name)) continue;
      const previous = this.flames.get(object.objectId);
      if (previous && dist(previous.origin, object.position) > 12) {
        this.collectedFlames.add(object.objectId);
        // The PDF says the relocated flame reveals the treasure room. Keep its
        // destination as a hint, without treating a flame as a killable enemy.
        this.treasureHint = { ...object.position };
      }
      this.flames.set(object.objectId, { ...object, origin: previous?.origin ?? { ...object.position } });
    }
    if (this.collectedFlames.size >= 3 && this.titanReadyAt === null) this.titanReadyAt = now + 45000;
    for (const e of enemies.filter(e => this.isBoss(e))) {
      if (this.dead.has(e.objectId) && e.hp > 0 && !this.sdk.world.objects.isDead?.(e.objectId)) {
        this.dead.delete(e.objectId);
        this.clearAt = null; this.clearPosition = null; this.lootAt = null;
        this.terminalAt = null; this.terminalQuietAt = null;
      }
      this.bosses.set(e.objectId, { ...e, position: { ...e.position }, seenAt: now });
      this.landmarks.set(e.objectId, { ...e, position: { ...e.position } });
    }
    for (const [id, boss] of this.bosses) {
      if (this.dead.has(id)) continue;
      const live = enemies.find(e => e.objectId === id);
      if (!this.sdk.world.objects.isDead?.(id) && !(live && live.hp <= 0 && live.maxHp > 0)) continue;
      this.dead.add(id);
      if (this.encounter === id) this.encounter = null;
      if (this.stage === 'halls' && (COLOSSUS.test(boss.name) || TITAN.test(boss.name))) {
        this.clearAt = now; this.lootAt = now; this.clearPosition = { ...boss.position };
      }
      if ((this.stage === 'cult' && norm(boss.name) === 'malus') || (this.stage === 'void' && VOID.test(boss.name))) {
        this.terminalAt ??= now;
      }
    }
  }

  portals(destination) {
    const names = destination === 'void' ? ['thevoid', 'void'] : ['cultisthideout'];
    return (this.sdk.world.objects.getPortals?.() ?? []).filter(p =>
      names.includes(norm(p.destination)) || names.includes(norm(p.name.replace(/^locked\s+/i, '').replace(/\s+(?:portal|trapdoor)$/i, ''))))
      .sort((a, b) => Number(/locked|closed/i.test(a.name)) - Number(/locked|closed/i.test(b.name))
        || this.sdk.self.distanceTo(a.position) - this.sdk.self.distanceTo(b.position));
  }

  travelPortal(portal, now) {
    this.stopCombat();
    if (this.sdk.self.distanceTo(portal.position) > 1.2) {
      this.route(portal.position, now); this.status(`walking to ${portal.name}`);
    } else {
      this.sdk.dodge.clearWaypoint(); this.status(`entering ${portal.name}`);
      if (now - this.lastUseAt >= 3000) { this.lastUseAt = now; portal.enter(); }
    }
  }

  useVial(now) {
    if (this.vialUsed || !this.clearPosition) return false;
    const slot = this.sdk.inventory.getAll().findIndex((type, i) => i >= 4 && type > 0
      && norm(this.sdk.world.objects.getTypeName(type)) === 'vialofpuredarkness');
    if (slot < 0) return false;
    if (this.sdk.self.distanceTo(this.clearPosition) > 2) this.route(this.clearPosition, now);
    else if (now - this.farmer.lastItemActionAt >= 1300) {
      this.sdk.dodge.clearWaypoint(); this.vialUsed = true;
      this.farmer.lastItemActionAt = now; this.sdk.inventory.useItem(slot);
    }
    this.status('opening the Void with carried Vial of Pure Darkness');
    return true;
  }

  collectFlames(objects, now) {
    if (this.mode !== 'cult' || this.collectedFlames.size >= 3) return false;
    const flame = objects.filter(o => FLAME.test(o.name) && !this.collectedFlames.has(o.objectId)
      && now >= (this.flameRetry.get(o.objectId) ?? 0) && this.reachable(o.position))
      .sort((a, b) => this.sdk.self.distanceTo(a.position) - this.sdk.self.distanceTo(b.position))[0];
    if (!flame) { this.flamePending = null; return false; }
    this.stopCombat();
    if (this.sdk.self.distanceTo(flame.position) > 1.5) {
      this.route(flame.position, now, true); this.flamePending = null;
    } else {
      this.sdk.dodge.clearWaypoint();
      if (this.flamePending?.id !== flame.objectId) this.flamePending = { id: flame.objectId, at: now };
      if (now - this.flamePending.at > 5000) {
        this.flameRetry.set(flame.objectId, now + 30000); this.flamePending = null;
      }
    }
    this.status(`collecting pink flame (${this.collectedFlames.size}/3 relocations confirmed)`);
    return true;
  }

  combatTick(enemies, now) {
    const bosses = enemies.filter(e => e.hp > 0 && this.isBoss(e) && !this.dead.has(e.objectId)
      && this.reachable(e.position) && (this.sdk.self.distanceTo(e.position) <= 20 || e.objectId === this.encounter)
      && !(this.stage === 'halls' && this.mode === 'cult' && !e.isTargetable && this.collectedFlames.size < 3));
    // Archdemons and cores must be cleared before continuing their parent fight.
    const priority = enemies.filter(e => e.hp > 0 && e.isTargetable && LATE_ADD.test(e.name)
      && this.reachable(e.position) && this.sdk.self.distanceTo(e.position) <= 16)
      .sort((a, b) => this.sdk.self.distanceTo(a.position) - this.sdk.self.distanceTo(b.position))[0];
    if (priority) { this.fight(priority, now, priority.name); return true; }
    const boss = bosses.sort((a, b) => Number(b.isTargetable) - Number(a.isTargetable)
      || Number(b.objectId === this.encounter) - Number(a.objectId === this.encounter)
      || this.sdk.self.distanceTo(a.position) - this.sdk.self.distanceTo(b.position))[0];
    if (boss) {
      this.encounter = boss.objectId;
      if (boss.isTargetable) { this.fight(boss, now, boss.name); return true; }
    }
    const ordinary = enemies.filter(e => e.hp > 0 && e.isTargetable && !this.dead.has(e.objectId)
      && !HAZARD.test(e.name) && !this.isBoss(e) && !TITAN.test(e.name) && !COLOSSUS.test(e.name) && !DEFENDER.test(e.name)
      && !POT.test(e.name) && !FLAME.test(e.name) && !START_PILLAR.test(e.name)
      && this.reachable(e.position) && this.sdk.self.distanceTo(e.position) <= (this.encounter ? 12 : 8))
      .sort((a, b) => this.sdk.self.distanceTo(a.position) - this.sdk.self.distanceTo(b.position))[0];
    if (ordinary) { this.fight(ordinary, now, ordinary.name); return true; }
    const held = this.bosses.get(this.encounter);
    if (held && !this.dead.has(held.objectId) && now - held.seenAt < 30000) {
      this.stopCombat(); this.sdk.dodge.clearWaypoint();
      const activation = TITAN.test(held.name) && this.titanReadyAt !== null && now < this.titanReadyAt;
      this.status(activation ? `Titan awakening in ${Math.ceil((this.titanReadyAt - now) / 1000)}s`
        : `${held.name}: waiting for vulnerable phase or adds`); return true;
    }
    this.encounter = null;
    return false;
  }

  explore(now) {
    const g = this.tickGraph;
    if (this.exploreGoal) {
      const d = this.sdk.self.distanceTo(this.exploreGoal);
      if (d < this.exploreDistance - 1) { this.exploreDistance = d; this.exploreProgressAt = now; }
      if (d <= 2 || now - this.exploreProgressAt > 8000 || !g.parents.has(cell(this.exploreGoal))) {
        const k = sector(this.exploreGoal);
        this.branchVisits.set(k, (this.branchVisits.get(k) ?? 0) + 1); this.exploreGoal = null;
      }
    }
    if (!this.exploreGoal) {
      // Compress adjacent exploration candidates into small spatial sectors, so
      // a revealed dead end is not selected repeatedly one tile at a time. These
      // sectors are not claimed to be the game's room grid.
      const candidates = new Map();
      for (const k of g.queue) {
        const p = g.cells.get(k);
        const frontier = DIRS.some(([dx, dy]) => !g.known.has(cell({ x: p.x + dx, y: p.y + dy })));
        if (!frontier && this.physicalVisits.has(sector(p))) continue;
        if (this.sdk.self.distanceTo(p) < 2) continue;
        const bucket = sector(p), visited = this.branchVisits.get(bucket) ?? 0;
        const originDistance = dist(p, this.spawn);
        // Void favors outward progress on the main route; Cult favors nearby
        // side branches. Known pot/Titan/Defender landmarks override this guess.
        const progressBias = this.mode === 'void' ? -originDistance * 0.35 : 0;
        const score = g.steps.get(k) + visited * 200 + progressBias - (frontier ? 10 : 0);
        if (!candidates.has(bucket) || score < candidates.get(bucket).score)
          candidates.set(bucket, { position: p, score });
      }
      // The Cult guide identifies beams over wrong branches. Penalize observed
      // beam decorations, never assume their absence on an unrevealed branch.
      const beams = this.stage === 'cult' ? this.sdk.world.objects.getAll().filter(o => /beam/i.test(o.name)) : [];
      for (const c of candidates.values()) if (beams.some(o => dist(o.position, c.position) <= 6)) c.score += 100;
      const pick = [...candidates.values()].sort((a, b) => a.score - b.score)[0];
      if (pick) {
        this.exploreGoal = { ...pick.position }; this.exploreAt = now;
        this.exploreDistance = this.sdk.self.distanceTo(this.exploreGoal); this.exploreProgressAt = now;
      }
    }
    if (this.exploreGoal) {
      this.route(this.exploreGoal, now); this.status(this.mode === 'cult' && this.stage === 'halls'
        ? 'searching pot-room branches for flames' : 'exploring toward the boss route');
    } else {
      this.sdk.dodge.clearWaypoint(); this.status('waiting for revealed passages or destructible obstacles');
    }
  }

  tick(now) {
    if (!this.stage) return false;
    const sdk = this.sdk, f = this.farmer;
    if ((this.stage === 'void' && this.mode !== 'void') || (this.stage === 'cult' && this.mode !== 'cult')) {
      this.exit(now, 'wrong branch entered; returning to find Lost Halls'); return true;
    }
    if (sdk.self.getHP() <= 0) { this.stopCombat(); sdk.dodge.clearWaypoint(); return true; }
    this.spawn ??= { x: sdk.self.getX(), y: sdk.self.getY() };
    this.physicalVisits.add(sector({ x: sdk.self.getX(), y: sdk.self.getY() }));
    const enemies = sdk.enemies.getAll(), objects = sdk.world.objects.getAll();
    if (!this.tickGraph || now - this.graphAt >= 500) { this.tickGraph = this.graph(); this.graphAt = now; }
    this.remember(enemies, objects, now);
    if (this.stage === 'halls') {
      const portal = this.portals(this.mode).find(p => p.isOpen && !/locked|closed/i.test(p.name));
      if (portal) {
        this.lootAt ??= now;
        this.stopCombat();
        if (now - this.lootAt < 10000 && f.handleLoot(now)) return true;
        this.travelPortal(portal, now); return true;
      }
      if (this.clearAt !== null) {
        this.stopCombat();
        if (now - this.clearAt < 10000 && f.handleLoot(now)) return true;
        if (now - this.clearAt > 120000) { this.exit(now, 'entrance did not open; returning to find Lost Halls'); return true; }
        if (this.mode === 'void' && this.useVial(now)) return true;
        sdk.dodge.clearWaypoint();
        this.status(this.mode === 'void' ? 'waiting for Vial of Pure Darkness / Void entrance' : 'waiting for Cultist trapdoor');
        return true;
      }
    }
    // A clone, side cultist or archdemon death cannot finish a run. Require the
    // terminal boss death and a quiet interval for delayed replacements/loot.
    const liveBoss = enemies.some(e => e.hp > 0 && this.isBoss(e) && !this.dead.has(e.objectId));
    const outstandingTerminal = [...this.bosses.values()].some(e =>
      (this.stage === 'void' ? VOID.test(e.name) : norm(e.name) === 'malus') && !this.dead.has(e.objectId));
    if (this.terminalAt !== null && !liveBoss && !outstandingTerminal) {
      this.terminalQuietAt ??= now;
      this.stopCombat();
      if (now - this.terminalQuietAt < 15000) { f.handleLoot(now); this.status('collecting completion loot'); }
      else this.exit(now, 'route completed; returning to find Lost Halls');
      return true;
    }
    this.terminalQuietAt = null;
    if (this.combatTick(enemies, now)) return true;
    this.stopCombat();
    if (this.stage === 'halls' && this.collectFlames(objects, now)) return true;
    if (this.stage === 'halls') {
      const objective = [...this.landmarks.values()].filter(o => !this.dead.has(o.objectId)
        && !sdk.world.objects.isDead?.(o.objectId) && (this.mode === 'void'
          ? DEFENDER.test(o.name) || COLOSSUS.test(o.name)
          : (this.collectedFlames.size >= 3 && TITAN.test(o.name))))
        .sort((a, b) => sdk.self.distanceTo(a.position) - sdk.self.distanceTo(b.position))[0];
      const pot = this.mode === 'cult' && this.collectedFlames.size < 3 && objects.filter(o => POT.test(o.name)
        && o.hp !== 0 && !sdk.world.objects.isDead?.(o.objectId) && this.reachable(o.position))
        .sort((a, b) => sdk.self.distanceTo(a.position) - sdk.self.distanceTo(b.position))[0];
      if (pot) { this.fight({ ...pot, isTargetable: true }, now, 'treasure pots for pink flames'); return true; }
      const wall = objects.find(o => WALL.test(o.name) && o.hp !== 0 && sdk.self.distanceTo(o.position) <= 6);
      if (wall) {
        sdk.dodge.clearWaypoint(); sdk.combat.aimAtPosition(wall.position.x, wall.position.y);
        f.setFiring(true); this.status('breaking Lost Halls wall'); return true;
      }
      const pillar = enemies.find(e => (START_PILLAR.test(e.name)
        || (/^pillar$/i.test(e.name) && dist(e.position, this.spawn) < 20))
        && e.hp > 0 && sdk.self.distanceTo(e.position) <= 16);
      if (pillar) {
        if (pillar.isTargetable) this.fight(pillar, now, 'entrance pillar');
        else { this.route(pillar.position, now); this.status('approaching entrance pillar to activate it'); }
        return true;
      }
      if (objective) {
        this.route(objective.position, now, true); this.status(`finding ${objective.name}`); return true;
      }
      if (this.collectedFlames.size >= 3 && this.treasureHint) {
        this.route(this.treasureHint, now, true); this.status('returning to the revealed treasure room'); return true;
      }
    }
    if (this.stage === 'void') {
      // Do not walk across Corruption to chase an entity on another sector.
      // Current connected floor is rebuilt as the arena shrinks and splits.
      sdk.dodge.clearWaypoint(); this.status('holding current safe sector for Void Entity or adds'); return true;
    }
    this.explore(now);
    return true;
  }
}
