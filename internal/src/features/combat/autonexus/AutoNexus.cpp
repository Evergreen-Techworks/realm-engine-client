#include "pch-il2cpp.h"
#include "AutoNexus.h"
#include "ProjectileTracking.h"
#include "gui/tabs/WorldTAB.h"
#include "LocalPlayer.h"
#include "SharedMemory.h"
#include "RuntimeOffsets.h"
#include "Il2CppResolver.h"
#include <algorithm>
#include <cstdio>
#include <cstdint>
#include <cmath>
#include <vector>
#include <imgui/imgui.h>

namespace CombatTAB {
namespace FeatAutoNexus {

static bool  g_autoNexus    = false;
static float g_nexusHpPct   = 30.f;
static bool  g_nexusProjDmg = true;
static bool  g_nexusTileDmg = true;

// ── Autopot state (xrDriver-pattern: folded into AutoNexus) ──────────────
// Two independent toggles (HP / MP) so users can run pot-only without
// AutoNexus or AutoNexus-only without pots. Cooldowns prevent burning a
// whole pot stack on one HP dip.
static bool  g_autoPotHp      = false;
static float g_autoPotHpPct   = 65.f;
static int   g_autoPotHpHotkey = 4;     // F by default (first inv slot)
static bool  g_autoPotMp      = false;
static float g_autoPotMpPct   = 30.f;
static int   g_autoPotMpHotkey = 5;     // G by default (second inv slot)
static ULONGLONG s_lastHpPotMs = 0;
static ULONGLONG s_lastMpPotMs = 0;
static constexpr ULONGLONG kPotCooldownMs = 800ULL;

// EquipmentManager.UseInventoryItemByHotkey — resolved lazily on first
// use so the module costs nothing at startup. Cached forever once
// resolved (function pointer is stable for the process lifetime).
using UseInvByHotkeyFn = void(__fastcall*)(void* eqMgr, int32_t hotkey, void* methodInfo);
static UseInvByHotkeyFn s_fnUseInvByHotkey = nullptr;
static uint32_t          s_eqMgrFieldOff   = 0;   // FKALGHJIADI.AJJJBDBNBLM offset
static bool              s_autoPotResolved = false;

static ULONGLONG s_lastNexusTick     = 0;
static ULONGLONG s_lastAutoNexusTick = 0;

static constexpr float kNexusProjImminentMs    = 30.f;
static constexpr float kNexusProjHitScanStepMs = 10.f;
static constexpr ULONGLONG kAutoNexusPollMs = 16ULL;

// ── xrDriver-style multi-source HP trackers (Phase 1) ───────────────────
// xrDriver maintains TWO predicted HP values alongside the game's reported
// HP, and nexuses if ANY of the three drop below threshold. This catches
// the case where the game-reported HP is stale (server-tick lag) but the
// client has already taken / will imminently take damage.
//
//   g_gameHp       = read live from LocalPlayer::GetHP()  (authoritative
//                    but lags ~1 tick behind real damage events)
//   g_predClientHp = decrements on EVERY predicted hit (projectile/tile/
//                    packet). May over-predict (false-positive) when a
//                    predicted projectile actually misses, BUT is the
//                    earliest signal.
//   g_predRealHp   = decrements only on hits we believe are committed
//                    (silent=false). More conservative than predClientHp,
//                    less stale than gameHp.
//
// On HP gain (heal / server resync), both trackers snap up to current
// gameHp. This avoids permanent drift after a near-miss where we predicted
// damage that didn't materialize. Trackers are also clamped to maxHp.
static int32_t g_predClientHp = 0;
static int32_t g_predRealHp   = 0;
static int32_t g_lastGameHp   = 0;   // for rise-detection vs predicted decay

static void ResetPredictedHpTo(int32_t newHp, int32_t maxHp)
{
    if (newHp < 0)         newHp = 0;
    if (newHp > maxHp * 2) newHp = maxHp;  // sanity cap on absurd values
    g_predClientHp = newHp;
    g_predRealHp   = newHp;
    g_lastGameHp   = newHp;
}

// xrDriver mirror: drop dmg from one or both trackers and immediately
// check the multi-source nexus condition. Returns true if Nexus fired.
//
//   silent=true:  decrement clientHp only (e.g. our projectile-imminent
//                 scan — predicted, not yet confirmed)
//   silent=false: decrement both (e.g. tile-damage on the player's tile —
//                 essentially guaranteed)
static bool SubtractDamage(int32_t dmg, int32_t gameHp, int32_t maxHp, float thresholdPct,
                           const char* /*source*/, bool silent);

static bool ReadPlayerStatsCached(int32_t& hp, int32_t& maxHp, int32_t& defense)
{
    hp      = LocalPlayer::GetHP();
    maxHp   = LocalPlayer::GetMaxHP();
    defense = SharedMemory::GetClientDefense();
    return LocalPlayer::GetPtr() != nullptr;
}

// Maintain predicted trackers against the live game HP. Call once per
// RunAutoNexus tick BEFORE doing any damage prediction. Handles:
//   - First-ever read: trackers initialize to current HP.
//   - HP rose since last tick (heal, server caught up, near-miss): snap
//     trackers up to live HP so we don't permanently under-estimate.
//   - HP fell since last tick (real damage applied): re-baseline
//     predRealHp to live HP (server confirmed it) so we don't double-
//     count. predClientHp is NOT snapped down — if we already predicted
//     more damage than the server confirmed, keep the safer (lower)
//     estimate until a future heal resets it.
//   - Always clamp both trackers to [0, maxHp].
static void SyncPredictedHpTo(int32_t gameHp, int32_t maxHp)
{
    if (g_lastGameHp == 0 && g_predClientHp == 0 && g_predRealHp == 0) {
        ResetPredictedHpTo(gameHp, maxHp);
        return;
    }
    if (gameHp > g_lastGameHp) {
        // Health rose — heal or server caught up. Snap both trackers up.
        g_predClientHp = gameHp;
        g_predRealHp   = gameHp;
    } else if (gameHp < g_predRealHp) {
        // Server reports lower than our realHp estimate (we under-
        // predicted real damage). Re-baseline realHp.
        g_predRealHp = gameHp;
    }
    if (g_predClientHp > maxHp) g_predClientHp = maxHp;
    if (g_predRealHp   > maxHp) g_predRealHp   = maxHp;
    if (g_predClientHp < 0)     g_predClientHp = 0;
    if (g_predRealHp   < 0)     g_predRealHp   = 0;
    g_lastGameHp = gameHp;
}

static int32_t CalcDamage(int32_t baseDmg, int32_t defense, bool armorBroken, bool armored)
{
    int32_t def = defense;
    if (armorBroken) def = 0;
    else if (armored) def *= 2;
    const int32_t reduced = baseDmg - def;
    const int32_t floor15 = static_cast<int32_t>(0.15f * static_cast<float>(baseDmg));
    return (reduced > floor15) ? reduced : floor15;
}

static bool NexusProjOverlapsPlayerAt(
    const WorldProjectile& proj, float tMs, float playerX, float playerY)
{
    float x = 0.f, y = 0.f;
    ProjectileTracking::ComputePosAt(proj, tMs, x, y);
    const float halfP = (proj.runtimeChebyshevHalf > 1e-4f) ? proj.runtimeChebyshevHalf : proj.projHalfSize;
    const float T     = 0.1f + halfP;
    return fabsf(x - playerX) < T && fabsf(y - playerY) < T;
}

static float FindFirstProjHitTimeMs(
    const WorldProjectile& proj, float tStart, float playerX, float playerY)
{
    const float tMax = tStart + proj.lifetime;
    if (!(tMax > tStart) || !std::isfinite(tStart) || !std::isfinite(tMax))
        return -1.f;

    if (NexusProjOverlapsPlayerAt(proj, tStart, playerX, playerY))
        return tStart;

    const float step = kNexusProjHitScanStepMs;
    float       lo   = tStart;
    for (float t = tStart + step; t <= tMax + 0.5f * step; t += step) {
        if (NexusProjOverlapsPlayerAt(proj, t, playerX, playerY)) {
            float hi = t;
            for (int i = 0; i < 12; ++i) {
                const float mid = 0.5f * (lo + hi);
                if (NexusProjOverlapsPlayerAt(proj, mid, playerX, playerY))
                    hi = mid;
                else
                    lo = mid;
            }
            return hi;
        }
        lo = t;
    }
    return -1.f;
}

static void DbgNexus(const char* msg, const char* hyp, const char* data) {
    FILE* f = nullptr;
    fopen_s(&f, "C:\\Users\\rrizz\\Desktop\\debug-489c1d.log", "a");
    if (f) {
        fprintf(f,
            "{\"sessionId\":\"489c1d\",\"location\":\"AutoNexus/AutoNexus.cpp\",\"message\":\"%s\","
            "\"data\":{%s},\"timestamp\":%llu,\"hypothesisId\":\"%s\"}\n",
            msg, data, (unsigned long long)GetTickCount64(), hyp);
        fclose(f);
    }
}

static void DoNexus()
{
    const ULONGLONG now = GetTickCount64();
    if (now - s_lastNexusTick < 200ULL) return;
    s_lastNexusTick = now;

    SharedMemory::SetNeedsNexus(true);
    DbgNexus("nexus_flag_set", "H", "\"flagSet\":true");
}

static void RunAutoNexus()
{
    void* lp = LocalPlayer::GetPtr();
    if (!lp) return;

    int32_t hp = 0, maxHp = 0, defense = 0;
    if (!ReadPlayerStatsCached(hp, maxHp, defense)) return;

    if (maxHp <= 0 || hp > maxHp * 4) return;
    if (defense < 0) defense = 0;

    if (hp <= 0) { DoNexus(); return; }

    uint32_t cW0 = 0, cW1 = 0;
    RuntimeOffsets::TryReadMapObjectConditions(lp, &cW0, &cW1);
    const uint64_t cFull   = RuntimeOffsets::GetFullConditions(cW0, cW1);
    const bool armorBroken = RuntimeOffsets::HasCondition(cFull, RuntimeOffsets::ConditionEffects::ArmorBroken);
    const bool armored     = RuntimeOffsets::HasCondition(cFull, RuntimeOffsets::ConditionEffects::Armored);

    const float nexusPct = g_nexusHpPct;

    // xrDriver-style: sync our two predicted trackers against live game HP
    // before we evaluate any new damage events this tick.
    SyncPredictedHpTo(hp, maxHp);

    // Multi-source baseline check: nexus if ANY of the three sources is at
    // or below threshold right now (before predicting new damage).
    auto hpPctOf = [&](int32_t v) { return (float)v / (float)maxHp * 100.f; };
    {
        const float gameHpPct   = hpPctOf(hp);
        const float clientHpPct = hpPctOf(g_predClientHp);
        const float realHpPct   = hpPctOf(g_predRealHp);
        if (gameHpPct   <= nexusPct) { DoNexus(); return; }
        if (clientHpPct <= nexusPct) { DoNexus(); return; }
        if (realHpPct   <= nexusPct) { DoNexus(); return; }
    }

    if (g_nexusProjDmg) {
        const float playerX = LocalPlayer::GetX();
        const float playerY = LocalPlayer::GetY();

        std::vector<WorldProjectile> projs;
        ProjectileTracking::CopyActiveForDraw(projs);

        const ULONGLONG nowMs   = GetTickCount64();
        const int32_t   localId = ProjectileTracking::GetLocalPlayerObjectId();

        int32_t totalImminentDmg = 0;

        for (const auto& proj : projs) {
            if (!proj.valid) continue;
            if (localId != 0 && proj.attackerObjId == localId) continue;
            if (localId != 0 && static_cast<int32_t>(proj.ownerObjId) == localId) continue;

            const int32_t hitDmg = CalcDamage(proj.damage, defense, armorBroken, armored);
            if (hitDmg <= 0) continue;

            const float alreadyElapsed =
                (float)((int64_t)nowMs - (int64_t)proj.spawnTick);
            if (alreadyElapsed < 0.f || alreadyElapsed > proj.lifetime + 50.f)
                continue;

            const float tHit = FindFirstProjHitTimeMs(proj, alreadyElapsed, playerX, playerY);
            if (tHit < 0.f) continue;

            const float msUntilHit = tHit - alreadyElapsed;
            if (msUntilHit < 0.f || msUntilHit > kNexusProjImminentMs) continue;

            totalImminentDmg += hitDmg;
        }

        if (totalImminentDmg > 0) {
            // Apply the predicted damage to clientHp (silent=true: not yet
            // confirmed). xrDriver: clientHp shrinks; realHp untouched.
            // Then check all three sources.
            if (SubtractDamage(totalImminentDmg, hp, maxHp, nexusPct,
                               "imminent-proj", /*silent=*/true)) return;
        }
    }

    if (g_nexusTileDmg) {
        const float playerX = LocalPlayer::GetX();
        const float playerY = LocalPlayer::GetY();
        const int tileX = (int)floorf(playerX);
        const int tileY = (int)floorf(playerY);

        for (const auto& tile : WorldTAB::GetTiles()) {
            if (tile.tileX != tileX || tile.tileY != tileY) continue;
            if (tile.maxDmg > 0) {
                const int32_t tileDmg = CalcDamage(tile.maxDmg, defense, armorBroken, armored);
                if (tileDmg > 0) {
                    // Tile damage on the player's tile is essentially
                    // guaranteed every game tick — silent=false: also
                    // subtract from realHp.
                    if (SubtractDamage(tileDmg, hp, maxHp, nexusPct,
                                       "tile", /*silent=*/false)) return;
                }
            }
            break;
        }
    }
}

// Definition of SubtractDamage (declared near the top of the file).
// Mirrors xrDriver::AutoNexus::SubtractDamage(dmg, source, silent):
//   - decrements g_predClientHp always
//   - decrements g_predRealHp only when silent=false
//   - runs the multi-source nexus check; returns true if Nexus fired
static bool SubtractDamage(int32_t dmg, int32_t gameHp, int32_t maxHp, float thresholdPct,
                           const char* /*source*/, bool silent)
{
    if (dmg <= 0) return false;
    g_predClientHp -= dmg;
    if (!silent) g_predRealHp -= dmg;
    if (g_predClientHp < 0) g_predClientHp = 0;
    if (g_predRealHp   < 0) g_predRealHp   = 0;

    auto hpPctOf = [&](int32_t v) { return (float)v / (float)maxHp * 100.f; };
    const float gameHpPct   = hpPctOf(gameHp);
    const float clientHpPct = hpPctOf(g_predClientHp);
    const float realHpPct   = hpPctOf(g_predRealHp);

    if (gameHpPct   <= thresholdPct ||
        clientHpPct <= thresholdPct ||
        realHpPct   <= thresholdPct) {
        DoNexus();
        return true;
    }
    return false;
}

// ── Autopot impl ─────────────────────────────────────────────────────────
// Resolve EquipmentManager.UseInventoryItemByHotkey + the EquipmentManager
// pointer field on the player class. Idempotent — subsequent calls return
// immediately when s_autoPotResolved is set.
static void ResolveAutoPotOnce()
{
    if (s_autoPotResolved) return;
    Resolver::Protection::safe_call([&]() {
        Il2CppClass* em = Resolver::FindClass("DecaGames.RotMG.Managers.Equipment", "EquipmentManager");
        if (!em) em = Resolver::FindClassLoose("PNBNDBIPENP");
        if (em) {
            const MethodInfo* mi = il2cpp_class_get_method_from_name(em, "UseInventoryItemByHotkey", 1);
            if (mi && mi->methodPointer) {
                s_fnUseInvByHotkey = reinterpret_cast<UseInvByHotkeyFn>(mi->methodPointer);
            }
        }
        Il2CppClass* fk = Resolver::FindClassLoose("FKALGHJIADI");
        if (fk) {
            FieldInfo* eqf = il2cpp_class_get_field_from_name(fk, "AJJJBDBNBLM");
            if (eqf) s_eqMgrFieldOff = static_cast<uint32_t>(il2cpp_field_get_offset(eqf));
        }
    });
    if (s_fnUseInvByHotkey && s_eqMgrFieldOff) s_autoPotResolved = true;
}

static void* ReadEquipmentManagerPtr(void* localPlayer)
{
    if (!localPlayer || !s_eqMgrFieldOff) return nullptr;
    void* eqMgr = nullptr;
    __try {
        eqMgr = *reinterpret_cast<void**>(reinterpret_cast<uint8_t*>(localPlayer) + s_eqMgrFieldOff);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return nullptr;
    }
    return eqMgr;
}

static void TryDrinkHotkey(int hotkey, ULONGLONG& lastTickMs)
{
    const ULONGLONG now = GetTickCount64();
    if (now - lastTickMs < kPotCooldownMs) return;
    void* lp = LocalPlayer::GetPtr();
    if (!lp) return;
    void* eqMgr = ReadEquipmentManagerPtr(lp);
    if (!eqMgr) return;
    Resolver::Protection::safe_call([&]() {
        s_fnUseInvByHotkey(eqMgr, hotkey, nullptr);
    });
    lastTickMs = now;
}

static void RunAutoPot()
{
    ResolveAutoPotOnce();
    if (!s_fnUseInvByHotkey || !s_eqMgrFieldOff) return;

    if (g_autoPotHp) {
        const int32_t hp    = LocalPlayer::GetHP();
        const int32_t maxHp = LocalPlayer::GetMaxHP();
        if (hp > 0 && maxHp > 0) {
            const float pct = static_cast<float>(hp) / static_cast<float>(maxHp) * 100.f;
            if (pct < g_autoPotHpPct)
                TryDrinkHotkey(g_autoPotHpHotkey, s_lastHpPotMs);
        }
    }

    if (g_autoPotMp) {
        const float   mp    = LocalPlayer::GetCurMpF();
        const int32_t maxMp = LocalPlayer::GetMaxMP();
        if (mp > 0.f && maxMp > 0) {
            const float pct = mp / static_cast<float>(maxMp) * 100.f;
            if (pct < g_autoPotMpPct)
                TryDrinkHotkey(g_autoPotMpHotkey, s_lastMpPotMs);
        }
    }
}

void Tick()
{
    const ULONGLONG now = GetTickCount64();

    if (g_autoNexus) {
        if (now - s_lastAutoNexusTick >= kAutoNexusPollMs) {
            s_lastAutoNexusTick = now;
            RunAutoNexus();
        }
    }

    // Autopot runs on every poll (cheap when disabled — early-out at the
    // top of RunAutoPot). Independent of AutoNexus toggle so users can
    // drink without auto-nexus or vice versa.
    if (g_autoPotHp || g_autoPotMp) {
        RunAutoPot();
    }
}

void Render()
{
    ImGui::TextColored(ImVec4(0.4f, 0.8f, 1.f, 1.f), "AUTO NEXUS");
    ImGui::Checkbox("Auto nexus", &g_autoNexus);

    if (g_autoNexus) {
        ImGui::Indent();

        ImGui::SliderFloat("Nexus HP %", &g_nexusHpPct, 1.f, 95.f, "%.0f%%");
        ImGui::Checkbox("Predict projectile damage", &g_nexusProjDmg);
        if (g_nexusProjDmg)
            ImGui::TextDisabled(
                "Nexus when imminent projectiles (within %.0f ms) would drop HP below threshold. "
                "Accumulates ALL close bullets. Uses RotMG damage formula (15%% floor, "
                "ArmorBroken/Armored aware). Hitbox: 0.1 tile (pixel-perfect).",
                kNexusProjImminentMs);
        ImGui::Checkbox("Tile damage check", &g_nexusTileDmg);

        if (LocalPlayer::GetPtr()) {
            const int32_t hp    = LocalPlayer::GetHP();
            const int32_t maxHp = LocalPlayer::GetMaxHP();
            if (maxHp > 0 && hp > 0)
                ImGui::TextDisabled("HP: %d / %d  (%.0f%%)", hp, maxHp,
                    static_cast<float>(hp) / static_cast<float>(maxHp) * 100.f);
        } else {
            ImGui::TextDisabled("No local player");
        }

        ImGui::Unindent();
    }
}

bool ConsumesLocalPlayer()
{
    return g_autoNexus || g_autoPotHp || g_autoPotMp;
}

// ── Public setters (called from IpcBridge) ──────────────────────────────
void SetAutoNexusEnabled(bool on)            { g_autoNexus = on; }
void SetAutoNexusHpPct(float pct)            { g_nexusHpPct = std::max(1.f, std::min(95.f, pct)); }
void SetAutoNexusProjPredictEnabled(bool on) { g_nexusProjDmg = on; }
void SetAutoNexusTilePredictEnabled(bool on) { g_nexusTileDmg = on; }

void SetAutoPotHpEnabled(bool on)            { g_autoPotHp = on; }
void SetAutoPotHpThresholdPct(float pct)     { g_autoPotHpPct = std::max(1.f, std::min(99.f, pct)); }
void SetAutoPotHpHotkey(int hotkey)          { g_autoPotHpHotkey = std::max(0, std::min(15, hotkey)); }
void SetAutoPotMpEnabled(bool on)            { g_autoPotMp = on; }
void SetAutoPotMpThresholdPct(float pct)     { g_autoPotMpPct = std::max(1.f, std::min(99.f, pct)); }
void SetAutoPotMpHotkey(int hotkey)          { g_autoPotMpHotkey = std::max(0, std::min(15, hotkey)); }

// ── External (proxy-driven) damage / HP-sync — Phase 2 ──────────────────
// Wired in IpcBridge.cpp via the "autonexusOnDamage" / "autonexusSyncHp"
// feature keys. The bot-client proxy parses outgoing PLAYERHIT / AOEACK
// + incoming NEWTICK statuses and forwards the damage / authoritative HP
// here so the predicted trackers stay aligned without our own polling
// having to guess.
void OnExternalDamage(int32_t dmg, bool silent)
{
    if (!g_autoNexus) return;             // disabled → nothing to do
    if (dmg <= 0) return;
    const int32_t hp    = LocalPlayer::GetHP();
    const int32_t maxHp = LocalPlayer::GetMaxHP();
    if (maxHp <= 0) return;
    // SyncPredictedHpTo runs at the top of every poll tick; do a fast
    // version here so we don't wait for the next poll before reacting.
    SyncPredictedHpTo(hp, maxHp);
    (void)SubtractDamage(dmg, hp, maxHp, g_nexusHpPct,
                         silent ? "proxy-imminent" : "proxy-confirmed",
                         silent);
}

void OnExternalHpSync(int32_t hp, int32_t maxHp)
{
    if (maxHp <= 0) return;
    if (hp < 0)    hp = 0;
    // Server packet is authoritative — snap both trackers, then update
    // g_lastGameHp so the next polling-side SyncPredictedHpTo doesn't
    // mistake the server's update for a heal-induced rise.
    ResetPredictedHpTo(hp, maxHp);
}

} // namespace FeatAutoNexus
} // namespace CombatTAB
