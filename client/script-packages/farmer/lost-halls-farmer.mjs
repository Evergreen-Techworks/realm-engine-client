import { RealmEngine } from '@realmengine/sdk';
import Farmer from './index.mjs';
import LostHallsRunner from './lost-halls-runner.mjs';

const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');

export default class LostHallsFarmer extends Farmer {
  constructor(mode) {
    super();
    this.halls = new LostHallsRunner(this, RealmEngine, mode);
    this.hallsPortalAt = -Infinity;
  }

  resetMap(name) {
    super.resetMap(name);
    this.halls.reset(name);
    this.hallsPortalAt = -Infinity;
  }

  onStart() {
    super.onStart();
    this.halls.status('searching for a Lost Halls entrance');
  }

  bagIsUseful(bag) {
    return super.bagIsUseful(bag) || bag.items.some(item =>
      norm(RealmEngine.world.objects.getTypeName(item.objectType)) === 'vialofpuredarkness');
  }

  handleLoot(now) {
    // A Vial isn't an equipment upgrade; explicitly collect it for future runs.
    if (now - this.lastItemActionAt >= 1300) {
      const bag = RealmEngine.loot.getNearbyBags(0.7).find(b => b.items.some(item =>
        norm(RealmEngine.world.objects.getTypeName(item.objectType)) === 'vialofpuredarkness'));
      const item = bag?.items.find(i => norm(RealmEngine.world.objects.getTypeName(i.objectType)) === 'vialofpuredarkness');
      if (item && RealmEngine.loot.pickup(bag, item.slotIndex, { useBackpack: true })) {
        this.lastItemActionAt = now; return true;
      }
    }
    return super.handleLoot(now);
  }

  onLoop() {
    const now = Date.now(), map = RealmEngine.world.getName();
    if (map !== this.mapName) this.resetMap(map);
    if (this.halls.tick(now)) return 100;
    if (RealmEngine.self.getHP() <= 0) {
      this.halls.stopCombat(); RealmEngine.dodge.clearWaypoint(); return 100;
    }
    const portal = (RealmEngine.world.objects.getOpenPortals?.() ?? []).find(p =>
      !/locked|closed/i.test(p.name) && (norm(p.destination) === 'losthalls' || norm(p.name) === 'losthallsportal'));
    if (portal) {
      this.halls.stopCombat();
      if (RealmEngine.self.distanceTo(portal.position) > 1.2) {
        RealmEngine.dodge.navigateToPosition(portal.position);
        this.halls.status('walking to Lost Halls entrance');
      } else {
        RealmEngine.dodge.clearWaypoint(); this.halls.status('entering Lost Halls');
        if (now - this.hallsPortalAt >= 3000) { this.hallsPortalAt = now; portal.enter(); }
      }
      return 100;
    }
    if (RealmEngine.world.isRealm() || RealmEngine.world.isNexus()) return super.onLoop();
    // Keep the two new farmers on their selected Lost Halls route.
    this.halls.exit(now, 'returning to Realm to find Lost Halls');
    return 100;
  }
}
