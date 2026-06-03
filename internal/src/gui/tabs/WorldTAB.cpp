#include "pch-il2cpp.h"

#define IMGUI_DEFINE_MATH_OPERATORS

#include "gui/tabs/WorldTAB.h"
#include "AoeTracking.h"
#include "ProjectileTracking.h"
#include "features/projectiles/ProjectileRuntimeReader.h"
#include "features/projectiles/ProjectileTrajectory.h"
#include "Il2CppResolver.h"
#include "RuntimeOffsets.h"
#include "GameState.h"
#include "LocalPlayer.h"
#include "helpers.h"
#include "BeebyteName.h"
#include <imgui/imgui.h>
#include <imgui/imgui_internal.h>
#include <vector>
#include <algorithm>
#include <cstdint>
#include <cmath>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <unordered_map>
#include <unordered_set>
#include <windows.h>

// ─────────────────────────────────────────────────────────────────────────────
// Runtime-confirmed field offsets.
// KJMONHENJEN (base class) fields have NO ACTK shift — confirmed by X/Y at 0x3C/0x40.
//   objectType = HFDNHJFNEKA @ 0x30  (no shift, confirmed by probe: player=782 at 0x30)
//   pos X/Y    = CLFEOFKBNEJ/PKEECFNFEIO @ 0x3C / 0x40
// LKHPPBEGNOM ACTK anti-tamper inserts hidden fields:
//   +0x50 before dump-0x1B8 → hp/maxHp at runtime 0x208/0x20C
// WorldManager itself has NO shift.
// ─────────────────────────────────────────────────────────────────────────────
// Game-specific field offsets — resolved at runtime by RuntimeOffsets::EnsureAll().
// These aliases let the rest of this file stay unchanged.
static const uint32_t& OFF_POS_X           = RuntimeOffsets::PosX;
static const uint32_t& OFF_POS_Y           = RuntimeOffsets::PosY;
static const uint32_t& OFF_HP              = RuntimeOffsets::HP;
static const uint32_t& OFF_MAX_HP          = RuntimeOffsets::MaxHP;

// WorldManager (HJMBOMEHGDJ)
static const uint32_t& OFF_WM_ALL_DICT      = RuntimeOffsets::WM_AllDict;
static const uint32_t& OFF_WM_MAPOBJ_DICT_A = RuntimeOffsets::WM_MapDictA;
static const uint32_t& OFF_WM_MAPOBJ_DICT_B = RuntimeOffsets::WM_MapDictB;
static const uint32_t& OFF_WM_KJMON_LIST    = RuntimeOffsets::WM_KjmonList;
// NOTE: raw ints at tile 0x70/0x74 are NOT minDmg/maxDmg — 0x74 is a tick counter.
// BGAIOPJMHLO tile instance fields:
static const uint32_t& OFF_WM_TILE_ARR     = RuntimeOffsets::WM_TileArr;
static const uint32_t& OFF_WM_TILE_LIST    = RuntimeOffsets::WM_TileList;
static const uint32_t& OFF_TILE_X          = RuntimeOffsets::TileX;
static const uint32_t& OFF_TILE_Y          = RuntimeOffsets::TileY;
static const uint32_t& OFF_TILE_TYPE       = RuntimeOffsets::TileType;
static const uint32_t& OFF_TILE_PROPS      = RuntimeOffsets::TileProps;
// CMFPKCJHKKB (XmlTileProperties) string fields — non-null means condition present:
static const uint32_t& OFF_TP_SPEED        = RuntimeOffsets::TP_Speed;
static const uint32_t& OFF_TP_SINK         = RuntimeOffsets::TP_Sink;
static const uint32_t& OFF_TP_NOWALK       = RuntimeOffsets::TP_NoWalk;
static const uint32_t& OFF_TP_MINDMG       = RuntimeOffsets::TP_MinDmg;
static const uint32_t& OFF_TP_MAXDMG       = RuntimeOffsets::TP_MaxDmg;
static const uint32_t& OFF_TP_PUSH         = RuntimeOffsets::TP_Push;
static const uint32_t& OFF_TP_ALPHA        = RuntimeOffsets::TP_Alpha;
static const uint32_t& OFF_TP_SINKING      = RuntimeOffsets::TP_Sinking;
// IL2CPP System.String layout: +0x10 = int32 length, +0x14 = UTF-16LE chars[]
static constexpr uint32_t OFF_STR_LEN       = 0x10;
static constexpr uint32_t OFF_STR_CHARS     = 0x14;
// Tile/object condition flags defined in WorldTAB.h (TCOND_*, OCOND_*)
static constexpr uint32_t OFF_LIST_ITEMS    = 0x10;   // IL2CPP List<T>._items
static constexpr uint32_t OFF_LIST_SIZE     = 0x18;   // IL2CPP List<T>._size
static constexpr uint32_t MAX_TILES         = 65536;
static const uint32_t& OFF_WM_LOCAL         = RuntimeOffsets::WM_Local;

// FKALGHJIADI / LKHPPBEGNOM player name fields — confirmed by runtime blind scan:
// IGN (DPGEBOCBKEF @ LKHPPBEGNOM dump 0x178) is at runtime 0x178 — NO ACTK shift (below insertion point)
// Guild name (NFJGJKLPLBA @ FKALGHJIADI dump 0x468) is at runtime 0x468 — dump offsets for FKALGHJIADI
// own fields ARE the runtime offsets (the dump was generated from the already-patched binary).
static const uint32_t& OFF_PLAYER_IGN       = RuntimeOffsets::PlayerIGN;
static constexpr uint32_t OFF_PLAYER_GUILD  = 0x468;  // string NFJGJKLPLBA — guild name (empty if no guild)
// KJMONHENJEN.FDNHINDAEHK — dict key / object id when pointer match fails vs GameState::GetLocalPtr()
static constexpr uint32_t OFF_KJM_OBJECT_ID = 0xC0;

// ObjectProperties (XML data) on every entity — no ACTK shift (KJMONHENJEN base fields are unshifted)
// OFF_OP_* = byte offset from ObjectProperties* (klass 8 + monitor 8 + fields…).
// Old 0x6C1+ region sits inside String* / padding — not bools; bool cluster follows il2cpp-types.h:
// isEventChestBoss(0x698), isKey(0x699), occupySquare(0x69A),
// then int32 type @0x69C; after displayId/displayIdWithQty pointers, isEnemy @0x6C9; fullOccupy @0x6D1,
// enemyOccupySquare @0x6D2, isStatic @0x6D3, blockProjectiles @0x6D4; protect* @0x6DC/0x6DD; flying @0x6E4
static const uint32_t& OFF_KJM_OBJPROPS     = RuntimeOffsets::ObjProps;
static const uint32_t& OFF_OP_ID_STR        = RuntimeOffsets::OP_IdStr;
static const uint32_t& OFF_OP_NOCOVER       = RuntimeOffsets::OP_NoCover;
static const uint32_t& OFF_OP_NOWALL_RPT    = RuntimeOffsets::OP_NoWallRpt;
static const uint32_t& OFF_OP_OCCUPY_SQ     = RuntimeOffsets::OP_OccupySq;
static const uint32_t& OFF_OP_FULL_OCC      = RuntimeOffsets::OP_FullOcc;
static const uint32_t& OFF_OP_ENEMY_OCC     = RuntimeOffsets::OP_EnemyOcc;
static const uint32_t& OFF_OP_IS_ENEMY      = RuntimeOffsets::OP_IsEnemy;
static const uint32_t& OFF_OP_IS_STATIC     = RuntimeOffsets::OP_IsStatic;
static const uint32_t& OFF_OP_BLOCK_PROJ    = RuntimeOffsets::OP_BlockProj;
static const uint32_t& OFF_OP_PROT_GND      = RuntimeOffsets::OP_ProtGnd;
static const uint32_t& OFF_OP_PROT_SINK     = RuntimeOffsets::OP_ProtSink;
static const uint32_t& OFF_OP_FLYING        = RuntimeOffsets::OP_Flying;
static const uint32_t& OFF_OP_CONNECT_T     = RuntimeOffsets::OP_ConnectT;
// Object condition bitmask flags — defined in WorldTAB.h

// WorldManager time/tick display fields
static constexpr uint32_t OFF_WM_UINT_D8    = 0xD8;
static constexpr uint32_t OFF_WM_UINT_DC    = 0xDC;
static constexpr uint32_t OFF_WM_UINT_E0    = 0xE0;
static constexpr uint32_t OFF_WM_FLOAT_F4   = 0xF4;
static constexpr uint32_t OFF_WM_FLOAT_F8   = 0xF8;
static constexpr uint32_t OFF_WM_INT_FC     = 0xFC;
static constexpr uint32_t OFF_WM_INT_100    = 0x100;

// IL2CPP Dictionary<int, ptr> layout
static constexpr uint32_t OFF_DICT_ENTRIES  = 0x18;
static constexpr uint32_t OFF_DICT_COUNT    = 0x20;

// IL2CPP Array layout
static constexpr uint32_t OFF_ARR_MAXLEN    = 0x18;
static constexpr uint32_t OFF_ARR_DATA      = 0x20;

// Dictionary Entry layout (24 bytes: hash+next+key+pad+value*)
static constexpr uint32_t DICT_ENTRY_SIZE   = 24;
static constexpr uint32_t OFF_ENTRY_HASH    = 0;
static constexpr uint32_t OFF_ENTRY_KEY     = 8;
static constexpr uint32_t OFF_ENTRY_VALUE   = 16;

// ─────────────────────────────────────────────────────────────────────────────
// Entity classification
// ─────────────────────────────────────────────────────────────────────────────
// Players — FKALGHJIADI only (sealed local/other player class in dump)
// Enemies — PMMFLLAIPGN (characters that are not FKALGHJIADI)
// Objects — portals, chests, statics (everything else in the dict)
// ─────────────────────────────────────────────────────────────────────────────

enum class EntityCat : int { All = 0, Player = 1, Enemy = 2, Object = 3 };
static const char* kCatLabels[] = { "All", "Players", "Enemies", "Objects" };

// ─────────────────────────────────────────────────────────────────────────────
// Data structures (WorldEntity defined in WorldTAB.h for cross-tab access)
// ─────────────────────────────────────────────────────────────────────────────

// WorldTile defined in WorldTAB.h for cross-tab access

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state
// ─────────────────────────────────────────────────────────────────────────────
static std::vector<WorldEntity>     g_entities;
static std::vector<WorldTile>       g_tiles;
static std::vector<WorldProjectile>  g_projectiles;

// Movement tile maps — rebuilt once per DoRefresh(), O(1) lookup per frame.
// Key: (uint16_t(tx) << 16) | uint16_t(ty).
static std::unordered_map<uint32_t, bool>  s_blockedMap;    // present = movement blocked (NoWalk / OccupySquare / FullOccupy)
static std::unordered_map<uint32_t, bool>  s_fullOccupyMap; // present = tile has FullOccupy entity (for sub-tile neighbour check)
static std::unordered_map<uint32_t, bool>  s_damagingMap;  // present = tile deals damage (minDmg/maxDmg > 0)
static std::unordered_map<uint32_t, float> s_tileSpeedMap; // value = XML speed multiplier (non-zero tiles only)
static std::mutex s_tileMapMutex;

static inline uint32_t BlockedKey(int tx, int ty)
{
    return (static_cast<uint32_t>(static_cast<uint16_t>(tx)) << 16) |
            static_cast<uint32_t>(static_cast<uint16_t>(ty));
}

static void RebuildBlockedMap()
{
    std::unordered_map<uint32_t, bool> blockedMap;
    std::unordered_map<uint32_t, bool> fullOccupyMap;
    std::unordered_map<uint32_t, bool> damagingMap;
    std::unordered_map<uint32_t, float> tileSpeedMap;

    blockedMap.reserve(g_tiles.size() + g_entities.size());
    fullOccupyMap.reserve(g_entities.size());
    damagingMap.reserve(g_tiles.size());
    tileSpeedMap.reserve(g_tiles.size());

    for (const WorldTile& t : g_tiles) {
        uint32_t k = BlockedKey(t.tileX, t.tileY);
        // Only truly impassable tiles go in the blocked map — damage tiles are
        // physically walkable (the game triggers damage from player centre, not hitbox).
        if (t.conds & TCOND_NOWALK)
            blockedMap[k] = true;
        // Damaging tiles tracked separately: damage triggers when the player centre
        // (floor of world XY) lands on the tile, not when the hitbox overlaps it.
        if (t.minDmg > 0 || t.maxDmg > 0)
            damagingMap[k] = true;
        // Store speed modifier for any tile that has one (0 = no modifier)
        if (t.speed != 0.f)
            tileSpeedMap[k] = t.speed;
    }

    // Flash isWalkable() parity: a tile is blocked (cannot be entered from outside)
    // if its object has OccupySquare, FullOccupy, or EnemyOccupySquare.
    // EnemyOccupySquare is what breakable walls / pillars / destructibles use —
    // they're Enemy-class (have HP, can be attacked) AND block movement.
    // Without ENEMY_OCC in this criteria, A* happily plans through them and
    // the player walks into a tile the game refuses to enter → snap-back.
    // FullOccupy is additionally tracked separately for the sub-tile neighbour
    // check (isValidPosition section B: fractional-position constraints on
    // adjacent tiles).
    for (const WorldEntity& e : g_entities) {
        if (e.objConds & (OCOND_OCCUPY_SQ | OCOND_FULL_OCC | OCOND_ENEMY_OCC)) {
            int tx = static_cast<int>(floorf(e.x));
            int ty = static_cast<int>(floorf(e.y));
            blockedMap[BlockedKey(tx, ty)] = true;
        }
        if (e.objConds & OCOND_FULL_OCC) {
            int tx = static_cast<int>(floorf(e.x));
            int ty = static_cast<int>(floorf(e.y));
            fullOccupyMap[BlockedKey(tx, ty)] = true;
        }
    }

    std::lock_guard<std::mutex> lock(s_tileMapMutex);
    s_blockedMap.swap(blockedMap);
    s_fullOccupyMap.swap(fullOccupyMap);
    s_damagingMap.swap(damagingMap);
    s_tileSpeedMap.swap(tileSpeedMap);
}

static std::string  g_status       = "Press Refresh while in-game.";
static bool         g_statusOk     = true;
static float        g_localX       = 0.f;
static float        g_localY       = 0.f;
static bool         g_autoRefresh  = false;
static float        g_autoTimer    = 0.f;
static float        g_autoInterval = 1.0f;

// Filter / view state
static char         g_filter[64]   = {};
static char         g_tileFilter[64] = {};
static EntityCat    g_entityCat    = EntityCat::All;
static int          g_activeTable  = 0;   // 0 = entities, 1 = tiles, 2 = projectiles, 3 = throwables/AOEs
static char         g_projFilter[96]   = {};

// Managed object inspect popup (double-click Ptr in entity / projectile tables)
static Il2CppObject* s_worldInspectObj       = nullptr;
static int32_t       s_worldInspectObjectId  = 0;
static char          s_worldInspectSubtitle[192] = {};
// ImGui popup IDs are stack-relative; OpenPopup inside a table row must use the same
// ImGuiID as BeginPopup at window root (see imgui.cpp OpenPopup comment).
static ImGuiID       s_worldInspectPopupRootId = 0;
static char          s_worldInspectSearchBuf[256] = {};

// String edit buffers for inspect modal (cleared when popup opens).
static std::unordered_map<uint64_t, std::vector<char>> s_worldInspectStrFieldBufs;
static std::unordered_map<uint64_t, std::vector<char>> s_worldInspectStrPropBufs;

static uint64_t WorldInspectStrFieldKey(Il2CppObject* obj, FieldInfo* f, bool isStatic)
{
    const uintptr_t ob = isStatic ? 0u : reinterpret_cast<uintptr_t>(obj);
    return (static_cast<uint64_t>(ob) * 0x9E3779B97F4A7C15ULL)
         ^ static_cast<uint64_t>(reinterpret_cast<uintptr_t>(f));
}

static uint64_t WorldInspectStrPropKey(Il2CppObject* obj, const PropertyInfo* p)
{
    return (static_cast<uint64_t>(reinterpret_cast<uintptr_t>(obj)) * 0x9E3779B97F4A7C15ULL)
         ^ static_cast<uint64_t>(reinterpret_cast<uintptr_t>(p));
}

static int WorldInspectInputTextResizeCallback(ImGuiInputTextCallbackData* data)
{
    if (data->EventFlag == ImGuiInputTextFlags_CallbackResize) {
        auto* vec = static_cast<std::vector<char>*>(data->UserData);
        IM_ASSERT(data->Buf == vec->data());
        vec->resize(static_cast<size_t>(data->BufSize));
        data->Buf = vec->data();
    }
    return 0;
}

// Cached local player pointer (mirrors GameState; updated in DoRefresh/GetLocalPtr)
static void* g_localPtr = nullptr;

// WorldManager diagnostics (display only — read from GameState)
static uintptr_t g_worldMgrPtr = 0;
static uintptr_t g_appMgrPtr   = 0;
static uint32_t   g_wm_d8 = 0, g_wm_dc = 0, g_wm_e0 = 0;
static float      g_wm_f4 = 0.f, g_wm_f8 = 0.f;
static int32_t    g_wm_fc = 0, g_wm_100 = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
static Il2CppClass* FindClassByName(const char* name)
{
    struct Ctx { const char* name; Il2CppClass* result; };
    Ctx ctx{ name, nullptr };
    il2cpp_class_for_each([](Il2CppClass* klass, void* ud) {
        auto* c = static_cast<Ctx*>(ud);
        if (c->result) return;
        if (strcmp(il2cpp_class_get_name(klass), c->name) == 0)
            c->result = klass;
    }, &ctx);
    return ctx.result;
}

template<typename T>
static bool SafeRead(const void* base, uint32_t offset, T& out)
{
    return Resolver::Protection::safe_call([&]() {
        out = *reinterpret_cast<const T*>(
            reinterpret_cast<const uint8_t*>(base) + offset);
    });
}

static float Distance(float ax, float ay, float bx, float by)
{
    float dx = ax - bx, dy = ay - by;
    return sqrtf(dx * dx + dy * dy);
}

static bool AddrValid(const void* p)
{
    uintptr_t v = reinterpret_cast<uintptr_t>(p);
    return v > 0x10000 && v < 0x7FFFFFFFFFFull;
}

// ─────────────────────────────────────────────────────────────────────────────
// Walk IL2CPP Dictionary<int, ptr> (same layout as entity dict @ WM+0xB0)
// ─────────────────────────────────────────────────────────────────────────────
template<typename Cb>
static void WalkDict(void* dictPtr, int maxEntries, Cb cb)
{
    if (!AddrValid(dictPtr)) return;

    void*   entriesArr = nullptr;
    int32_t count      = 0;
    SafeRead(dictPtr, OFF_DICT_ENTRIES, entriesArr);
    SafeRead(dictPtr, OFF_DICT_COUNT,   count);
    if (!AddrValid(entriesArr)) return;

    int32_t maxLen = 0;
    SafeRead(entriesArr, OFF_ARR_MAXLEN, maxLen);
    if (maxLen <= 0 || maxLen > 65536) maxLen = maxEntries;
    if (count  <= 0 || count  > maxLen) count = maxLen;

    for (int32_t i = 0; i < count; ++i) {
        const uint8_t* entry = reinterpret_cast<const uint8_t*>(entriesArr)
                             + OFF_ARR_DATA
                             + static_cast<size_t>(i) * DICT_ENTRY_SIZE;
        int32_t hashCode = 0;
        if (!SafeRead(entry, OFF_ENTRY_HASH, hashCode)) continue;
        if (hashCode < 0) continue;

        int32_t key   = 0;
        void*   value = nullptr;
        if (!SafeRead(entry, OFF_ENTRY_KEY,   key))   continue;
        if (!SafeRead(entry, OFF_ENTRY_VALUE, value)) continue;
        if (!AddrValid(value))                         continue;

        cb(key, value);
    }
}

// HBEAKBIHANL (runtime projectile) — klass cached here; FOMOIBCKIFP offset via RuntimeOffsets.
static Il2CppClass* s_hbeakKlass = nullptr;

static Il2CppClass* GetHbeakProjectileClass()
{
    if (!s_hbeakKlass)
        s_hbeakKlass = FindClassByName("HBEAKBIHANL");
    return s_hbeakKlass;
}

// MSVC C2712: __try cannot be used in the same function as parameters like std::vector& / std::unordered_set&.
static float SehReadProjectileAngle148(void* elem)
{
    float a = 0.f;
    __try {
        a = *reinterpret_cast<float*>(reinterpret_cast<uint8_t*>(elem) + RuntimeOffsets::Hbeak_Angle);
    } __except (EXCEPTION_EXECUTE_HANDLER) {}
    return a;
}

// If `elem` is HBEAKBIHANL (or subclass), append to `out`. DIA4A: HBEAKBIHANL : KJMONHENJEN.
static void TryAppendHbeakFromElem(
    void*        elem,
    Il2CppClass* hbeakKlass,
    uint32_t     offProjPropsField,
    std::vector<WorldProjectile>&     out,
    std::unordered_set<uintptr_t>&    seenPtrs)
{
    if (!AddrValid(elem) || !hbeakKlass) return;

    void* klassRaw = nullptr;
    if (!SafeRead(elem, 0u, klassRaw) || !AddrValid(klassRaw)) return;
    auto* elemKlass = reinterpret_cast<Il2CppClass*>(klassRaw);
    if (!il2cpp_class_is_assignable_from(hbeakKlass, elemKlass)) return;

    const uintptr_t pu = reinterpret_cast<uintptr_t>(elem);
    if (seenPtrs.count(pu)) return;
    seenPtrs.insert(pu);

    const ULONGLONG nowTick = GetTickCount64();
    WorldProjectile wp{};
    wp.ptr = elem;
    wp.valid = true;
    wp.spawnTick = nowTick;
    wp.lifetime = 120000.f;
    wp.speed = 5000.f;
    wp.damage = 0;
    wp.bulletId = 0;
    SafeRead(elem, OFF_POS_X, wp.x);
    SafeRead(elem, OFF_POS_Y, wp.y);
    wp.angle = SehReadProjectileAngle148(elem);

    void* projProps = nullptr;
    if (SafeRead(elem, offProjPropsField, projProps) && AddrValid(projProps)) {
        ProjectileRuntimeReader::ApplyProperties(
            wp, elem, projProps, ProjectileCollisionFallback::WorldManager);
        if (wp.lifetime < 50.f || wp.lifetime > 600000.f)
            wp.lifetime = 120000.f;
        wp.speedMul = ProjectileTracking::EffectiveSpeedMulFromProjectile(elem);
    }

    // Approximate spawn from HBEAKBIHANL.GLEGBLDBOJF @ 0x16C (types.cs) as elapsed ms.
    // This is the only reliable way to set spawnTick for projectiles discovered from
    // WorldManager containers (non-spawn-hook path). Without it:
    //   - elapsed = now - spawnTick ≈ 0 → projectiles never expire ("go on forever")
    //   - path anchoring fails because live position doesn't align with t=0
    static constexpr uint32_t OFF_HBEAK_GLEGBLDBOJF = 0x16C;
    int32_t                   ageMs               = -1;
    SafeRead(elem, OFF_HBEAK_GLEGBLDBOJF, ageMs);
    if (ageMs >= 0 && static_cast<float>(ageMs) < wp.lifetime * 1.05f && static_cast<float>(ageMs) < 120000.f)
        wp.spawnTick = nowTick - static_cast<uint64_t>(ageMs);

    // Lasers are stationary: live XY == spawn origin, so back-calculating startX
    // via speed×age would produce a position one beam-length behind the emitter.
    const bool straight = !wp.wavy && !wp.parametric && !wp.laser && (fabsf(wp.amplitude) < 1e-4f);
    if (straight && ageMs >= 0 && wp.speed > 1.f) {
        float dist   = (wp.speed / 10000.f) * static_cast<float>(ageMs);
        float ca     = cosf(wp.angle);
        float sa     = sinf(wp.angle);
        wp.startX    = wp.x - dist * ca;
        wp.startY    = wp.y - dist * sa;
    } else {
        wp.startX = wp.x;
        wp.startY = wp.y;
    }

    ProjectileTrajectory::CachePath(wp);

    out.push_back(wp);
}

// WM+0xB8 / +0xC0: Dictionary<int, KJMONHENJEN> (DIA4A KHIHFNACEKJ, CIOIHEOEAEB)
static void TryMergeProjectileDict(
    void*        dictPtr,
    Il2CppClass* hbeakKlass,
    uint32_t     offProjPropsField,
    std::vector<WorldProjectile>&  out,
    std::unordered_set<uintptr_t>&   seenPtrs)
{
    if (!AddrValid(dictPtr) || !hbeakKlass) return;
    WalkDict(dictPtr, 8192, [&](int32_t /*key*/, void* value) {
        TryAppendHbeakFromElem(value, hbeakKlass, offProjPropsField, out, seenPtrs);
    });
}

// WM+0xE8: List<KJMONHENJEN> ONABHKFOJNE
static void TryMergeKjmonProjectileList(
    void*        listObj,
    Il2CppClass* hbeakKlass,
    uint32_t     offProjPropsField,
    std::vector<WorldProjectile>&  out,
    std::unordered_set<uintptr_t>&   seenPtrs)
{
    if (!AddrValid(listObj) || !hbeakKlass) return;

    int32_t listSize = 0;
    void*   itemsArr = nullptr;
    if (!SafeRead(listObj, OFF_LIST_SIZE, listSize)) return;
    if (!SafeRead(listObj, OFF_LIST_ITEMS, itemsArr)) return;
    if (!AddrValid(itemsArr) || listSize <= 0 || listSize > 8192) return;

    int32_t arrMax = 0;
    SafeRead(itemsArr, OFF_ARR_MAXLEN, arrMax);
    if (arrMax <= 0 || arrMax > 65536) arrMax = listSize;
    int32_t cap = (listSize < arrMax) ? listSize : arrMax;

    const uint8_t* itemBase = reinterpret_cast<const uint8_t*>(itemsArr) + OFF_ARR_DATA;
    for (int32_t i = 0; i < cap; ++i) {
        void* elem = nullptr;
        if (!SafeRead(itemBase + static_cast<size_t>(i) * sizeof(void*), 0u, elem) || !AddrValid(elem))
            continue;
        TryAppendHbeakFromElem(elem, hbeakKlass, offProjPropsField, out, seenPtrs);
    }
}

static void MergeProjectilePoolsFromWorldManager(void* worldMgr, std::vector<WorldProjectile>& out,
                                                 std::unordered_set<uintptr_t>& seenPtrs)
{
    Il2CppClass* hbeak = GetHbeakProjectileClass();
    if (!hbeak) return;

    const uint32_t offProjProps = RuntimeOffsets::Hbeak_ProjPropsPtr;
    void* dictA = nullptr;
    void* dictB = nullptr;
    void* listKj = nullptr;
    if (SafeRead(worldMgr, OFF_WM_MAPOBJ_DICT_A, dictA) && AddrValid(dictA))
        TryMergeProjectileDict(dictA, hbeak, offProjProps, out, seenPtrs);
    if (SafeRead(worldMgr, OFF_WM_MAPOBJ_DICT_B, dictB) && AddrValid(dictB))
        TryMergeProjectileDict(dictB, hbeak, offProjProps, out, seenPtrs);
    if (SafeRead(worldMgr, OFF_WM_KJMON_LIST, listKj) && AddrValid(listKj))
        TryMergeKjmonProjectileList(listKj, hbeak, offProjProps, out, seenPtrs);
}

// ─────────────────────────────────────────────────────────────────────────────
// Classification helpers
//
// Class hierarchy (confirmed from dump):
//   FKALGHJIADI (sealed) : PMMFLLAIPGN — local player (only subclass of PMMFLLAIPGN)
//   PMMFLLAIPGN          : LKHPPBEGNOM — all characters: enemies, NPCs, other players
//   KJMONHENJEN          — tile / terrain base
//   everything else      — portals, chests, statics (FPMMAILJKBN etc.)
//
// "Enemy" = PMMFLLAIPGN (all non–FKALGHJIADI characters in the entity dict).
// ─────────────────────────────────────────────────────────────────────────────
static bool IsPlayerClass(const WorldEntity& e)
{
    return strcmp(e.typeName, "FKALGHJIADI") == 0;
}

static bool IsEnemy(const WorldEntity& e)
{
    return strcmp(e.typeName, "PMMFLLAIPGN") == 0;
}

static bool MatchesCat(const WorldEntity& e, EntityCat cat)
{
    switch (cat) {
    case EntityCat::Player: return IsPlayerClass(e);
    case EntityCat::Enemy:  return IsEnemy(e);
    case EntityCat::Object: return !IsPlayerClass(e) && !IsEnemy(e) &&
                                    strcmp(e.typeName, "KJMONHENJEN") != 0;
    default:                return true;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Read a short IL2CPP System.String into a char buffer (ASCII-safe). Returns false if null/empty.
static bool ReadIl2CppString(void* strPtr, char* buf, int bufLen)
{
    if (!AddrValid(strPtr) || bufLen <= 0) return false;
    int32_t len = 0;
    SafeRead(strPtr, OFF_STR_LEN, len);
    if (len <= 0 || len > 256) return false;
    if (len > bufLen - 1) len = bufLen - 1;
    const uint8_t* chars = reinterpret_cast<const uint8_t*>(strPtr) + OFF_STR_CHARS;
    for (int i = 0; i < len; ++i) {
        uint16_t ch = 0;
        SafeRead(chars + (size_t)i * 2u, 0u, ch);
        buf[i] = (char)(ch & 0x7F);
    }
    buf[len] = '\0';
    return buf[0] != '\0';
}

// Read tile conditions, damage, and speed from a BGAIOPJMHLO instance into a WorldTile.
// All three are sourced exclusively from the CMFPKCJHKKB XML property strings:
//   - Speed string null  → no modifier (t.speed = 0)
//   - Speed string "0.6" → slow tile (< 1.0)
//   - Speed string "1.4" → fast tile (> 1.0)
// The raw float at 0x78 (AIDOHEECBOC) is the tile's absolute move speed, NOT a modifier.
// It is always non-zero, so it was masking speed tiles when used as the primary source.
static void ReadTileProps(void* tp, WorldTile& t)
{
    void* props = nullptr;
    SafeRead(tp, OFF_TILE_PROPS, props);
    if (!AddrValid(props)) return;

    void* sinkStr = nullptr, *pushStr = nullptr, *alphaStr = nullptr,
          *sinkingStr = nullptr, *nowalkStr = nullptr;
    SafeRead(props, OFF_TP_SINK,    sinkStr);
    SafeRead(props, OFF_TP_PUSH,    pushStr);
    SafeRead(props, OFF_TP_ALPHA,   alphaStr);
    SafeRead(props, OFF_TP_SINKING, sinkingStr);
    SafeRead(props, OFF_TP_NOWALK,  nowalkStr);

    if (AddrValid(sinkStr))    t.conds |= TCOND_SINK;
    if (AddrValid(pushStr))    t.conds |= TCOND_PUSH;
    if (AddrValid(alphaStr))   t.conds |= TCOND_ALPHA;
    if (AddrValid(sinkingStr)) t.conds |= TCOND_SINKING;
    if (AddrValid(nowalkStr))  t.conds |= TCOND_NOWALK;

    // Damage: parse from CMFPKCJHKKB XML strings (raw ints at 0x70/0x74 are wrong)
    {
        void* minStr = nullptr;
        SafeRead(props, OFF_TP_MINDMG, minStr);
        if (AddrValid(minStr)) {
            char buf[32] = {};
            if (ReadIl2CppString(minStr, buf, sizeof(buf)))
                t.minDmg = (int32_t)std::strtol(buf, nullptr, 10);
        }
    }
    {
        void* maxStr = nullptr;
        SafeRead(props, OFF_TP_MAXDMG, maxStr);
        if (AddrValid(maxStr)) {
            char buf[32] = {};
            if (ReadIl2CppString(maxStr, buf, sizeof(buf)))
                t.maxDmg = (int32_t)std::strtol(buf, nullptr, 10);
        }
    }

    // Speed: always parse from CMFPKCJHKKB XML string.
    // t.speed stays 0 (no modifier) if the string is absent.
    {
        void* spStr = nullptr;
        SafeRead(props, OFF_TP_SPEED, spStr);
        if (AddrValid(spStr)) {
            char buf[32] = {};
            if (ReadIl2CppString(spStr, buf, sizeof(buf)))
                t.speed = std::strtof(buf, nullptr);
        }
    }
}

// Core refresh
// ─────────────────────────────────────────────────────────────────────────────
static void DoRefresh()
{
    g_entities.clear();
    g_tiles.clear();
    g_projectiles.clear();
    g_localX = g_localY = 0.f;

    // ── Resolve via GameState (single shared AppMgr/WorldMgr cache) ─────────
    void* appMgr = GameState::GetAppMgr();
    if (!appMgr) {
        g_status = "Waiting for GameState to resolve ApplicationManager...";
        g_statusOk = false; return;
    }
    g_appMgrPtr = reinterpret_cast<uintptr_t>(appMgr);

    void* worldMgr = GameState::GetWorldMgr();
    if (!worldMgr) {
        g_status = "ERROR: WorldManager not available (GameState).";
        g_statusOk = false; return;
    }
    g_worldMgrPtr = reinterpret_cast<uintptr_t>(worldMgr);

    SafeRead(worldMgr, OFF_WM_UINT_D8,  g_wm_d8);
    SafeRead(worldMgr, OFF_WM_UINT_DC,  g_wm_dc);
    SafeRead(worldMgr, OFF_WM_UINT_E0,  g_wm_e0);
    SafeRead(worldMgr, OFF_WM_FLOAT_F4, g_wm_f4);
    SafeRead(worldMgr, OFF_WM_FLOAT_F8, g_wm_f8);
    SafeRead(worldMgr, OFF_WM_INT_FC,   g_wm_fc);
    SafeRead(worldMgr, OFF_WM_INT_100,  g_wm_100);

    // Local player — read from GameState (already resolved this frame).
    void* localPtr = GameState::GetLocalPtr();
    if (localPtr && AddrValid(localPtr)) {
        g_localPtr = localPtr;
        SafeRead(localPtr, OFF_POS_X, g_localX);
        SafeRead(localPtr, OFF_POS_Y, g_localY);
    }

    // ── Scan entity dict (DFALIKKKGLI @ 0xB0) ───────────────────────────────
    void* entDictPtr = nullptr;
    SafeRead(worldMgr, OFF_WM_ALL_DICT, entDictPtr);
    if (!AddrValid(entDictPtr)) {
        g_status = "ERROR: Entity dict null (offset 0xB0). Not in-game?"; g_statusOk = false; return;
    }

    ProjectileTracking::OnWorldRefreshBegin();

    WalkDict(entDictPtr, 4096, [&](int32_t key, void* value) {
        WorldEntity ent;
        ent.objectId = key;
        ent.ptr      = value;

        SafeRead(value, OFF_POS_X,  ent.x);
        SafeRead(value, OFF_POS_Y,  ent.y);
        SafeRead(value, OFF_HP,     ent.hp);
        SafeRead(value, OFF_MAX_HP, ent.maxHp);

        RuntimeOffsets::TryReadMapObjectConditions(value, &ent.condLo, &ent.condHi);

        void* klass = nullptr;
        if (SafeRead(value, 0u, klass) && AddrValid(klass)) {
            ent.klass = klass;
            Resolver::Protection::safe_call([&]() {
                const char* cn = il2cpp_class_get_name(reinterpret_cast<Il2CppClass*>(klass));
                if (cn) strncpy_s(ent.typeName, cn, sizeof(ent.typeName) - 1);
            });
        }

        // HFDNHJFNEKA (objectType) @ 0x30 — no ACTK shift (same as X/Y)
        if (ent.typeName[0] && strcmp(ent.typeName, "KJMONHENJEN") != 0)
            SafeRead(value, 0x30u, ent.objType);

        // Player name — probe multiple candidate offsets to find the IGN string.
        // H1: 0x4B8 (NFJGJKLPLBA, dump 0x468 + 0x50 ACTK)
        // H2: 0x4F0 (HKGPJPCHOFF, dump 0x4A0 + 0x50)
        // H3: 0x520 (CMDGOAAPPGL, dump 0x4D0 + 0x50)
        // H4: 0x528 (FKIHLOKHKIA, dump 0x4D8 + 0x50)
        if (strcmp(ent.typeName, "FKALGHJIADI") == 0) {
            // IGN: DPGEBOCBKEF @ 0x178 (no ACTK shift — confirmed by blind scan)
            void* nameStr = nullptr;
            if (SafeRead(value, OFF_PLAYER_IGN, nameStr) && AddrValid(nameStr))
                ReadIl2CppString(nameStr, ent.playerName, sizeof(ent.playerName));
        }

        // XML object name + conditions via KJMONHENJEN.OBAKMCCDBJA @ 0x18 → ObjectProperties
        {
            void* op = nullptr;
            if (SafeRead(value, OFF_KJM_OBJPROPS, op) && AddrValid(op)) {
                // Name
                void* idStr = nullptr;
                if (SafeRead(op, OFF_OP_ID_STR, idStr) && AddrValid(idStr))
                    ReadIl2CppString(idStr, ent.objName, sizeof(ent.objName));
                // ObjectProperties condition fields are not real XML conditions on players
                // (FKALGHJIADI); memory may still expose flags — leave objConds blank until mapped elsewhere.
                if (!IsPlayerClass(ent)) {
                    uint8_t b = 0;
                    if (SafeRead(op, OFF_OP_OCCUPY_SQ,  b) && b) ent.objConds |= OCOND_OCCUPY_SQ;
                    if (SafeRead(op, OFF_OP_FULL_OCC,   b) && b) ent.objConds |= OCOND_FULL_OCC;
                    if (SafeRead(op, OFF_OP_ENEMY_OCC,  b) && b) ent.objConds |= OCOND_ENEMY_OCC;
                    if (SafeRead(op, OFF_OP_IS_ENEMY,   b) && b) ent.objConds |= OCOND_IS_ENEMY;
                    if (SafeRead(op, OFF_OP_IS_STATIC,  b) && b) ent.objConds |= OCOND_STATIC;
                    if (SafeRead(op, OFF_OP_BLOCK_PROJ, b) && b) ent.objConds |= OCOND_BLOCK_PROJ;
                    if (SafeRead(op, OFF_OP_PROT_GND,   b) && b) ent.objConds |= OCOND_PROT_GND;
                    if (SafeRead(op, OFF_OP_PROT_SINK,  b) && b) ent.objConds |= OCOND_PROT_SINK;
                    if (SafeRead(op, OFF_OP_FLYING,     b) && b) ent.objConds |= OCOND_FLYING;
                    // String element conditions (non-null pointer = flag set)
                    void* sp = nullptr;
                    if (SafeRead(op, OFF_OP_NOCOVER,    sp) && AddrValid(sp)) ent.objConds |= OCOND_NO_COVER;
                    if (SafeRead(op, OFF_OP_NOWALL_RPT, sp) && AddrValid(sp)) ent.objConds |= OCOND_NO_WALL_RPT;
                    // connectType int (non-zero = Connects)
                    int32_t ct = 0;
                    if (SafeRead(op, OFF_OP_CONNECT_T,  ct) && ct != 0) ent.objConds |= OCOND_CONNECTS;
                }
            }
        }

        if (localPtr && value == localPtr) {
            ent.isLocal = true;
            SafeRead(value, OFF_POS_X, g_localX);
            SafeRead(value, OFF_POS_Y, g_localY);
            ProjectileTracking::SetLocalPlayerObjectId(key);
        }

        ProjectileTracking::OnWorldEntity(key, ent.x, ent.y);

        g_entities.push_back(ent);
    });

    if (localPtr && AddrValid(localPtr) && ProjectileTracking::GetLocalPlayerObjectId() == 0) {
        int32_t oidFromField = 0;
        if (SafeRead(localPtr, OFF_KJM_OBJECT_ID, oidFromField) && oidFromField != 0)
            ProjectileTracking::SetLocalPlayerObjectId(oidFromField);
    }

    // ── Scan tiles: BGAIOPJMHLO[] NOJEHIAOAJM @ wm+0x58
    // H-A: array holds all received ground tiles (size and X/Y/type valid)
    // H-B: List<BGAIOPJMHLO> IMAOBDCMPHC @ wm+0x60 may hold same/subset
    // H-C: ushort tileType @ tile+0x40 is non-zero
    // H-D: int tileX/Y @ tile+0x38/0x3C are integer grid coords
    void* tileArrPtr  = nullptr;
    void* tileListPtr = nullptr;
    SafeRead(worldMgr, OFF_WM_TILE_ARR,  tileArrPtr);
    SafeRead(worldMgr, OFF_WM_TILE_LIST, tileListPtr);

    int32_t arrLen    = 0;
    int32_t listSize  = 0;
    void*   listItems = nullptr;

    if (AddrValid(tileArrPtr))
        SafeRead(tileArrPtr, OFF_ARR_MAXLEN, arrLen);
    if (AddrValid(tileListPtr)) {
        SafeRead(tileListPtr, OFF_LIST_SIZE, listSize);
        SafeRead(tileListPtr, OFF_LIST_ITEMS, listItems);
    }

    // CONFIRMED by logs:
    // - Array @ 0x58 (arrLen=65536=256x256 spatial grid): most entries are type=255 (PFHFAHFGIOB=void/empty).
    // - List  @ 0x60 (listSize grows as you move): accumulates ALL received tiles with valid type IDs.
    // → Use the List as the primary source; also pull array but skip type=255.
    static constexpr uint16_t TILE_VOID = 255;   // BGAIOPJMHLO.PFHFAHFGIOB = 255 = unset/void

    // Primary: List<BGAIOPJMHLO> @ wm+0x60 — all tiles received this session
    if (AddrValid(listItems) && listSize > 0) {
        int32_t cap = listSize < (int32_t)MAX_TILES ? listSize : (int32_t)MAX_TILES;
        const uint8_t* base = reinterpret_cast<const uint8_t*>(listItems) + OFF_ARR_DATA;
        for (int32_t i = 0; i < cap; ++i) {
            void* tp = nullptr;
            if (!SafeRead(base + (size_t)i * sizeof(void*), 0u, tp) || !AddrValid(tp)) continue;
            WorldTile t;
            t.ptr = tp;
            SafeRead(tp, OFF_TILE_X,    t.tileX);
            SafeRead(tp, OFF_TILE_Y,    t.tileY);
            SafeRead(tp, OFF_TILE_TYPE, t.tileType);
            if (t.tileType == TILE_VOID) continue;   // skip void/unset slots
            ReadTileProps(tp, t);
            // Tile XML name via same chain as entities: KJMONHENJEN.OBAKMCCDBJA[0x18] → ObjectProperties.id[0x38]
            {
                void* op = nullptr;
                void* idStr = nullptr;
                if (SafeRead(tp, OFF_KJM_OBJPROPS, op) && AddrValid(op) &&
                    SafeRead(op, OFF_OP_ID_STR, idStr) && AddrValid(idStr))
                    ReadIl2CppString(idStr, t.tileName, sizeof(t.tileName));
            }
            g_tiles.push_back(t);
        }
    }


    RebuildBlockedMap();

    ProjectileTracking::SnapshotToWorld(g_projectiles);
    std::unordered_set<uintptr_t> projPtrSeen;
    projPtrSeen.reserve(g_projectiles.size() + 64);
    for (const WorldProjectile& p : g_projectiles)
        projPtrSeen.insert(reinterpret_cast<uintptr_t>(p.ptr));
    MergeProjectilePoolsFromWorldManager(worldMgr, g_projectiles, projPtrSeen);

    char buf[160];
    snprintf(buf, sizeof(buf),
        "Objects: %zu  |  Tiles: %zu  |  Projectiles: %zu (ring %d)  |  WM dict+0x%X list+0x%X + hook",
        g_entities.size(), g_tiles.size(), g_projectiles.size(),
        ProjectileTracking::CountValidForDiagnostics(), OFF_WM_MAPOBJ_DICT_A, OFF_WM_KJMON_LIST);
    g_status   = buf;
    g_statusOk = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// World inspect: editable primitive fields (match UnityExplorerTAB patterns).
// ─────────────────────────────────────────────────────────────────────────────
static bool WorldInspectFieldIsStatic(FieldInfo* f)
{
    return f && f->type && ((f->type->attrs & 0x0010) != 0);
}

static void WorldInspectApplyFieldValue(Il2CppObject* obj, FieldInfo* f, bool isStatic, const void* buf)
{
    if (isStatic) il2cpp_field_static_set_value(f, const_cast<void*>(buf));
    else if (obj) il2cpp_field_set_value(obj, f, const_cast<void*>(buf));
}

static void DrawWorldInspectEditableFieldValue(Il2CppObject* obj, FieldInfo* f)
{
    if (!f || !f->type) {
        ImGui::TextUnformatted("?");
        return;
    }
    if (il2cpp_field_is_literal(f)) {
        ImGui::TextUnformatted(Resolver::FormatFieldValueAsText(obj, f).c_str());
        return;
    }

    const bool isStatic = WorldInspectFieldIsStatic(f);
    if (!isStatic && !obj) {
        ImGui::TextDisabled("null");
        return;
    }

    const Il2CppType* ft   = il2cpp_field_get_type(f);
    const int         typeEnum = il2cpp_type_get_type(ft);

    ImGui::PushItemWidth(-1.f);

    switch (typeEnum) {
    case IL2CPP_TYPE_BOOLEAN: {
        bool v = false;
        Resolver::GetFieldValue(obj, f, &v);
        const char* items[] = { "false", "true" };
        int         i       = v ? 1 : 0;
        if (ImGui::Combo("##wfBool", &i, items, IM_ARRAYSIZE(items))) {
            v = (i != 0);
            WorldInspectApplyFieldValue(obj, f, isStatic, &v);
        }
        break;
    }
    case IL2CPP_TYPE_I1: {
        int8_t v = 0;
        Resolver::GetFieldValue(obj, f, &v);
        int iv = v;
        if (ImGui::InputInt("##wfI1", &iv, 1, 10, ImGuiInputTextFlags_CharsDecimal)) {
            if (iv < -128) iv = -128;
            if (iv > 127) iv = 127;
            v = static_cast<int8_t>(iv);
            WorldInspectApplyFieldValue(obj, f, isStatic, &v);
        }
        break;
    }
    case IL2CPP_TYPE_U1: {
        uint8_t v = 0;
        Resolver::GetFieldValue(obj, f, &v);
        int iv = v;
        if (ImGui::InputInt("##wfU1", &iv, 1, 10, ImGuiInputTextFlags_CharsDecimal)) {
            if (iv < 0) iv = 0;
            if (iv > 255) iv = 255;
            v = static_cast<uint8_t>(iv);
            WorldInspectApplyFieldValue(obj, f, isStatic, &v);
        }
        break;
    }
    case IL2CPP_TYPE_I2: {
        int16_t v = 0;
        Resolver::GetFieldValue(obj, f, &v);
        int iv = v;
        if (ImGui::InputInt("##wfI2", &iv, 1, 100, ImGuiInputTextFlags_CharsDecimal)) {
            if (iv < -32768) iv = -32768;
            if (iv > 32767) iv = 32767;
            v = static_cast<int16_t>(iv);
            WorldInspectApplyFieldValue(obj, f, isStatic, &v);
        }
        break;
    }
    case IL2CPP_TYPE_U2:
    case IL2CPP_TYPE_CHAR: {
        uint16_t v = 0;
        Resolver::GetFieldValue(obj, f, &v);
        int iv = v;
        if (ImGui::InputInt("##wfU2", &iv, 1, 100, ImGuiInputTextFlags_CharsDecimal)) {
            if (iv < 0) iv = 0;
            if (iv > 65535) iv = 65535;
            v = static_cast<uint16_t>(iv);
            WorldInspectApplyFieldValue(obj, f, isStatic, &v);
        }
        break;
    }
    case IL2CPP_TYPE_I4:
    case IL2CPP_TYPE_ENUM: {
        int32_t v = 0;
        Resolver::GetFieldValue(obj, f, &v);
        if (ImGui::InputInt("##wfI4", &v, 1, 100, ImGuiInputTextFlags_CharsDecimal))
            WorldInspectApplyFieldValue(obj, f, isStatic, &v);
        break;
    }
    case IL2CPP_TYPE_U4: {
        uint32_t v = 0;
        Resolver::GetFieldValue(obj, f, &v);
        if (ImGui::InputScalar("##wfU4", ImGuiDataType_U32, &v, nullptr, nullptr, "%u",
                ImGuiInputTextFlags_CharsDecimal))
            WorldInspectApplyFieldValue(obj, f, isStatic, &v);
        break;
    }
    case IL2CPP_TYPE_I8: {
        int64_t v = 0;
        Resolver::GetFieldValue(obj, f, &v);
        if (ImGui::InputScalar("##wfI8", ImGuiDataType_S64, &v, nullptr, nullptr, nullptr,
                ImGuiInputTextFlags_CharsDecimal))
            WorldInspectApplyFieldValue(obj, f, isStatic, &v);
        break;
    }
    case IL2CPP_TYPE_U8: {
        uint64_t v = 0;
        Resolver::GetFieldValue(obj, f, &v);
        if (ImGui::InputScalar("##wfU8", ImGuiDataType_U64, &v, nullptr, nullptr, nullptr,
                ImGuiInputTextFlags_CharsDecimal))
            WorldInspectApplyFieldValue(obj, f, isStatic, &v);
        break;
    }
    case IL2CPP_TYPE_R4: {
        float v = 0.f;
        Resolver::GetFieldValue(obj, f, &v);
        if (ImGui::InputFloat("##wfR4", &v, 0.f, 0.f, "%.9g", ImGuiInputTextFlags_CharsDecimal))
            WorldInspectApplyFieldValue(obj, f, isStatic, &v);
        break;
    }
    case IL2CPP_TYPE_R8: {
        double v = 0.0;
        Resolver::GetFieldValue(obj, f, &v);
        if (ImGui::InputDouble("##wfR8", &v, 0.0, 0.0, "%.17g", ImGuiInputTextFlags_CharsDecimal))
            WorldInspectApplyFieldValue(obj, f, isStatic, &v);
        break;
    }
    case IL2CPP_TYPE_I: {
        intptr_t v = 0;
        Resolver::GetFieldValue(obj, f, &v);
        if (sizeof(intptr_t) == 8) {
            int64_t vv = static_cast<int64_t>(v);
            if (ImGui::InputScalar("##wfIP", ImGuiDataType_S64, &vv, nullptr, nullptr, nullptr,
                    ImGuiInputTextFlags_CharsDecimal)) {
                v = static_cast<intptr_t>(vv);
                WorldInspectApplyFieldValue(obj, f, isStatic, &v);
            }
        } else {
            int32_t vv = static_cast<int32_t>(v);
            if (ImGui::InputInt("##wfIP", &vv, 1, 100, ImGuiInputTextFlags_CharsDecimal)) {
                v = static_cast<intptr_t>(vv);
                WorldInspectApplyFieldValue(obj, f, isStatic, &v);
            }
        }
        break;
    }
    case IL2CPP_TYPE_U: {
        uintptr_t v = 0;
        Resolver::GetFieldValue(obj, f, &v);
        if (sizeof(uintptr_t) == 8) {
            uint64_t vv = static_cast<uint64_t>(v);
            if (ImGui::InputScalar("##wfUP", ImGuiDataType_U64, &vv, nullptr, nullptr, nullptr,
                    ImGuiInputTextFlags_CharsDecimal)) {
                v = static_cast<uintptr_t>(vv);
                WorldInspectApplyFieldValue(obj, f, isStatic, &v);
            }
        } else {
            uint32_t vv = static_cast<uint32_t>(v);
            if (ImGui::InputScalar("##wfUP", ImGuiDataType_U32, &vv, nullptr, nullptr, nullptr,
                    ImGuiInputTextFlags_CharsDecimal)) {
                v = static_cast<uintptr_t>(vv);
                WorldInspectApplyFieldValue(obj, f, isStatic, &v);
            }
        }
        break;
    }
    case IL2CPP_TYPE_STRING: {
        const uint64_t key = WorldInspectStrFieldKey(obj, f, isStatic);
        std::vector<char>& buf = s_worldInspectStrFieldBufs[key];
        if (buf.empty()) {
            Il2CppString* s = nullptr;
            Resolver::GetFieldValue(obj, f, &s);
            const std::string cur = s ? il2cppi_to_string(s) : std::string();
            const size_t cap = (std::max)(size_t{ 256 }, cur.size() + 128);
            buf.resize(cap);
            strncpy_s(buf.data(), buf.size(), cur.c_str(), _TRUNCATE);
        }
        ImGui::InputText("##wfStr", buf.data(), buf.size(),
            ImGuiInputTextFlags_CallbackResize,
            WorldInspectInputTextResizeCallback, &buf);
        if (ImGui::IsItemDeactivatedAfterEdit()) {
            Il2CppString* ns = il2cpp_string_new(buf.data());
            WorldInspectApplyFieldValue(obj, f, isStatic, &ns);
        }
        break;
    }
    default:
        ImGui::PushTextWrapPos(0.f);
        ImGui::TextUnformatted(Resolver::FormatFieldValueAsText(obj, f).c_str());
        ImGui::PopTextWrapPos();
        break;
    }

    ImGui::PopItemWidth();
}

static void DrawWorldInspectEditableProperty(Il2CppObject* obj, const PropertyInfo* prop)
{
    if (!prop || !prop->get) {
        ImGui::TextUnformatted("?");
        return;
    }

    const Il2CppType* rt = prop->get->return_type;
    if (!rt) {
        ImGui::TextUnformatted("?");
        return;
    }

    const int typeEnum = il2cpp_type_get_type(rt);
    Il2CppObject* boxed =
        Resolver::Protection::SafeRuntimeInvoke(prop->get, obj, nullptr);

    ImGui::PushItemWidth(-1.f);

    auto invokeSet = [&](void* pVal) {
        if (!prop->set) return;
        void* params[] = { pVal };
        Resolver::Protection::SafeRuntimeInvoke(prop->set, obj, params);
    };

    switch (typeEnum) {
    case IL2CPP_TYPE_BOOLEAN: {
        bool v = Resolver::Protection::SafeUnbox<bool>(boxed, false);
        const char* items[] = { "false", "true" };
        int         i       = v ? 1 : 0;
        if (ImGui::Combo("##wpBool", &i, items, IM_ARRAYSIZE(items)) && prop->set) {
            v = (i != 0);
            invokeSet(&v);
        }
        break;
    }
    case IL2CPP_TYPE_I4:
    case IL2CPP_TYPE_ENUM: {
        int32_t v = Resolver::Protection::SafeUnbox<int32_t>(boxed, 0);
        if (ImGui::InputInt("##wpI4", &v, 1, 100, ImGuiInputTextFlags_CharsDecimal) && prop->set)
            invokeSet(&v);
        break;
    }
    case IL2CPP_TYPE_U4: {
        uint32_t v = Resolver::Protection::SafeUnbox<uint32_t>(boxed, 0u);
        if (ImGui::InputScalar("##wpU4", ImGuiDataType_U32, &v, nullptr, nullptr, "%u",
                ImGuiInputTextFlags_CharsDecimal) &&
            prop->set)
            invokeSet(&v);
        break;
    }
    case IL2CPP_TYPE_R4: {
        float v = Resolver::Protection::SafeUnbox<float>(boxed, 0.f);
        if (ImGui::InputFloat("##wpR4", &v, 0.f, 0.f, "%.9g", ImGuiInputTextFlags_CharsDecimal) &&
            prop->set)
            invokeSet(&v);
        break;
    }
    case IL2CPP_TYPE_R8: {
        double v = Resolver::Protection::SafeUnbox<double>(boxed, 0.0);
        if (ImGui::InputDouble("##wpR8", &v, 0.0, 0.0, "%.17g", ImGuiInputTextFlags_CharsDecimal) &&
            prop->set)
            invokeSet(&v);
        break;
    }
    case IL2CPP_TYPE_STRING: {
        if (!prop->set) {
            const std::string pval =
                boxed ? il2cppi_to_string(reinterpret_cast<Il2CppString*>(boxed)) : std::string("(null)");
            ImGui::PushTextWrapPos(0.f);
            ImGui::TextUnformatted(pval.c_str());
            ImGui::PopTextWrapPos();
            break;
        }
        const uint64_t key = WorldInspectStrPropKey(obj, prop);
        std::vector<char>& buf = s_worldInspectStrPropBufs[key];
        if (buf.empty()) {
            const std::string cur =
                boxed ? il2cppi_to_string(reinterpret_cast<Il2CppString*>(boxed)) : std::string();
            const size_t cap = (std::max)(size_t{ 256 }, cur.size() + 128);
            buf.resize(cap);
            strncpy_s(buf.data(), buf.size(), cur.c_str(), _TRUNCATE);
        }
        ImGui::InputText("##wpStr", buf.data(), buf.size(),
            ImGuiInputTextFlags_CallbackResize,
            WorldInspectInputTextResizeCallback, &buf);
        if (ImGui::IsItemDeactivatedAfterEdit()) {
            Il2CppString* ns = il2cpp_string_new(buf.data());
            void* params[] = { ns };
            Resolver::Protection::SafeRuntimeInvoke(prop->set, obj, params);
        }
        break;
    }
    default: {
        std::string pval = Resolver::FormatIl2CppReturn(prop->get, boxed);
        ImGui::PushTextWrapPos(0.f);
        ImGui::TextUnformatted(pval.c_str());
        ImGui::PopTextWrapPos();
        break;
    }
    }

    ImGui::PopItemWidth();
}

static const char* WorldInspectFilterTrim(const char* s)
{
    if (!s) return "";
    while (*s == ' ') ++s;
    return s;
}

static bool WorldInspectFilterActive()
{
    return WorldInspectFilterTrim(s_worldInspectSearchBuf)[0] != '\0';
}

static bool WorldInspectMatchesFilter(const std::string& displayName, const char* rawName)
{
    const char* needle = WorldInspectFilterTrim(s_worldInspectSearchBuf);
    if (!needle[0]) return true;

    std::string n(needle);
    for (char& c : n)
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));

    auto toLower = [](std::string x) {
        for (char& c : x)
            c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        return x;
    };

    if (toLower(displayName).find(n) != std::string::npos) return true;
    if (rawName && rawName[0] && toLower(std::string(rawName)).find(n) != std::string::npos) return true;
    return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal: IL2CPP field dump for a double-clicked entity / projectile pointer
// ─────────────────────────────────────────────────────────────────────────────
static void DrawWorldInspectPopupModal()
{
    if (s_worldInspectPopupRootId == 0)
        return;

    ImGui::SetNextWindowPos(ImGui::GetMainViewport()->GetCenter(), ImGuiCond_FirstUseEver, ImVec2(0.5f, 0.5f));
    ImGui::SetNextWindowSize(ImVec2(580.f, 460.f), ImGuiCond_FirstUseEver);
    // Do not use AlwaysAutoResize here: it fights SetNextWindowSize and can collapse the scroll child to ~0 height.
    if (!ImGui::BeginPopupEx(s_worldInspectPopupRootId,
            ImGuiWindowFlags_Modal | ImGuiWindowFlags_NoCollapse)) {
        return;
    }

    if (ImGui::IsWindowAppearing()) {
        s_worldInspectStrFieldBufs.clear();
        s_worldInspectStrPropBufs.clear();
    }

    if (!s_worldInspectObj || !Resolver::Protection::IsValidIl2CppObject(s_worldInspectObj)) {
        ImGui::TextColored(ImVec4(1.f, 0.45f, 0.35f, 1.f),
            "Pointer is null, stale, or not a valid Il2CppObject. Close and double-click again after Refresh.");
    }
    else {
        Il2CppClass* klass = nullptr;
        Resolver::Protection::safe_call([&]() {
            klass = il2cpp_object_get_class(s_worldInspectObj);
        });
        if (!klass) {
            ImGui::TextColored(ImVec4(1.f, 0.45f, 0.35f, 1.f), "Could not read object class.");
        }
        else {
            const char* cn = il2cpp_class_get_name(klass);
            const char* ns = il2cpp_class_get_namespace(klass);
            ImGui::Text("ObjectId: %d", s_worldInspectObjectId);
            ImGui::Text("Ptr: 0x%p", (void*)s_worldInspectObj);
            if (s_worldInspectSubtitle[0])
                ImGui::TextDisabled("%s", s_worldInspectSubtitle);
            ImGui::TextColored(ImVec4(0.45f, 0.95f, 0.55f, 1.f), "Class: %s%s%s",
                (ns && ns[0]) ? ns : "",
                (ns && ns[0]) ? "::" : "",
                cn ? Beebyte::Deobf(cn).c_str() : "?");
            ImGui::Separator();
            ImGui::TextDisabled(
                "Bools: false/true. Numbers & strings: edit in place; string writes apply when you leave the field "
                "(Tab/click away). References / structs: read-only. Refresh may invalidate the pointer.");
            ImGui::Spacing();
            ImGui::SetNextItemWidth(-1.f);
            ImGui::InputTextWithHint("##wInspectSearch", "Search fields, properties, methods (name, case-insensitive)...",
                s_worldInspectSearchBuf, IM_ARRAYSIZE(s_worldInspectSearchBuf));
            ImGui::Spacing();

            // Walk to root via parents only — do not use il2cpp_defaults (not linked in this DLL).
            std::vector<Il2CppClass*> hierarchy;
            for (Il2CppClass* k = klass; k; k = il2cpp_class_get_parent(k))
                hierarchy.push_back(k);
            std::reverse(hierarchy.begin(), hierarchy.end());

            // Fixed-height scroll region (fractional height with AutoResize parent produced an empty body).
            ImGui::BeginChild("WorldInspectScroll", ImVec2(0.f, 320.f), true);
            for (Il2CppClass* k : hierarchy) {
                ImGui::PushID((void*)k);
                const char* kn = il2cpp_class_get_name(k);
                const char* kns = il2cpp_class_get_namespace(k);
                std::string header = (kns && kns[0]) ? (std::string(kns) + "::" + Beebyte::Deobf(kn)) : Beebyte::Deobf(kn);
                if (header.empty() && kn) header = kn;
                if (header.empty()) header = "?";
                if (ImGui::CollapsingHeader(header.c_str(), ImGuiTreeNodeFlags_DefaultOpen)) {
                    ImGui::Indent(8.f);
                    constexpr ImGuiTableFlags tf =
                        ImGuiTableFlags_Borders | ImGuiTableFlags_RowBg | ImGuiTableFlags_SizingStretchProp;
                    if (ImGui::BeginTable("fld", 2, tf, ImVec2(-1.f, 0.f))) {
                        ImGui::TableSetupColumn("Field", ImGuiTableColumnFlags_WidthStretch, 0.38f);
                        ImGui::TableSetupColumn("Value", ImGuiTableColumnFlags_WidthStretch, 0.62f);
                        ImGui::TableHeadersRow();

                        void* fIter = nullptr;
                        bool    anyField = false;
                        while (FieldInfo* f = il2cpp_class_get_fields(k, &fIter)) {
                            const char* fname = il2cpp_field_get_name(f);
                            std::string fdisp = fname ? Beebyte::Deobf(fname) : "?";
                            if (!WorldInspectMatchesFilter(fdisp, fname))
                                continue;
                            anyField = true;
                            ImGui::TableNextRow();
                            ImGui::PushID(f);
                            ImGui::TableNextColumn();
                            const bool isStatic = WorldInspectFieldIsStatic(f);
                            if (isStatic)
                                ImGui::TextColored(ImVec4(1.f, 0.92f, 0.5f, 1.f), "(S) %s", fdisp.c_str());
                            else
                                ImGui::TextUnformatted(fdisp.c_str());

                            ImGui::TableNextColumn();
                            DrawWorldInspectEditableFieldValue(s_worldInspectObj, f);
                            ImGui::PopID();
                        }
                        if (WorldInspectFilterActive() && !anyField) {
                            ImGui::TableNextRow();
                            ImGui::TableNextColumn();
                            ImGui::TextDisabled("(no matching fields)");
                            ImGui::TableNextColumn();
                            ImGui::TextDisabled("");
                        }
                        ImGui::EndTable();
                    }
                    ImGui::Spacing();
                    ImGui::TextDisabled("Properties");
                    if (ImGui::BeginTable("pr", 2, tf, ImVec2(-1.f, 0.f))) {
                        ImGui::TableSetupColumn("Property", ImGuiTableColumnFlags_WidthStretch, 0.38f);
                        ImGui::TableSetupColumn("Value", ImGuiTableColumnFlags_WidthStretch, 0.62f);
                        ImGui::TableHeadersRow();
                        void* pIter = nullptr;
                        bool  anyProp = false;
                        while (const PropertyInfo* prop = il2cpp_class_get_properties(k, &pIter)) {
                            if (!prop->get) continue;
                            const char* pname = il2cpp_property_get_name(const_cast<PropertyInfo*>(prop));
                            std::string pdisp = pname ? Beebyte::Deobf(pname) : std::string("?");
                            if (!WorldInspectMatchesFilter(pdisp, pname))
                                continue;
                            anyProp = true;
                            ImGui::TableNextRow();
                            ImGui::PushID(prop);
                            ImGui::TableNextColumn();
                            ImGui::TextUnformatted(pdisp.c_str());
                            ImGui::TableNextColumn();
                            DrawWorldInspectEditableProperty(s_worldInspectObj, prop);
                            ImGui::PopID();
                        }
                        if (WorldInspectFilterActive() && !anyProp) {
                            ImGui::TableNextRow();
                            ImGui::TableNextColumn();
                            ImGui::TextDisabled("(no matching properties)");
                            ImGui::TableNextColumn();
                            ImGui::TextDisabled("");
                        }
                        ImGui::EndTable();
                    }
                    ImGui::Spacing();
                    ImGui::TextDisabled("Methods");
                    if (ImGui::BeginTable("mtd", 3, tf, ImVec2(-1.f, 0.f))) {
                        ImGui::TableSetupColumn("Method", ImGuiTableColumnFlags_WidthStretch, 0.52f);
                        ImGui::TableSetupColumn("#args", ImGuiTableColumnFlags_WidthFixed, 48.f);
                        ImGui::TableSetupColumn("Native", ImGuiTableColumnFlags_WidthStretch, 0.36f);
                        ImGui::TableHeadersRow();

                        void*       mIter = nullptr;
                        bool        anyMethod = false;
                        while (const MethodInfo* mi = il2cpp_class_get_methods(k, &mIter)) {
                            const char* mname = il2cpp_method_get_name(mi);
                            std::string mdisp = mname ? Beebyte::Deobf(mname) : std::string("?");
                            if (!WorldInspectMatchesFilter(mdisp, mname))
                                continue;
                            anyMethod = true;
                            ImGui::TableNextRow();
                            ImGui::PushID(mi);
                            ImGui::TableNextColumn();
                            const bool isInstance = il2cpp_method_is_instance(mi);
                            if (isInstance)
                                ImGui::TextUnformatted(mdisp.c_str());
                            else
                                ImGui::TextColored(ImVec4(1.f, 0.92f, 0.5f, 1.f), "(S) %s", mdisp.c_str());
                            ImGui::TableNextColumn();
                            const uint32_t npc = il2cpp_method_get_param_count(mi);
                            ImGui::Text("%u", (unsigned)npc);
                            ImGui::TableNextColumn();
                            void* mptr = nullptr;
                            Resolver::Protection::safe_call([&]() {
                                mptr = reinterpret_cast<void*>(mi->methodPointer);
                            });
                            if (mptr)
                                ImGui::TextDisabled("0x%llX", (unsigned long long)(uintptr_t)mptr);
                            else
                                ImGui::TextDisabled("—");
                            ImGui::PopID();
                        }
                        if (WorldInspectFilterActive() && !anyMethod) {
                            ImGui::TableNextRow();
                            ImGui::TableNextColumn();
                            ImGui::TextDisabled("(no matching methods)");
                            ImGui::TableNextColumn();
                            ImGui::TextDisabled("");
                            ImGui::TableNextColumn();
                            ImGui::TextDisabled("");
                        }
                        ImGui::EndTable();
                    }
                    ImGui::Unindent(8.f);
                }
                ImGui::PopID();
            }
            ImGui::EndChild();
        }
    }

    ImGui::Spacing();
    if (ImGui::Button("Close", ImVec2(120.f, 0.f))) {
        s_worldInspectObj = nullptr;
        s_worldInspectSubtitle[0] = '\0';
        ImGui::CloseCurrentPopup();
    }
    ImGui::EndPopup();
}

// ─────────────────────────────────────────────────────────────────────────────
// Draw the entity table (used inside the entity view)
// ─────────────────────────────────────────────────────────────────────────────
static void DrawEntityTable(const std::vector<const WorldEntity*>& shown)
{
    static constexpr ImGuiTableFlags kFlags =
        ImGuiTableFlags_Borders | ImGuiTableFlags_RowBg |
        ImGuiTableFlags_ScrollY | ImGuiTableFlags_Resizable |
        ImGuiTableFlags_Sortable | ImGuiTableFlags_SizingFixedFit;

    if (!ImGui::BeginTable("EntTable", 11, kFlags, ImGui::GetContentRegionAvail()))
        return;

    ImGui::TableSetupScrollFreeze(0, 1);
    ImGui::TableSetupColumn("Ptr",     ImGuiTableColumnFlags_WidthFixed, 138.f);
    ImGui::TableSetupColumn("ID",      ImGuiTableColumnFlags_WidthFixed,  64.f);
    ImGui::TableSetupColumn("Class",   ImGuiTableColumnFlags_WidthFixed, 120.f);
    ImGui::TableSetupColumn("ObjType", ImGuiTableColumnFlags_WidthFixed, 100.f);
    ImGui::TableSetupColumn("X",       ImGuiTableColumnFlags_WidthFixed,  62.f);
    ImGui::TableSetupColumn("Y",       ImGuiTableColumnFlags_WidthFixed,  62.f);
    ImGui::TableSetupColumn("HP",      ImGuiTableColumnFlags_WidthFixed, 150.f);
    ImGui::TableSetupColumn("Dist",    ImGuiTableColumnFlags_WidthFixed,  52.f);
    ImGui::TableSetupColumn("Name",    ImGuiTableColumnFlags_WidthFixed, 140.f);
    ImGui::TableSetupColumn("IGN",     ImGuiTableColumnFlags_WidthFixed, 120.f);
    ImGui::TableSetupColumn("Conds",   ImGuiTableColumnFlags_WidthStretch,  0.f);
    ImGui::TableHeadersRow();

    for (const WorldEntity* e : shown) {
        ImGui::TableNextRow();
        if (e->isLocal)
            ImGui::TableSetBgColor(ImGuiTableBgTarget_RowBg0,
                ImGui::GetColorU32(ImVec4(0.10f, 0.35f, 0.10f, 0.80f)));
        else if (IsEnemy(*e))
            ImGui::TableSetBgColor(ImGuiTableBgTarget_RowBg0,
                ImGui::GetColorU32(ImVec4(0.35f, 0.08f, 0.08f, 0.50f)));

        // Ptr
        ImGui::TableNextColumn();
        {
            char ptrbuf[24];
            snprintf(ptrbuf, sizeof(ptrbuf), "0x%llX", (unsigned long long)e->ptr);
            ImGui::TextDisabled("%s", ptrbuf);
            if (ImGui::IsItemClicked()) ImGui::SetClipboardText(ptrbuf);
            if (ImGui::IsItemHovered()) ImGui::SetTooltip("Click to copy address\nDouble-click: inspect fields (popup)");
            if (e->ptr && Resolver::Protection::IsValidIl2CppObject((Il2CppObject*)e->ptr)) {
                if (ImGui::IsItemHovered() && ImGui::IsMouseDoubleClicked(ImGuiMouseButton_Left)) {
                    s_worldInspectObj = (Il2CppObject*)e->ptr;
                    s_worldInspectObjectId = e->objectId;
                    if (e->typeName[0])
                        strncpy_s(s_worldInspectSubtitle, e->typeName, _TRUNCATE);
                    else
                        s_worldInspectSubtitle[0] = '\0';
                    ImGui::OpenPopupEx(s_worldInspectPopupRootId, ImGuiPopupFlags_None);
                }
            }
        }
        // ID
        ImGui::TableNextColumn();
        if (e->isLocal)
            ImGui::TextColored(ImVec4(0.4f, 1.f, 0.4f, 1.f), "%d*", e->objectId);
        else
            ImGui::Text("%d", e->objectId);
        // Class
        ImGui::TableNextColumn();
        if (e->typeName[0]) ImGui::TextUnformatted(e->typeName);
        else                ImGui::TextDisabled("?");
        // ObjType
        ImGui::TableNextColumn();
        if (e->objType != 0)
            ImGui::Text("%d (0x%X)", e->objType, (uint32_t)e->objType);
        else if (e->typeName[0] && strcmp(e->typeName, "KJMONHENJEN") != 0)
            ImGui::TextDisabled("0");
        else
            ImGui::TextDisabled("--");
        // X / Y
        ImGui::TableNextColumn(); ImGui::Text("%.1f", e->x);
        ImGui::TableNextColumn(); ImGui::Text("%.1f", e->y);
        // HP bar
        ImGui::TableNextColumn();
        if (e->maxHp > 0) {
            float frac = static_cast<float>(e->hp) / static_cast<float>(e->maxHp);
            frac = frac < 0.f ? 0.f : frac > 1.f ? 1.f : frac;
            ImVec4 col = frac > 0.60f ? ImVec4(0.20f, 0.80f, 0.20f, 1.f)
                       : frac > 0.30f ? ImVec4(0.90f, 0.70f, 0.10f, 1.f)
                       :                ImVec4(0.90f, 0.20f, 0.20f, 1.f);
            char hpbuf[32]; snprintf(hpbuf, sizeof(hpbuf), "%d / %d", e->hp, e->maxHp);
            ImGui::PushStyleColor(ImGuiCol_PlotHistogram, col);
            ImGui::ProgressBar(frac, ImVec2(-1.f, 13.f), hpbuf);
            ImGui::PopStyleColor();
        } else {
            ImGui::TextDisabled("N/A");
        }
        // Dist
        ImGui::TableNextColumn();
        if (e->isLocal) ImGui::TextDisabled("--");
        else            ImGui::Text("%.1f", Distance(e->x, e->y, g_localX, g_localY));
        // Name — XML id from ObjectProperties (e.g. "Cyclops God", "Wizard")
        ImGui::TableNextColumn();
        if (e->objName[0]) ImGui::TextUnformatted(e->objName);
        else               ImGui::TextDisabled("--");
        // IGN — player account name (FKALGHJIADI only)
        ImGui::TableNextColumn();
        if (e->playerName[0])
            ImGui::TextColored(ImVec4(0.7f, 0.9f, 1.f, 1.f), "%s", e->playerName);
        else
            ImGui::TextDisabled("--");
        // Object XML flags + MapObject status conditions (COHCKAPOLCA / offset_map.md)
        ImGui::TableNextColumn();
        {
            char cbuf[384] = {};
            if (e->objConds) {
                if (e->objConds & OCOND_STATIC)      strcat_s(cbuf, sizeof cbuf, "Static ");
                if (e->objConds & OCOND_IS_ENEMY)    strcat_s(cbuf, sizeof cbuf, "isEnemy ");
                if (e->objConds & OCOND_OCCUPY_SQ)   strcat_s(cbuf, sizeof cbuf, "OccupySq ");
                if (e->objConds & OCOND_FULL_OCC)    strcat_s(cbuf, sizeof cbuf, "FullOcc ");
                if (e->objConds & OCOND_ENEMY_OCC)   strcat_s(cbuf, sizeof cbuf, "EnemyOcc ");
                if (e->objConds & OCOND_BLOCK_PROJ)  strcat_s(cbuf, sizeof cbuf, "BlkProj ");
                if (e->objConds & OCOND_NO_COVER)    strcat_s(cbuf, sizeof cbuf, "NoCover ");
                if (e->objConds & OCOND_CONNECTS)    strcat_s(cbuf, sizeof cbuf, "Connects ");
                if (e->objConds & OCOND_NO_WALL_RPT) strcat_s(cbuf, sizeof cbuf, "NoWallRpt ");
                if (e->objConds & OCOND_FLYING)      strcat_s(cbuf, sizeof cbuf, "Flying ");
                if (e->objConds & OCOND_PROT_GND)    strcat_s(cbuf, sizeof cbuf, "PrtGnd ");
                if (e->objConds & OCOND_PROT_SINK)   strcat_s(cbuf, sizeof cbuf, "PrtSink ");
            }
            if (e->condLo | e->condHi) {
                if (cbuf[0]) strcat_s(cbuf, sizeof cbuf, "| ");
                char sbuf[256] = {};
                RuntimeOffsets::FormatMapObjectConditionMask(e->condLo, e->condHi, sbuf, sizeof sbuf);
                strcat_s(cbuf, sizeof cbuf, sbuf);
            }
            if (cbuf[0])
                ImGui::TextColored(ImVec4(0.85f, 0.75f, 1.f, 1.f), "%s", cbuf);
            else
                ImGui::TextDisabled("--");
        }
    }
    ImGui::EndTable();
}

// ─────────────────────────────────────────────────────────────────────────────
// Enemy projectiles (hook ring + WM list walk merged on refresh)
// ─────────────────────────────────────────────────────────────────────────────
static void DrawProjectileTable(const std::vector<const WorldProjectile*>& shown)
{
    static constexpr ImGuiTableFlags kFlags =
        ImGuiTableFlags_Borders | ImGuiTableFlags_RowBg |
        ImGuiTableFlags_ScrollY | ImGuiTableFlags_Resizable |
        ImGuiTableFlags_SizingFixedFit;

    if (!ImGui::BeginTable("ProjTable", 12, kFlags, ImGui::GetContentRegionAvail()))
        return;

    ImGui::TableSetupScrollFreeze(0, 1);
    ImGui::TableSetupColumn("Ptr",       ImGuiTableColumnFlags_WidthFixed, 130.f);
    ImGui::TableSetupColumn("X",         ImGuiTableColumnFlags_WidthFixed,  56.f);
    ImGui::TableSetupColumn("Y",         ImGuiTableColumnFlags_WidthFixed,  56.f);
    ImGui::TableSetupColumn("Bullet",    ImGuiTableColumnFlags_WidthFixed,  52.f);
    ImGui::TableSetupColumn("Dmg",       ImGuiTableColumnFlags_WidthFixed,  72.f);
    ImGui::TableSetupColumn("Speed",     ImGuiTableColumnFlags_WidthFixed,  64.f);
    ImGui::TableSetupColumn("Life ms",   ImGuiTableColumnFlags_WidthFixed,  58.f);
    ImGui::TableSetupColumn("HalfR",     ImGuiTableColumnFlags_WidthFixed,  50.f);
    ImGui::TableSetupColumn("Attacker",  ImGuiTableColumnFlags_WidthFixed,  64.f);
    ImGui::TableSetupColumn("Owner",     ImGuiTableColumnFlags_WidthFixed,  64.f);
    ImGui::TableSetupColumn("Dist",      ImGuiTableColumnFlags_WidthFixed,  44.f);
    ImGui::TableSetupColumn("Flags",     ImGuiTableColumnFlags_WidthStretch,   0.f);
    ImGui::TableHeadersRow();

    for (const WorldProjectile* p : shown) {
        ImGui::TableNextRow();

        float lx = p->x, ly = p->y;
        if (p->ptr && AddrValid(p->ptr)) {
            __try {
                uint8_t* pi = reinterpret_cast<uint8_t*>(p->ptr);
                lx = *reinterpret_cast<float*>(pi + OFF_POS_X);
                ly = *reinterpret_cast<float*>(pi + OFF_POS_Y);
            } __except (EXCEPTION_EXECUTE_HANDLER) {}
        }

        ImGui::TableNextColumn();
        {
            char ptrbuf[24];
            snprintf(ptrbuf, sizeof(ptrbuf), "0x%llX", (unsigned long long)p->ptr);
            ImGui::TextDisabled("%s", ptrbuf);
            if (ImGui::IsItemClicked()) ImGui::SetClipboardText(ptrbuf);
            if (ImGui::IsItemHovered()) ImGui::SetTooltip("Click to copy address\nDouble-click: inspect fields (popup)");
            if (p->ptr && Resolver::Protection::IsValidIl2CppObject((Il2CppObject*)p->ptr)) {
                if (ImGui::IsItemHovered() && ImGui::IsMouseDoubleClicked(ImGuiMouseButton_Left)) {
                    s_worldInspectObj = (Il2CppObject*)p->ptr;
                    s_worldInspectObjectId = -1;
                    snprintf(s_worldInspectSubtitle, sizeof(s_worldInspectSubtitle),
                        "Projectile  bulletId=%d  attackerObjId=%d  ownerObjId=%u",
                        p->bulletId, p->attackerObjId, (unsigned)p->ownerObjId);
                    ImGui::OpenPopupEx(s_worldInspectPopupRootId, ImGuiPopupFlags_None);
                }
            }
        }
        ImGui::TableNextColumn(); ImGui::Text("%.2f", lx);
        ImGui::TableNextColumn(); ImGui::Text("%.2f", ly);
        ImGui::TableNextColumn(); ImGui::Text("%d", p->bulletId);
        ImGui::TableNextColumn();
        if (p->minDamage > 0 && p->minDamage < p->damage)
            ImGui::Text("%d-%d", p->minDamage, p->damage);
        else
            ImGui::Text("%d", p->damage);
        ImGui::TableNextColumn(); ImGui::Text("%.0f", p->speed);
        ImGui::TableNextColumn(); ImGui::Text("%.0f", p->lifetime);
        ImGui::TableNextColumn(); ImGui::Text("%.3f", p->projHalfSize);
        ImGui::TableNextColumn(); ImGui::Text("%d", p->attackerObjId);
        ImGui::TableNextColumn(); ImGui::Text("%u", p->ownerObjId);
        ImGui::TableNextColumn();
        ImGui::Text("%.1f", Distance(lx, ly, g_localX, g_localY));

        ImGui::TableNextColumn();
        {
            char fbuf[48] = {};
            if (p->wavy)       strcat_s(fbuf, "wavy ");
            if (p->boomerang)  strcat_s(fbuf, "boom ");
            if (p->parametric) strcat_s(fbuf, "param ");
            if (p->isAccelerating) strcat_s(fbuf, "accel ");
            if (fbuf[0] == '\0') strcat_s(fbuf, "—");
            ImGui::TextUnformatted(fbuf);
        }
    }
    ImGui::EndTable();
}

// ─────────────────────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────────────────────
void WorldTAB::Render()
{
    if (ImGuiWindow* ww = ImGui::GetCurrentWindow())
        s_worldInspectPopupRootId = ww->GetID("WorldObjectInspect");

    const float dt = ImGui::GetIO().DeltaTime;

    if (g_autoRefresh) {
        g_autoTimer -= dt;
        if (g_autoTimer <= 0.f) { DoRefresh(); g_autoTimer = g_autoInterval; }
    }

    // ── Header bar ────────────────────────────────────────────────────────────
    ImGui::Spacing();
    ImGui::TextColored(ImVec4(0.4f, 1.f, 0.6f, 1.f), "WORLD ENTITIES");
    ImGui::SameLine(0.f, 16.f);

    if (ImGui::Button("Refresh")) { DoRefresh(); g_autoTimer = g_autoInterval; }
    ImGui::SameLine();
    ImGui::Checkbox("Auto", &g_autoRefresh);
    if (g_autoRefresh) {
        ImGui::SameLine();
        ImGui::SetNextItemWidth(50.f);
        ImGui::DragFloat("##ival", &g_autoInterval, 0.1f, 0.2f, 10.f, "%.1fs");
    }
    ImGui::Separator();

    // ── Status ────────────────────────────────────────────────────────────────
    {
        ImVec4 sc = g_statusOk ? ImVec4(0.5f,0.5f,0.5f,1.f) : ImVec4(1.f,0.3f,0.3f,1.f);
        ImGui::TextColored(sc, "%s", g_status.c_str());
    }

    // ── WorldManager info (collapsible) ───────────────────────────────────────
    if (g_worldMgrPtr) {
        ImGui::Spacing();
        if (ImGui::CollapsingHeader("WorldManager Info")) {
            ImGui::Indent(8.f);
            ImGui::TextColored(ImVec4(0.6f,0.8f,1.f,1.f), "AppMgr   0x%llX", (unsigned long long)g_appMgrPtr);
            ImGui::TextColored(ImVec4(0.6f,1.f,0.8f,1.f), "WorldMgr 0x%llX", (unsigned long long)g_worldMgrPtr);
            ImGui::Spacing();
            ImGui::TextDisabled("--- time/tick candidates ---");
            ImGui::Text("+0xD8 Ticks = %u",   g_wm_d8);
            ImGui::Text("+0xDC uint  = %u",   g_wm_dc);
            ImGui::Text("+0xE0 uint  = %u",   g_wm_e0);
            ImGui::Text("+0xF4 float = %.3f", g_wm_f4);
            ImGui::Text("+0xF8 float = %.3f", g_wm_f8);
            ImGui::Text("+0xFC int   = %d",   g_wm_fc);
            ImGui::Text("+0x100 int  = %d",   g_wm_100);
            ImGui::TextDisabled("Projectiles: WM dicts +0xB8/+0xC0, List +0x%X (HBEAKBIHANL) + SpawnProjectile hook.", OFF_WM_KJMON_LIST);
            ImGui::Unindent(8.f);
        }
        ImGui::Spacing();
    }

    if (g_entities.empty() && g_tiles.empty() && g_projectiles.empty()) {
        ImGui::TextDisabled("No data. Press Refresh while in-game.");
        DrawWorldInspectPopupModal();
        return;
    }

    // ── Table switcher tabs ────────────────────────────────────────────────────
    // Count entities per category for the badge
    // Players = FKALGHJIADI only
    // Enemies = PMMFLLAIPGN
    // Objects = portals, chests, statics, etc.
    int nAll = 0, nPlayer = 0, nEnemy = 0, nObject = 0;
    for (const WorldEntity& e : g_entities) {
        ++nAll;
        if (IsPlayerClass(e)) ++nPlayer;
        else if (IsEnemy(e))  ++nEnemy;
        else                  ++nObject;
    }

    ImGui::Spacing();
    ImGui::Text("Local: (%.1f, %.1f)", g_localX, g_localY);
    ImGui::Spacing();

    // Primary tab bar: Objects / Tiles / Projectiles / Throwables
    {
        char entLabel[40], tileLabel[40], projLabel[48], aoeLabel[48];
        snprintf(entLabel,  sizeof(entLabel),  "Objects (%d)##etab",            (int)g_entities.size());
        snprintf(tileLabel, sizeof(tileLabel), "Tiles (%zu)##ttab",             g_tiles.size());
        snprintf(projLabel, sizeof(projLabel), "Projectiles (%zu)##ptab",       g_projectiles.size());
        snprintf(aoeLabel,  sizeof(aoeLabel),  "Throwables (%d)##aoetab",       AoeTracking::CountActive());

        ImGui::PushStyleVar(ImGuiStyleVar_FramePadding, ImVec2(10.f, 4.f));

        bool entSel  = (g_activeTable == 0);
        bool tileSel = (g_activeTable == 1);
        bool projSel = (g_activeTable == 2);
        bool aoeSel  = (g_activeTable == 3);

        if (entSel)
            ImGui::PushStyleColor(ImGuiCol_Button, ImGui::GetColorU32(ImGuiCol_ButtonActive));
        if (ImGui::Button(entLabel)) g_activeTable = 0;
        if (entSel)  ImGui::PopStyleColor();

        ImGui::SameLine();

        if (tileSel)
            ImGui::PushStyleColor(ImGuiCol_Button, ImGui::GetColorU32(ImGuiCol_ButtonActive));
        if (ImGui::Button(tileLabel)) g_activeTable = 1;
        if (tileSel) ImGui::PopStyleColor();

        ImGui::SameLine();

        if (projSel)
            ImGui::PushStyleColor(ImGuiCol_Button, ImGui::GetColorU32(ImGuiCol_ButtonActive));
        if (ImGui::Button(projLabel)) g_activeTable = 2;
        if (projSel) ImGui::PopStyleColor();

        ImGui::SameLine();

        if (aoeSel)
            ImGui::PushStyleColor(ImGuiCol_Button, ImGui::GetColorU32(ImGuiCol_ButtonActive));
        if (ImGui::Button(aoeLabel)) g_activeTable = 3;
        if (aoeSel) ImGui::PopStyleColor();

        ImGui::PopStyleVar();
    }

    ImGui::Separator();

    // ── OBJECT VIEW ──────────────────────────────────────────────────────────
    if (g_activeTable == 0)
    {
        // Category filter row (All / Players / Enemies / Objects with counts)
        {
            const int counts[] = { nAll, nPlayer, nEnemy, nObject };
            const ImVec4 cols[] = {
                ImVec4(0.8f, 0.8f, 0.8f, 1.f),   // All — white-ish
                ImVec4(0.3f, 0.6f, 1.0f, 1.f),   // Players — blue
                ImVec4(1.0f, 0.35f, 0.25f, 1.f), // Enemies — red-orange
                ImVec4(0.8f, 0.65f, 0.2f, 1.f),  // Objects — gold
            };

            ImGui::PushStyleVar(ImGuiStyleVar_FramePadding, ImVec2(8.f, 3.f));
            for (int ci = 0; ci < 4; ++ci) {
                if (ci > 0) ImGui::SameLine();
                char lbl[32];
                snprintf(lbl, sizeof(lbl), "%s (%d)##cat%d", kCatLabels[ci], counts[ci], ci);

                bool selected = (g_entityCat == (EntityCat)ci);
                if (selected) {
                    ImGui::PushStyleColor(ImGuiCol_Button, ImGui::GetColorU32(ImGuiCol_ButtonActive));
                    ImGui::PushStyleColor(ImGuiCol_Text, cols[ci]);
                }
                if (ImGui::Button(lbl)) g_entityCat = (EntityCat)ci;
                if (selected) ImGui::PopStyleColor(2);
            }
            ImGui::PopStyleVar();
        }

        ImGui::SameLine(0.f, 16.f);
        ImGui::SetNextItemWidth(160.f);
        ImGui::InputTextWithHint("##eflt", "Filter id / class / type / name / Static...", g_filter, sizeof(g_filter));

        ImGui::Spacing();

        // Build filtered + sorted list
        std::vector<const WorldEntity*> shown;
        shown.reserve(g_entities.size());
        for (const WorldEntity& e : g_entities) {
            if (!MatchesCat(e, g_entityCat)) continue;
            if (g_filter[0]) {
                char idBuf[32], typBuf[32], condBuf[384] = {};
                snprintf(idBuf, sizeof(idBuf), "%d", e.objectId);
                snprintf(typBuf, sizeof(typBuf), "0x%X", (uint32_t)e.objType);
                if (e.objConds & OCOND_STATIC)      strcat_s(condBuf, sizeof condBuf, "Static ");
                if (e.objConds & OCOND_IS_ENEMY)    strcat_s(condBuf, sizeof condBuf, "isEnemy ");
                if (e.objConds & OCOND_OCCUPY_SQ)   strcat_s(condBuf, sizeof condBuf, "OccupySq ");
                if (e.objConds & OCOND_FULL_OCC)    strcat_s(condBuf, sizeof condBuf, "FullOcc ");
                if (e.objConds & OCOND_ENEMY_OCC)   strcat_s(condBuf, sizeof condBuf, "EnemyOcc ");
                if (e.objConds & OCOND_BLOCK_PROJ)  strcat_s(condBuf, sizeof condBuf, "BlkProj ");
                if (e.objConds & OCOND_NO_COVER)    strcat_s(condBuf, sizeof condBuf, "NoCover ");
                if (e.objConds & OCOND_CONNECTS)    strcat_s(condBuf, sizeof condBuf, "Connects ");
                if (e.objConds & OCOND_FLYING)      strcat_s(condBuf, sizeof condBuf, "Flying ");
                if (e.condLo | e.condHi) {
                    char mbuf[256] = {};
                    RuntimeOffsets::FormatMapObjectConditionMask(e.condLo, e.condHi, mbuf, sizeof mbuf);
                    strcat_s(condBuf, sizeof condBuf, mbuf);
                }
                if (!strstr(idBuf,        g_filter) &&
                    !strstr(e.typeName,   g_filter) &&
                    !strstr(typBuf,       g_filter) &&
                    !strstr(e.objName,    g_filter) &&
                    !strstr(e.playerName, g_filter) &&
                    !strstr(condBuf,      g_filter)) continue;
            }
            shown.push_back(&e);
        }

        // Sort: local first, then by distance
        std::sort(shown.begin(), shown.end(), [](const WorldEntity* a, const WorldEntity* b) {
            if (a->isLocal != b->isLocal) return a->isLocal > b->isLocal;
            return Distance(a->x, a->y, g_localX, g_localY) <
                   Distance(b->x, b->y, g_localX, g_localY);
        });

        ImGui::TextDisabled("Showing %zu / %zu", shown.size(), g_entities.size());
        ImGui::Spacing();
        DrawEntityTable(shown);
    }
    // ── PROJECTILES VIEW ─────────────────────────────────────────────────────
    else if (g_activeTable == 2)
    {
        ImGui::TextDisabled("Refresh merges hook + WM KJMONHENJEN dicts (0xB8/0xC0) and list (+0xE8). Shooter IDs use entity scan + dict key.");
        ImGui::Spacing();
        ImGui::SetNextItemWidth(220.f);
        ImGui::InputTextWithHint("##pflt", "Filter ptr / bullet / id / flags...", g_projFilter, sizeof(g_projFilter));

        ImGui::Spacing();

        std::vector<const WorldProjectile*> shown;
        shown.reserve(g_projectiles.size());
        for (const WorldProjectile& p : g_projectiles) {
            if (!p.valid) continue;
            if (g_projFilter[0]) {
                char ptrbuf[32], bid[24], atk[24], own[24], fl[48] = {};
                snprintf(ptrbuf, sizeof(ptrbuf), "%llX", (unsigned long long)p.ptr);
                snprintf(bid, sizeof(bid), "%d", p.bulletId);
                snprintf(atk, sizeof(atk), "%d", p.attackerObjId);
                snprintf(own, sizeof(own), "%u", p.ownerObjId);
                if (p.wavy) strcat_s(fl, "wavy ");
                if (p.boomerang) strcat_s(fl, "boom ");
                if (p.parametric) strcat_s(fl, "param ");
                if (p.isAccelerating) strcat_s(fl, "accel ");
                if (!strstr(ptrbuf, g_projFilter) && !strstr(bid, g_projFilter) &&
                    !strstr(atk, g_projFilter) && !strstr(own, g_projFilter) &&
                    !strstr(fl, g_projFilter))
                    continue;
            }
            shown.push_back(&p);
        }

        std::sort(shown.begin(), shown.end(), [](const WorldProjectile* a, const WorldProjectile* b) {
            return Distance(a->x, a->y, g_localX, g_localY) < Distance(b->x, b->y, g_localX, g_localY);
        });

        ImGui::TextDisabled("Showing %zu / %zu", shown.size(), g_projectiles.size());
        ImGui::Spacing();
        DrawProjectileTable(shown);
    }
    // ── THROWABLES / AOE VIEW ────────────────────────────────────────────────
    else if (g_activeTable == 3)
    {
        AoeTracking::EnsureInstalled();
        ImGui::TextDisabled(
            "Four hook paths: GJJ=GJJCEFJMNMK entity  FHOH=visual fallback  EXPL=explosion controller  SFX=ShowEffect packet.");
        ImGui::TextDisabled(
            "GJJ/FHOH radius = 2.0 default. EXPL radius = CustomExplosionEntrance+0x38 (~3.0 tiles). "
            "SFX OwnerID = packet targetObjectId (direct source entity). GJJ/FHOH OwnerID = throwable object (not thrower).");
        ImGui::Spacing();

        std::vector<WorldAoe> aoes;
        AoeTracking::CopyActiveForDraw(aoes);

        const ULONGLONG now = GetTickCount64();

        static constexpr ImGuiTableFlags kAoeFlags =
            ImGuiTableFlags_Borders | ImGuiTableFlags_RowBg |
            ImGuiTableFlags_ScrollY | ImGuiTableFlags_Resizable |
            ImGuiTableFlags_SizingFixedFit;

        // Count breakdown
        int nDamaging = 0, nEnemy = 0, nFriendly = 0;
        for (const WorldAoe& a : aoes) {
            if (a.isDamaging) { ++nDamaging; if (a.isEnemy) ++nEnemy; else ++nFriendly; }
        }
        ImGui::TextDisabled("Active: %d  |  Damaging: %d  (Enemy: %d  Friendly: %d)  |  Hooks: %d",
            (int)aoes.size(), nDamaging, nEnemy, nFriendly, AoeTracking::CountHooks());
        ImGui::Spacing();

        if (ImGui::BeginTable("AoeTable", 13, kAoeFlags, ImGui::GetContentRegionAvail())) {
            ImGui::TableSetupScrollFreeze(0, 1);
            ImGui::TableSetupColumn("Src",       ImGuiTableColumnFlags_WidthFixed,  42.f);
            ImGui::TableSetupColumn("Side",      ImGuiTableColumnFlags_WidthFixed,  68.f);
            ImGui::TableSetupColumn("OwnerID",   ImGuiTableColumnFlags_WidthFixed,  72.f);
            ImGui::TableSetupColumn("Dmg",       ImGuiTableColumnFlags_WidthFixed,  38.f);
            ImGui::TableSetupColumn("DestX",     ImGuiTableColumnFlags_WidthFixed,  62.f);
            ImGui::TableSetupColumn("DestY",     ImGuiTableColumnFlags_WidthFixed,  62.f);
            ImGui::TableSetupColumn("OriginX",   ImGuiTableColumnFlags_WidthFixed,  62.f);
            ImGui::TableSetupColumn("OriginY",   ImGuiTableColumnFlags_WidthFixed,  62.f);
            ImGui::TableSetupColumn("Radius",    ImGuiTableColumnFlags_WidthFixed,  52.f);
            ImGui::TableSetupColumn("Dur ms",    ImGuiTableColumnFlags_WidthFixed,  54.f);
            ImGui::TableSetupColumn("Rem ms",    ImGuiTableColumnFlags_WidthFixed,  54.f);
            ImGui::TableSetupColumn("Ptr",       ImGuiTableColumnFlags_WidthFixed, 130.f);
            ImGui::TableSetupColumn("SFX Type",  ImGuiTableColumnFlags_WidthStretch,  0.f);
            ImGui::TableHeadersRow();

            for (const WorldAoe& a : aoes) {
                float elapsed = static_cast<float>(now - a.spawnTick);
                if (elapsed >= a.lifetime) continue;
                float remMs = a.lifetime - elapsed;

                // Row tint: enemy red, friendly green, unresolved side yellow, expiring orange
                if (a.isDamaging && a.isEnemyChecked && a.isEnemy)
                    ImGui::TableSetBgColor(ImGuiTableBgTarget_RowBg0,
                        ImGui::GetColorU32(ImVec4(0.45f, 0.04f, 0.04f, 0.55f)));
                else if (a.isDamaging && a.isEnemyChecked && !a.isEnemy)
                    ImGui::TableSetBgColor(ImGuiTableBgTarget_RowBg0,
                        ImGui::GetColorU32(ImVec4(0.04f, 0.30f, 0.06f, 0.45f)));
                else if (a.isDamaging && !a.isEnemyChecked)
                    ImGui::TableSetBgColor(ImGuiTableBgTarget_RowBg0,
                        ImGui::GetColorU32(ImVec4(0.30f, 0.25f, 0.04f, 0.45f)));
                else if (remMs < 500.f)
                    ImGui::TableSetBgColor(ImGuiTableBgTarget_RowBg0,
                        ImGui::GetColorU32(ImVec4(0.35f, 0.15f, 0.0f, 0.45f)));

                ImGui::TableNextRow();

                // Source path
                ImGui::TableNextColumn();
                switch (a.source) {
                case kAoeSrcGjj:  ImGui::TextColored(ImVec4(1.0f, 0.55f, 0.10f, 1.f), "GJJ");  break;
                case kAoeSrcFhoh: ImGui::TextColored(ImVec4(1.0f, 0.85f, 0.20f, 1.f), "FHOH"); break;
                case kAoeSrcExpl: ImGui::TextColored(ImVec4(0.4f, 0.85f, 1.00f, 1.f), "EXPL"); break;
                case kAoeSrcSfx:  ImGui::TextColored(ImVec4(0.5f, 1.00f, 0.55f, 1.f), "SFX");  break;
                default:          ImGui::TextDisabled("?");                                      break;
                }

                // Side: Enemy / Friendly / pending (yellow) / unknown
                ImGui::TableNextColumn();
                if (!a.isDamaging) {
                    ImGui::TextDisabled("?");
                } else if (!a.isEnemyChecked) {
                    ImGui::TextColored(ImVec4(1.f, 0.85f, 0.1f, 1.f), "pending");
                } else if (a.isEnemy) {
                    ImGui::TextColored(ImVec4(1.f, 0.25f, 0.25f, 1.f), "Enemy");
                } else {
                    ImGui::TextColored(ImVec4(0.3f, 1.f, 0.4f, 1.f), "Friendly");
                }

                // OwnerID — meaning depends on source:
                //   GJJ/FHOH: throwable object's objectId (NOT the thrower)
                //   EXPL:     anchor (thrower) entity objectId
                //   SFX:      packet targetObjectId = source entity (thrower/caster)
                ImGui::TableNextColumn();
                if (a.ownerObjId != 0) {
                    if (a.source == kAoeSrcExpl || a.source == kAoeSrcSfx)
                        ImGui::Text("%d", a.ownerObjId);       // direct thrower/source entity
                    else
                        ImGui::TextDisabled("%d", a.ownerObjId); // throwable object (not thrower)
                } else {
                    ImGui::TextDisabled("--");
                }
                if (ImGui::IsItemHovered()) {
                    const char* tip = (a.source == kAoeSrcExpl) ? "Anchor (thrower) entity objectId"
                                    : (a.source == kAoeSrcSfx)  ? "ShowEffect targetObjectId — source entity"
                                    : "Throwable/visual object objectId (not the thrower)";
                    ImGui::SetTooltip("%s", tip);
                }

                // Damaging?
                ImGui::TableNextColumn();
                if (a.isDamaging)
                    ImGui::TextColored(ImVec4(1.f, 0.3f, 0.2f, 1.f), "YES");
                else
                    ImGui::TextDisabled("no");

                // Destination (landing spot / effect centre)
                ImGui::TableNextColumn(); ImGui::Text("%.2f", a.destX);
                ImGui::TableNextColumn(); ImGui::Text("%.2f", a.destY);

                // Origin (throw source / SFX pos1)
                ImGui::TableNextColumn(); ImGui::TextDisabled("%.2f", a.x);
                ImGui::TableNextColumn(); ImGui::TextDisabled("%.2f", a.y);

                // Radius
                ImGui::TableNextColumn();
                if (a.isDamaging)
                    ImGui::Text("%.2f", a.radius);
                else
                    ImGui::TextDisabled("~%.2f", a.radius);

                // Total duration ms
                ImGui::TableNextColumn();
                ImGui::Text("%.0f", a.lifetime);

                // Remaining ms
                ImGui::TableNextColumn();
                if (remMs < 500.f)
                    ImGui::TextColored(ImVec4(1.f, 0.3f, 0.2f, 1.f), "%.0f", remMs);
                else
                    ImGui::Text("%.0f", remMs);

                // Live ptr (moved to end as less important)
                ImGui::TableNextColumn();
                if (a.ptr)
                    ImGui::Text("0x%llX", (unsigned long long)a.ptr);
                else
                    ImGui::TextDisabled("--");

                // SFX effect type — only populated for kAoeSrcSfx entries
                ImGui::TableNextColumn();
                if (a.source == kAoeSrcSfx) {
                    switch (a.sfxEffectType) {
                    case  4: ImGui::TextColored(ImVec4(0.5f, 1.f, 0.55f, 1.f), "THROW(4)");   break;
                    case  5: ImGui::TextColored(ImVec4(0.5f, 1.f, 0.55f, 1.f), "NOVA(5)");    break;
                    case 23: ImGui::TextColored(ImVec4(0.5f, 1.f, 0.55f, 1.f), "CIRC(23)");   break;
                    case 39: ImGui::TextColored(ImVec4(0.5f, 1.f, 0.55f, 1.f), "AOE(39)");    break;
                    default: ImGui::TextColored(ImVec4(0.5f, 1.f, 0.55f, 1.f), "SFX(%d)", a.sfxEffectType); break;
                    }
                } else {
                    ImGui::TextDisabled("--");
                }
            }
            ImGui::EndTable();
        }
    }
    // ── TILE VIEW ─────────────────────────────────────────────────────────────
    else
    {
        ImGui::SetNextItemWidth(240.f);
        ImGui::InputTextWithHint("##tflt", "Filter type / x / y / name / Sink / Push...", g_tileFilter, sizeof(g_tileFilter));

        ImGui::Spacing();

        std::vector<const WorldTile*> shown;
        shown.reserve(g_tiles.size());
        for (const WorldTile& t : g_tiles) {
            if (g_tileFilter[0]) {
                char xbuf[16], ybuf[16], typbuf[16];
                snprintf(xbuf,   sizeof(xbuf),   "%d",   t.tileX);
                snprintf(ybuf,   sizeof(ybuf),   "%d",   t.tileY);
                snprintf(typbuf, sizeof(typbuf), "0x%X", (uint32_t)t.tileType);
                // Build condition string for matching
                char condbuf[64] = {};
                if (t.conds & TCOND_SINK)    strcat_s(condbuf, "Sink ");
                if (t.conds & TCOND_SINKING) strcat_s(condbuf, "Sinking ");
                if (t.conds & TCOND_PUSH)    strcat_s(condbuf, "Push ");
                if (t.conds & TCOND_ALPHA)   strcat_s(condbuf, "Alpha ");
                if (t.conds & TCOND_NOWALK)  strcat_s(condbuf, "NoWalk");
                if (!strstr(xbuf,         g_tileFilter) &&
                    !strstr(ybuf,         g_tileFilter) &&
                    !strstr(typbuf,       g_tileFilter) &&
                    !strstr(condbuf,      g_tileFilter) &&
                    !strstr(t.tileName,   g_tileFilter)) continue;
            }
            shown.push_back(&t);
        }

        // Sort by distance from local player (closest first)
        std::sort(shown.begin(), shown.end(), [](const WorldTile* a, const WorldTile* b) {
            auto dx = [](int32_t tx, float lx){ return (float)tx - lx; };
            auto dy = [](int32_t ty, float ly){ return (float)ty - ly; };
            float da = dx(a->tileX,g_localX)*dx(a->tileX,g_localX) + dy(a->tileY,g_localY)*dy(a->tileY,g_localY);
            float db = dx(b->tileX,g_localX)*dx(b->tileX,g_localX) + dy(b->tileY,g_localY)*dy(b->tileY,g_localY);
            return da < db;
        });

        ImGui::TextDisabled("Showing %zu / %zu", shown.size(), g_tiles.size());
        ImGui::Spacing();

        static constexpr ImGuiTableFlags kFlags =
            ImGuiTableFlags_Borders | ImGuiTableFlags_RowBg |
            ImGuiTableFlags_ScrollY | ImGuiTableFlags_Resizable |
            ImGuiTableFlags_Sortable | ImGuiTableFlags_SizingFixedFit;

        if (ImGui::BeginTable("TileTable", 8, kFlags, ImGui::GetContentRegionAvail())) {
            ImGui::TableSetupScrollFreeze(0, 1);
            ImGui::TableSetupColumn("Type",   ImGuiTableColumnFlags_WidthFixed,  70.f);
            ImGui::TableSetupColumn("X",      ImGuiTableColumnFlags_WidthFixed,  55.f);
            ImGui::TableSetupColumn("Y",      ImGuiTableColumnFlags_WidthFixed,  55.f);
            ImGui::TableSetupColumn("Damage", ImGuiTableColumnFlags_WidthFixed,  90.f);
            ImGui::TableSetupColumn("Speed",  ImGuiTableColumnFlags_WidthFixed,  60.f);
            ImGui::TableSetupColumn("Dist",   ImGuiTableColumnFlags_WidthFixed,  50.f);
            ImGui::TableSetupColumn("Conds",  ImGuiTableColumnFlags_WidthFixed, 130.f);
            ImGui::TableSetupColumn("Name",   ImGuiTableColumnFlags_WidthStretch,  0.f);
            ImGui::TableHeadersRow();

            for (const WorldTile* t : shown) {
                // Tint hazardous tiles
                bool hasDmg   = (t->minDmg > 0 || t->maxDmg > 0);
                bool hasSink  = (t->conds & TCOND_SINK) || (t->conds & TCOND_SINKING);
                bool hasPush  = (t->conds & TCOND_PUSH) != 0;
                if (hasDmg || hasSink)
                    ImGui::TableSetBgColor(ImGuiTableBgTarget_RowBg0,
                        ImGui::GetColorU32(ImVec4(0.4f, 0.1f, 0.0f, 0.45f)));
                else if (hasPush)
                    ImGui::TableSetBgColor(ImGuiTableBgTarget_RowBg0,
                        ImGui::GetColorU32(ImVec4(0.0f, 0.2f, 0.4f, 0.45f)));

                ImGui::TableNextRow();
                // Type (hex)
                ImGui::TableNextColumn();
                ImGui::Text("0x%X", (uint32_t)t->tileType);
                // X / Y
                ImGui::TableNextColumn(); ImGui::Text("%d", t->tileX);
                ImGui::TableNextColumn(); ImGui::Text("%d", t->tileY);
                // Damage: "60" or "40-80" or "—"
                ImGui::TableNextColumn();
                if (hasDmg) {
                    if (t->minDmg == t->maxDmg)
                        ImGui::TextColored(ImVec4(1.f,0.4f,0.3f,1.f), "%d", t->minDmg);
                    else
                        ImGui::TextColored(ImVec4(1.f,0.4f,0.3f,1.f), "%d-%d", t->minDmg, t->maxDmg);
                } else {
                    ImGui::TextDisabled("—");
                }
                // Speed
                ImGui::TableNextColumn();
                if (t->speed > 0.001f && t->speed < 0.9999f)
                    ImGui::TextColored(ImVec4(1.f,0.85f,0.2f,1.f), "%.0f%%", t->speed * 100.f);
                else
                    ImGui::TextDisabled("—");
                // Distance from player
                ImGui::TableNextColumn();
                {
                    float dx = (float)t->tileX - g_localX;
                    float dy = (float)t->tileY - g_localY;
                    float dist = std::sqrt(dx*dx + dy*dy);
                    ImGui::Text("%.0f", dist);
                }
                // Conditions string
                ImGui::TableNextColumn();
                {
                    char cbuf[64] = {};
                    if (t->conds & TCOND_SINK)    strcat_s(cbuf, "Sink ");
                    if (t->conds & TCOND_SINKING) strcat_s(cbuf, "Sinking ");
                    if (t->conds & TCOND_PUSH)    strcat_s(cbuf, "Push ");
                    if (t->conds & TCOND_ALPHA)   strcat_s(cbuf, "Alpha ");
                    if (t->conds & TCOND_NOWALK)  strcat_s(cbuf, "NoWalk");
                    if (cbuf[0])
                        ImGui::TextColored(ImVec4(0.7f,0.9f,1.f,1.f), "%s", cbuf);
                    else
                        ImGui::TextDisabled("—");
                }
                // Name — XML id from ObjectProperties
                ImGui::TableNextColumn();
                if (t->tileName[0]) ImGui::TextUnformatted(t->tileName);
                else                ImGui::TextDisabled("--");
            }
            ImGui::EndTable();
        }
    }

    DrawWorldInspectPopupModal();
}

// ── ReadMapName helpers ───────────────────────────────────────────────────────
// Safe approach: reads the IL2CPP managed string pointer at wm+fieldOffset,
// then copies wchar_t chars as ASCII. Only POD types — __try is valid.
static bool SehReadStringField(void* wm, uint32_t fieldOffset, char* buf, int bufLen)
{
    void* strPtr = nullptr;
    __try { strPtr = *reinterpret_cast<void**>((uint8_t*)wm + fieldOffset); }
    __except(EXCEPTION_EXECUTE_HANDLER) { return false; }
    if (!strPtr) return false;

    int32_t len = 0;
    __try { len = *reinterpret_cast<int32_t*>((uint8_t*)strPtr + 0x10); }
    __except(EXCEPTION_EXECUTE_HANDLER) { return false; }
    if (len <= 0 || len > 64) return false;

    int copyLen = (len < bufLen - 1) ? len : bufLen - 1;
    __try {
        const wchar_t* chars = reinterpret_cast<const wchar_t*>((uint8_t*)strPtr + 0x14);
        for (int i = 0; i < copyLen; i++)
            buf[i] = (chars[i] >= 0x20 && chars[i] < 0x7F) ? (char)chars[i] : '\0';
        buf[copyLen] = '\0';
    } __except(EXCEPTION_EXECUTE_HANDLER) { buf[0] = '\0'; return false; }

    for (int i = 0; i < copyLen; i++)
        if (buf[i] == '\0') { buf[0] = '\0'; return false; }

    return true;
}

// Probes known HJMBOMEHGDJ (WorldManager) string fields in order:
//   0x1E0 = AINOLPMCJIK (public), 0x1C0 = OEHNFKAGPDD, 0x108 = PICNEHLAODO
static bool SehCallAndReadMapString(void* wm, uintptr_t /*base*/, char* buf, int bufLen)
{
    static const uint32_t kOffsets[] = { 0x1E0, 0x1C0, 0x108 };

    for (int i = 0; i < 3; i++) {
        char tmp[128] = {};
        bool ok = SehReadStringField(wm, kOffsets[i], tmp, sizeof(tmp));

        if (ok && tmp[0]) {
            int copyN = (static_cast<int>(strlen(tmp)) < bufLen - 1)
                        ? static_cast<int>(strlen(tmp)) : bufLen - 1;
            memcpy(buf, tmp, copyN);
            buf[copyN] = '\0';
            return true;
        }
    }
    return false;
}

// ResolveLiveLocalPtr() removed — GameState::Tick() handles this every frame.

// ── Public API ───────────────────────────────────────────────────────────────
namespace WorldTAB {
    void      ForceRefresh()
    {
        // Coalesce refreshes requested within the same ~50 ms window. Multiple
        // callers (TestTAB + DebugTAB + tab Render paths) all drive this at
        // ~100 ms cadence via independent timers; without the gate, when two
        // happen to align in the same frame we walk the 4096-slot entity
        // dict and the tile list twice back-to-back. 50 ms is well below the
        // 100 ms call cadence (so legitimate ticks never get skipped) but
        // covers frame-aligned double-calls.
        static ULONGLONG s_lastRefreshMs = 0;
        const ULONGLONG nowMs = GetTickCount64();
        if (nowMs - s_lastRefreshMs < 50ULL) return;
        s_lastRefreshMs = nowMs;
        DoRefresh();
    }
    void*     GetLocalPtr()
    {
        // GameState owns the realtime pointer; LocalPlayer mirrors it.
        void* lp = GameState::GetLocalPtr();
        if (lp) { g_localPtr = lp; return lp; }
        return g_localPtr;  // last known value from most recent DoRefresh
    }
    float     GetLocalX()      { return LocalPlayer::GetX() ? LocalPlayer::GetX() : g_localX; }
    float     GetLocalY()      { return LocalPlayer::GetY() ? LocalPlayer::GetY() : g_localY; }
    uintptr_t GetAppMgrPtr()
    {
        return reinterpret_cast<uintptr_t>(GameState::GetAppMgr());
    }

    void ReadLocalWorldXYLive(float& outX, float& outY)
    {
        // LocalPlayer::Tick() always reads XY when ptr is valid — use cache.
        float cx = LocalPlayer::GetX(), cy = LocalPlayer::GetY();
        if (cx != 0.f || cy != 0.f) {
            outX = cx; outY = cy;
            g_localX = cx; g_localY = cy;
            return;
        }
        outX = g_localX;
        outY = g_localY;
    }

    bool GetEntityLivePos(int32_t objectId, float& outX, float& outY)
    {
        for (const WorldEntity& e : g_entities) {
            if (e.objectId != objectId) continue;
            if (!AddrValid(e.ptr)) return false;
            float lx = 0.f, ly = 0.f;
            bool ok = SafeRead(e.ptr, OFF_POS_X, lx) && SafeRead(e.ptr, OFF_POS_Y, ly);
            if (ok) { outX = lx; outY = ly; return true; }
            return false;
        }
        return false;
    }

    // Find a player entity (FKALGHJIADI) whose IGN best matches the given query.
    // Matching priority: exact > starts-with > contains (all case-insensitive).
    // Among ties at the same priority, the shorter name wins (avoids picking an unrelated
    // long name when a short partial query could match multiple players).
    // Returns true and fills outObjectId / outMatchedName on success.
    bool FindPlayerByName(const char* query, int32_t& outObjectId, char* outMatchedName, int nameLen)
    {
        if (!query || query[0] == '\0') return false;

        // Build lower-case query
        char lq[32] = {};
        for (int i = 0; query[i] && i < 31; ++i)
            lq[i] = (char)tolower((unsigned char)query[i]);

        // Priority: 0=exact, 1=starts-with, 2=contains, 3=none
        int   bestPri  = 3;
        int   bestLen  = INT_MAX;
        int32_t bestId = 0;
        const char* bestName = nullptr;

        for (const WorldEntity& e : g_entities) {
            if (e.playerName[0] == '\0') continue;  // not a player with a known IGN

            char ln[32] = {};
            for (int i = 0; e.playerName[i] && i < 31; ++i)
                ln[i] = (char)tolower((unsigned char)e.playerName[i]);

            int elen = (int)strlen(ln);
            int qlen = (int)strlen(lq);

            int pri = 3;
            if (strcmp(ln, lq) == 0)          pri = 0;  // exact
            else if (strncmp(ln, lq, qlen) == 0) pri = 1;  // starts-with
            else if (strstr(ln, lq) != nullptr)  pri = 2;  // contains

            if (pri < bestPri || (pri == bestPri && elen < bestLen)) {
                bestPri  = pri;
                bestLen  = elen;
                bestId   = e.objectId;
                bestName = e.playerName;
            }
        }

        if (bestPri == 3 || bestId == 0) return false;

        outObjectId = bestId;
        if (outMatchedName && nameLen > 0)
            strncpy_s(outMatchedName, nameLen, bestName, nameLen - 1);
        return true;
    }

    const std::vector<WorldEntity>& GetEntities()
    {
        return g_entities;
    }

    const std::vector<WorldTile>& GetTiles()
    {
        return g_tiles;
    }

    const std::vector<WorldProjectile>& GetProjectiles()
    {
        return g_projectiles;
    }

    bool IsTileBlocked(int tx, int ty)
    {
        std::lock_guard<std::mutex> lock(s_tileMapMutex);
        return s_blockedMap.count(BlockedKey(tx, ty)) != 0;
    }

    bool IsTileFullOccupied(int tx, int ty)
    {
        std::lock_guard<std::mutex> lock(s_tileMapMutex);
        return s_fullOccupyMap.count(BlockedKey(tx, ty)) != 0;
    }

    bool IsDamagingTile(int tx, int ty)
    {
        std::lock_guard<std::mutex> lock(s_tileMapMutex);
        return s_damagingMap.count(BlockedKey(tx, ty)) != 0;
    }

    // Returns the XML speed multiplier for the tile at (tx, ty).
    // 0.0 = no modifier; > 1.0 = speedy ground; < 1.0 = slow ground.
    float GetTileSpeed(int tx, int ty)
    {
        std::lock_guard<std::mutex> lock(s_tileMapMutex);
        auto it = s_tileSpeedMap.find(BlockedKey(tx, ty));
        return (it != s_tileSpeedMap.end()) ? it->second : 0.f;
    }

    bool ReadMapName(char* buf, int bufLen)
    {
        if (!buf || bufLen <= 1) { if (buf && bufLen > 0) buf[0] = '\0'; return false; }
        buf[0] = '\0';
        void* wm = reinterpret_cast<void*>(g_worldMgrPtr);
        if (!wm) return false;
        return SehCallAndReadMapString(wm, 0, buf, bufLen);
    }
}
