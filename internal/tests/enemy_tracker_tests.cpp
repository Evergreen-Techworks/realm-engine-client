// EnemyTracker host tests: the keep/drop rule (EnemyClassify.h), the snapshot
// hand-off between the render and game-update threads (SnapshotHandoff.h), and
// what AutoAim does with an explicit lock (LockPolicy.h).
#include "features/combat/enemytracker/EnemyClassify.h"
#include "features/combat/enemytracker/SnapshotHandoff.h"
#include "features/combat/autoaim/core/LockPolicy.h"
#include "features/combat/enemytracker/LockLiveness.h"

#include <cmath>

#include <atomic>
#include <cstdio>
#include <thread>
#include <vector>

static int checks = 0, failures = 0;
#define CHECK(cond, ...) do { ++checks; if (!(cond)) { ++failures; \
    std::printf("FAIL %s:%d: ", __FILE__, __LINE__); std::printf(__VA_ARGS__); std::printf("\n"); } } while (0)

using EnemyClassify::Classify;
using EnemyClassify::Facts;
using EnemyClassify::Reject;

static Facts Enemy(int32_t type, int32_t hp, int32_t maxHp)
{
    Facts f;
    f.isEnemy = true;
    f.objType = type;
    f.hp = hp;
    f.maxHp = maxHp;
    f.x = 120.5f;
    f.y = 88.25f;
    return f;
}

// Real enemies whose objects.xml MaxHitPoints is exactly 200 (game 86ad651b). The
// game initialises an entity's MaxHP and HP from MaxHitPoints, defaulting to 200
// when the element is absent (LKHPPBEGNOM init writes [this+0x208] and [+0x20C]).
// The first six are Realm quests; the rest are common Realm adds.
static const struct { int32_t type; const char* name; } kRealEnemiesAt200Hp[] = {
    { 0x0617, "Hobbit Mage (quest)" },
    { 0x0609, "Elf Wizard (quest)" },
    { 0x1656, "Hobbit Mage Challenger (quest)" },
    { 0x165a, "Elf Wizard Challenger (quest)" },
    { 0x551e, "New Hobbit Mage (quest)" },
    { 0x5514, "New Elf Wizard (quest)" },
    { 0x0922, "Ent Sapling" },
    { 0x55ac, "New Ent Sapling" },
    { 0x0669, "Imp" },
    { 0x0677, "Birdman" },
    { 0x0679, "Oasis Ruler" },
    { 0x0225, "Fire Python" },
    { 0x021e, "Red Spotted Den Spider" },
    { 0x0d10, "Red Swarm Minions" },
};

static void TestRealEnemiesAt200HpAreKept()
{
    for (const auto& e : kRealEnemiesAt200Hp) {
        const Reject why = Classify(Enemy(e.type, 200, 200));
        CHECK(why == Reject::None, "%s (0x%X) at 200/200 HP dropped as %s",
              e.name, static_cast<unsigned>(e.type), EnemyClassify::Name(why));
        const Reject hurt = Classify(Enemy(e.type, 57, 200));
        CHECK(hurt == Reject::None, "%s (0x%X) at 57/200 HP dropped as %s",
              e.name, static_cast<unsigned>(e.type), EnemyClassify::Name(hurt));
    }
}

static void TestPlayerDecoysAreNotEnemies()
{
    // Trickster "Decoy" (0x0715, Class Decoy) has no <Enemy/> tag, so isEnemy is
    // false and the default 200 HP never matters.
    Facts decoy = Enemy(0x0715, 200, 200);
    decoy.isEnemy = false;
    CHECK(Classify(decoy) == Reject::NotEnemy, "player decoy kept");
}

static void TestHardRejects()
{
    CHECK(Classify(Enemy(0x0617, 0, 200)) == Reject::NoHealth, "dead enemy kept");
    CHECK(Classify(Enemy(0x0617, 10, 0)) == Reject::NoHealth, "maxHp 0 kept");
    CHECK(Classify(Enemy(0x0617, 300, 200)) == Reject::HpAboveMax, "hp above max kept");
    CHECK(Classify(Enemy(28491, 500, 500)) == Reject::IgnoredType, "ignored type kept");

    Facts origin = Enemy(0x0617, 100, 200);
    origin.x = 0.f; origin.y = 0.f;
    CHECK(Classify(origin) == Reject::BadPosition, "(0,0) position kept");
    Facts nan = Enemy(0x0617, 100, 200);
    nan.x = std::nan("");
    CHECK(Classify(nan) == Reject::BadPosition, "NaN position kept");
}

static void TestOrdinaryEnemiesAndSoftFlagsAreKept()
{
    CHECK(Classify(Enemy(0x0d59, 1200, 1500)) == Reject::None, "ordinary enemy dropped");
    // 0x7980 "Hero Helper Object" used to be whitelisted past the 200-HP rule;
    // with no such rule it is kept like any other enemy-flagged object.
    CHECK(Classify(Enemy(31104, 200, 200)) == Reject::None, "former whitelisted type dropped");
}

// Enemies with no <MaxHitPoints> start at the game's default 200 HP. 62 such
// <Enemy/> types are not <Invincible/> in 86ad651b, and every one is a prop,
// telegraph, turret or invisible helper (Shatters dining tables, Leucoryx
// light helpers, NM/drac walls). The old max-HP rule dropped them by accident;
// DefaultHp keeps dropping exactly those while they sit at the default.
static void TestDefaultHpHelpersStayDropped()
{
    Facts table = Enemy(0x825c, 200, 200);   // "Shatters Dining Table Centerpiece"
    table.authoredMaxHp = false;
    CHECK(Classify(table) == Reject::DefaultHp, "no-MaxHitPoints prop at default HP kept");

    Facts served = Enemy(0x825c, 900, 1500);  // the server gave it real HP
    served.authoredMaxHp = false;
    CHECK(Classify(served) == Reject::None, "no-MaxHitPoints object with server HP dropped");

    Facts unknown = Enemy(0x0617, 200, 200);  // offset unresolved: treated as authored
    CHECK(Classify(unknown) == Reject::None, "authored 200-HP enemy dropped");
}

// Objects the client's game data marks as hidden helpers (invisible texture, no
// animation, and no MaxHitPoints or Size <= 1) — e.g. 0x86f3 "World's Oyster
// Coral Spawner", 6000 HP and not <Invincible/>. The texture file is not held in
// ObjectProperties, so the client supplies the type list.
static void TestHiddenHelpers()
{
    std::vector<int32_t> types;
    CHECK(EnemyClassify::ParseTypeList("0x86f3, 8234;0x2018\n0x86F3", types, false),
          "valid type list rejected");
    CHECK(types.size() == 3, "expected 3 unique types, got %zu", types.size());
    CHECK(EnemyClassify::IsListed(types, 0x86f3) && EnemyClassify::IsListed(types, 0x202a)
          && EnemyClassify::IsListed(types, 0x2018), "parsed types not listed");
    // A corrupted message changes nothing rather than applying half a list.
    CHECK(!EnemyClassify::ParseTypeList("0x11, garbage, 12", types, false) && types.size() == 3
          && !EnemyClassify::IsListed(types, 0x11), "bad token applied part of a list");
    CHECK(EnemyClassify::ApplyTypeListMessage("+0x753A", types) && types.size() == 4
          && EnemyClassify::IsListed(types, 0x753A), "append message did not add a type");
    CHECK(EnemyClassify::ApplyTypeListMessage("0x2018", types) && types.size() == 1,
          "replace message did not replace");
    CHECK(EnemyClassify::ApplyTypeListMessage("", types) && types.empty(), "empty message did not clear");

    Facts coral = Enemy(0x86f3, 6000, 6000);
    coral.hiddenHelper = true;
    CHECK(Classify(coral) == Reject::HiddenHelper, "hidden helper kept");
}

// ── LockPolicy ────────────────────────────────────────────────────────────────
static EnemyTracker::Entry Tracked(bool invulnerable, bool healthBar, bool scenery)
{
    EnemyTracker::Entry e{};
    e.id = 4242;
    e.objType = 0x0D70;   // "Destructible Castle Wall": Static, no projectiles
    e.hp = 9000;
    e.maxHp = 9000;
    e.isInvulnerable = invulnerable;
    e.hasHealthBar = healthBar;
    e.isScenery = scenery;
    return e;
}

static EnemyTracker::LockInfo LockOn(const EnemyTracker::Entry& e)
{
    return EnemyTracker::ResolveLock(std::vector<EnemyTracker::Entry>{ e }, e.id);
}

static void TestLockPolicy()
{
    using LockPolicy::Decide;
    using LockPolicy::Use;
    const EnemyTracker::Entry wall = Tracked(false, false, true);
    CHECK(Decide(LockOn(wall), false) == Use::Aim, "explicit lock on a breakable not aimed at");
    const EnemyTracker::Entry plain = Tracked(false, true, false);
    CHECK(Decide(LockOn(plain), false) == Use::Aim, "explicit lock on an enemy not aimed at");
    const EnemyTracker::Entry invuln = Tracked(true, true, false);
    CHECK(Decide(LockOn(invuln), false) == Use::Hold, "invulnerable lock not held");
    CHECK(Decide(LockOn(invuln), true) == Use::Aim, "invulnerable lock not aimed at with Shoot invulnerable");
    CHECK(Decide(EnemyTracker::LockInfo{}, false) == Use::FallBack, "missing lock did not fall back");
    EnemyTracker::Entry corpse = plain;
    corpse.hp = 0;
    CHECK(Decide(LockOn(corpse), false) == Use::FallBack, "a dead lock is aimed at instead of falling back");
}

// ── Lock liveness (LockLiveness.h): the one answer every lock consumer reads ─────
static void TestLockLiveness()
{
    using EnemyTracker::LockState;
    using EnemyTracker::ResolveLock;
    EnemyTracker::Entry boss = Tracked(false, true, false);
    boss.x = 16.5f; boss.y = 0.5f;
    std::vector<EnemyTracker::Entry> snap{ Tracked(false, true, false), boss };
    snap[0].id = 7;

    CHECK(ResolveLock(snap, 0).state == LockState::None, "id 0 is not a lock");
    CHECK(ResolveLock(snap, -3).state == LockState::None, "a negative id is not a lock");
    const EnemyTracker::LockInfo live = ResolveLock(snap, boss.id);
    CHECK(live.state == LockState::Live && live.entry == &snap[1] && live.x == 16.5f && live.y == 0.5f,
          "a live lock resolves to its snapshot entry and position");
    CHECK(EnemyTracker::Engages(live), "a live lock is a fight");

    snap[1].isInvulnerable = true;
    const EnemyTracker::LockInfo invuln = ResolveLock(snap, boss.id);
    CHECK(invuln.state == LockState::Invulnerable && EnemyTracker::Engages(invuln),
          "an invulnerable lock holds the fight");

    snap[1].isInvulnerable = false;
    snap[1].hp = 0;
    const EnemyTracker::LockInfo dead = ResolveLock(snap, boss.id);
    CHECK(dead.state == LockState::Gone && dead.entry == nullptr && !EnemyTracker::Engages(dead),
          "a dead lock is gone on the same tick (no grace)");

    snap[1].hp = 9000;
    snap[1].x = NAN;
    CHECK(ResolveLock(snap, boss.id).state == LockState::Gone, "a lock at a non-finite position is gone");

    snap.pop_back();
    const EnemyTracker::LockInfo absent = ResolveLock(snap, boss.id);
    CHECK(absent.state == LockState::Gone && !EnemyTracker::Engages(absent),
          "a lock missing from the snapshot is gone (no last-known position)");
}

// ── SnapshotHandoff ───────────────────────────────────────────────────────────
struct Row { uint64_t gen; uint32_t index; };

static void TestHandoffViewIsStableUntilRefresh()
{
    SnapshotHandoff<Row> hub;
    std::vector<Row> view;
    uint64_t gen = 0;
    hub.Refresh(view, gen);
    CHECK(view.empty(), "view not empty before the first publish");

    hub.Publish({ {1, 0}, {1, 1} });
    hub.Refresh(view, gen);
    CHECK(view.size() == 2 && view[0].gen == 1, "first publish not visible after Refresh");

    const Row* held = &view[1];
    hub.Publish({ {2, 0} });
    CHECK(view.size() == 2 && held->gen == 1, "view changed without Refresh");
    hub.Refresh(view, gen);
    CHECK(view.size() == 1 && view[0].gen == 2, "second publish not visible after Refresh");

    // A second view of the same hub is independent of the first.
    std::vector<Row> other;
    uint64_t otherGen = 0;
    hub.Refresh(other, otherGen);
    CHECK(other.size() == 1 && other[0].gen == 2, "second view did not see the latest publish");
}

// One thread builds and publishes while another refreshes and iterates its own
// view, the way the render thread (AutoAim) and the game-update thread (uDodge)
// share EnemyTracker. Every view must be one whole publish.
static void TestHandoffAcrossThreads()
{
    SnapshotHandoff<Row> hub;
    std::atomic<bool> stop{ false };
    std::atomic<int> torn{ 0 };
    std::atomic<uint64_t> readerViews{ 0 };

    std::thread writer([&] {
        std::vector<Row> build;
        for (uint64_t gen = 1; gen <= 20000; ++gen) {
            build.clear();
            const uint32_t n = 1 + static_cast<uint32_t>(gen % 300);
            for (uint32_t i = 0; i < n; ++i) build.push_back({ gen, i });
            hub.Publish(build);
        }
        stop.store(true);
    });
    std::thread reader([&] {
        std::vector<Row> view;
        uint64_t viewGen = 0;
        while (!stop.load()) {
            hub.Refresh(view, viewGen);
            if (view.empty()) continue;
            const uint64_t gen = view.front().gen;
            const uint32_t expect = 1 + static_cast<uint32_t>(gen % 300);
            if (view.size() != expect) ++torn;
            for (uint32_t i = 0; i < view.size(); ++i)
                if (view[i].gen != gen || view[i].index != i) { ++torn; break; }
            readerViews.fetch_add(1);
        }
    });
    writer.join();
    reader.join();
    CHECK(torn.load() == 0, "%d torn views", torn.load());
    CHECK(readerViews.load() > 0, "reader never saw a publish");
}

int main()
{
    TestRealEnemiesAt200HpAreKept();
    TestPlayerDecoysAreNotEnemies();
    TestHardRejects();
    TestOrdinaryEnemiesAndSoftFlagsAreKept();
    TestDefaultHpHelpersStayDropped();
    TestHiddenHelpers();
    TestLockPolicy();
    TestLockLiveness();
    TestHandoffViewIsStableUntilRefresh();
    TestHandoffAcrossThreads();
    std::printf("enemy_tracker_tests: %d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
