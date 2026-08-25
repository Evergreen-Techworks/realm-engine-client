#include "pch-il2cpp.h"

#include "features/combat/autoaim/modes/KillAura.h"
#include "features/combat/enemytracker/EnemyTracker.h"
#include "features/combat/autoaim/core/TargetSelector.h"
#include "features/combat/autoaim/core/WeaponProfile.h"
#include "GameState.h"
#include "game/objects/GameObjects.h"
#include "core/ipc/IpcBridge.h"
#include "gui/tabs/TestTAB.h"
#include "game/math/W2S.h"
#include "DbgFileLog.h"
#include <imgui/imgui.h>

#include <Windows.h>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>

namespace {

// ── Settings (relaxed atomics — written from the IPC/UI threads, read here) ───
static std::atomic<bool>    s_enabled{ false };
static std::atomic<int>     s_modeInt{ 0 };
// Default 16 tiles, matching the reference implementation this feature was
// modelled on. The old 8 kept enemies hovering at the selection boundary — with
// the dodge moving the player, that boundary crossing is what produced the
// acquire/drop flapping. Only the DEFAULT changed; the clamp stays [1, 40].
static std::atomic<float>   s_rangeTiles{ 16.f };
static std::atomic<float>   s_standoffTiles{ 0.35f };
static std::atomic<float>   s_maxOffsetTiles{ 12.f };
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
// Retention is only ever a BRIDGE over a momentary miss: a target that is dead,
// absent from the EnemyTracker snapshot, no longer damageable, or past the drop
// radius is dropped on the spot and never retained. When in doubt, drop.
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

// ── Published state (read lock-free from the projectile-spawn detour) ────────
static std::atomic<bool>     s_armed{ false };
static std::atomic<int32_t>  s_targetId{ 0 };
static std::atomic<float>    s_tx{ 0.f };
static std::atomic<float>    s_ty{ 0.f };
static std::atomic<float>    s_px{ 0.f };
static std::atomic<float>    s_py{ 0.f };
static std::atomic<uint32_t> s_stampMs{ 0 };

// ── Render-thread-only bookkeeping ───────────────────────────────────────────
static ULONGLONG s_lastThrottleMs      = 0;
static ULONGLONG s_lastIdlePublishMs   = 0;
static ULONGLONG s_lastAliveLogMs      = 0;
static ULONGLONG s_armedSinceMs        = 0;
static uint64_t  s_publishCount        = 0;
static int       s_lastArmed           = -1;   // -1 = no edge observed yet
static int32_t   s_lastTargetId        = 0;
static bool      s_loggedFirstSelect   = false;
static unsigned  s_noListenerLogN      = 0;
static int32_t   s_heldTargetId        = 0;   // current lock (0 = none), retention subject
static ULONGLONG s_retainSinceMs       = 0;   // wall clock of the first miss in this run
static unsigned  s_retainMisses        = 0;   // consecutive selector misses bridged so far

static float ClampF(float v, float lo, float hi, float fallback)
{
    if (!std::isfinite(v)) return fallback;
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

static void PublishNow(bool armed, int32_t targetId,
                       float tx, float ty, float px, float py, uint32_t stamp)
{
    IpcAim a{};
    a.armed           = armed ? 1 : 0;
    a.mode            = static_cast<uint8_t>(s_modeInt.load(std::memory_order_relaxed) == 1 ? 1 : 0);
    a.targetId        = targetId;
    a.tx              = tx;
    a.ty              = ty;
    a.px              = px;
    a.py              = py;
    a.standoffTiles   = s_standoffTiles.load(std::memory_order_relaxed);
    a.maxOffsetTiles  = s_maxOffsetTiles.load(std::memory_order_relaxed);
    a.stampMs         = stamp;
    IpcBridge_PublishAim(a);
    ++s_publishCount;
}

// Stores the tick result, logs the ARMED/disarmed EDGE only, and publishes:
// every tick while armed, plus exactly one more publish on the disarm edge.
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
            s_armedSinceMs = GetTickCount64();
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

    if (armed || edge)
        PublishNow(armed, armed ? targetId : 0, tx, ty, px, py, stamp);

    // "Client not listening": armed for > 2 s while the bridge is down means
    // nothing is draining the aim publisher. Rate-limited so it stays readable.
    if (armed && !IpcBridge_IsAuthenticated()
        && GetTickCount64() - s_armedSinceMs > 2000ULL
        && (s_noListenerLogN++ % 240) == 0) {
        DBG_FILE_LOG("[KillAura] armed but bridge not connected — aim payloads are not being drained"
                     << " pub=" << s_publishCount);
    }
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

// Retention validity gate — the INVARIANT. True only while `id` is still a legal
// killaura target in the CURRENT EnemyTracker snapshot: present, alive,
// damageable, and no further than range + margin from the reference point.
// Anything else, including an id the snapshot no longer carries, is a hard drop.
static bool RetainedTargetStillValid(int32_t id, float rx, float ry, float rangeT)
{
    if (id == 0) return false;
    const float dropR = rangeT + kKaRetainRangeMarginTiles;
    for (const EnemyTracker::Entry& e : EnemyTracker::GetSnapshot()) {
        if (e.id != id) continue;
        if (e.hp <= 0)        return false;   // dead
        if (!e.hasHealthBar)  return false;   // same filter acquisition applied
        if (e.isInvulnerable) return false;   // no longer damageable
        if (!std::isfinite(e.x) || !std::isfinite(e.y)) return false;
        const float dx = e.x - rx, dy = e.y - ry;
        return dx * dx + dy * dy <= dropR * dropR;
    }
    return false;   // absent from the snapshot — gone
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

static void LogAlive()
{
    const ULONGLONG now = GetTickCount64();
    if (now - s_lastAliveLogMs < 30000ULL) return;
    s_lastAliveLogMs = now;
    DBG_FILE_LOG("[KillAura] alive armed=" << (s_armed.load(std::memory_order_relaxed) ? 1 : 0)
                 << " id=" << s_targetId.load(std::memory_order_relaxed)
                 << " pub=" << s_publishCount);
}

} // namespace

namespace KillAura {

void Tick()
{
    if (!s_enabled.load(std::memory_order_relaxed)) {
        // Disabled: hold the disarm edge, then re-assert armed=0 at most every
        // 250 ms so a client that connects later still learns the state.
        const bool wasArmed = s_armed.load(std::memory_order_relaxed);
        const ULONGLONG now = GetTickCount64();
        if (wasArmed || s_lastArmed != 0) {
            ApplyState(false, 0, 0.f, 0.f, 0.f, 0.f, "disabled");
            s_lastIdlePublishMs = now;
            return;
        }
        if (now - s_lastIdlePublishMs >= 250ULL) {
            s_lastIdlePublishMs = now;
            PublishNow(false, 0, 0.f, 0.f,
                       s_px.load(std::memory_order_relaxed),
                       s_py.load(std::memory_order_relaxed),
                       static_cast<uint32_t>(now));
        }
        return;
    }

    const ULONGLONG wall = GetTickCount64();
    if (wall - s_lastThrottleMs < 8ULL) return;
    s_lastThrottleMs = wall;

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

    const int32_t forced   = s_forcedTargetId.load(std::memory_order_relaxed);
    const bool    atMouse  = (s_modeInt.load(std::memory_order_relaxed) == 1);
    const float   rangeT   = s_rangeTiles.load(std::memory_order_relaxed);

    const TargetSelector::Result r = TargetSelector::SelectKillAura(
        atMouse, rangeT, px, py, forced, WeaponCalibrator::GetProfile());

    if (r.found) {
        if (!s_loggedFirstSelect) {
            s_loggedFirstSelect = true;
            DBG_FILE_LOG("[KillAura] armed via TargetSelector::SelectKillAura mode="
                         << s_modeInt.load(std::memory_order_relaxed)
                         << " range=" << rangeT);
        }
        // Transition-only: closes a bridged run, so the log shows how much of a
        // gap retention actually covered. Never fires on a clean refresh.
        if (s_retainMisses > 0) {
            DBG_FILE_LOG("[KillAura] retained-lock recovered targetId=" << r.enemyId
                         << " heldId=" << s_heldTargetId
                         << " bridgedMisses=" << s_retainMisses
                         << " bridgedMs=" << (wall - s_retainSinceMs));
            s_retainMisses = 0;
        }
        s_heldTargetId = r.enemyId;
        ApplyState(true, r.enemyId, r.aimX, r.aimY, px, py, nullptr);
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
        if (!RetainedTargetStillValid(s_heldTargetId, rx, ry, rangeT)) {
            dropReason = "retain-invalid";        // dead / gone / past range+margin
        } else if (s_retainMisses > 0 && wall - s_retainSinceMs > kKaRetainMs) {
            dropReason = "retain-expired";        // grace window used up
        } else {
            // Re-resolve the SAME id through the selector's locked path so the
            // bridged aim point keeps its lead prediction instead of freezing.
            const TargetSelector::Result h = TargetSelector::SelectKillAura(
                atMouse, rangeT, px, py, s_heldTargetId, WeaponCalibrator::GetProfile());
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

void  SetRangeTiles(float t)      { s_rangeTiles.store(ClampF(t, 1.f, 40.f, 16.f), std::memory_order_relaxed); }
float GetRangeTiles()             { return s_rangeTiles.load(std::memory_order_relaxed); }

void  SetStandoffTiles(float t)   { s_standoffTiles.store(ClampF(t, 0.05f, 1.5f, 0.35f), std::memory_order_relaxed); }
float GetStandoffTiles()          { return s_standoffTiles.load(std::memory_order_relaxed); }

void  SetMaxOffsetTiles(float t)  { s_maxOffsetTiles.store(ClampF(t, 1.f, 40.f, 12.f), std::memory_order_relaxed); }
float GetMaxOffsetTiles()         { return s_maxOffsetTiles.load(std::memory_order_relaxed); }

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

bool ComputeShotOrigin(float shotAngleRad, float& ox, float& oy)
{
    if (!s_armed.load(std::memory_order_relaxed)) return false;
    if (!std::isfinite(shotAngleRad)) return false;

    const float tx       = s_tx.load(std::memory_order_relaxed);
    const float ty       = s_ty.load(std::memory_order_relaxed);
    const float px       = s_px.load(std::memory_order_relaxed);
    const float py       = s_py.load(std::memory_order_relaxed);
    const float standoff = s_standoffTiles.load(std::memory_order_relaxed);
    if (!std::isfinite(tx) || !std::isfinite(ty) ||
        !std::isfinite(px) || !std::isfinite(py) || !std::isfinite(standoff))
        return false;

    const float nx = tx - std::cos(shotAngleRad) * standoff;
    const float ny = ty - std::sin(shotAngleRad) * standoff;
    if (!std::isfinite(nx) || !std::isfinite(ny)) return false;

    // Hard cap — never move the origin further than maxOffset from the player.
    const float maxOff = s_maxOffsetTiles.load(std::memory_order_relaxed);
    const float dx = nx - px, dy = ny - py;
    if (dx * dx + dy * dy > maxOff * maxOff) return false;

    ox = nx;
    oy = ny;
    return true;
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
        ImGui::SetTooltip("Redirects where an already-fired shot originates so it lands on the\nchosen target. It never pulls the trigger.");

    ImGui::Spacing();
    ImGui::TextDisabled("Target mode");
    int mode = static_cast<int>(GetMode());
    if (ImGui::RadioButton("At target##kaMode0", mode == 0)) SetMode(Mode::AtTarget);
    if (ImGui::RadioButton("At mouse##kaMode1",  mode == 1)) SetMode(Mode::AtMouse);

    ImGui::Spacing();
    ImGui::PushItemWidth(180.f);

    float range = GetRangeTiles();
    if (ImGui::SliderFloat("Range (tiles)##kaRange", &range, 1.f, 40.f, "%.1f"))
        SetRangeTiles(range);
    ImGui::SameLine(); ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Absolute selection radius around the reference point.\nIndependent of weapon range.");

    float standoff = GetStandoffTiles();
    if (ImGui::SliderFloat("Standoff (tiles)##kaStandoff", &standoff, 0.05f, 1.5f, "%.2f"))
        SetStandoffTiles(standoff);
    ImGui::SameLine(); ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Tiles the shot origin is backed off the target, along the shot angle.");

    float maxOffset = GetMaxOffsetTiles();
    if (ImGui::SliderFloat("Max offset (tiles)##kaMaxOffset", &maxOffset, 1.f, 40.f, "%.1f"))
        SetMaxOffsetTiles(maxOffset);
    ImGui::SameLine(); ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Hard cap: an origin further than this from the player is refused\nand the shot is left alone.");

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
    const float rangeT  = s_rangeTiles.load(std::memory_order_relaxed);
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
