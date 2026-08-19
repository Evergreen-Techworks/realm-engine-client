#include "pch-il2cpp.h"
#include "PlayerTAB.h"
#include "WorldTAB.h"
#include "LocalPlayer.h"
#include <imgui/imgui.h>
#include <imgui/imgui_internal.h>
#include <windows.h>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <cmath>
#include "Il2CppResolver.h"
#include "Il2CppHook.h"
#include "RuntimeOffsets.h"
#include "core/runtime/MemRead.h"
#include "core/il2cpp/Il2CppContainers.h"
#include "game/objects/GameObjects.h"
#include "game/math/MoveSpeed.h"

// ─────────────────────────────────────────────────────────────────────────────
// Equipment slots: EquipmentManager.equipmentSlots[] — same order as game static ids
// (FirstWeaponEquipmentId, SecondWeaponEquipmentId, ArmorEquipmentId, RingEquipmentId).
// Object type id from ItemSlot / InteractiveItemSlot (matches entity objType namespace).
// ─────────────────────────────────────────────────────────────────────────────
struct EquipSlotSnap {
    bool    readable = false;
    bool    empty    = false;
    int32_t objType  = 0;
};

static constexpr int kEquipSlotCount = 4;

static const char* const kEquipSlotLabels[kEquipSlotCount] = {
    "Weapon (primary)",
    "Weapon (secondary)",
    "Armor",
    "Ring",
};

// ─────────────────────────────────────────────────────────────────────────────
// Cached player snapshot
// ─────────────────────────────────────────────────────────────────────────────
struct PlayerSnap {
    float  x = 0.f, y = 0.f;
    int32_t hp = 0, maxHp = 0;
    int32_t classNum = 0;
    int32_t guildRank = 0;
    float  curMp = 0.f;
    int32_t maxMp = 0;
    // Stats (values unconfirmed; using dump+0x50 shift hypothesis)
    int32_t atk = 0, vit = 0, wis = 0, def = 0;
    float   spd = 0.f, dex = 0.f;
    float   calcMoveSpeed = 0.f;
    bool    calcMoveSpeedValid = false;
    char   name[64] = {};
    EquipSlotSnap equipment[kEquipSlotCount];
    // Condition tracking — three sources, all resolved dynamically where possible:
    //   [A] COHCKAPOLCA UInt32[] pointer path (MapObject base, word0/word1)
    //   [B] MPJGAPJBBBF single-int on FKALGHJIADI (BeeByte name resolved via il2cpp)
    //   [C] raw [this+0x440] — the exact offset HasConditionEffect reads in the .lst
    uint32_t condLo  = 0;  // [A] word 0  (bits  0–30)
    uint32_t condHi  = 0;  // [A] word 1  (bits 31–63)
    int32_t  condInt = 0;  // [B] MPJGAPJBBBF int
    int32_t  condRaw = 0;  // [C] [this+0x440] raw int
};

static PlayerSnap g_snap;
// FKALGHJIADI.GCFKGLKAPND => CalcMoveSpeed (float, instance, 0 args) — FKALGHJIADI_mapped.txt
static const MethodInfo* s_miCalcMoveSpeed = nullptr;
static bool  g_valid        = false;
static bool  g_autoRefresh  = false;
static float g_autoTimer    = 0.f;
static float g_autoInterval = 1.0f;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
// Raw-memory reads and pointer validation now go through Mem::
// (core/runtime/MemRead.h).

// EquipmentManager.equipmentSlots[i] → ItemSlot HLJFBHLMANJ (ObjectProperties*), INAAIAHOEFE (type id).
static void ReadEquipmentSlots(void* localFk, PlayerSnap& s)
{
    for (int i = 0; i < kEquipSlotCount; ++i)
        s.equipment[i] = {};

    if (!localFk || !Mem::AddrOk(localFk))
        return;

    const bool ok = Resolver::Protection::safe_call([&]() {
        void* em = Mem::ReadPtr(localFk, RuntimeOffsets::PlayerEquipMgr);
        if (!Mem::AddrOk(em))
            return;

        void* arr = Mem::ReadPtr(em, RuntimeOffsets::EM_EquipSlots);
        if (!Mem::AddrOk(arr))
            return;

        const uint32_t lenU = il2cpp_array_length(reinterpret_cast<Il2CppArray*>(arr));
        if (lenU == 0)
            return;

        const int n = (static_cast<int>(lenU) < kEquipSlotCount)
            ? static_cast<int>(lenU)
            : kEquipSlotCount;

        for (int i = 0; i < n; ++i) {
            void* slot = GET_ARRAY_ELEMENT(arr, i);
            if (!Mem::AddrOk(slot))
                continue;

            void* op = Mem::ReadPtr(slot, RuntimeOffsets::Item_ObjProps);
            int32_t tid = Mem::ReadOr<int32_t>(slot, RuntimeOffsets::Item_ObjType, 0);

            EquipSlotSnap& es = s.equipment[i];
            es.readable = true;
            const bool hasOp = Mem::AddrOk(op);
            if (!hasOp && tid == 0)
                es.empty = true;
            else
                es.objType = tid;
        }
    });

    if (!ok) {
        for (int i = 0; i < kEquipSlotCount; ++i)
            s.equipment[i] = {};
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DoRefresh — read all fields from localPtr
// ─────────────────────────────────────────────────────────────────────────────
static void DoRefresh()
{
    // Use LocalPlayer cache — pointer is resolved by LocalPlayer::Tick() each frame.
    void* lp = LocalPlayer::GetPtr();
    if (!lp) lp = WorldTAB::GetLocalPtr();  // fallback if LocalPlayer not yet warm
    g_valid = false;
    if (!lp || !Mem::AddrOk(lp)) return;

    PlayerSnap s = {};

    Game::Character ch(lp);
    s.x     = ch.AsEntity().X();
    s.y     = ch.AsEntity().Y();
    s.hp    = ch.Hp();
    s.maxHp = ch.MaxHp();
    Mem::TryRead(lp, RuntimeOffsets::PlayerClassNum,    s.classNum);
    Mem::TryRead(lp, RuntimeOffsets::PlayerGuildRank,   s.guildRank);
    s.curMp = ch.CurMpF();
    s.maxMp = ch.MaxMp();
    Mem::TryRead(lp, RuntimeOffsets::PlayerAtk,         s.atk);
    Mem::TryRead(lp, RuntimeOffsets::Player_Spd,        s.spd);
    Mem::TryRead(lp, RuntimeOffsets::PlayerDex,         s.dex);
    Mem::TryRead(lp, RuntimeOffsets::PlayerVit,         s.vit);
    Mem::TryRead(lp, RuntimeOffsets::PlayerWis,         s.wis);
    s.def   = ch.Defense();

    // Player name (Il2CppString*)
    void* namePtr = nullptr;
    if (Mem::TryRead(lp, RuntimeOffsets::PlayerName, namePtr))
        Il2CppC::ReadStringUtf8(namePtr, s.name, sizeof(s.name));
    if (s.name[0] == '\0')
        strcpy_s(s.name, "<?>");

    ReadEquipmentSlots(lp, s);

    // [A] COHCKAPOLCA UInt32[] pointer path (same as WorldTAB / CombatTAB)
    {
        uint64_t condFull = 0;
        if (ch.Conditions(condFull)) {
            s.condLo = static_cast<uint32_t>(condFull);
            s.condHi = static_cast<uint32_t>(condFull >> 32);
        }
    }
    // [B] MPJGAPJBBBF single-int condition field (BeeByte-resolved at runtime)
    Mem::TryRead(lp, RuntimeOffsets::PlayerCondInt, s.condInt);
    // [C] raw [this+0x440] — the exact offset HasConditionEffect reads in the .lst
    Mem::TryRead(lp, RuntimeOffsets::Player_CondRaw, s.condRaw);

    if (!s_miCalcMoveSpeed) {
        s_miCalcMoveSpeed = Il2CppHook::ResolveMethodCached("FKALGHJIADI", "GCFKGLKAPND", 0);
    }
    if (s_miCalcMoveSpeed) {
        Il2CppObject* boxed = Resolver::Protection::SafeRuntimeInvoke(
            s_miCalcMoveSpeed, reinterpret_cast<Il2CppObject*>(lp), nullptr);
        if (boxed) {
            s.calcMoveSpeed = Resolver::Protection::SafeUnbox<float>(boxed, 0.f);
            s.calcMoveSpeedValid = std::isfinite(s.calcMoveSpeed);
        }
    }

    g_snap  = s;
    g_valid = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress bar helper
// ─────────────────────────────────────────────────────────────────────────────
static void DrawBar(float cur, float max, ImVec4 col, const char* label)
{
    if (max <= 0.f) max = 1.f;
    float frac = cur / max;
    if (frac < 0.f) frac = 0.f;
    if (frac > 1.f) frac = 1.f;

    char overlay[32];
    snprintf(overlay, sizeof(overlay), "%d / %d", static_cast<int>(cur), static_cast<int>(max));

    ImGui::PushStyleColor(ImGuiCol_PlotHistogram, col);
    ImGui::ProgressBar(frac, ImVec2(-1.f, 13.f), overlay);
    ImGui::PopStyleColor();

    ImGui::SameLine(0, 6);
    ImGui::TextUnformatted(label);
}

// ─────────────────────────────────────────────────────────────────────────────
// PlayerTAB::Tick — called every frame from dPresent (before Render)
// Handles auto-refresh timing and consumer registration so LocalPlayer
// keeps stats hot when auto-refresh is active and the menu is open.
// ─────────────────────────────────────────────────────────────────────────────
void PlayerTAB::Tick(bool menuVisible)
{
    // Register/unregister as a LocalPlayer consumer: live stats needed only
    // when auto-refresh is enabled AND the menu is visible.
    {
        static bool s_wasConsuming = false;
        const bool  nowConsuming   = g_autoRefresh && menuVisible;
        if (nowConsuming && !s_wasConsuming)  LocalPlayer::AddConsumer();
        else if (!nowConsuming && s_wasConsuming) LocalPlayer::RemoveConsumer();
        s_wasConsuming = nowConsuming;
    }

    // Auto-refresh tick (time-based, independent of frame rate)
    if (g_autoRefresh && menuVisible) {
        const float dt = ImGui::GetIO().DeltaTime;
        g_autoTimer += dt;
        if (g_autoTimer >= g_autoInterval) {
            g_autoTimer = 0.f;
            DoRefresh();
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PlayerTAB::Render
// ─────────────────────────────────────────────────────────────────────────────
void PlayerTAB::Render()
{

    ImGui::Spacing();
    ImGui::TextColored(ImVec4(0.4f, 0.9f, 1.f, 1.f), "LOCAL PLAYER");
    ImGui::SameLine();
    ImGui::SetCursorPosX(ImGui::GetCursorPosX() + 8.f);

    if (ImGui::Button("Refresh"))
        DoRefresh();

    ImGui::SameLine();
    ImGui::Checkbox("Auto", &g_autoRefresh);
    if (g_autoRefresh) {
        ImGui::SameLine();
        ImGui::SetNextItemWidth(60.f);
        ImGui::DragFloat("##interval", &g_autoInterval, 0.1f, 0.2f, 10.f, "%.1fs");
    }

    ImGui::Separator();
    ImGui::Spacing();

    if (!g_valid) {
        if (!LocalPlayer::GetPtr()) {
            ImGui::TextColored(ImVec4(1.f, 0.5f, 0.3f, 1.f),
                "No local player — loading...");
        } else {
            ImGui::TextColored(ImVec4(1.f, 0.9f, 0.3f, 1.f),
                "Player found — press Refresh.");
        }
        return;
    }

    // ── Identity ────────────────────────────────────────────────────────────
    ImGui::TextColored(ImVec4(1.f, 0.9f, 0.3f, 1.f), "%s", g_snap.name);
    ImGui::SameLine();
    ImGui::TextDisabled("  class 0x%03X (%d)", g_snap.classNum, g_snap.classNum);

    ImGui::Text("Position:  %.2f, %.2f", g_snap.x, g_snap.y);
    ImGui::Text("Guild Rank: %d", g_snap.guildRank);

    ImGui::TextColored(ImVec4(0.75f, 0.75f, 0.75f, 1.f), "Equipment (object type id)");
    {
        bool anyReadable = false;
        for (int i = 0; i < kEquipSlotCount; ++i) {
            if (g_snap.equipment[i].readable)
                anyReadable = true;
        }
        if (!anyReadable) {
            ImGui::TextDisabled("  —  (not in game or EquipmentManager not linked)");
        } else {
            for (int i = 0; i < kEquipSlotCount; ++i) {
                const EquipSlotSnap& es = g_snap.equipment[i];
                if (!es.readable) {
                    ImGui::TextDisabled("  [%d] %s:  —", i, kEquipSlotLabels[i]);
                    continue;
                }
                if (es.empty)
                    ImGui::Text("  [%d] %s:  (empty)", i, kEquipSlotLabels[i]);
                else
                    ImGui::Text("  [%d] %s:  %d", i, kEquipSlotLabels[i], es.objType);
            }
        }
    }

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    // ── Vitals ──────────────────────────────────────────────────────────────
    ImGui::TextColored(ImVec4(0.8f, 0.8f, 0.8f, 1.f), "VITALS");
    DrawBar(static_cast<float>(g_snap.hp),    static_cast<float>(g_snap.maxHp),
            ImVec4(0.2f, 0.8f, 0.2f, 1.f), "HP");
    DrawBar(g_snap.curMp, static_cast<float>(g_snap.maxMp),
            ImVec4(0.2f, 0.4f, 1.f, 1.f), "MP");

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    // ── Status conditions ────────────────────────────────────────────────────
    ImGui::TextColored(ImVec4(0.8f, 0.8f, 0.8f, 1.f), "STATUS CONDITIONS");

    // [A] COHCKAPOLCA UInt32[] pointer (MapObject base — offset_map.md / CombatTAB)
    ImGui::TextDisabled("[A] COHCKAPOLCA UInt32[] (MoConditions @ +0x%03X)", RuntimeOffsets::MoConditions);
    if (g_snap.condLo | g_snap.condHi) {
        char cdesc[320] = {};
        RuntimeOffsets::FormatMapObjectConditionMask(g_snap.condLo, g_snap.condHi, cdesc, sizeof cdesc);
        ImGui::TextWrapped("%s", cdesc);
        ImGui::TextDisabled("  mask: %08X %08X", g_snap.condLo, g_snap.condHi);
    } else {
        ImGui::TextDisabled("  (none)");
    }

    ImGui::Spacing();

    // [B] MPJGAPJBBBF single-int field on FKALGHJIADI (BeeByte-resolved)
    ImGui::TextDisabled("[B] MPJGAPJBBBF int (FKALGHJIADI @ +0x%03X)", RuntimeOffsets::PlayerCondInt);
    if (g_snap.condInt != 0) {
        char cdescB[320] = {};
        uint32_t w0B = static_cast<uint32_t>(g_snap.condInt);
        RuntimeOffsets::FormatMapObjectConditionMask(w0B, 0u, cdescB, sizeof cdescB);
        ImGui::TextWrapped("%s", cdescB);
        ImGui::TextDisabled("  raw: %08X (%d)", w0B, g_snap.condInt);
    } else {
        ImGui::TextDisabled("  (none / 0)");
    }

    ImGui::Spacing();

    // [C] Raw [this+0x440] — the exact dword HasConditionEffect reads in the .lst
    ImGui::TextDisabled("[C] lst HasConditionEffect offset [this+0x440]");
    if (g_snap.condRaw != 0) {
        char cdescC[320] = {};
        uint32_t w0C = static_cast<uint32_t>(g_snap.condRaw);
        RuntimeOffsets::FormatMapObjectConditionMask(w0C, 0u, cdescC, sizeof cdescC);
        ImGui::TextWrapped("%s", cdescC);
        ImGui::TextDisabled("  raw: %08X (%d)", w0C, g_snap.condRaw);
    } else {
        ImGui::TextDisabled("  (none / 0)");
    }

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    // ── Stats ───────────────────────────────────────────────────────────────
    ImGui::TextColored(ImVec4(0.8f, 0.8f, 0.8f, 1.f), "STATS");
    ImGui::TextDisabled("%s",
        RuntimeOffsets::AllResolved()
            ? "Field offsets from RuntimeOffsets (self-healing table)."
            : "Field offsets: RuntimeOffsets pending (resolution in progress).");
    ImGui::Spacing();

    float col2 = 110.f;
    auto StatRow = [&](const char* labelA, int valA,
                       const char* labelB, int valB) {
        ImGui::Text("%-4s  %4d", labelA, valA);
        ImGui::SameLine(col2);
        ImGui::Text("%-4s  %4d", labelB, valB);
    };
    auto StatRowF = [&](const char* labelA, float valA,
                        const char* labelB, float valB) {
        ImGui::Text("%-4s  %4.0f", labelA, valA);
        ImGui::SameLine(col2);
        ImGui::Text("%-4s  %4.0f", labelB, valB);
    };

    StatRow("ATK",  g_snap.atk,  "DEF",  g_snap.def);
    StatRowF("SPD", g_snap.spd,  "DEX",  g_snap.dex);
    StatRow("VIT",  g_snap.vit,  "WIS",  g_snap.wis);

    ImGui::Spacing();
    if (g_snap.calcMoveSpeedValid)
        ImGui::TextColored(ImVec4(0.65f, 1.f, 0.8f, 1.f),
            "CalcMoveSpeed (GCFKGLKAPND):  %.4f", g_snap.calcMoveSpeed);
    else
        ImGui::TextDisabled("CalcMoveSpeed (GCFKGLKAPND):  —  (invoke failed or non-finite)");

    // Tiles/sec = DIA4A's autododge speed formula (same formula used for Follow Mouse movement)
    if (g_snap.spd > 0.f) {
        const float tilesPerSec = GameMath::TilesPerSecFromSpd(g_snap.spd);
        ImGui::Spacing();
        ImGui::TextColored(ImVec4(0.6f, 1.f, 0.6f, 1.f),
            "Move speed:  %.2f tiles/s  (4 + 5.6 * spd/75)", tilesPerSec);
    }

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    // ── Raw pointer ─────────────────────────────────────────────────────────
    void* lp = WorldTAB::GetLocalPtr();
    ImGui::TextDisabled("ptr: 0x%llX", (unsigned long long)lp);
}
