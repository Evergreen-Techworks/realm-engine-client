#include "pch-il2cpp.h"

#include "features/combat/autoaim/modes/KillAura.h"
#include "features/combat/enemytracker/EnemyTracker.h"
#include "features/combat/autoaim/core/TargetSelector.h"
#include "features/combat/autoaim/core/WeaponProfile.h"
#include "GameState.h"
#include "game/objects/GameObjects.h"
#include "core/ipc/IpcBridge.h"
#include "DbgFileLog.h"
#include <imgui/imgui.h>

#include <Windows.h>
#include <atomic>
#include <cmath>
#include <cstdint>

namespace {

// ── Settings (relaxed atomics — written from the IPC/UI threads, read here) ───
static std::atomic<bool>    s_enabled{ false };
static std::atomic<int>     s_modeInt{ 0 };
static std::atomic<float>   s_rangeTiles{ 8.f };
static std::atomic<float>   s_standoffTiles{ 0.35f };
static std::atomic<float>   s_maxOffsetTiles{ 12.f };
static std::atomic<int32_t> s_forcedTargetId{ 0 };

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

    if (!r.found) {
        ApplyState(false, 0, 0.f, 0.f, px, py, forced != 0 ? "forced-target-gone" : "no-target");
        return;
    }

    if (!s_loggedFirstSelect) {
        s_loggedFirstSelect = true;
        DBG_FILE_LOG("[KillAura] armed via TargetSelector::SelectKillAura mode="
                     << s_modeInt.load(std::memory_order_relaxed)
                     << " range=" << rangeT);
    }

    ApplyState(true, r.enemyId, r.aimX, r.aimY, px, py, nullptr);
}

void SetEnabled(bool on) { s_enabled.store(on, std::memory_order_relaxed); }
bool IsEnabled()         { return s_enabled.load(std::memory_order_relaxed); }

void SetMode(Mode m) {
    s_modeInt.store(m == Mode::AtMouse ? 1 : 0, std::memory_order_relaxed);
}
Mode GetMode() {
    return s_modeInt.load(std::memory_order_relaxed) == 1 ? Mode::AtMouse : Mode::AtTarget;
}

void  SetRangeTiles(float t)      { s_rangeTiles.store(ClampF(t, 1.f, 40.f, 8.f), std::memory_order_relaxed); }
float GetRangeTiles()             { return s_rangeTiles.load(std::memory_order_relaxed); }

void  SetStandoffTiles(float t)   { s_standoffTiles.store(ClampF(t, 0.05f, 1.5f, 0.35f), std::memory_order_relaxed); }
float GetStandoffTiles()          { return s_standoffTiles.load(std::memory_order_relaxed); }

void  SetMaxOffsetTiles(float t)  { s_maxOffsetTiles.store(ClampF(t, 1.f, 40.f, 12.f), std::memory_order_relaxed); }
float GetMaxOffsetTiles()         { return s_maxOffsetTiles.load(std::memory_order_relaxed); }

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

} // namespace KillAura
