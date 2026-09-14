#include "pch-il2cpp.h"

#include "features/combat/autoaim/modes/AutoFire.h"
#include "features/combat/autoaim/modes/AutoFireDecision.h"
#include "features/combat/autoaim/modes/AutoAim.h"
#include "features/combat/autoaim/core/TargetSelector.h"
#include "features/combat/enemytracker/EnemyTracker.h"
#include "core/runtime/InputFocus.h"
#include "features/combat/autoaim/shoot/ShootRuntime.h"
#include "game/objects/GameObjects.h"
#include "BootGate.h"
#include "DangerPlanner.h"
#include "DiagTiming.h"
#include "GameState.h"
#include "LocalPlayer.h"
#include "keybinds.h"
#include "DbgFileLog.h"
#include <imgui/imgui.h>

#include <Windows.h>
#include <atomic>
#include <cstdint>
#include <vector>

namespace {

// ── Settings (relaxed atomics — written from the IPC/UI threads, read here) ───
static std::atomic<bool> s_enabled{ false };
static std::atomic<int>  s_hotkeyVk{ 0 };
static std::atomic<int>  s_slot{ 0 };
static std::atomic<bool> s_autoEngage{ false };
static std::atomic<bool> s_scriptArmed{ false };
static std::atomic<uint32_t> s_sceneEpoch{ 0 };

// ── Diagnostics (render-thread writes, UI reads) ─────────────────────────────
static std::atomic<bool>     s_diagResolved{ false };
static std::atomic<bool>     s_diagGated{ false };
static std::atomic<bool>     s_diagEngaged{ false };
static std::atomic<bool>     s_diagCanShoot{ false };
static std::atomic<uint32_t> s_shotsSent{ 0 };
static std::atomic<uint32_t> s_framesEngaged{ 0 };
static std::atomic<uint8_t>  s_diagScriptBlock{ static_cast<uint8_t>(AutoFireDecision::Block::NotArmed) };
static std::atomic<uint32_t> s_scriptPulls{ 0 };

// ── Render-thread-only bookkeeping ───────────────────────────────────────────
static uint64_t  s_frame            = 0;   // monotonic Tick counter (one per Present)
static uint64_t  s_lastAttemptFrame = ~0ull;
static ULONGLONG s_lastGateLogMs    = 0;
static ULONGLONG s_lastBindLogMs    = 0;
static ULONGLONG s_lastAliveLogMs   = 0;
static int       s_lastEngaged      = -1;  // -1 = no edge observed yet

// Transition-only edge logging. Never called per-frame while the state holds,
// so the trace gets exactly one line per press and one per release.
static void SetEngaged(bool engaged, const char* reason)
{
    s_diagEngaged.store(engaged, std::memory_order_relaxed);
    if (!engaged) s_diagCanShoot.store(false, std::memory_order_relaxed);

    const int now = engaged ? 1 : 0;
    if (s_lastEngaged == now) return;
    s_lastEngaged = now;
    if (engaged) {
        DBG_FILE_LOG("[AutoFire] ENGAGED vk=" << s_hotkeyVk.load(std::memory_order_relaxed)
                     << " auto=" << (s_autoEngage.load(std::memory_order_relaxed) ? 1 : 0)
                     << " slot=" << s_slot.load(std::memory_order_relaxed));
    } else {
        DBG_FILE_LOG("[AutoFire] disengaged reason=" << (reason ? reason : "unknown")
                     << " shots=" << s_shotsSent.load(std::memory_order_relaxed));
    }
}

// AutoFire owns no hook, so this heartbeat is the only proof it is running.
static void LogAlive()
{
    const ULONGLONG now = GetTickCount64();
    if (now - s_lastAliveLogMs < 30000ULL) return;
    s_lastAliveLogMs = now;
    DBG_FILE_LOG("[AutoFire] alive engaged=" << (s_diagEngaged.load(std::memory_order_relaxed) ? 1 : 0)
                 << " resolved=" << (s_diagResolved.load(std::memory_order_relaxed) ? 1 : 0)
                 << " shots=" << s_shotsSent.load(std::memory_order_relaxed)
                 << " scriptArmed=" << (s_scriptArmed.load(std::memory_order_relaxed) ? 1 : 0)
                 << " scriptPulls=" << s_scriptPulls.load(std::memory_order_relaxed));
}

// ── Script trigger: the live game behind AutoFireDecision::ScriptStep ────────
//
// Game-update thread only. Why not the render thread the manual trigger ticks on:
// ShootWithAngle spawns projectiles and queues the shot packet, and Present runs
// on Unity's render thread, concurrently with the main thread's Update. Firing
// from inside AppEngineManager.Update keeps the call on the main thread, where the
// game's InputManager also calls ShootWithAngle, so the game's own auto-fire and
// this trigger take turns on one per-attack timer instead of racing it.
//
// Why not ShootRuntime::TryComputeShootAngle's canShoot, which the manual trigger
// waits on: in games 4a8beb50 and 86ad651b the method ShootRuntime binds under that
// name (RVA 0x3E4DA0 in 86ad651b) is a condition-effect/status-text routine; for
// slot 0 it returns at once and canShoot stays false. ShootWithAngle itself checks
// the weapon, two condition masks and the per-attack timer, so it is called directly.
static AutoFireDecision::MapWatch s_mapWatch;   // game-update thread only

class LiveWorld {
public:
    LiveWorld() : m_local(GameState::GetLocalPtr()) {}   // one read, so every question is about the same player

    bool ScriptArmed() const
    {
        return s_enabled.load(std::memory_order_relaxed) && s_scriptArmed.load(std::memory_order_relaxed);
    }
    bool ManualEngaged() const { return s_diagEngaged.load(std::memory_order_relaxed); }
    bool ShootReady() const
    {
        return BootGate::FeatureAllowed("AutoFire") && ShootRuntime::IsResolved();
    }
    uintptr_t LocalPlayer() const { return reinterpret_cast<uintptr_t>(m_local); }
    uint32_t  SceneEpoch() const  { return s_sceneEpoch.load(std::memory_order_relaxed); }
    bool LocalHp(int32_t& hp) const
    {
        int32_t maxHp = 0;
        return Game::Character(m_local).TryHp(hp, maxHp);
    }
    bool PlayerPos(float& x, float& y) const { return Game::Entity(m_local).TryPos(x, y); }
    AutoFireDecision::AimTarget Aim() const
    {
        AutoFireDecision::AimTarget t;
        t.aimEnabled = AutoAim::IsEnabled();
        t.hasTarget  = AutoAim::HasTarget();
        t.enemyId    = AutoAim::GetAimFocusEnemyId();
        return t;
    }
    // This thread's own snapshot copy (EnemyTracker.h), brought up to the latest
    // published build first. Self-throttled, and only reached with a target.
    AutoFireDecision::EnemyView FindEnemy(int32_t id) const
    {
        EnemyTracker::Tick();
        AutoFireDecision::EnemyView v;
        for (const EnemyTracker::Entry& e : EnemyTracker::GetSnapshot()) {
            if (e.id != id) continue;
            v.found = true;
            v.hp = e.hp;
            v.x = e.x;
            v.y = e.y;
            break;
        }
        return v;
    }
    float RangeTiles() const
    {
        const WeaponProfile weapon = AutoAim::GetWeaponProfile();   // copy: the render thread refreshes it
        return TargetSelector::AutoAimSelectionRangeTiles(weapon, AutoAim::GetRangeLeadBias());
    }
    bool Fire(float px, float py, float tx, float ty)
    {
        if (!ShootRuntime::CallShootWithAngle(m_local, AutoAim::ShotAngleTo(px, py, tx, ty))) return false;
        s_scriptPulls.fetch_add(1, std::memory_order_relaxed);
        return true;
    }

private:
    void* m_local;
};

// Field capture (DiagTiming.h, OFF unless RE_ASSETS/diag-timing.flag exists): one
// line when the script trigger's state changes, e.g. firing -> no-target. At most
// one line per 250 ms; a state that flaps faster is reported once it holds.
//   GREP THE TRACE LOG FOR:  [Diag/AutoFire]
static void DiagScriptState(AutoFireDecision::Block block)
{
    if (!DiagTiming::On()) return;
    static AutoFireDecision::Block s_logged = AutoFireDecision::Block::NotArmed;
    static ULONGLONG s_lastLogMs = 0;
    if (block == s_logged) return;
    const ULONGLONG now = GetTickCount64();
    if (now - s_lastLogMs < 250ULL) return;
    DiagTiming::Logf("[Diag/AutoFire] script %s -> %s aimEnabled=%d aimId=%d pulls=%u",
                     AutoFireDecision::Name(s_logged), AutoFireDecision::Name(block),
                     AutoAim::IsEnabled() ? 1 : 0, AutoAim::GetAimFocusEnemyId(),
                     s_scriptPulls.load(std::memory_order_relaxed));
    s_logged = block;
    s_lastLogMs = now;
}

static void GameThreadTickBody()
{
    LiveWorld world;
    const AutoFireDecision::Block block = AutoFireDecision::ScriptStep(s_mapWatch, world, GetTickCount64());
    s_diagScriptBlock.store(static_cast<uint8_t>(block), std::memory_order_relaxed);
    DiagScriptState(block);
}

} // namespace

namespace AutoFire {

void Tick(bool menuOpen)
{
    ++s_frame;

    if (!s_enabled.load(std::memory_order_relaxed)) {
        s_autoEngage.store(false, std::memory_order_relaxed);
        s_diagGated.store(false, std::memory_order_relaxed);
        SetEngaged(false, "disabled");
        return;
    }

    LogAlive();

    if (!BootGate::FeatureAllowed("AutoFire")) {
        s_diagGated.store(true, std::memory_order_relaxed);
        SetEngaged(false, "bootgate");
        const ULONGLONG now = GetTickCount64();
        if (now - s_lastGateLogMs >= 30000ULL) {
            s_lastGateLogMs = now;
            DBG_FILE_LOG("[AutoFire] blocked by BootGate (stale anchors) — not firing");
        }
        return;
    }
    s_diagGated.store(false, std::memory_order_relaxed);

    const bool resolved = ShootRuntime::EnsureResolved();
    s_diagResolved.store(resolved, std::memory_order_relaxed);
    if (!resolved) {
        SetEngaged(false, "unresolved");
        const ULONGLONG now = GetTickCount64();
        if (now - s_lastBindLogMs >= 30000ULL) {
            s_lastBindLogMs = now;
            DBG_FILE_LOG("[AutoFire] shoot methods not bound yet — not firing");
        }
        return;
    }

    // The script trigger fires from the AppEngineManager.Update detour
    // (GameThreadTick). Dodge modes install it too; a script may arm with dodge off.
    if (s_scriptArmed.load(std::memory_order_relaxed) && GameState::GetLocalPtr())
        DangerPlanner::TryInstall();

    const bool autoEngaged = s_autoEngage.load(std::memory_order_relaxed);
    const int  vk          = s_hotkeyVk.load(std::memory_order_relaxed);
    // The hotkey counts only while the game window owns the foreground
    // (core/runtime/InputFocus.h), and never off a keystroke the player is typing
    // into the menu. An auto-engage (plan 89) is programmatic, so the menu does
    // not affect it. Rule: AutoFireDecision::ManualEngaged.
    const bool engaged = AutoFireDecision::ManualEngaged(
        autoEngaged, vk != 0 && InputFocus::KeyDown(vk), menuOpen);

    if (!engaged) {
        SetEngaged(false, menuOpen ? "menu-open" : "key-up");
        return;
    }

    SetEngaged(true, nullptr);
    s_framesEngaged.fetch_add(1, std::memory_order_relaxed);

    void* player = GameState::GetLocalPtr();
    if (!player) { SetEngaged(false, "no-local"); return; }
    if (LocalPlayer::GetHP() <= 0) { SetEngaged(false, "dead"); return; }

    // At most one shoot attempt per Present frame. A frame counter, not a
    // wall-clock timer — the game's own outCanShoot gate sets the cadence.
    if (s_frame == s_lastAttemptFrame) return;
    s_lastAttemptFrame = s_frame;

    float angle    = 0.f;
    bool  canShoot = false;
    if (!ShootRuntime::TryComputeShootAngle(player, static_cast<uint8_t>(s_slot.load(std::memory_order_relaxed)),
                                            angle, canShoot))
        return;

    s_diagCanShoot.store(canShoot, std::memory_order_relaxed);
    if (!canShoot) return;   // the game said no — never force it

    if (!ShootRuntime::CallShootWithAngle(player, angle)) return;
    s_shotsSent.fetch_add(1, std::memory_order_relaxed);
}

// SEH firewall for the script trigger, same shape as DangerPlanner's
// DodgeTickGuarded: a fault must never take down the game's Update. The handler
// uses only the plain DbgFileLogWrite, so nothing here needs unwinding (C2712).
void GameThreadTick()
{
    __try {
        GameThreadTickBody();
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        static volatile LONG s_ex = 0;
        if ((InterlockedIncrement(&s_ex) % 240) == 1)
            DbgFileLogWrite("[AutoFire] script trigger: SEH caught a fault — update skipped");
    }
}

void SetEnabled(bool on)
{
    s_enabled.store(on, std::memory_order_relaxed);
    if (!on) {
        s_autoEngage.store(false, std::memory_order_relaxed);
        s_scriptArmed.store(false, std::memory_order_relaxed);
    }
}
bool IsEnabled() { return s_enabled.load(std::memory_order_relaxed); }

void SetScriptArmed(bool on)
{
    // The game thread fires only while both flags are set (LiveWorld::ScriptArmed),
    // so a disarm stops it at the first store.
    s_scriptArmed.store(on, std::memory_order_relaxed);
    SetEnabled(on);
}
bool IsScriptArmed() { return s_scriptArmed.load(std::memory_order_relaxed); }

void NotifyMapChange() { s_sceneEpoch.fetch_add(1, std::memory_order_relaxed); }

void SetHotkeyVk(int vk) { s_hotkeyVk.store(vk, std::memory_order_relaxed); }
int  GetHotkeyVk()       { return s_hotkeyVk.load(std::memory_order_relaxed); }

void SetSlot(int slot)
{
    if (slot < 0) slot = 0;
    if (slot > 3) slot = 3;
    s_slot.store(slot, std::memory_order_relaxed);
}
int GetSlot() { return s_slot.load(std::memory_order_relaxed); }

void SetAutoEngage(bool on) { s_autoEngage.store(on, std::memory_order_relaxed); }
bool IsAutoEngaged()        { return s_autoEngage.load(std::memory_order_relaxed); }

Diag GetDiag()
{
    Diag d;
    d.resolved      = s_diagResolved.load(std::memory_order_relaxed);
    d.gated         = s_diagGated.load(std::memory_order_relaxed);
    d.engaged       = s_diagEngaged.load(std::memory_order_relaxed);
    d.lastCanShoot  = s_diagCanShoot.load(std::memory_order_relaxed);
    d.shotsSent     = s_shotsSent.load(std::memory_order_relaxed);
    d.framesEngaged = s_framesEngaged.load(std::memory_order_relaxed);
    d.scriptArmed   = s_scriptArmed.load(std::memory_order_relaxed);
    d.scriptState   = AutoFireDecision::Name(static_cast<AutoFireDecision::Block>(
                          s_diagScriptBlock.load(std::memory_order_relaxed)));
    d.scriptPulls   = s_scriptPulls.load(std::memory_order_relaxed);
    return d;
}

void RenderSettings()
{
    ImGui::TextColored(ImVec4(1.f, 0.75f, 0.35f, 1.f), "AUTOFIRE");
    ImGui::Spacing();

    bool on = IsEnabled();
    if (ImGui::Checkbox("Enable##afEnable", &on))
        SetEnabled(on);
    ImGui::SameLine(); ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Hold the bound key to fire continuously. Drives the game's own shoot\nentry, so its rate limit / MP / silence checks all still apply.\n\nA script's autoFireEnabled fires with no key, but only at Auto Aim's\ntarget while it is in the enemy list, alive and in range. Never at the cursor.");

    ImGui::Spacing();
    ImGui::PushItemWidth(180.f);

    // Hotkey picker — same key table the menu toggle uses (core/config/keybinds.h).
    const std::vector<uint8_t> keys = KeyBinds::GetValidKeys();
    const int  vk      = GetHotkeyVk();
    const char* vkName = (vk == 0) ? "NONE" : KeyBinds::ToString(static_cast<uint8_t>(vk));
    if (ImGui::BeginCombo("Hotkey##afHotkey", vkName)) {
        if (ImGui::Selectable("NONE", vk == 0)) SetHotkeyVk(0);
        for (const uint8_t k : keys) {
            const bool sel = (static_cast<int>(k) == vk);
            if (ImGui::Selectable(KeyBinds::ToString(k), sel)) SetHotkeyVk(static_cast<int>(k));
            if (sel) ImGui::SetItemDefaultFocus();
        }
        ImGui::EndCombo();
    }
    ImGui::SameLine(); ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Unbound (NONE) never fires.");

    int slot = GetSlot();
    if (ImGui::InputInt("Weapon slot##afSlot", &slot))
        SetSlot(slot);
    ImGui::SameLine(); ImGui::TextDisabled("(?)");
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Diagnostic: the slot index passed to the game's ComputeShootAngle.\n0 is the weapon slot in every observed build; 0..3 for correction\nwithout a rebuild.");

    ImGui::PopItemWidth();

    ImGui::Spacing();
    const Diag d = GetDiag();
    ImGui::TextDisabled("resolved=%d gated=%d engaged=%d canShoot=%d shots=%u",
                        d.resolved ? 1 : 0, d.gated ? 1 : 0,
                        d.engaged ? 1 : 0, d.lastCanShoot ? 1 : 0,
                        d.shotsSent);
    ImGui::TextDisabled("script armed=%d state=%s pulls=%u",
                        d.scriptArmed ? 1 : 0, d.scriptState, d.scriptPulls);
}

} // namespace AutoFire
