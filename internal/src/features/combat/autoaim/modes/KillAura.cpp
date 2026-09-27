#include "pch-il2cpp.h"

#include "features/combat/autoaim/modes/KillAura.h"
#include "features/combat/autoaim/shoot/ShotTransaction.h"
#include "features/combat/enemytracker/EnemyTracker.h"
#include "features/combat/autoaim/core/TargetSelector.h"
#include "features/combat/autoaim/core/WeaponProfile.h"
#include "ProjectileTracking.h"
#include "GameState.h"
#include "game/objects/GameObjects.h"
#include "gui/tabs/TestTAB.h"
#include "game/math/W2S.h"
#include "DbgFileLog.h"
#include <imgui/imgui.h>

#include <Windows.h>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>

// ═══════════════════════════════════════════════════════════════════════════
// DESIGN — native shot transaction (owner decision, 2026-09-26)
// ═══════════════════════════════════════════════════════════════════════════
//
// This file chooses WHAT to shoot at. ShotTransaction (shoot/ShotTransaction.*)
// edits HOW each local shot leaves, inside the game's own attack call, so the
// game keeps ownership of cooldowns, bullet ids, projectile counts, bursts,
// sub-attacks, spread and spawn offsets:
//
//   * Per projectile, at the map add, the origin moves from the player toward
//     the aim point — at most 2 tiles from the player, stopping `standoff` short
//     of the aim point — and the angle points from that origin at the aim point
//     with the game's own spread offset kept.
//   * The aim point is this file's target (lead-predicted from the moved origin
//     with the projectile's own speed) when that target is within the
//     projectile's range of the moved origin; otherwise the mouse point, under
//     the same range rule; otherwise the shot is left natural.
//   * The outgoing PlayerShoot borrows the same origin and angle while it is
//     serialized, and the projectile keeps its edit only if the message was
//     really written with those values in the same session. Nothing else moves:
//     playerPosition stays the player's real position.
//
// History: the earlier proxy-side PLAYERSHOOT rewrite and a local-only bullet
// move (2026-08) displaced the origin by up to the whole selection radius and
// never kept the local projectile and the packet in step; both are removed.
//
// Tick publishes a ShotTarget (target position/velocity, mouse point, standoff)
// every refresh; the game thread reads it per projectile. Target selection,
// retention and stickiness below are unchanged.
// ═══════════════════════════════════════════════════════════════════════════

namespace {

// ── Settings (relaxed atomics — written from the IPC/UI threads, read here) ───
static std::atomic<bool>    s_enabled{ false };
static std::atomic<int>     s_modeInt{ 0 };
// 0 = AUTO (the default): the selection radius is the WEAPON's own resolved
// range, derived by TargetSelector from the calibrated projectile properties. A
// non-zero value is a shrink-only CAP over that radius — see SetRangeTiles. A
// previous flat 16 REPLACED the weapon range and locked targets out of reach;
// this default undoes that.
static std::atomic<float>   s_rangeTiles{ 0.f };
static std::atomic<float>   s_standoffTiles{ 0.35f };
// The radius the last armed tick actually selected on (weapon range under the
// cap). Published so the overlay and the retention drop radius read the SAME
// number the selector filtered on. 0 until the first armed tick.
static std::atomic<float>   s_effRangeTiles{ 0.f };
static std::atomic<int32_t> s_forcedTargetId{ 0 };
static std::atomic<bool>    s_overlayEnabled{ true };   // default ON — see KillAura.h

// ── Target-retention hysteresis ──────────────────────────────────────────────
// Tick() refreshes at up to ~125 Hz. A SINGLE refresh where the selector comes
// up empty used to disarm and then re-arm on the SAME enemy ~19 ms later, and
// every refresh spent disarmed fires a vanilla (missed) shot. So the lock is
// held across a short run of selector misses instead of being dropped on the
// first one. Same commitment/anti-flip-flop idea as the dodge solver's
// kSolveReflexHystEps / kUReturnRangeSlack (features/movement/udodge/UDodgeTypes.h).
//
// Retention is only ever a BRIDGE over a momentary miss, and the distinction it
// turns on is POSITIVE EVIDENCE vs mere absence: a target the snapshot still
// carries but that is dead, no longer damageable, or past the drop radius is
// dropped on the spot and never retained. An id that is simply MISSING from the
// snapshot is NOT evidence of death — the snapshot is rebuilt periodically and an
// entry can momentarily fail a filter, which is precisely the transient this
// grace window exists to ride out. See RetainVerdict.
//
// Grace window measured from the FIRST miss of a run. ~250 ms is a handful of
// refreshes — long enough to ride out a snapshot rebuilt mid-frame or one
// boundary-straddling tick, short enough that a genuinely gone enemy is
// released well inside human reaction time.
static constexpr ULONGLONG kKaRetainMs = 250ULL;
// Drop at range + margin, RE-ACQUIRE at plain range. The asymmetry is the whole
// point: an enemy sitting exactly on the selection radius — routine while the
// dodge is walking the player around — cannot flap in and out of the lock.
static constexpr float kKaRetainRangeMarginTiles = 2.0f;

// ── Selection stickiness (incumbent bias) ────────────────────────────────────
// Retention above only bridges selector MISSES. It does nothing about the other
// flip-flop: two similarly-ranked enemies, the selector nominating first one
// then the other, and the lock following it every ~200 ms. Each of those swaps
// moves the shot origin mid-burst, so the shots split between two enemies and
// neither dies. So a HELD target is not given up merely because someone else
// edged ahead — the challenger has to be clearly better.
//
// "Clearly better" is measured on the selector's own ranking metric: tier
// first (TargetSelector::KillAuraTierRank — a categorical priority, so a
// better tier switches with no margin at all), then distance from the same
// reference point Select() uses. The margin is therefore in TILES of that
// distance.
//
// 1.5 tiles: an enemy pack is dense enough that two targets within ~1 tile of
// equal distance are interchangeable, and with both sides moving, the frame-to-
// frame distance delta at ~125 Hz is on the order of 0.05 tiles — pure noise
// that must never cost a burst. 1.5 tiles is roughly one enemy-body step and
// ~9% of the default 16-tile radius: big enough that only a real improvement
// pays for abandoning a burst, small enough that an enemy walking into melee
// range still takes the lock. Same commitment/anti-flip-flop spirit as the
// dodge solver's kSolveReflexHystEps / kUReturnRangeSlack.
static constexpr float kKaSwitchMarginTiles = 1.5f;
// A suppressed switch is a STEADY condition, not an event: KaRefresh runs at up
// to ~125 Hz, so the unguarded log would be one line per refresh. One line when
// the (keep, challenger) pair changes and at most one per second while the same
// pair keeps losing — with a hard floor so an alternating challenger can never
// turn the pair-change term into a per-refresh log.
static constexpr ULONGLONG kKaSuppressLogEveryMs = 1000ULL;
static constexpr ULONGLONG kKaSuppressLogFloorMs = 250ULL;

// ── Published state (render thread writes; overlay/GUI read) ─────────────────
static std::atomic<bool>     s_armed{ false };
static std::atomic<int32_t>  s_targetId{ 0 };
static std::atomic<float>    s_tx{ 0.f };
static std::atomic<float>    s_ty{ 0.f };
static std::atomic<float>    s_px{ 0.f };
static std::atomic<float>    s_py{ 0.f };
static std::atomic<uint32_t> s_stampMs{ 0 };

// ── The shot target slot (render thread writes, game thread reads) ───────────
// A struct copy behind a one-word spin flag. The writer holds it for a copy of
// ~50 bytes; a reader that finds it held retries a few times and otherwise
// reports "no input", which leaves that one shot natural. Never blocks either
// thread for longer than that.
static std::atomic_flag       s_slotBusy = ATOMIC_FLAG_INIT;
static KillAura::ShotTarget   s_slot;
static bool                   s_slotValid = false;
static uint32_t               s_slotGen   = 0;

static void WriteSlot(bool valid, const KillAura::ShotTarget& t)
{
    while (s_slotBusy.test_and_set(std::memory_order_acquire)) { /* reader copy is short */ }
    s_slot = t;
    s_slot.generation = ++s_slotGen;
    s_slotValid = valid;
    s_slotBusy.clear(std::memory_order_release);
}

// ── Render-thread-only bookkeeping ───────────────────────────────────────────
static ULONGLONG s_lastThrottleMs      = 0;
static ULONGLONG s_lastAliveLogMs      = 0;
static int       s_lastArmed           = -1;   // -1 = no edge observed yet
static int32_t   s_lastTargetId        = 0;
static bool      s_loggedFirstSelect   = false;
static int32_t   s_heldTargetId        = 0;   // current lock (0 = none), retention subject
static ULONGLONG s_retainSinceMs       = 0;   // wall clock of the first miss in this run
static unsigned  s_retainMisses        = 0;   // consecutive selector misses bridged so far
static int32_t   s_supprKeepId        = 0;   // last logged suppressed-switch pair (incumbent)
static int32_t   s_supprCandId        = 0;   // last logged suppressed-switch pair (challenger)
static ULONGLONG s_supprLogMs         = 0;   // wall clock of the last suppressed-switch line

static float ClampF(float v, float lo, float hi, float fallback)
{
    if (!std::isfinite(v)) return fallback;
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

// Live position and velocity of `id` from the current EnemyTracker snapshot.
static bool SnapshotEntry(int32_t id, float& x, float& y, float& vx, float& vy)
{
    if (id == 0) return false;
    for (const EnemyTracker::Entry& e : EnemyTracker::GetSnapshot()) {
        if (e.id != id) continue;
        if (!std::isfinite(e.x) || !std::isfinite(e.y)) return false;
        x = e.x; y = e.y;
        vx = std::isfinite(e.vx) ? e.vx : 0.f;
        vy = std::isfinite(e.vy) ? e.vy : 0.f;
        return true;
    }
    return false;
}

// Publishes what the shot edit reads: the committed target (its live position
// and velocity; the game thread does its own lead from the moved origin), the
// mouse point, and the standoff. Called from ApplyState, i.e. every refresh
// while enabled. When the target is not in the snapshot (a bridged retention
// miss) the last committed aim point stands in, without velocity.
static void PublishShotTarget(bool armed, int32_t targetId, float tx, float ty, uint32_t stamp)
{
    KillAura::ShotTarget t;
    if (armed && targetId != 0) {
        float x = tx, y = ty, vx = 0.f, vy = 0.f;
        if (!SnapshotEntry(targetId, x, y, vx, vy)) { x = tx; y = ty; vx = 0.f; vy = 0.f; }
        if (std::isfinite(x) && std::isfinite(y)) {
            t.hasTarget = true;
            t.targetId  = targetId;
            t.ex = x; t.ey = y; t.vx = vx; t.vy = vy;
        }
    }
    const float mx = TestTAB::GetMouseWorldX();
    const float my = TestTAB::GetMouseWorldY();
    if ((mx != 0.f || my != 0.f) && std::isfinite(mx) && std::isfinite(my)) {
        t.hasMouse = true;
        t.mx = mx; t.my = my;
    }
    t.standoffTiles = s_standoffTiles.load(std::memory_order_relaxed);
    t.stampMs = stamp;
    WriteSlot(true, t);
}

// Stores the tick result, logs the ARMED/disarmed EDGE only, and publishes the
// shot target.
static void ApplyState(bool armed, int32_t targetId,
                       float tx, float ty, float px, float py,
                       const char* disarmReason)
{
    const uint32_t stamp = static_cast<uint32_t>(GetTickCount64());

    s_armed.store(armed, std::memory_order_relaxed);
    s_targetId.store(armed ? targetId : 0, std::memory_order_relaxed);
    s_tx.store(tx, std::memory_order_relaxed);
    s_ty.store(ty, std::memory_order_relaxed);
    s_px.store(px, std::memory_order_relaxed);
    s_py.store(py, std::memory_order_relaxed);
    s_stampMs.store(stamp, std::memory_order_relaxed);

    const int  nowArmed = armed ? 1 : 0;
    const bool edge     = (s_lastArmed != nowArmed);
    if (edge) {
        if (armed) {
            DBG_FILE_LOG("[KillAura] ARMED targetId=" << targetId
                         << " mode=" << s_modeInt.load(std::memory_order_relaxed));
        } else {
            DBG_FILE_LOG("[KillAura] disarmed reason=" << (disarmReason ? disarmReason : "unknown")
                         << " lastTargetId=" << s_lastTargetId);
        }
        s_lastArmed = nowArmed;
    }
    if (armed) s_lastTargetId = targetId;
    // Disarm is the ONE place the lock dies, whatever the path in — no route to
    // ApplyState(false, ...) may leave a stale target behind for retention.
    if (!armed) { s_heldTargetId = 0; s_retainMisses = 0; }

    // Disabled publishes nothing (the slot is cleared in Tick); enabled-but-
    // disarmed still publishes the mouse point for the fallback.
    if (s_enabled.load(std::memory_order_relaxed))
        PublishShotTarget(armed, targetId, tx, ty, stamp);
}

// Selection reference point — mirrors TargetSelector::Select(): the player, or
// the mouse world position in "at mouse" mode (falling back to the player when
// the mouse projection has not been computed yet).
static void RefPoint(bool atMouse, float px, float py, float& rx, float& ry)
{
    rx = px; ry = py;
    if (!atMouse) return;
    const float mx = TestTAB::GetMouseWorldX();
    const float my = TestTAB::GetMouseWorldY();
    if (mx != 0.f || my != 0.f) { rx = mx; ry = my; }
}

// Retention validity gate — the INVARIANT, as a TRI-STATE. Absence from the
// snapshot used to be folded into "invalid", which made the transient retention
// was built to bridge indistinguishable from proof of death, and dropped the
// lock ~35 ms after arming on an enemy that was still very much alive.
//
//   Valid   — in the CURRENT snapshot and still a legal killaura target:
//             alive, health-barred, damageable, finite, within range + margin.
//   Invalid — in the snapshot but FAILING one of those checks. Positive
//             evidence the target should go: callers drop on the spot.
//   Absent  — the id is not in this snapshot at all. Says nothing about whether
//             the enemy died; it is the momentary miss the grace window covers.
enum class RetainVerdict { Valid, Invalid, Absent };

static RetainVerdict ClassifyRetainedTarget(int32_t id, float rx, float ry, float rangeT)
{
    if (id == 0) return RetainVerdict::Invalid;
    const float dropR = rangeT + kKaRetainRangeMarginTiles;
    for (const EnemyTracker::Entry& e : EnemyTracker::GetSnapshot()) {
        if (e.id != id) continue;
        if (e.hp <= 0)        return RetainVerdict::Invalid;   // dead
        if (!e.hasHealthBar)  return RetainVerdict::Invalid;   // same filter acquisition applied
        if (e.isInvulnerable) return RetainVerdict::Invalid;   // no longer damageable
        if (!std::isfinite(e.x) || !std::isfinite(e.y)) return RetainVerdict::Invalid;
        const float dx = e.x - rx, dy = e.y - ry;
        return (dx * dx + dy * dy <= dropR * dropR) ? RetainVerdict::Valid
                                                    : RetainVerdict::Invalid;
    }
    return RetainVerdict::Absent;   // not in THIS snapshot — bridgeable, not proof of death
}

// The selector's ranking values for one id, read out of the CURRENT snapshot:
// tier rank (lower wins) and distance in tiles from the reference point. Select()
// ranks on the enemy's live position, not on the lead-predicted aim point, so
// this reads the same positions it does. False when the id is not selectable.
static bool CandidateScore(int32_t id, float rx, float ry, int& rank, float& distT)
{
    if (id == 0) return false;
    for (const EnemyTracker::Entry& e : EnemyTracker::GetSnapshot()) {
        if (e.id != id) continue;
        if (!std::isfinite(e.x) || !std::isfinite(e.y)) return false;
        const float dx = e.x - rx, dy = e.y - ry;
        rank  = TargetSelector::KillAuraTierRank(e.objType);
        distT = std::sqrt(dx * dx + dy * dy);
        return true;
    }
    return false;
}

// Transition-keyed + rate-limited: see kKaSuppressLogEveryMs.
static void LogSuppressedSwitch(int32_t keepId, int32_t candId, float delta)
{
    const ULONGLONG now = GetTickCount64();
    if (now - s_supprLogMs < kKaSuppressLogFloorMs) return;
    const bool newPair = (keepId != s_supprKeepId || candId != s_supprCandId);
    if (!newPair && now - s_supprLogMs < kKaSuppressLogEveryMs) return;
    s_supprKeepId = keepId; s_supprCandId = candId; s_supprLogMs = now;
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.2f < margin=%.2f", delta, kKaSwitchMarginTiles);
    DBG_FILE_LOG("[KillAura] switch suppressed: keeping " << keepId
                 << " over " << candId << " (delta=" << buf << " tiles)");
}

// Incumbent bias. Called only when the selector nominated a DIFFERENT enemy
// than the one currently held. Returns true to KEEP the incumbent (aim point
// re-resolved into outAimX/Y), false to take the selector's pick.
//
// Every early false is deliberate: stickiness may delay a switch, but it must
// never keep a target the selector would have been right to drop.
static bool KeepIncumbentOverPick(int32_t heldId, const TargetSelector::Result& pick,
                                  bool atMouse, float px, float py,
                                  float rangeT, float rangeCap,
                                  float& outAimX, float& outAimY)
{
    float rx = px, ry = py;
    RefPoint(atMouse, px, py, rx, ry);

    // Dead / no longer damageable / past range+margin — the same invariant
    // retention enforces, reused rather than re-stated. Only Valid keeps the
    // incumbent, and Absent counting as "cannot keep" is deliberate rather than
    // accidental: an incumbent the snapshot does not carry cannot be SCORED
    // against the challenger — CandidateScore reads that same snapshot and would
    // fail two lines down — so there is nothing to bias the comparison with.
    if (ClassifyRetainedTarget(heldId, rx, ry, rangeT) != RetainVerdict::Valid) return false;

    int   heldRank = 0,   candRank = 0;
    float heldDist = 0.f, candDist = 0.f;
    if (!CandidateScore(heldId, rx, ry, heldRank, heldDist)) return false;
    if (!CandidateScore(pick.enemyId, rx, ry, candRank, candDist)) return false;

    // A better TIER is a categorical priority in Select(), not a distance
    // difference — it outranks the incumbent with no margin to clear.
    if (candRank < heldRank) return false;
    const float delta = heldDist - candDist;   // how much closer the challenger is
    if (candRank == heldRank && delta > kKaSwitchMarginTiles) return false;

    // Keeping it: re-resolve the held id through the selector's forced path so
    // the aim point keeps its live lead prediction instead of freezing.
    const TargetSelector::Result h = TargetSelector::SelectKillAura(
        atMouse, rangeCap, px, py, heldId, WeaponCalibrator::GetProfile());
    if (!h.found) return false;

    outAimX = h.aimX; outAimY = h.aimY;
    LogSuppressedSwitch(heldId, pick.enemyId, delta);
    return true;
}

// ── Lock-overlay drawing helpers (render thread, draw-only) ──────────────────
// World→screen goes through the repo's one projection helper (game/math/W2S.h),
// exactly as the dodge overlays do — no local camera math.
struct OverlayCam { float camX, camY, angle, zoom, cx, cy; };

static bool ToScreen(const OverlayCam& c, float wx, float wy, ImVec2& out)
{
    if (!std::isfinite(wx) || !std::isfinite(wy)) return false;
    float sx = 0.f, sy = 0.f;
    if (!W2S(wx, wy, sx, sy, c.camX, c.camY, c.angle, c.zoom, c.cx, c.cy)) return false;
    if (!std::isfinite(sx) || !std::isfinite(sy)) return false;
    out = ImVec2(sx, sy);
    return true;
}

// A world-space radius drawn as a screen circle. W2S is a rigid rotation plus a
// uniform scale, so one projected offset point gives the exact screen radius.
static void DrawWorldRing(ImDrawList* dl, const OverlayCam& c,
                          float wx, float wy, float radiusTiles,
                          ImU32 col, float thickness)
{
    ImVec2 sc, se;
    if (!ToScreen(c, wx, wy, sc)) return;
    if (!ToScreen(c, wx + radiusTiles, wy, se)) return;
    const float r = std::sqrt((se.x - sc.x) * (se.x - sc.x) + (se.y - sc.y) * (se.y - sc.y));
    if (!std::isfinite(r) || r < 2.f || r > 6000.f) return;
    dl->AddCircle(sc, r, col, 48, thickness);
}

// The lock marker: a diamond (rotated square), deliberately unlike the circles
// and crosshairs the dodge/planner overlays already use, so the killaura lock is
// unmistakable when several overlays are on at once.
static void DrawLockDiamond(ImDrawList* dl, ImVec2 s, float halfPx, ImU32 col, float thickness)
{
    const ImVec2 pts[4] = {
        ImVec2(s.x, s.y - halfPx), ImVec2(s.x + halfPx, s.y),
        ImVec2(s.x, s.y + halfPx), ImVec2(s.x - halfPx, s.y)
    };
    dl->AddPolyline(pts, 4, col, ImDrawFlags_Closed, thickness);
}

// Live world position of the locked id from the current EnemyTracker snapshot.
// Falls back to the published aim point when the id is not in the snapshot.
static bool SnapshotPos(int32_t id, float& x, float& y)
{
    if (id == 0) return false;
    for (const EnemyTracker::Entry& e : EnemyTracker::GetSnapshot()) {
        if (e.id != id) continue;
        if (!std::isfinite(e.x) || !std::isfinite(e.y)) return false;
        x = e.x; y = e.y;
        return true;
    }
    return false;
}


// 30 s heartbeat with the shot-edit counters, so a trace log says whether shots
// were being edited, kept, undone or skipped (and why) without a debugger.
static void LogAlive()
{
    const ULONGLONG now = GetTickCount64();
    if (now - s_lastAliveLogMs < 30000ULL) return;
    s_lastAliveLogMs = now;
    const ShotTransaction::Stats st = ShotTransaction::GetStats();
    DBG_FILE_LOG("[KillAura] alive armed=" << (s_armed.load(std::memory_order_relaxed) ? 1 : 0)
                 << " id=" << s_targetId.load(std::memory_order_relaxed)
                 << " txn=" << ShotTransaction::InstallStatus()
                 << " scopes=" << st.scopes << " staged=" << st.staged
                 << " edited=" << st.edited << " committed=" << st.committed
                 << " (target " << st.targetShots << ", mouse " << st.mouseShots << ")"
                 << " restored=" << st.restored << " skipped=" << st.skipped
                 << " mismatch=" << st.packetMismatch << " notSerialized=" << st.notSerialized
                 << " sessionChanged=" << st.sessionChanged
                 << " containerDisagree=" << st.containerDisagree
                 << " lastSkip=" << ShotTransaction::LastSkipReason()
                 << " lastRestore=" << ShotTransaction::LastRestoreReason());
}

} // namespace

namespace KillAura {

void Tick()
{
    if (!s_enabled.load(std::memory_order_relaxed)) {
        // Disabled: hold the disarm edge once and withdraw the shot target, so
        // the game thread stops editing on the very next shot.
        if (s_armed.load(std::memory_order_relaxed) || s_lastArmed != 0) {
            ApplyState(false, 0, 0.f, 0.f, 0.f, 0.f, "disabled");
            WriteSlot(false, KillAura::ShotTarget{});
        }
        return;
    }

    const ULONGLONG wall = GetTickCount64();
    if (wall - s_lastThrottleMs < 8ULL) return;
    s_lastThrottleMs = wall;

    // Both self-guard and retry on their own schedule; the shot edit needs the
    // projectile spawn hook for its creation step.
    ProjectileTracking::Install();
    ShotTransaction::Install();

    LogAlive();

    void* local = GameState::GetLocalPtr();
    if (!local) {
        ApplyState(false, 0, 0.f, 0.f, 0.f, 0.f, "no-local");
        return;
    }

    float px = 0.f, py = 0.f;
    if (!Game::Entity(local).TryPos(px, py)) {
        ApplyState(false, 0, 0.f, 0.f, 0.f, 0.f, "pos-read-failed");
        return;
    }

    // Shared data sources for target selection. Both are self-throttled, so
    // this is deduped against the auto-aim path.
    WeaponCalibrator::Tick(local);
    EnemyTracker::Tick();

    // ── Range resolution ─────────────────────────────────────────────────────
    // REFUSE TO ARM until the weapon profile is calibrated. `rangeTiles` on an
    // uncalibrated profile is a 15.0 PLACEHOLDER, not a measurement, and acting
    // on it is precisely the failure this feature was just fixed for: selecting
    // targets the player cannot reach, whose hit claims the server then refuses.
    // Calibration happens on the first local shot (WeaponCalibrator::
    // OnProjectileSpawn) and resets on realm transition — killaura never pulls
    // the trigger, so the cost is that the FIRST shot of a realm is vanilla and
    // every shot after it is armed. That is self-healing and honest; treating
    // the placeholder as truth is neither.
    const WeaponProfile& weapon = WeaponCalibrator::GetProfile();
    if (!weapon.isResolved) {
        ApplyState(false, 0, 0.f, 0.f, px, py, "weapon-uncalibrated");
        return;
    }

    const int32_t forced   = s_forcedTargetId.load(std::memory_order_relaxed);
    const bool    atMouse  = (s_modeInt.load(std::memory_order_relaxed) == 1);
    // The user's setting is a SHRINK-ONLY cap (0 = auto); the radius that
    // actually applies comes from the selector so retention and the overlay
    // rings cannot disagree with what Select() filtered on.
    // SelectKillAura takes the CAP and derives the radius itself — handing it
    // the already-derived radius would shrink it a second time.
    const float   rangeCap = s_rangeTiles.load(std::memory_order_relaxed);
    const float   rangeT   = TargetSelector::KillAuraSelectionRangeTiles(weapon, rangeCap);
    s_effRangeTiles.store(rangeT, std::memory_order_relaxed);

    const TargetSelector::Result r = TargetSelector::SelectKillAura(
        atMouse, rangeCap, px, py, forced, weapon);

    if (r.found) {
        if (!s_loggedFirstSelect) {
            s_loggedFirstSelect = true;
            DBG_FILE_LOG("[KillAura] armed via TargetSelector::SelectKillAura mode="
                         << s_modeInt.load(std::memory_order_relaxed)
                         << " range=" << rangeT);
        }
        // Stickiness runs BEFORE the pick is committed: a held target is only
        // traded for a clearly better one. A FORCED target is excluded — that
        // id is auto-break-walls' choice, not the selector's, so there is
        // nothing to bias.
        int32_t pickId = r.enemyId;
        float   aimX   = r.aimX, aimY = r.aimY;
        if (forced == 0 && s_heldTargetId != 0 && r.enemyId != s_heldTargetId
            && KeepIncumbentOverPick(s_heldTargetId, r, atMouse, px, py,
                                     rangeT, rangeCap, aimX, aimY)) {
            pickId = s_heldTargetId;
        }

        // Transition-only: closes a bridged run, so the log shows how much of a
        // gap retention actually covered. Never fires on a clean refresh.
        if (s_retainMisses > 0) {
            DBG_FILE_LOG("[KillAura] retained-lock recovered targetId=" << pickId
                         << " heldId=" << s_heldTargetId
                         << " bridgedMisses=" << s_retainMisses
                         << " bridgedMs=" << (wall - s_retainSinceMs));
            s_retainMisses = 0;
        }
        s_heldTargetId = pickId;
        ApplyState(true, pickId, aimX, aimY, px, py, nullptr);
        return;
    }

    // ── Selector came up empty ───────────────────────────────────────────────
    // Retention bridges the miss when the held target is demonstrably still
    // there. A FORCED target is excluded on purpose: auto-break-walls owns that
    // id and "gone" is the signal it acts on, so its semantics stay untouched.
    const char* dropReason = (forced != 0) ? "forced-target-gone" : "no-target";
    if (forced == 0 && s_heldTargetId != 0) {
        float rx = px, ry = py;
        RefPoint(atMouse, px, py, rx, ry);
        const RetainVerdict verdict = ClassifyRetainedTarget(s_heldTargetId, rx, ry, rangeT);
        const bool expired = (s_retainMisses > 0 && wall - s_retainSinceMs > kKaRetainMs);
        if (verdict == RetainVerdict::Invalid) {
            dropReason = "retain-invalid";        // dead / not damageable / past range+margin
        } else if (expired) {
            // Grace window used up. The two ways a run can run out are worth
            // telling apart in the trace: bridged selector misses on a target the
            // snapshot still shows, vs an id the snapshot never brought back.
            dropReason = (verdict == RetainVerdict::Absent) ? "retain-absent-expired"
                                                           : "retain-expired";
        } else if (verdict == RetainVerdict::Absent) {
            // The id is missing from the snapshot, which is NOT proof it died —
            // it is the transient kKaRetainMs exists for, so stay armed and count
            // it against the window.
            //
            // Deliberately NOT the bridge path below: SelectKillAura reads the
            // SAME snapshot, so forcing the held id through it would also come up
            // empty and the lock would die as retain-resolve-failed — moving the
            // bug, not fixing it. Hold the last aim point already committed for
            // this target instead. Freezing the aim — i.e. giving up lead
            // prediction — for at most 250 ms is the right trade against dropping
            // the lock outright, which costs vanilla (missed) shots for the rest
            // of the burst.
            const float hx = s_tx.load(std::memory_order_relaxed);
            const float hy = s_ty.load(std::memory_order_relaxed);
            if (std::isfinite(hx) && std::isfinite(hy)) {
                if (s_retainMisses == 0) {
                    s_retainSinceMs = wall;
                    // Transition-only (once per bridged run, never per refresh):
                    // this is a BRIDGED drop, not a real one — no disarm edge.
                    DBG_FILE_LOG("[KillAura] retained targetId=" << s_heldTargetId
                                 << " reason=snapshot-absent (aim frozen, lock bridged, still armed)");
                }
                ++s_retainMisses;
                ApplyState(true, s_heldTargetId, hx, hy, px, py, nullptr);
                return;
            }
            dropReason = "retain-absent-no-aim";  // nothing sane to hold on to
        } else {
            // Re-resolve the SAME id through the selector's locked path so the
            // bridged aim point keeps its lead prediction instead of freezing.
            const TargetSelector::Result h = TargetSelector::SelectKillAura(
                atMouse, rangeCap, px, py, s_heldTargetId, WeaponCalibrator::GetProfile());
            if (h.found) {
                if (s_retainMisses == 0) {
                    s_retainSinceMs = wall;
                    // Transition-only (once per bridged run, not per refresh):
                    // this is a BRIDGED drop, not a real one — no disarm edge.
                    DBG_FILE_LOG("[KillAura] retained targetId=" << s_heldTargetId
                                 << " reason=selector-miss (lock bridged, still armed)");
                }
                ++s_retainMisses;
                ApplyState(true, s_heldTargetId, h.aimX, h.aimY, px, py, nullptr);
                return;
            }
            dropReason = "retain-resolve-failed";
        }
    }

    if (s_retainMisses > 0) {
        DBG_FILE_LOG("[KillAura] retention gave up targetId=" << s_heldTargetId
                     << " bridgedMisses=" << s_retainMisses
                     << " bridgedMs=" << (wall - s_retainSinceMs)
                     << " reason=" << dropReason);
    }
    ApplyState(false, 0, 0.f, 0.f, px, py, dropReason);
}

void SetEnabled(bool on) { s_enabled.store(on, std::memory_order_relaxed); }
bool IsEnabled()         { return s_enabled.load(std::memory_order_relaxed); }

void SetMode(Mode m) {
    s_modeInt.store(m == Mode::AtMouse ? 1 : 0, std::memory_order_relaxed);
}
Mode GetMode() {
    return s_modeInt.load(std::memory_order_relaxed) == 1 ? Mode::AtMouse : Mode::AtTarget;
}

// 0 (and anything non-positive or non-finite) means AUTO: no cap, the weapon's
// own resolved range stands. Falling back to auto rather than to some number we
// invented is the point — an invented radius is how killaura came to lock
// targets out of reach in the first place.
void  SetRangeTiles(float t)
{
    const float v = (std::isfinite(t) && t > 0.f) ? ClampF(t, 1.f, 40.f, 0.f) : 0.f;
    s_rangeTiles.store(v, std::memory_order_relaxed);
}
float GetRangeTiles()             { return s_rangeTiles.load(std::memory_order_relaxed); }

float GetEffectiveRangeTiles()    { return s_effRangeTiles.load(std::memory_order_relaxed); }

void  SetStandoffTiles(float t)   { s_standoffTiles.store(ClampF(t, 0.05f, 1.5f, 0.35f), std::memory_order_relaxed); }
float GetStandoffTiles()          { return s_standoffTiles.load(std::memory_order_relaxed); }

void SetOverlayEnabled(bool on) { s_overlayEnabled.store(on, std::memory_order_relaxed); }
bool IsOverlayEnabled()         { return s_overlayEnabled.load(std::memory_order_relaxed); }

void    SetForcedTargetId(int32_t id) { s_forcedTargetId.store(id, std::memory_order_relaxed); }
int32_t GetForcedTargetId()           { return s_forcedTargetId.load(std::memory_order_relaxed); }

State GetState()
{
    State s;
    s.armed    = s_armed.load(std::memory_order_relaxed);
    s.targetId = s_targetId.load(std::memory_order_relaxed);
    s.tx       = s_tx.load(std::memory_order_relaxed);
    s.ty       = s_ty.load(std::memory_order_relaxed);
    s.px       = s_px.load(std::memory_order_relaxed);
    s.py       = s_py.load(std::memory_order_relaxed);
    s.stampMs  = s_stampMs.load(std::memory_order_relaxed);
    return s;
}

// Any thread; see KillAura.h. The reader copies under the same spin flag the
// render-thread writer holds for one struct copy.
bool GetShotTarget(ShotTarget& out)
{
    if (!s_enabled.load(std::memory_order_relaxed)) return false;
    for (int attempt = 0; attempt < 64; ++attempt) {
        if (!s_slotBusy.test_and_set(std::memory_order_acquire)) {
            const bool valid = s_slotValid;
            const ShotTarget copy = s_slot;
            s_slotBusy.clear(std::memory_order_release);
            if (!valid) return false;
            out = copy;
            return true;
        }
        YieldProcessor();
    }
    return false;
}

void RenderSettings()
{
    ImGui::TextColored(ImVec4(0.5f, 0.95f, 0.65f, 1.f), "KILLAURA");
    ImGui::Spacing();

    bool on = IsEnabled();
    if (ImGui::Checkbox("Enable##kaEnable", &on))
        SetEnabled(on);
    ImGui::SameLine(); ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Edits each of your shots as the game fires it: the projectile starts up to\n"
                          "2 tiles from you toward the target (or the mouse when there is no\n"
                          "reachable target) and flies at it, and the shot packet says the same.\n"
                          "It never pulls the trigger.");

    ImGui::Spacing();
    ImGui::TextDisabled("Target mode");
    int mode = static_cast<int>(GetMode());
    if (ImGui::RadioButton("At target##kaMode0", mode == 0)) SetMode(Mode::AtTarget);
    if (ImGui::RadioButton("At mouse##kaMode1",  mode == 1)) SetMode(Mode::AtMouse);

    ImGui::Spacing();
    ImGui::PushItemWidth(180.f);

    float range = GetRangeTiles();
    if (ImGui::SliderFloat("Range cap (tiles)##kaRange", &range, 0.f, 40.f,
                           range <= 0.f ? "auto (weapon range)" : "%.1f"))
        SetRangeTiles(range);
    ImGui::SameLine(); ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("0 = AUTO: select inside the range your WEAPON actually has\n"
                          "(derived from the calibrated projectile properties).\n\n"
                          "A non-zero value can only SHRINK that radius. Each shot is\n"
                          "still checked on its own: it is edited only when the target\n"
                          "is within that projectile's range of the moved origin.");

    float standoff = GetStandoffTiles();
    if (ImGui::SliderFloat("Standoff (tiles)##kaStandoff", &standoff, 0.05f, 1.5f, "%.2f"))
        SetStandoffTiles(standoff);
    ImGui::SameLine(); ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("How far short of the aim point the moved shot origin stops.\n"
                          "The origin never moves more than 2 tiles from you.");

    ImGui::PopItemWidth();

    bool overlay = IsOverlayEnabled();
    if (ImGui::Checkbox("Lock overlay##kaOverlay", &overlay))
        SetOverlayEnabled(overlay);
    ImGui::SameLine(); ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Draws the locked target and the selection-range ring in world space.\n"
                          "Green = locked, amber = lock held across a selector miss,\n"
                          "dim = enabled with no target. The outer faint ring is the\n"
                          "retention drop radius — between the two rings the lock is kept.");

    ImGui::Spacing();
    const State st = GetState();
    if (st.armed) {
        const uint32_t nowMs = static_cast<uint32_t>(GetTickCount64());
        ImGui::TextColored(ImVec4(0.4f, 1.f, 0.5f, 1.f),
            "ARMED id=%d t=(%.2f,%.2f) age=%ums",
            st.targetId,
            static_cast<double>(st.tx), static_cast<double>(st.ty),
            nowMs - st.stampMs);
    } else {
        ImGui::TextDisabled("disarmed");
    }

    // The uncalibrated case is a REFUSAL to select, not a bug — say so out loud
    // rather than leaving "disarmed" to look like a broken feature.
    const WeaponProfile& wp = WeaponCalibrator::GetProfile();
    if (!wp.isResolved) {
        ImGui::TextColored(ImVec4(1.f, 0.75f, 0.35f, 1.f),
            "weapon not calibrated — fire one shot to arm");
    } else {
        ImGui::TextDisabled("selecting within %.1f tiles (weapon %.1f%s)",
            static_cast<double>(GetEffectiveRangeTiles()),
            static_cast<double>(wp.rangeTiles),
            GetRangeTiles() > 0.f ? ", capped" : "");
    }

    // Shot edit counters (cumulative this session).
    const ShotTransaction::Stats tx = ShotTransaction::GetStats();
    ImGui::TextDisabled("shot edit: %s", ShotTransaction::InstallStatus());
    ImGui::TextDisabled("kept %llu (target %llu, mouse %llu)  undone %llu  natural %llu",
        static_cast<unsigned long long>(tx.committed),
        static_cast<unsigned long long>(tx.targetShots),
        static_cast<unsigned long long>(tx.mouseShots),
        static_cast<unsigned long long>(tx.restored),
        static_cast<unsigned long long>(tx.skipped));
    ImGui::TextDisabled("last natural: %s   last undone: %s",
        ShotTransaction::LastSkipReason(), ShotTransaction::LastRestoreReason());
}

void RenderOverlay(float camX, float camY, float angle, float zoom, float cx, float cy)
{
    if (!s_enabled.load(std::memory_order_relaxed)) return;
    if (!s_overlayEnabled.load(std::memory_order_relaxed)) return;
    if (!std::isfinite(camX) || !std::isfinite(camY) || !std::isfinite(angle) ||
        !std::isfinite(zoom) || zoom <= 0.f || !std::isfinite(cx) || !std::isfinite(cy))
        return;

    ImDrawList* dl = ImGui::GetForegroundDrawList();
    if (!dl) return;

    const OverlayCam cam{ camX, camY, angle, zoom, cx, cy };
    const State st = GetState();
    if (!std::isfinite(st.px) || !std::isfinite(st.py)) return;
    if (st.px == 0.f && st.py == 0.f) return;   // no player position published yet

    const bool  atMouse = (s_modeInt.load(std::memory_order_relaxed) == 1);
    // The radius the last armed tick SELECTED on, not the user's cap — the cap
    // is 0 by default and drawing a 0-tile ring would hide the lock entirely.
    const float rangeT  = s_effRangeTiles.load(std::memory_order_relaxed);
    if (!std::isfinite(rangeT) || rangeT <= 0.f) return;

    // The ring is centred on the SELECTION reference point, not blindly on the
    // player — in "at mouse" mode the radius that matters is the one around the
    // cursor, which is what the selector actually tests against.
    float refX = st.px, refY = st.py;
    RefPoint(atMouse, st.px, st.py, refX, refY);

    // Three states, told apart at a glance: locked (green), lock currently being
    // held across a selector miss (amber — retention is doing its job), and
    // enabled but with nothing to shoot (dim slate, ring only).
    const bool bridged = st.armed && s_retainMisses > 0;
    const ImU32 colMain = st.armed ? (bridged ? IM_COL32(255, 190,  60, 235)
                                              : IM_COL32( 70, 240, 120, 235))
                                   : IM_COL32(150, 158, 172, 110);
    const ImU32 colRing = st.armed ? (bridged ? IM_COL32(255, 190,  60, 150)
                                              : IM_COL32( 70, 240, 120, 150))
                                   : IM_COL32(150, 158, 172,  85);
    const ImU32 colDrop = st.armed ? (bridged ? IM_COL32(255, 190,  60,  70)
                                              : IM_COL32( 70, 240, 120,  70))
                                   : IM_COL32(150, 158, 172,  50);

    // Selection radius (where a target is ACQUIRED) and, just outside it, the
    // retention drop radius (where an existing lock is finally released). The
    // gap between the two rings IS the hysteresis band.
    DrawWorldRing(dl, cam, refX, refY, rangeT, colRing, st.armed ? 2.0f : 1.2f);
    DrawWorldRing(dl, cam, refX, refY, rangeT + kKaRetainRangeMarginTiles, colDrop, 1.0f);

    if (!st.armed) return;

    // Prefer the target's LIVE snapshot position; the published aim point is
    // lead-predicted and would sit ahead of a moving enemy.
    float tx = st.tx, ty = st.ty;
    const bool live = SnapshotPos(st.targetId, tx, ty);

    ImVec2 sPlayer, sTarget, sAim;
    const bool haveTarget = ToScreen(cam, tx, ty, sTarget);
    if (!haveTarget) return;

    if (ToScreen(cam, st.px, st.py, sPlayer))
        dl->AddLine(sPlayer, sTarget, (colMain & 0x00FFFFFFu) | (100u << IM_COL32_A_SHIFT), 1.6f);

    DrawLockDiamond(dl, sTarget, 14.f, colMain, 2.2f);
    DrawLockDiamond(dl, sTarget,  7.f, colMain, 1.2f);
    dl->AddCircleFilled(sTarget, 2.5f, colMain, 10);

    // Lead marker: where the shot origin is actually aimed, when that is
    // meaningfully ahead of the enemy itself.
    if (live && ToScreen(cam, st.tx, st.ty, sAim)) {
        const float ddx = sAim.x - sTarget.x, ddy = sAim.y - sTarget.y;
        if (ddx * ddx + ddy * ddy > 36.f) {
            const ImU32 colLead = (colMain & 0x00FFFFFFu) | (140u << IM_COL32_A_SHIFT);
            dl->AddLine(sTarget, sAim, colLead, 1.2f);
            dl->AddLine(ImVec2(sAim.x - 4.f, sAim.y - 4.f), ImVec2(sAim.x + 4.f, sAim.y + 4.f), colLead, 1.4f);
            dl->AddLine(ImVec2(sAim.x - 4.f, sAim.y + 4.f), ImVec2(sAim.x + 4.f, sAim.y - 4.f), colLead, 1.4f);
        }
    }

    char label[48];
    std::snprintf(label, sizeof(label), bridged ? "LOCK %d (held)" : "LOCK %d", st.targetId);
    dl->AddText(ImVec2(sTarget.x + 18.f, sTarget.y - 8.f), colMain, label);
}

} // namespace KillAura
