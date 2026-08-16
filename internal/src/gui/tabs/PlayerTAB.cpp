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
#include "RuntimeOffsets.h"
#include "core/runtime/MemRead.h"
#include "game/math/MoveSpeed.h"

// ─────────────────────────────────────────────────────────────────────────────
// Fallback offsets when IL2CPP metadata lookup fails (DIA4A / WorldTAB lineage).
// Live game uses il2cpp_field_get_offset + field names from global-metadata.
// ─────────────────────────────────────────────────────────────────────────────
static constexpr uint32_t FB_POS_X         = 0x3C;
static constexpr uint32_t FB_POS_Y         = 0x40;
static constexpr uint32_t FB_HP            = 0x20C;
static constexpr uint32_t FB_MAX_HP        = 0x208;
static constexpr uint32_t FB_NAME          = 0x4B8;
static constexpr uint32_t FB_CLASSNUM      = 0x4B0;
static constexpr uint32_t FB_GRANK         = 0x4AC;
static constexpr uint32_t FB_CUR_MP        = 0x54C;
static constexpr uint32_t FB_MAX_MP        = 0x548;
static constexpr uint32_t FB_ATK           = 0x474;
static constexpr uint32_t FB_SPD           = 0x478;
static constexpr uint32_t FB_DEX           = 0x47C;
static constexpr uint32_t FB_VIT           = 0x480;
static constexpr uint32_t FB_WIS           = 0x484;
static constexpr uint32_t FB_DEF           = 0x508;  // NNECFGPDBEE defense @ dump 0x4B8 + 0x50 ACTK
// MPJGAPJBBBF condition single-int @ dump 0x4C4 + 0x50 ACTK
static constexpr uint32_t FB_COND_INT      = 0x514;
// HasConditionEffect in lst reads [this+0x440] — track this raw offset too
static constexpr uint32_t FB_COND_RAW      = 0x440;
static constexpr uint32_t FB_EQUIPMENT_MGR = 0x668;
static constexpr uint32_t FB_EM_SLOTS      = 0x48;
static constexpr uint32_t FB_ITEM_OP       = 0x58;
static constexpr uint32_t FB_ITEM_TYPE     = 0x60;

// ─────────────────────────────────────────────────────────────────────────────
// Cached offsets from IL2CPP (or fallbacks)
// ─────────────────────────────────────────────────────────────────────────────
struct PlayerFieldCache {
    uint32_t posX = 0, posY = 0, hp = 0, maxHp = 0;
    uint32_t nameStr = 0, classNum = 0, guildRank = 0;
    uint32_t curMp = 0, maxMp = 0;
    uint32_t atk = 0, spd = 0, dex = 0, vit = 0, wis = 0, def = 0;
    uint32_t condInt = 0;   // MPJGAPJBBBF — single-int condition field
    uint32_t condRaw = 0;   // raw offset used by HasConditionEffect in lst ([this+0x440])
    uint32_t equipmentMgr = 0;
    uint32_t emEquipmentSlots = 0;
    uint32_t itemObjProps = 0, itemObjType = 0;
    bool     ready = false;
    bool     fromIl2Cpp = false;
};

static PlayerFieldCache g_fields;

static FieldInfo* FindFieldOnHierarchy(Il2CppClass* klass, const char* fieldName)
{
    for (Il2CppClass* k = klass; k; k = il2cpp_class_get_parent(k)) {
        FieldInfo* f = il2cpp_class_get_field_from_name(k, fieldName);
        if (f)
            return f;
    }
    return nullptr;
}

static uint32_t FieldOffsetOr(Il2CppClass* startKlass, const char* fieldName, uint32_t fallback)
{
    FieldInfo* f = FindFieldOnHierarchy(startKlass, fieldName);
    if (!f)
        return fallback;
    return static_cast<uint32_t>(il2cpp_field_get_offset(f));
}

static void ApplyFallbackFieldOffsets()
{
    // Use RuntimeOffsets for the shared fields — EnsureAll() may have already
    // resolved them; these are at least the hardcoded fallback values otherwise.
    g_fields.posX           = RuntimeOffsets::PosX;
    g_fields.posY           = RuntimeOffsets::PosY;
    g_fields.hp             = RuntimeOffsets::HP;
    g_fields.maxHp          = RuntimeOffsets::MaxHP;
    g_fields.nameStr        = FB_NAME;
    g_fields.classNum       = FB_CLASSNUM;
    g_fields.guildRank      = FB_GRANK;
    g_fields.curMp          = FB_CUR_MP;
    g_fields.maxMp          = FB_MAX_MP;
    g_fields.atk            = FB_ATK;
    g_fields.spd            = FB_SPD;
    g_fields.dex            = FB_DEX;
    g_fields.vit            = FB_VIT;
    g_fields.wis            = FB_WIS;
    g_fields.def            = FB_DEF;
    g_fields.condInt        = FB_COND_INT;
    g_fields.condRaw        = FB_COND_RAW;
    g_fields.equipmentMgr   = FB_EQUIPMENT_MGR;
    g_fields.emEquipmentSlots = FB_EM_SLOTS;
    g_fields.itemObjProps   = FB_ITEM_OP;
    g_fields.itemObjType    = FB_ITEM_TYPE;
    g_fields.fromIl2Cpp     = false;
    g_fields.ready          = true;
}

static Il2CppClass* ResolveEquipmentManagerClass()
{
    Il2CppClass* k = Resolver::FindClass("DecaGames.RotMG.Managers.Equipment", "EquipmentManager");
    if (k)
        return k;
    return Resolver::FindClassLoose("PNBNDBIPENP");
}

static Il2CppClass* ResolveItemSlotClass()
{
    Il2CppClass* k = Resolver::FindClass("DecaGames.RotMG.UI.Slots", "ItemSlot");
    if (k)
        return k;
    return Resolver::FindClassLoose("CMHHJNPDMHJ");
}

// il2cpp_field_get_offset reflects runtime layout (incl. ACTK). Retries after menu-time fallback.
static void EnsurePlayerFieldOffsets()
{
    if (g_fields.fromIl2Cpp)
        return;

    Il2CppClass* fk = Resolver::FindClassLoose("FKALGHJIADI");
    if (!fk) {
        if (!g_fields.ready)
            ApplyFallbackFieldOffsets();
        return;
    }

    g_fields.posX      = FieldOffsetOr(fk, "CLFEOFKBNEJ", FB_POS_X);
    g_fields.posY      = FieldOffsetOr(fk, "PKEECFNFEIO", FB_POS_Y);
    g_fields.hp        = FieldOffsetOr(fk, "NCBIICBDGAG", FB_HP);
    g_fields.maxHp     = FieldOffsetOr(fk, "KJNHLADHEMH", FB_MAX_HP);
    g_fields.nameStr   = FieldOffsetOr(fk, "NFJGJKLPLBA", FB_NAME);
    g_fields.guildRank = FieldOffsetOr(fk, "GBANOMPLGBH", FB_GRANK);
    g_fields.classNum  = FieldOffsetOr(fk, "KABPJBJPGCM", FB_CLASSNUM);
    g_fields.curMp     = FieldOffsetOr(fk, "FMHMGKEPIDN", FB_CUR_MP);
    g_fields.maxMp     = FieldOffsetOr(fk, "NEDCKPIIIPN", FB_MAX_MP);
    g_fields.atk       = FieldOffsetOr(fk, "HCMECDPHEMC", FB_ATK);
    g_fields.spd       = FieldOffsetOr(fk, "BHJFNEAHAOE", FB_SPD);
    g_fields.dex       = FieldOffsetOr(fk, "GDNEBFDDDKM", FB_DEX);
    g_fields.vit       = FieldOffsetOr(fk, "CGFPEPCKKOK", FB_VIT);
    g_fields.wis       = FieldOffsetOr(fk, "HDCDGHKGLDI", FB_WIS);
    g_fields.def       = FieldOffsetOr(fk, "NNECFGPDBEE", FB_DEF);
    // MPJGAPJBBBF is the single-int condition field on FKALGHJIADI (not defense).
    // HasConditionEffect in the .lst reads [this+0x440]; track both for diagnostics.
    g_fields.condInt   = FieldOffsetOr(fk, "MPJGAPJBBBF", FB_COND_INT);
    g_fields.condRaw   = FB_COND_RAW; // static — lst-confirmed; no BeeByte alias for this internal field
    g_fields.equipmentMgr = FieldOffsetOr(fk, "AJJJBDBNBLM", FB_EQUIPMENT_MGR);

    Il2CppClass* em = ResolveEquipmentManagerClass();
    if (em) {
        FieldInfo* es = FindFieldOnHierarchy(em, "equipmentSlots");
        g_fields.emEquipmentSlots = es
            ? static_cast<uint32_t>(il2cpp_field_get_offset(es))
            : FB_EM_SLOTS;
    } else {
        g_fields.emEquipmentSlots = FB_EM_SLOTS;
    }

    Il2CppClass* item = ResolveItemSlotClass();
    if (item) {
        g_fields.itemObjProps = FieldOffsetOr(item, "HLJFBHLMANJ", FB_ITEM_OP);
        g_fields.itemObjType  = FieldOffsetOr(item, "INAAIAHOEFE", FB_ITEM_TYPE);
    } else {
        g_fields.itemObjProps = FB_ITEM_OP;
        g_fields.itemObjType  = FB_ITEM_TYPE;
    }

    g_fields.fromIl2Cpp = true;
    g_fields.ready      = true;
}

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

// Read a managed Il2CppString* into a fixed-size char buffer.
static bool ReadManagedString(const void* strPtr, char* buf, int bufSize)
{
    if (!Mem::AddrOk(strPtr)) return false;
    int32_t len = 0;
    if (!Mem::TryRead(strPtr, 0x10u, len)) return false;
    if (len <= 0 || len >= bufSize) return false;

    wchar_t wbuf[128] = {};
    bool ok = Resolver::Protection::safe_call([&]() {
        const wchar_t* chars = reinterpret_cast<const wchar_t*>(
            reinterpret_cast<const uint8_t*>(strPtr) + 0x14u);
        int n = (len < 127) ? len : 127;
        memcpy(wbuf, chars, static_cast<size_t>(n) * sizeof(wchar_t));
    });
    if (!ok) return false;
    WideCharToMultiByte(CP_UTF8, 0, wbuf, len, buf, bufSize - 1, nullptr, nullptr);
    return buf[0] != '\0';
}

// EquipmentManager.equipmentSlots[i] → ItemSlot HLJFBHLMANJ (ObjectProperties*), INAAIAHOEFE (type id).
static void ReadEquipmentSlots(void* localFk, PlayerSnap& s)
{
    for (int i = 0; i < kEquipSlotCount; ++i)
        s.equipment[i] = {};

    if (!localFk || !Mem::AddrOk(localFk))
        return;

    const uint32_t offEm    = g_fields.equipmentMgr;
    const uint32_t offSlots = g_fields.emEquipmentSlots;
    const uint32_t offOp    = g_fields.itemObjProps;
    const uint32_t offTid   = g_fields.itemObjType;

    const bool ok = Resolver::Protection::safe_call([&]() {
        void* em = *reinterpret_cast<void**>(
            reinterpret_cast<uint8_t*>(localFk) + offEm);
        if (!Mem::AddrOk(em))
            return;

        void* arr = *reinterpret_cast<void**>(
            reinterpret_cast<uint8_t*>(em) + offSlots);
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

            uint8_t* sp = reinterpret_cast<uint8_t*>(slot);
            void* op = *reinterpret_cast<void**>(sp + offOp);
            int32_t tid = *reinterpret_cast<int32_t*>(sp + offTid);

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

    EnsurePlayerFieldOffsets();

    PlayerSnap s = {};

    Mem::TryRead(lp, g_fields.posX,    s.x);
    Mem::TryRead(lp, g_fields.posY,    s.y);
    Mem::TryRead(lp, g_fields.hp,      s.hp);
    Mem::TryRead(lp, g_fields.maxHp,   s.maxHp);
    Mem::TryRead(lp, g_fields.classNum, s.classNum);
    Mem::TryRead(lp, g_fields.guildRank, s.guildRank);
    Mem::TryRead(lp, g_fields.curMp,   s.curMp);
    Mem::TryRead(lp, g_fields.maxMp,   s.maxMp);
    Mem::TryRead(lp, g_fields.atk,     s.atk);
    Mem::TryRead(lp, g_fields.spd,     s.spd);
    Mem::TryRead(lp, g_fields.dex,     s.dex);
    Mem::TryRead(lp, g_fields.vit,     s.vit);
    Mem::TryRead(lp, g_fields.wis,     s.wis);
    Mem::TryRead(lp, g_fields.def,     s.def);

    // Player name (Il2CppString*)
    void* namePtr = nullptr;
    if (Mem::TryRead(lp, g_fields.nameStr, namePtr))
        ReadManagedString(namePtr, s.name, sizeof(s.name));
    if (s.name[0] == '\0')
        strcpy_s(s.name, "<?>");

    ReadEquipmentSlots(lp, s);

    // [A] COHCKAPOLCA UInt32[] pointer path (same as WorldTAB / CombatTAB)
    RuntimeOffsets::TryReadMapObjectConditions(lp, &s.condLo, &s.condHi);
    // [B] MPJGAPJBBBF single-int condition field (BeeByte-resolved at runtime)
    Mem::TryRead(lp, g_fields.condInt, s.condInt);
    // [C] raw [this+0x440] — the exact offset HasConditionEffect reads in the .lst
    Mem::TryRead(lp, g_fields.condRaw, s.condRaw);

    if (!s_miCalcMoveSpeed) {
        Il2CppClass* fk = Resolver::FindClassLoose("FKALGHJIADI");
        if (fk)
            s_miCalcMoveSpeed = il2cpp_class_get_method_from_name(fk, "GCFKGLKAPND", 0);
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
    ImGui::TextDisabled("[B] MPJGAPJBBBF int (FKALGHJIADI @ +0x%03X)", g_fields.condInt);
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
        g_fields.fromIl2Cpp
            ? "Field offsets from IL2CPP metadata (il2cpp_field_get_offset)."
            : "Field offsets: static fallbacks (class FKALGHJIADI not loaded yet).");
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
