// Dungeon structure: RealmEye dungeon PDFs supplied September 7, 2026.
// Route through observed floor cells: the diagrams have no world-coordinate scale.
const normalize = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const key = p => `${Math.floor(p.x)},${Math.floor(p.y)}`;
const valid = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
const NEIGHBORS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const STAGES = {
  oryxscastle: 'castle', oryxcastle: 'castle',
  oryxschamber: 'chamber', oryxchamber: 'chamber',
  winecellar: 'cellar', oryxssanctuary: 'sanctuary', oryxsanctuary: 'sanctuary',
};
const NEXT = { castle: 'chamber', chamber: 'cellar', cellar: 'sanctuary' };
const LABEL = { castle: 'Castle', chamber: 'Oryx 1', cellar: 'Wine Cellar', sanctuary: 'Sanctuary' };
const GUARDIAN = /^(?:(?:parasite|oryx|red|blue|purple)\s+)*stone guardian(?:\s+(?:left|right|red|blue|purple))?$/i;
const ORYX = /^(?:exalted\s+)?oryx(?: the mad god)?(?:\s+[123])?$/i;
const MINI = /^(?:chancellor dammah|treasurer gemsbok|archbishop leucoryx|chief beisa)$/i;
const WALL = /^(?:fortified\s+)?destructible castle wall$/i;
const ROOM_ENEMY = /^oryx (?:ambassador|minister|judge|noble|aristocrat|patrician|deacon|cleric|cardinal|officer|sergeant|major)$/i;
const PRIORITY_ADD = /^(?:orb of (?:light|chaos)|messengers? of oryx)$/i;
const OPTIONAL = /janus|suit of armor|haunted armor|stone guardian sword|quiet bomb|artifact|portal of oryx/i;
const RETRY_MS = 3000;
const GATE_WAIT_MS = 120000;
const LOOT_WINDOW_MS = 10000;

export default class OryxRunner {
  constructor(farmer, sdk) {
    this.farmer = farmer;
    this.sdk = sdk;
    this.reset();
  }

  reset(map = '') {
    this.stage = STAGES[normalize(map)] ?? null;
    this.spawn = null;
    this.bosses = new Map();
    this.dead = new Set();
    this.encounter = null;
    this.completedAt = null;
    this.gateAt = null;
    this.lootAt = null;
    this.lastUseAt = -Infinity;
    this.lastNexusAt = -Infinity;
    this.usedUnlocks = new Set();
    this.navAt = -Infinity;
    this.navGoal = null;
    this.tickGraph = null;
    this.graphAt = -Infinity;
    this.frontier = null;
    this.frontierAt = 0;
    this.visits = new Map();
    this.statusText = '';
    this.phases = new Map();
    this.dammahStarted = new Set();
    this.heavens = false;
  }

  onMessage(event) {
    if (this.stage !== 'sanctuary' || event.isLocal || !Number.isInteger(event.sourceObjectId)) return;
    // Player names and message text alone cannot authenticate a boss cue.
    const boss = this.sdk.enemies.getAll().find(e => e.objectId === event.sourceObjectId && this.isBoss(e));
    if (!boss) return;
    const text = String(event.message ?? '').toLowerCase();
    let phase;
    if (/^chancellor dammah$/i.test(boss.name)) {
      if (/greetings, dogged|lay down your feeble|do not interrupt/.test(text)) phase = 'speech';
      else if (/miasma of death/.test(text)) phase = 'miasma';
      else if (/room shall burn/.test(text)) phase = 'inferno';
      else if (/disintegrate before/.test(text)) phase = 'finale';
      if (phase && phase !== 'speech') this.dammahStarted.add(boss.objectId);
    } else if (ORYX.test(boss.name)) {
      if (/celestial strength/.test(text)) phase = 'celestial';
      else if (/heavens are mine/.test(text)) {
        this.heavens = true;
      } else if (/cannot be|armor will crumple|nowhere to run|accept your fate|fleeing is futile|shield is enough|escape from my control|melt before my fury|stand back in cowardice|splendor|cosmos|gaze|panic and scream|slashes/.test(text)) phase = 'combat';
    } else if (/^treasurer gemsbok$/i.test(boss.name) && /heads i win, tails you lose/.test(text)) phase = 'coins';
    if (phase) this.phases.set(boss.objectId, phase);
  }

  holdFire(label) {
    this.stopCombat();
    this.sdk.combat.pauseAutomaticAbility?.(1000);
    this.sdk.dodge.clearWaypoint();
    this.status(label);
  }

  status(text) {
    const full = `${LABEL[this.stage]}: ${text}`;
    this.sdk.ui.status(full);
    if (full !== this.statusText) {
      this.statusText = full;
      this.sdk.log.info(`Realm Farmer — ${full}`);
    }
  }

  stopCombat() {
    this.farmer.updateTarget(0, false);
    // Walls are aimed at by position and don't own an enemy lock.
    this.sdk.combat.stopAiming();
  }

  isBoss(e) {
    if (this.stage === 'castle') return GUARDIAN.test(e.name);
    if (this.stage === 'sanctuary') return MINI.test(e.name) || ORYX.test(e.name);
    return ORYX.test(e.name) || (this.stage === 'chamber' && /^giant oryx chicken$/i.test(e.name));
  }

  observe(enemies, now) {
    for (const e of enemies.filter(e => this.isBoss(e))) {
      if (this.dead.has(e.objectId) && e.hp > 0 && !this.sdk.world.objects.isDead?.(e.objectId)) {
        this.dead.delete(e.objectId);
        this.completedAt = null; this.gateAt = null; this.lootAt = null;
      }
      this.bosses.set(e.objectId, { ...e, position: { ...e.position },
        targetable: e.isTargetable, seenAt: now });
    }
    for (const [id, boss] of this.bosses) {
      if (this.dead.has(id)) continue;
      const live = enemies.find(e => e.objectId === id);
      if (this.sdk.world.objects.isDead?.(id) || (live && live.hp <= 0 && live.maxHp > 0)) {
        this.dead.add(id);
        if (this.encounter === id) this.encounter = null;
        const terminal = this.stage === 'castle'
          ? [...this.bosses.values()].filter(e => GUARDIAN.test(e.name)).length >= 2
            && [...this.bosses.keys()].every(id => this.dead.has(id))
          : this.stage !== 'sanctuary' || ORYX.test(boss.name);
        if (terminal && this.completedAt === null) this.completedAt = now;
        this.lootAt = now;
        this.status(`${boss.name} defeated`);
      }
    }
  }

  // Only the expected destination can advance the chain. Some hosts label a
  // locked Wine Cellar portal "open" because its player count is below capacity.
  progressionPortals() {
    const expected = NEXT[this.stage];
    if (!expected) return [];
    return (this.sdk.world.objects.getPortals?.() ?? this.sdk.world.objects.getOpenPortals?.() ?? [])
      .filter(p => valid(p.position) && (STAGES[normalize(p.destination)] === expected
        || STAGES[normalize(String(p.name).replace(/^locked\s+/i, '').replace(/\s+portal$/i, ''))] === expected))
      .sort((a, b) => Number(/locked/i.test(a.name)) - Number(/locked/i.test(b.name))
        || this.sdk.self.distanceTo(a.position) - this.sdk.self.distanceTo(b.position));
  }

  // Construct a connected floor graph once per navigation update. Occupied is
  // deliberately not used: that SDK field includes players, loot and decorations.
  graph() {
    const sdk = this.sdk;
    const cells = new Map();
    const known = new Set();
    const blocked = new Set(sdk.world.objects.getAll().filter(o => o.blocksMovement)
      .map(o => key(o.position)));
    for (const t of sdk.world.tiles?.getAll?.() ?? []) {
      if (valid(t.position)) known.add(key(t.position));
      if (valid(t.position) && !t.isBlocking && !t.damaging && !t.hasConditionEffect
        && !blocked.has(key(t.position))) cells.set(key(t.position), t.position);
    }
    const origin = { x: sdk.self.getX(), y: sdk.self.getY() };
    const start = key(origin);
    // Permit leaving our own cell even if a gate/terrain update just covered it.
    cells.set(start, { x: Math.floor(origin.x) + 0.5, y: Math.floor(origin.y) + 0.5 });
    const queue = [start], parents = new Map([[start, null]]), steps = new Map([[start, 0]]);
    for (let i = 0; i < queue.length; i++) {
      const k = queue[i], p = cells.get(k);
      for (const [dx, dy] of NEIGHBORS) {
        const nk = key({ x: p.x + dx, y: p.y + dy });
        if (cells.has(nk) && !parents.has(nk)) {
          parents.set(nk, k); steps.set(nk, steps.get(k) + 1); queue.push(nk);
        }
      }
    }
    return { cells, parents, steps, queue, start, known };
  }

  route(goal, now, explore = false) {
    if (!valid(goal)) { this.sdk.dodge.clearWaypoint(); return false; }
    if (now - this.navAt < 500 && this.navGoal && distance(this.navGoal, goal) < 1) return true;
    this.navAt = now; this.navGoal = { ...goal };
    const g = this.tickGraph && now - this.graphAt < 500 ? this.tickGraph : this.graph();
    if (g.queue.length <= 1) { this.sdk.dodge.clearWaypoint(); return false; }
    explore = explore && !g.parents.has(key(goal));
    const known = g.known;
    if (this.frontier && (this.sdk.self.distanceTo(this.frontier) < 2 || now - this.frontierAt >= 8000)) {
      const k = key(this.frontier);
      this.visits.set(k, (this.visits.get(k) ?? 0) + 1);
      this.frontier = null;
    }
    let best = null, score = Infinity;
    for (const k of g.queue) {
      const p = g.cells.get(k), d = distance(p, goal);
      const frontier = NEIGHBORS.some(([dx, dy]) => !known.has(key({ x: p.x + dx, y: p.y + dy })));
      if (explore && !frontier) continue;
      const visits = this.visits.get(k) ?? 0;
      const s = d + g.steps.get(k) * (explore ? 0.12 : 0.001) + (explore ? visits * 40 : 0);
      if (s < score && (k !== g.start || !explore)) { score = s; best = k; }
    }
    if (best === null && explore) {
      // Fully revealed maps have no frontiers. Still approach the closest
      // reachable floor toward the goal, stopping on this side of closed gates.
      for (const k of g.queue) {
        const s = distance(g.cells.get(k), goal) + g.steps.get(k) * 0.001;
        if (s < score) { score = s; best = k; }
      }
    }
    if (best === null) { this.sdk.dodge.clearWaypoint(); return false; }
    const destination = g.cells.get(best);
    if (explore && (!this.frontier || distance(this.frontier, destination) > 2)) {
      this.frontier = destination; this.frontierAt = now;
    }
    const path = [];
    for (let k = best; k !== g.start; k = g.parents.get(k)) path.push(g.cells.get(k));
    path.reverse();
    if (!path.length) { this.sdk.dodge.clearWaypoint(); return false; }
    // Feed short steps into native uDodge; it still owns projectile/AoE avoidance.
    this.sdk.dodge.navigateToPosition(path[Math.min(4, path.length - 1)]);
    return true;
  }

  routeHint() {
    const size = this.sdk.world.getSize();
    if (!(size.width > 0 && size.height > 0)) return null;
    // These are directional hints, not assumed pixel-to-tile map coordinates.
    if (this.stage === 'castle') return { x: size.width / 2, y: 0 };
    if (this.stage === 'cellar') return { x: size.width * 0.8, y: size.height / 2 };
    return { x: size.width / 2, y: size.height / 2 };
  }

  fight(target, now, label) {
    const sdk = this.sdk, f = this.farmer;
    const d = sdk.self.distanceTo(target.position);
    const blockers = new Set(sdk.world.objects.getAll().filter(o => o.blocksMovement && o.objectId !== target.objectId)
      .map(o => key(o.position)));
    const origin = { x: sdk.self.getX(), y: sdk.self.getY() };
    let occluded = false;
    for (let step = 1; step < Math.ceil(d * 4); step++) {
      const t = step / Math.ceil(d * 4);
      const p = { x: origin.x + (target.position.x - origin.x) * t,
        y: origin.y + (target.position.y - origin.y) * t };
      if (blockers.has(key(p)) || sdk.world.tiles?.getAt?.(p.x, p.y)?.isBlocking) { occluded = true; break; }
    }
    if (d > 8 || occluded) {
      this.stopCombat();
      this.route(target.position, now);
      this.status(`approaching ${label}`);
      return;
    }
    sdk.dodge.clearWaypoint();
    if (f.lockId !== target.objectId) {
      this.stopCombat(); f.lockId = target.objectId;
      sdk.dodge.lockEnemy(target.objectId); sdk.combat.aimAt(target.objectId);
    }
    f.setFiring(target.isTargetable === true);
    this.status(`fighting ${label}`);
  }

  encounterTick(enemies, now) {
    const liveBosses = enemies.filter(e => e.hp > 0 && this.isBoss(e) && !this.dead.has(e.objectId)
      && (e.objectId === this.encounter || this.sdk.self.distanceTo(e.position) <= 16)
      && this.reachable(e.position));
    const boss = liveBosses.find(e => e.objectId === this.encounter && e.isTargetable)
      ?? liveBosses.sort((a, b) => Number(b.isTargetable) - Number(a.isTargetable)
        || this.sdk.self.distanceTo(a.position) - this.sdk.self.distanceTo(b.position))[0];
    if (boss) this.encounter = boss.objectId;
    const remembered = this.bosses.get(this.encounter);
    if (!remembered) return false;
    if (!boss && now - remembered.seenAt > 30000) {
      // Missing/hidden is not dead. Re-explore for the target or its replacement.
      this.encounter = null; return false;
    }
    if (boss?.isGuarding || (!boss && remembered.isGuarding)) {
      this.holdFire(`${remembered.name}: guard — holding weapons and abilities`);
      return true;
    }
    const phase = this.phases.get(remembered.objectId);
    if (/^chancellor dammah$/i.test(remembered.name)) {
      const portals = this.sdk.world.objects.getAll().some(e =>
        /^(?:giant )?(?:inferno|miasma|bloodshed) portal$/i.test(e.name)
        && distance(e.position, remembered.position) < 35);
      if (portals) this.dammahStarted.add(remembered.objectId);
      if (!this.dammahStarted.has(remembered.objectId)) {
        this.holdFire('Dammah: listening until attack portals appear'); return true;
      }
    }
    if (phase === 'celestial') {
      // Targetability remains true during Celestial. Do not chase the boss or
      // leave a native dodge escape trajectory to acquire messengers or loot.
      this.holdFire('Oryx 3: Celestial — Unified Dodge controls movement'); return true;
    }
    if (phase === 'coins') {
      const artifacts = enemies.some(e => /treasure artifact/i.test(e.name) && e.hp > 0);
      if (artifacts || !boss?.isTargetable) {
        this.holdFire('Gemsbok: coin shuffle — waiting for resolved artifacts'); return true;
      }
      this.phases.delete(remembered.objectId);
    }
    const priority = enemies.filter(e => e.hp > 0 && e.isTargetable && PRIORITY_ADD.test(e.name)
      && this.reachable(e.position) && distance(e.position, remembered.position) < 25)
      .sort((a, b) => this.sdk.self.distanceTo(a.position) - this.sdk.self.distanceTo(b.position))[0];
    if (priority) { this.fight(priority, now, priority.name); return true; }
    if (boss?.isTargetable) {
      this.fight(boss, now, this.heavens ? `${boss.name} — Heavens active` : boss.name); return true;
    }
    const add = enemies.filter(e => e.hp > 0 && e.isTargetable && !this.isBoss(e) && !OPTIONAL.test(e.name)
      && distance(e.position, remembered.position) <= 12 && this.sdk.self.distanceTo(e.position) <= 8)
      .sort((a, b) => this.sdk.self.distanceTo(a.position) - this.sdk.self.distanceTo(b.position))[0];
    if (add) { this.fight(add, now, add.name); return true; }
    this.stopCombat(); this.sdk.dodge.clearWaypoint();
    if (this.sdk.self.distanceTo(remembered.position) > 14) {
      this.route(remembered.position, now);
    }
    this.status(`${remembered.name}: waiting through transition`);
    return true;
  }

  unlock(portal, now) {
    // Incantations are consumed only next to the locked progression portal.
    if (this.stage !== 'chamber' || !/locked/i.test(portal.name)) return;
    const items = this.sdk.inventory.getAll();
    const slot = items.findIndex((type, i) => i >= 4 && type > 0
      && normalize(this.sdk.world.objects.getTypeName?.(type)) === 'winecellarincantation');
    if (slot < 0 || this.usedUnlocks.has(portal.objectId) || now - this.farmer.lastItemActionAt < 1300) return;
    this.usedUnlocks.add(portal.objectId);
    this.farmer.lastItemActionAt = now;
    this.sdk.inventory.useItem(slot);
  }

  unlockRunes(monuments, now) {
    const sdk = this.sdk;
    const items = sdk.inventory.getAll();
    for (const kind of ['sword', 'shield', 'helmet']) {
      if (this.usedUnlocks.has(kind)) continue;
      const slot = items.findIndex((type, i) => i >= 4 && type > 0
        && normalize(sdk.world.objects.getTypeName?.(type)) === `${kind}rune`);
      const monument = monuments.find(o => new RegExp(`\\b${kind}\\b`, 'i').test(o.name)
        && !/activated|unlocked|complete/i.test(o.name));
      if (slot < 0 || !monument) continue;
      if (sdk.self.distanceTo(monument.position) > 1.2) {
        this.route(monument.position, now); this.status(`walking to ${kind} rune monument`);
      } else {
        sdk.dodge.clearWaypoint(); this.status(`offering ${kind} rune`);
        if (now - this.farmer.lastItemActionAt >= 1300) {
          // Attempt once per kind per map. Server validates monument activation;
          // retries must not spend a second rune after a delayed inventory update.
          this.usedUnlocks.add(kind); this.farmer.lastItemActionAt = now;
          sdk.inventory.useItem(slot);
        }
      }
      return true;
    }
    return false;
  }

  reachable(position) {
    // An enemy in the next sealed room must not starve this room's last enemy.
    const g = this.tickGraph;
    if (!g || g.known.size === 0) return true;
    if (g.queue.length <= 1) return g.parents.has(key(position));
    return g.parents.has(key(position)) || NEIGHBORS.some(([dx, dy]) =>
      g.parents.has(key({ x: position.x + dx, y: position.y + dy })));
  }

  exit(now, reason) {
    this.stopCombat(); this.sdk.dodge.clearWaypoint(); this.status(reason);
    if (now - this.lastNexusAt >= RETRY_MS) {
      this.lastNexusAt = now; this.sdk.walking.nexus();
    }
  }

  tick(now) {
    if (!this.stage) return false;
    const sdk = this.sdk, f = this.farmer;
    if (sdk.self.getHP() <= 0) {
      this.stopCombat(); sdk.dodge.clearWaypoint(); this.status('waiting for character'); return true;
    }
    this.spawn ??= { x: sdk.self.getX(), y: sdk.self.getY() };
    const enemies = sdk.enemies.getAll().filter(e => valid(e.position));
    // Reuse the connectivity snapshot for target selection; refresh gates and
    // floor changes at the same cadence as navigation.
    if (!this.tickGraph || now - this.graphAt >= 500) {
      this.tickGraph = this.graph(); this.graphAt = now;
    }
    this.observe(enemies, now);
    const portals = this.progressionPortals();
    const portal = portals[0];
    const monuments = this.stage === 'cellar' ? sdk.world.objects.getAll().filter(o =>
      /(?:rune.*(?:monument|altar|sword|shield|helmet)|(?:monument|altar).*(?:rune|oryx)|(?:sword|shield|helmet) rune)/i.test(o.name)) : [];
    if ((portal || monuments.length || this.completedAt !== null) && this.gateAt === null) {
      this.gateAt = now; this.lootAt ??= now;
    }
    // A progression portal is stronger completion evidence than a missing boss.
    // Loot has a bounded window so a full bag cannot strand us until it expires.
    if (this.gateAt !== null) {
      this.stopCombat();
      if (this.lootAt !== null && now - this.lootAt < LOOT_WINDOW_MS && f.handleLoot(now)) return true;
      f.lootBagId = 0; f.lootArrivedAt = 0;
      if (portal) {
        if (sdk.self.distanceTo(portal.position) > 1.2) {
          this.route(portal.position, now); this.status(`walking to ${portal.name}`);
        } else {
          sdk.dodge.clearWaypoint();
          if (/locked/i.test(portal.name)) {
            this.unlock(portal, now); this.status('waiting for Wine Cellar Incantation');
          } else if (portal.isOpen) {
            this.status(`entering ${portal.name}`);
            if (now - this.lastUseAt >= RETRY_MS) { this.lastUseAt = now; portal.enter(); }
          } else this.status(`waiting for ${portal.name} to open`);
        }
        if (/locked/i.test(portal.name) && now - this.gateAt >= GATE_WAIT_MS)
          this.exit(now, 'Wine Cellar stayed locked; returning to Realm farming');
        return true;
      }
      if (this.stage === 'sanctuary' && this.completedAt !== null) {
        if (now - this.completedAt >= LOOT_WINDOW_MS) this.exit(now, 'Oryx 3 defeated; returning to Realm farming');
        return true;
      }
      if (this.stage !== 'castle' && now - this.gateAt >= GATE_WAIT_MS) {
        this.exit(now, 'next dungeon did not open; returning to Realm farming'); return true;
      }
      if (this.stage === 'cellar' && this.unlockRunes(monuments, now)) return true;
      sdk.dodge.clearWaypoint();
      this.status(this.stage === 'cellar' ? 'waiting for Sanctuary runes and portal' : 'waiting for progression portal');
      return true;
    }
    // Never detour into loot while an endgame boss controls the arena.
    if (this.encounterTick(enemies, now)) return true;
    if (this.lootAt !== null && now - this.lootAt < LOOT_WINDOW_MS) {
      this.stopCombat();
      if (f.handleLoot(now)) return true;
    }
    const target = enemies.filter(e => e.hp > 0 && e.isTargetable && !OPTIONAL.test(e.name) && this.reachable(e.position)
      && (this.stage === 'sanctuary' ? ROOM_ENEMY.test(e.name) : sdk.self.distanceTo(e.position) <= 8))
      .sort((a, b) => sdk.self.distanceTo(a.position) - sdk.self.distanceTo(b.position))[0];
    if (target) { this.fight(target, now, target.name); return true; }
    this.stopCombat();
    // Castle destructible walls may be classified as props, not SDK enemies.
    const wall = this.stage === 'castle' && sdk.world.objects.getAll().filter(o =>
      WALL.test(o.name) && o.hp !== 0 && !sdk.world.objects.isDead?.(o.objectId)
      && sdk.self.distanceTo(o.position) <= 6)
      .sort((a, b) => sdk.self.distanceTo(a.position) - sdk.self.distanceTo(b.position))[0];
    if (wall) {
      sdk.dodge.clearWaypoint(); sdk.combat.aimAtPosition(wall.position.x, wall.position.y);
      f.setFiring(true); this.status('breaking castle wall'); return true;
    }
    const quest = sdk.world.objects.getQuestObject();
    const goal = quest && this.isBoss(quest) && !this.dead.has(quest.objectId) ? quest.position : this.routeHint();
    const moved = this.route(goal, now, true);
    this.status(moved ? 'clearing route toward next encounter' : 'waiting for terrain or room gate');
    return true;
  }
}
