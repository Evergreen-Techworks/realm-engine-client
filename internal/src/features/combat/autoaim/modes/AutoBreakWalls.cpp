#include "pch-il2cpp.h"

#include "features/combat/autoaim/modes/AutoBreakWalls.h"
#include "features/combat/enemytracker/EnemyTracker.h"
#include "features/combat/autoaim/modes/KillAura.h"
#include "features/combat/autoaim/modes/AutoFire.h"
#include "features/movement/udodge/UDodge.h"
#include "DbgFileLog.h"
#include <imgui/imgui.h>

#include <Windows.h>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>

namespace {

// ── Settings (relaxed atomics — written from the IPC/UI threads, read here) ───
static std::atomic<bool>  s_enabled{ false };
static std::atomic<float> s_probeTiles{ 2.5f };
static std::atomic<int>   s_timeoutMs{ 6000 };

// ── Diagnostics (render-thread writes, UI reads) ─────────────────────────────
static std::atomic<bool>     s_diagWedged{ false };
static std::atomic<int32_t>  s_diagTargetId{ 0 };
static std::atomic<int32_t>  s_diagTargetHp{ 0 };
static std::atomic<uint32_t> s_diagEngagedMs{ 0 };
static std::atomic<uint32_t> s_engagements{ 0 };

// ── Render-thread-only bookkeeping ───────────────────────────────────────────
static bool      s_engaged        = false;   // Idle (false) / Engaged (true)
static int32_t   s_targetId       = 0;
static int32_t   s_targetType     = 0;
static ULONGLONG s_engageStartMs  = 0;
static ULONGLONG s_unwedgedSince  = 0;       // 0 = still wedged / not counting
static ULONGLONG s_lastTickMs     = 0;       // 50 ms throttle
static ULONGLONG s_lastNoPickLog  = 0;
static ULONGLONG s_lastAliveLogMs = 0;
static char      s_lastRelease[24] = {};

// Wall pick from SelectBreakable. ok=false means "nothing worth shooting".
struct Pick {
    bool    ok      = false;
    int32_t id      = 0;
    int32_t objType = 0;
    int32_t hp      = 0;
    float   dist    = 0.f;
};

// Pure math over the enemy snapshot: the nearest no-health-bar destructible that
// sits ON the route from the player toward the wedged nav goal.
static Pick SelectBreakable(const UDodge::NavWedge& w)
{
    Pick pick{};

    float dirX = w.goalX - w.playerX;
    float dirY = w.goalY - w.playerY;
    const float len = std::sqrt(dirX * dirX + dirY * dirY);
    if (!(len > 1e-4f)) return pick;   // degenerate goal → no pick (also catches NaN)
    dirX /= len; dirY /= len;

    const float probe    = s_probeTiles.load(std::memory_order_relaxed);
    const float maxAlong = probe + 1.5f;
    float bestScore = 1e18f;

    for (const EnemyTracker::Entry& e : EnemyTracker::GetSnapshot()) {
        if (e.hasHealthBar)   continue;   // only no-health-bar destructibles
        if (e.hp <= 0)        continue;
        if (e.isInvulnerable) continue;

        const float rx = e.x - w.playerX;
        const float ry = e.y - w.playerY;
        const float along = rx * dirX + ry * dirY;                  // along the route
        if (along <= 0.f || along > maxAlong) continue;             // behind us / too far ahead
        const float perp = std::fabs(rx * dirY - ry * dirX);        // lateral offset from the route line
        if (perp > probe) continue;

        const float score = along + perp;                           // nearest along-route wall wins
        if (score < bestScore) {
            bestScore    = score;
            pick.ok      = true;
            pick.id      = e.id;
            pick.objType = e.objType;
            pick.hp      = e.hp;
            pick.dist    = std::sqrt(rx * rx + ry * ry);
        }
    }
    return pick;
}

// Find the engaged target in the current snapshot. nullptr = despawned / killed.
static const EnemyTracker::Entry* FindEntry(int32_t id)
{
    for (const EnemyTracker::Entry& e : EnemyTracker::GetSnapshot())
        if (e.id == id) return &e;
    return nullptr;
}

// Every exit from Engaged runs through here, so the killaura override can never
// be stranded. A no-op when already Idle (keeps the edge log transition-only).
static void Release(const char* reason)
{
    if (!s_engaged) return;

    KillAura::SetForcedTargetId(0);
    AutoFire::SetAutoEngage(false);

    strncpy_s(s_lastRelease, reason ? reason : "unknown", _TRUNCATE);

    // Transition-only: Release early-outs when already Idle, so the trace gets
    // exactly one RELEASE line per engagement.
    DBG_FILE_LOG("[AutoBreakWalls] RELEASE id=" << s_targetId
                 << " objType=" << s_targetType
                 << " hp=" << s_diagTargetHp.load(std::memory_order_relaxed)
                 << " engagedMs=" << (GetTickCount64() - s_engageStartMs)
                 << " reason=" << s_lastRelease);

    s_engaged       = false;
    s_targetId      = 0;
    s_targetType    = 0;
    s_engageStartMs = 0;
    s_unwedgedSince = 0;
    s_diagTargetId.store(0, std::memory_order_relaxed);
    s_diagTargetHp.store(0, std::memory_order_relaxed);
    s_diagEngagedMs.store(0, std::memory_order_relaxed);
}

} // namespace

namespace AutoBreakWalls {

void Tick()
{
    if (!s_enabled.load(std::memory_order_relaxed)) {
        Release("disabled");
        s_diagWedged.store(false, std::memory_order_relaxed);
        return;
    }

    const ULONGLONG now = GetTickCount64();
    if (now - s_lastTickMs < 50ULL) return;   // 20 Hz is plenty for a wall
    s_lastTickMs = now;

    // Self-throttled inside EnemyTracker — the same call AutoAim::RunTick makes.
    EnemyTracker::Tick();

    const UDodge::NavWedge w = UDodge::GetNavWedge();
    const bool stale = (static_cast<uint32_t>(now) - w.stampMs) > 500u;
    const bool wedged = w.walkActive && w.wedged && !stale;
    s_diagWedged.store(wedged, std::memory_order_relaxed);

    // This feature owns no hook, so the heartbeat is the only proof it runs.
    if (now - s_lastAliveLogMs >= 30000ULL) {
        s_lastAliveLogMs = now;
        DBG_FILE_LOG("[AutoBreakWalls] alive enabled=1 wedged=" << (wedged ? 1 : 0)
                     << " target=" << s_targetId);
    }

    if (!s_engaged) {
        // ── Idle ─────────────────────────────────────────────────────────────
        if (!w.walkActive || !w.wedged) return;
        if (stale) return;                       // udodge tick stalled → do not fire blind

        const Pick pick = SelectBreakable(w);
        if (!pick.ok) {
            if (now - s_lastNoPickLog >= 5000ULL) {
                s_lastNoPickLog = now;
                DBG_FILE_LOG("[AutoBreakWalls] wedged but no breakable on route"
                             << " goal=" << w.goalX << "," << w.goalY);
            }
            return;
        }

        KillAura::SetForcedTargetId(pick.id);
        AutoFire::SetAutoEngage(true);

        s_engaged       = true;
        s_targetId      = pick.id;
        s_targetType    = pick.objType;
        s_engageStartMs = now;
        s_unwedgedSince = 0;
        s_engagements.fetch_add(1, std::memory_order_relaxed);
        s_diagTargetId.store(pick.id, std::memory_order_relaxed);
        s_diagTargetHp.store(pick.hp, std::memory_order_relaxed);
        s_diagEngagedMs.store(0, std::memory_order_relaxed);
        DBG_FILE_LOG("[AutoBreakWalls] ENGAGE id=" << pick.id
                     << " objType=" << pick.objType
                     << " dist=" << pick.dist
                     << " hp=" << pick.hp);
        return;
    }

    // ── Engaged ──────────────────────────────────────────────────────────────
    s_diagEngagedMs.store(static_cast<uint32_t>(now - s_engageStartMs), std::memory_order_relaxed);

    const EnemyTracker::Entry* e = FindEntry(s_targetId);
    if (!e)            { Release("gone");   return; }   // despawned or killed
    s_diagTargetHp.store(e->hp, std::memory_order_relaxed);
    if (e->hp <= 0)    { Release("killed"); return; }

    const int timeout = s_timeoutMs.load(std::memory_order_relaxed);
    if (now - s_engageStartMs > static_cast<ULONGLONG>(timeout)) { Release("timeout"); return; }

    if (!w.wedged) {
        if (s_unwedgedSince == 0) s_unwedgedSince = now;
        else if (now - s_unwedgedSince > 1000ULL) { Release("unwedged"); return; }
    } else {
        s_unwedgedSince = 0;
    }
    // otherwise hold: killaura stays pinned, autofire stays engaged
}

void SetEnabled(bool on) { s_enabled.store(on, std::memory_order_relaxed); }
bool IsEnabled()         { return s_enabled.load(std::memory_order_relaxed); }

void SetProbeTiles(float t)
{
    if (!(t >= 0.5f)) t = 0.5f;   // also catches NaN
    if (t > 6.f)      t = 6.f;
    s_probeTiles.store(t, std::memory_order_relaxed);
}
float GetProbeTiles() { return s_probeTiles.load(std::memory_order_relaxed); }

void SetTimeoutMs(int ms)
{
    if (ms < 1000)  ms = 1000;
    if (ms > 30000) ms = 30000;
    s_timeoutMs.store(ms, std::memory_order_relaxed);
}
int GetTimeoutMs() { return s_timeoutMs.load(std::memory_order_relaxed); }

Diag GetDiag()
{
    Diag d;
    d.enabled     = s_enabled.load(std::memory_order_relaxed);
    d.navWedged   = s_diagWedged.load(std::memory_order_relaxed);
    d.targetId    = s_diagTargetId.load(std::memory_order_relaxed);
    d.targetHp    = s_diagTargetHp.load(std::memory_order_relaxed);
    d.engagedMs   = s_diagEngagedMs.load(std::memory_order_relaxed);
    d.engagements = s_engagements.load(std::memory_order_relaxed);
    strncpy_s(d.lastRelease, s_lastRelease, _TRUNCATE);
    return d;
}

void RenderSettings()
{
    ImGui::TextColored(ImVec4(0.85f, 0.7f, 1.f, 1.f), "AUTO-BREAK-WALLS");
    ImGui::Spacing();

    bool on = IsEnabled();
    if (ImGui::Checkbox("Enable##abwEnable", &on))
        SetEnabled(on);
    ImGui::SameLine(); ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("When walk-to navigation wedges against a breakable wall, pin killaura\nonto that wall and hold autofire until it dies, then release.\nNeeds Killaura + Autofire enabled to actually shoot.");

    ImGui::Spacing();
    ImGui::PushItemWidth(180.f);

    float probe = GetProbeTiles();
    if (ImGui::SliderFloat("Probe (tiles)##abwProbe", &probe, 0.5f, 6.f, "%.2f"))
        SetProbeTiles(probe);
    ImGui::SameLine(); ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("How far off the route line a destructible may sit and still count as\nthe thing we are wedged on (and, +1.5, how far ahead to look).");

    int timeout = GetTimeoutMs();
    if (ImGui::SliderInt("Timeout (ms)##abwTimeout", &timeout, 1000, 30000))
        SetTimeoutMs(timeout);
    ImGui::SameLine(); ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Give up on a wall after this long and hand navigation back.");

    ImGui::PopItemWidth();

    ImGui::Spacing();
    const Diag d = GetDiag();
    ImGui::TextDisabled("wedged=%d target=%d hp=%d engagedMs=%u lastRelease=%s total=%u",
                        d.navWedged ? 1 : 0, d.targetId, d.targetHp, d.engagedMs,
                        d.lastRelease[0] ? d.lastRelease : "-", d.engagements);
}

} // namespace AutoBreakWalls
