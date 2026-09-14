// Native AutoFire trigger rules (features/combat/autoaim/modes/AutoFireDecision.h).
//
// The script path is driven through a fake World: a fake Auto Aim target
// provider, a fake enemy snapshot, a fake local player and a fake shooter that
// records every ShootWithAngle the rule asks for. So "fires only at a real
// target, never at the cursor" is checked on the production rule, not a copy.
#include "features/combat/autoaim/modes/AutoFireDecision.h"

#include <cmath>
#include <cstdio>
#include <vector>

static int checks = 0, failures = 0;
#define CHECK(cond, ...) do { ++checks; if (!(cond)) { ++failures; \
    std::printf("FAIL %s:%d: ", __FILE__, __LINE__); std::printf(__VA_ARGS__); std::printf("\n"); } } while (0)

using AutoFireDecision::AimTarget;
using AutoFireDecision::Block;
using AutoFireDecision::EnemyView;
using AutoFireDecision::MapWatch;
using AutoFireDecision::ScriptStep;

struct Shot { float px, py, tx, ty; };

struct FakeWorld {
    bool      scriptArmed   = true;
    bool      manualEngaged = false;
    bool      shootReady    = true;
    uintptr_t local         = 0x1000;
    uint32_t  sceneEpoch    = 1;
    bool      hpReadable    = true;
    int32_t   hp            = 500;
    bool      posReadable   = true;
    float     px            = 10.f, py = 10.f;
    AimTarget aim           { true, true, 42 };
    struct Enemy { int32_t id; int32_t hp; float x, y; };
    std::vector<Enemy> snapshot { { 42, 900, 14.f, 13.f } };
    float     range         = 8.f;
    bool      fireSucceeds  = true;
    // A cursor the rule must never aim at. Nothing in the World interface
    // exposes it; it is here so a test can prove no shot went there.
    float     cursorX       = -50.f, cursorY = 77.f;

    std::vector<Shot> shots;

    bool      ScriptArmed() const   { return scriptArmed; }
    bool      ManualEngaged() const { return manualEngaged; }
    bool      ShootReady() const    { return shootReady; }
    uintptr_t LocalPlayer() const   { return local; }
    uint32_t  SceneEpoch() const    { return sceneEpoch; }
    bool LocalHp(int32_t& out) const { if (!hpReadable) return false; out = hp; return true; }
    bool PlayerPos(float& x, float& y) const {
        if (!posReadable) return false;
        x = px; y = py;
        return true;
    }
    AimTarget Aim() const { return aim; }
    EnemyView FindEnemy(int32_t id) const {
        for (const Enemy& e : snapshot)
            if (e.id == id) return EnemyView{ true, e.hp, e.x, e.y };
        return EnemyView{};
    }
    float RangeTiles() const { return range; }
    bool Fire(float fromX, float fromY, float toX, float toY) {
        shots.push_back(Shot{ fromX, fromY, toX, toY });
        return fireSucceeds;
    }
};

// The watch settles after kMapSettleMs; tests start well past the first sighting.
static uint64_t Settle(MapWatch& watch, FakeWorld& w, uint64_t now)
{
    ScriptStep(watch, w, now);
    w.shots.clear();
    return now + AutoFireDecision::kMapSettleMs;
}

static void TestFiresAtARealTarget()
{
    FakeWorld w;
    MapWatch watch;
    uint64_t now = Settle(watch, w, 1000);

    CHECK(ScriptStep(watch, w, now) == Block::None, "armed with a valid target did not fire");
    CHECK(w.shots.size() == 1, "expected exactly one shoot call, got %zu", w.shots.size());
    if (!w.shots.empty()) {
        const Shot& s = w.shots[0];
        CHECK(s.px == 10.f && s.py == 10.f, "shot did not leave from the player");
        CHECK(s.tx == 14.f && s.ty == 13.f, "shot did not aim at the target's snapshot position");
        CHECK(s.tx != w.cursorX && s.ty != w.cursorY, "shot aimed at the cursor");
    }

    // Every game update asks again; the game's own attack timer sets the cadence.
    CHECK(ScriptStep(watch, w, now + 16) == Block::None, "second update did not fire");
    CHECK(w.shots.size() == 2, "expected a shoot call per update, got %zu", w.shots.size());
}

static void TestNoTargetNeverFires()
{
    FakeWorld w;
    MapWatch watch;
    uint64_t now = Settle(watch, w, 1000);

    w.aim.hasTarget = false;
    CHECK(ScriptStep(watch, w, now) == Block::NoTarget, "no target was not reported as NoTarget");

    w.aim = AimTarget{ true, true, 0 };
    CHECK(ScriptStep(watch, w, now) == Block::NoTarget, "a target without an id fired");

    w.aim = AimTarget{ false, false, 0 };
    CHECK(ScriptStep(watch, w, now) == Block::AimOff, "Auto Aim off was not reported as AimOff");

    // Auto Aim's flags say "target" but its id is stale: gone from the snapshot.
    w.aim = AimTarget{ true, true, 77 };
    CHECK(ScriptStep(watch, w, now) == Block::NotInSnapshot, "a target missing from the snapshot fired");

    // Auto Aim off with a stale id still set.
    w.aim = AimTarget{ false, true, 42 };
    CHECK(ScriptStep(watch, w, now) == Block::AimOff, "a target published while Auto Aim is off fired");

    CHECK(w.shots.empty(), "fired %zu shots without a real target (cursor fallback)", w.shots.size());
}

static void TestTargetMustBeAliveAndInRange()
{
    FakeWorld w;
    MapWatch watch;
    uint64_t now = Settle(watch, w, 1000);

    w.snapshot[0].hp = 0;
    CHECK(ScriptStep(watch, w, now) == Block::TargetDead, "a dead target fired");
    w.snapshot[0].hp = 900;

    // (10,10) -> (14,13) is exactly 5 tiles.
    w.range = 5.f;
    CHECK(ScriptStep(watch, w, now) == Block::None, "a target exactly at the range edge did not fire");
    w.range = 4.99f;
    CHECK(ScriptStep(watch, w, now) == Block::OutOfRange, "an out-of-range target fired");
    w.range = std::nanf("");
    CHECK(ScriptStep(watch, w, now) == Block::OutOfRange, "a NaN range fired");
    w.range = 8.f;

    w.snapshot[0].x = std::nanf("");
    CHECK(ScriptStep(watch, w, now) == Block::OutOfRange, "a NaN target position fired");
    w.snapshot[0].x = 14.f;

    CHECK(w.shots.size() == 1, "expected only the range-edge shot, got %zu", w.shots.size());
}

static void TestScriptFlagGates()
{
    FakeWorld w;
    MapWatch watch;
    uint64_t now = Settle(watch, w, 1000);

    w.scriptArmed = false;
    CHECK(ScriptStep(watch, w, now) == Block::NotArmed, "fired with autoFireEnabled off");
    CHECK(w.shots.empty(), "fired with autoFireEnabled off");

    w.scriptArmed = true;
    w.shootReady = false;
    CHECK(ScriptStep(watch, w, now) == Block::NotReady, "fired while BootGate/bindings are not ready");
    CHECK(w.shots.empty(), "fired while not ready");
}

static void TestPlayerStateGates()
{
    FakeWorld w;
    MapWatch watch;
    uint64_t now = Settle(watch, w, 1000);

    w.hp = 0;
    CHECK(ScriptStep(watch, w, now) == Block::Dead, "fired while dead");
    w.hp = 500;
    w.hpReadable = false;
    CHECK(ScriptStep(watch, w, now) == Block::Dead, "fired with an unreadable HP");
    w.hpReadable = true;

    w.posReadable = false;
    CHECK(ScriptStep(watch, w, now) == Block::NoPosition, "fired with an unreadable position");
    w.posReadable = true;
    w.px = std::nanf("");
    CHECK(ScriptStep(watch, w, now) == Block::NoPosition, "fired from a NaN position");
    w.px = 10.f;

    w.local = 0;
    CHECK(ScriptStep(watch, w, now) == Block::NoLocal, "fired with no local player");

    CHECK(w.shots.empty(), "fired %zu shots in a blocked player state", w.shots.size());
}

// A hotkey-held (or auto-break-walls) fire owns the trigger; the script path
// steps aside so the two never call ShootWithAngle from two threads at once.
static void TestManualOwnsTheTrigger()
{
    FakeWorld w;
    MapWatch watch;
    uint64_t now = Settle(watch, w, 1000);

    w.manualEngaged = true;
    CHECK(ScriptStep(watch, w, now) == Block::Manual, "script fired while the hotkey path was engaged");
    CHECK(w.shots.empty(), "script fired while the hotkey path was engaged");
    w.manualEngaged = false;
    CHECK(ScriptStep(watch, w, now) == Block::None, "script did not resume after the hotkey released");
}

// The hotkey rule is the pre-existing one, verbatim:
//   engaged = autoEngaged || (vk != 0 && KeyDown(vk)); if (menuOpen && !autoEngaged) engaged = false;
static void TestHotkeyRuleUnchanged()
{
    for (int bits = 0; bits < 8; ++bits) {
        const bool autoEngaged = (bits & 1) != 0;
        const bool hotkeyDown  = (bits & 2) != 0;
        const bool menuOpen    = (bits & 4) != 0;
        bool legacy = autoEngaged || hotkeyDown;
        if (menuOpen && !autoEngaged) legacy = false;
        CHECK(AutoFireDecision::ManualEngaged(autoEngaged, hotkeyDown, menuOpen) == legacy,
              "manual rule differs from the legacy rule for auto=%d key=%d menu=%d",
              autoEngaged ? 1 : 0, hotkeyDown ? 1 : 0, menuOpen ? 1 : 0);
    }
}

static void TestStopConditions()
{
    FakeWorld w;
    MapWatch watch;
    uint64_t now = Settle(watch, w, 1000);

    CHECK(ScriptStep(watch, w, now) == Block::None, "baseline did not fire");

    // Target lost: the very next update does not fire.
    w.aim.hasTarget = false;
    CHECK(ScriptStep(watch, w, now + 16) != Block::None, "fired on the update after the target was lost");
    w.aim.hasTarget = true;

    // Target killed between Auto Aim's pick and this update: gone from the snapshot.
    w.snapshot.clear();
    CHECK(ScriptStep(watch, w, now + 32) == Block::NotInSnapshot, "fired at a target that left the snapshot");
    w.snapshot.push_back({ 42, 900, 14.f, 13.f });

    // Script turns autoFireEnabled off.
    w.scriptArmed = false;
    CHECK(ScriptStep(watch, w, now + 48) == Block::NotArmed, "fired after the script disarmed");
    w.scriptArmed = true;

    CHECK(w.shots.size() == 1, "expected only the baseline shot, got %zu", w.shots.size());
}

static void TestMapChangeStopsAndResettles()
{
    FakeWorld w;
    MapWatch watch;
    uint64_t now = Settle(watch, w, 1000);
    CHECK(ScriptStep(watch, w, now) == Block::None, "baseline did not fire");

    // New map: the game builds a new local player object. An enemy with the same
    // id exists in the new map, which must not be shot straight away.
    w.local = 0x2000;
    CHECK(ScriptStep(watch, w, now + 16) == Block::MapSettling, "fired on the update the map changed");
    CHECK(ScriptStep(watch, w, now + 16 + AutoFireDecision::kMapSettleMs - 1) == Block::MapSettling,
          "fired before the settle window elapsed");
    CHECK(ScriptStep(watch, w, now + 16 + AutoFireDecision::kMapSettleMs) == Block::None,
          "did not resume once the new map settled with a real target");

    // Passing through "no local player" and back to the SAME object is not a map change.
    now += 10000;
    w.local = 0;
    CHECK(ScriptStep(watch, w, now) == Block::NoLocal, "fired with no local player");
    w.local = 0x2000;
    CHECK(ScriptStep(watch, w, now + 16) == Block::None, "a null flicker restarted the settle window");

    // A scene reset (HELLO on a new connection) stops firing before the new player exists.
    w.sceneEpoch = 2;
    CHECK(ScriptStep(watch, w, now + 32) == Block::MapSettling, "fired on the update a scene reset arrived");
    CHECK(ScriptStep(watch, w, now + 32 + AutoFireDecision::kMapSettleMs) == Block::None,
          "did not resume after the scene reset settled");

    // The watch keeps observing while disarmed, so a map change made while the
    // script had firing off still settles before the first shot after re-arming.
    w.scriptArmed = false;
    now += 10000;
    w.local = 0x3000;
    CHECK(ScriptStep(watch, w, now) == Block::NotArmed, "disarmed step fired");
    w.scriptArmed = true;
    CHECK(ScriptStep(watch, w, now + 16) == Block::MapSettling, "re-arming right after a map change fired");

    CHECK(w.shots.size() == 4, "expected 4 shots across the map changes, got %zu", w.shots.size());
}

static void TestFirstSightingSettles()
{
    FakeWorld w;
    MapWatch watch;
    CHECK(ScriptStep(watch, w, 5000) == Block::MapSettling, "fired on the very first update after injection");
    CHECK(ScriptStep(watch, w, 5000 + AutoFireDecision::kMapSettleMs) == Block::None,
          "did not fire once the first map settled");
}

static void TestFailedShootCallIsReported()
{
    FakeWorld w;
    MapWatch watch;
    uint64_t now = Settle(watch, w, 1000);
    w.fireSucceeds = false;
    CHECK(ScriptStep(watch, w, now) == Block::FireFailed, "a faulted shoot call was reported as fired");
}

static void TestNamesCoverEveryBlock()
{
    for (int b = 0; b <= static_cast<int>(Block::FireFailed); ++b) {
        const char* n = AutoFireDecision::Name(static_cast<Block>(b));
        CHECK(n && n[0] && n[0] != '?', "Block %d has no name", b);
    }
}

int main()
{
    TestFiresAtARealTarget();
    TestNoTargetNeverFires();
    TestTargetMustBeAliveAndInRange();
    TestScriptFlagGates();
    TestPlayerStateGates();
    TestManualOwnsTheTrigger();
    TestHotkeyRuleUnchanged();
    TestStopConditions();
    TestMapChangeStopsAndResettles();
    TestFirstSightingSettles();
    TestFailedShootCallIsReported();
    TestNamesCoverEveryBlock();
    std::printf("autofire_decision_tests: %d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
