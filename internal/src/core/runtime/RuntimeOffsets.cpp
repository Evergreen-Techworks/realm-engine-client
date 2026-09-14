#include "pch-il2cpp.h"
#include "RuntimeOffsets.h"
#include "BuildBindings.h"
#include "Il2CppResolver.h"
#include "DbgFileLog.h"
#include <atomic>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <vector>
#include <cwchar>
#include <iomanip>

// ─────────────────────────────────────────────────────────────────────────────
// All variables are pre-initialised to their hardcoded fallback values.
// EnsureAll() overwrites each one the first time its class appears in IL2CPP
// metadata.  If a class loads but the field name is not found (e.g. a future
// Beebyte rename), the fallback stays in place.
// ─────────────────────────────────────────────────────────────────────────────

namespace RuntimeOffsets {

// ── Offset storage — initialised to fallbacks ─────────────────────────────
uint32_t PosX            = 0x3C;
uint32_t PosY            = 0x40;
uint32_t ObjType         = 0x30;
uint32_t ObjProps        = 0x18;
uint32_t KJ_ViewHandler  = 0x10;   // MPGOFIHIDML — ViewHandler component pointer
uint32_t KJ_SkinWidthObj = 0x28;   // LGDCEJKHGFJ — IPKAMAAPAGA reference
uint32_t ObjId           = 0x34;   // HHPOJBFICAH — objectId Int32
uint32_t KJ_BaseRadius   = 0x44;   // IOKKOCEAJNA — base bullet radius Single
uint32_t KJ_Scale        = 0x74;   // KEDBLBJIKCB — scale float3 first component
uint32_t KJ_Float3Pos    = 0x68;   // DGNPJNFGFPE — Unity.Mathematics.float3 world position (written on teleport/move)
uint32_t KJ_TileRef      = 0x58;   // EOKJOGFPLOA — BGAIOPJMHLO* current tile
uint32_t KJ_DictObjectId = 0xC0;   // FDNHINDAEHK — dict-key object id (NOT ObjId/HHPOJBFICAH)

// KJNHLADHEMH = current HP, NCBIICBDGAG = max HP (order in struct; names were once swapped in tooling).
uint32_t HP          = 0x20C;
uint32_t MaxHP       = 0x208;
uint32_t Defense     = 0x210;
uint32_t PlayerIGN   = 0x178;
// COHCKAPOLCA dump 0x248 on LKHPPBEGNOM (not 0x218 — that is HMMHAKPBEDK). +0x50 ACTK => 0x298.
// AV on PMMFLLAIPGN is handled gracefully: AutoAim SEH catches it and returns false (untargetable).
// PMMFLLAIPGN that AV are treated as targetable (correct fallback — assume no immunity).
uint32_t MoConditions = 0x298;
// ECGPFJKCCAN — Vector2 velocity. 0 = unresolved; AutoAim falls back to history.
uint32_t MoVelocity   = 0;
// KKENJFFDMPO — LKHPPBEGNOM ObjectProperties alias. Runtime metadata resolves this at 0x1C8.
uint32_t MoObjectProps = 0x1C8;
// GGBCADDBAPN — player collision ObjectProperties used by the C# working implementation.
// Generated/inherited player layout resolves this at 0x2F0; unlike the stat fields above,
// runtime evidence shows this ObjectProperties pointer is not ACTK-shifted.
uint32_t PlayerCollisionProps = 0x2F0;

uint32_t Tex1              = 0x4C4;
uint32_t Tex2              = 0x538;
uint32_t CurMP             = 0x54C;
uint32_t MaxMP             = 0x548;
// DAGEMHFLJLK — groundDamageImmune bool (dump 0x458 / runtime 0x4A8). NOT ability cooldown.
uint32_t GroundDmgImmune   = 0x4A8;
// BINDBHJLPMG — invincible bool (dump 0x459 / runtime 0x4A9). Short-duration hit invulnerability.
uint32_t LocalInvincible   = 0x4A9;
// PPBLNMIMIFP — abilityReady bool (dump 0x515 / runtime 0x565). True when ability can fire.
uint32_t AbilityReady      = 0x565;
// CGCMALPMMJL — bool moving (dump 0x448 / runtime 0x498).
uint32_t Player_Moving     = 0x498;
// BHJFNEAHAOE — float moveDirX (dump 0x478 / runtime 0x4C8).
uint32_t Player_MoveDirX   = 0x4C8;
// GDNEBFDDDKM — float moveDirY (dump 0x47C / runtime 0x4CC).
uint32_t Player_MoveDirY   = 0x4CC;
// BHJFNEAHAOE — float SPD stat (dump 0x478 / runtime 0x478, no ACTK shift).
// PlayerTAB and TestTAB read this without shift for the move-speed formula.
uint32_t Player_Spd        = 0x478;

// ── Player diagnostic stats (no ACTK shift for stat reads) ─────────────
uint32_t PlayerGuildName   = 0x470;  // NFJGJKLPLBA — Il2CppString* GUILD name (not IGN)
uint32_t PlayerClassNum    = 0x4B0;  // KABPJBJPGCM — class number int32
uint32_t PlayerGuildRank   = 0x4AC;  // GBANOMPLGBH — guild rank int32
uint32_t PlayerAtk         = 0x474;  // HCMECDPHEMC — ATK stat int32
uint32_t PlayerDex         = 0x47C;  // GDNEBFDDDKM — DEX stat int32
uint32_t PlayerVit         = 0x480;  // CGFPEPCKKOK — VIT stat int32
uint32_t PlayerWis         = 0x484;  // HDCDGHKGLDI — WIS stat int32
uint32_t PlayerCondInt     = 0x514;  // MPJGAPJBBBF — single-int condition field
uint32_t PlayerEquipMgr    = 0x668;  // AJJJBDBNBLM — EquipmentManager pointer

// ── EquipmentManager / ItemSlot (namespaced UI classes, no ACTK shift) ──
uint32_t EM_EquipSlots     = 0x48;   // "equipmentSlots" — ItemSlot[] on EquipmentManager
uint32_t Item_ObjProps     = 0x58;   // HLJFBHLMANJ — ObjectProperties* on ItemSlot
uint32_t Item_ObjType      = 0x60;   // INAAIAHOEFE — int32 type id on ItemSlot

// ApplicationManager → WorldManager field offset.
// Set by GameState.cpp type-scan (immune to backing-field name obfuscation).
uint32_t AppMgr_WorldMgr   = 0xC0;

// CameraManager component fields (no ACTK shift).
uint32_t CM_Transform      = 0x28;   // mainCameraContainer — Transform* (world-space camera container)
uint32_t CM_UnityCam        = 0x50;   // KNAIAEFDCLM — UnityEngine.Camera* (main gameplay camera)

uint32_t WM_Local    = 0x48;
uint32_t WM_AllDict  = 0xB0;
uint32_t WM_MapDictA = 0xB8;
uint32_t WM_MapDictB = 0xC0;
uint32_t WM_KjmonList= 0xE8;
uint32_t WM_TileArr  = 0x58;
uint32_t WM_TileList = 0x60;
uint32_t WM_TickId   = 0xD8;   // FIAJOKGHGGK — world tick counter UInt32
uint32_t WM_TickId2  = 0xDC;   // HOMNPDGNOMO — secondary tick UInt32

uint32_t TileX       = 0x38;
uint32_t TileY       = 0x3C;
uint32_t TileType    = 0x40;
uint32_t TileProps   = 0x50;
uint32_t Sq_Layer        = 0x44;  // EBCLNFDKKEH — int32 layer enum (ProjNoclip writes 37)
uint32_t Sq_DamageCached = 0x10;  // EAPMKCKMNDI — int32 current-damage cache
uint32_t Sq_Cover        = 0x48;  // JGMBPFJEGAH — ref; non-null = square has cover

uint32_t TP_Speed    = 0x50;
uint32_t TP_Sink     = 0x58;
uint32_t TP_NoWalk   = 0x78;
uint32_t TP_MinDmg   = 0xB0;
uint32_t TP_MaxDmg   = 0xB8;
uint32_t TP_Push     = 0xC8;
uint32_t TP_Alpha    = 0xD0;
uint32_t TP_Sinking  = 0xD8;

uint32_t OP_IdStr         = 0x38;
uint32_t OP_NoCover       = 0x98;
// InvincibleElement string pointer — non-null iff XML <Invincible/> is set.
// dump 0x450 + 0x10 IL2CPP object header = 0x460.
uint32_t OP_InvincibleElem= 0x460;
uint32_t OP_NoWallRpt     = 0x210;
uint32_t OP_OccupySq      = 0x69A;
// CORRECTED 2026-08-24: was 0x6D1 — byte-identical to OP_IsEnemy below, which is
// impossible: `fullOccupy` and `isEnemy` are distinct bools. Verified against the
// published build 6.13.0.1.0 dump (builds.him.is), where `isEnemy` = 0x6E1 and
// `fullOccupy` = 0x6E9 — 8 bytes apart (bool + padding). That group sits 0x10
// higher in 6.13 than in our build (the same shift seen on
// collisionRadiusMultiplier 0x788 -> 0x798), and our OP_IsEnemy = 0x6D1 is
// confirmed working against the live client, so fullOccupy = 0x6D1 + 8 = 0x6D9.
// LATENT, not active: both rows resolve by UNOBFUSCATED name on ObjectProperties
// (a class BeeByte does not rotate), so live metadata overwrites this every frame
// and the wrong value only bites if resolution ever fails.
uint32_t OP_FullOcc       = 0x6D9;
uint32_t OP_EnemyOcc      = 0x6D2;
// isEnemy verified at 0x6D1 against the live client (upstream offset update);
// our il2cpp-types.h dump still shows 0x6C9 — dump is stale for this region.
uint32_t OP_IsEnemy       = 0x6D1;
uint32_t OP_IsStatic      = 0x6D3;
uint32_t OP_BlockProj     = 0x6D4;
// noHealthBar bool — true when the entity type has no visible HP bar. dump 0x6C6 + 0x10 = 0x6D6.
uint32_t OP_NoHealthBar   = 0x6D6;
uint32_t OP_ProtGnd       = 0x6DC;
uint32_t OP_ProtSink      = 0x6DD;
uint32_t OP_Flying        = 0x6E4;
uint32_t OP_ConnectT      = 0x754;
uint32_t OP_Projectiles   = 0x1C0;
uint32_t OP_CollRadiusMult= 0x798;   // "collisionRadiusMultiplier" (boxed; current build per builds.him.is dump; 0x780 was questBarYOffset)

uint32_t PP_Lifetime        = 0x158;
uint32_t PP_Speed           = 0x160;
uint32_t PP_IsWavy          = 0x164;
uint32_t PP_IsBoomerang     = 0x165;
uint32_t PP_IsParametric    = 0x168;
uint32_t PP_HasCustomHitbox = 0x16D;
uint32_t PP_LaserDist       = 0x170;
uint32_t PP_SpeedClamp      = 0x174;
uint32_t PP_AccelDelay      = 0x178;
uint32_t PP_Acceleration    = 0x17C;
uint32_t PP_AccelerationInv = 0x180;
uint32_t PP_IsAccel         = 0x184;
uint32_t PP_UseAccel        = 0x185;   // 1 byte after IsAccel — adjacent bool pair
uint32_t PP_VelocityChangeRate = 0x188;
uint32_t PP_VelocityChangeRateInv = 0x18C;
uint32_t PP_Magnitude       = 0x19C;
uint32_t PP_Frequency       = 0x1A0;
uint32_t PP_Amplitude       = 0x1A4;
uint32_t PP_HasCustomAmplitude = 0x1A8;
uint32_t PP_CollMult              = 0xC0;
uint32_t PP_TurnRate              = 0xD4;
uint32_t PP_TurnRateDelay         = 0xD8;
uint32_t PP_TurnStopTime          = 0xE8;
uint32_t PP_CircleTurnAngle       = 0xEC;
uint32_t PP_CircleTurnDelay       = 0xF0;
uint32_t PP_TurnAcceleration      = 0xDC;
uint32_t PP_TurnAccelDelay        = 0xE0;
uint32_t PP_TurnClamp             = 0xE4;
uint32_t PP_TurnAccelInv          = 0x1AC;
uint32_t PP_IsTurning             = 0x1B0;
uint32_t PP_IsTurningDelayed      = 0x1B2;

uint32_t Hbeak_ProjRadius         = 0x1D4;  // HHFDCMIIIHF — collision radius T on projectile instance
uint32_t Hbeak_ProjPropsPtr       = 0x118;  // FOMOIBCKIFP — per-shot ProjectileProperties override
uint32_t Hbeak_Angle              = 0x148;  // FFFFKPDHEFP — spawn angle Single
uint32_t Hbeak_InstanceDamage     = 0x174;  // DBNNDLKNECM — per-instance damage Int32
uint32_t Hbeak_SpawnAgeMs         = 0x16C;  // GLEGBLDBOJF — spawn-age ms (path anchoring / expiry)
// NPMECLDKGEF — bool noclip guard. Fallback 0 = unresolved: ProjNoclip must NOT
// install its hook until this resolves non-zero (no reliable static fallback).
uint32_t Hbeak_NoclipGuard        = 0;
uint32_t Hbeak_SpeedMul           = 0;      // KDAJOMOFMJB — 0 = unresolved (speed-mul 1.0)
uint32_t PP_CustomHitbox          = 0x148;  // "CustomHitbox" — ProjectileCustomHitbox* reference
uint32_t PP_IsArmorPiercing       = 0x138;  // "IsArmorPiercing"
uint32_t CH_OffsetX               = 0x10;   // "offsetX" — custom hitbox X offset Single
uint32_t CH_OffsetY               = 0x14;   // "offsetY" — custom hitbox Y offset Single
uint32_t VH_SpriteShader          = 0x60;   // "spriteShader" — SpriteShader on ViewHandler
uint32_t VH_DestroyEntity         = 0x88;   // "destroyEntity" — authoritative entity pointer on ViewHandler

// ── LKHPPBEGNOM facing angle (+0x50 ACTK) ────────────────────────────────
// ECHAFMAAKMD — dump 0x1DC + kActk 0x50 = runtime 0x22C
uint32_t Player_FacingAngle  = 0x22C;

// ── GJJCEFJMNMK throwable entity ─────────────────────────────────────────
// BeeByte decoy names ("GuiCanvasSwitcher", "UpdateRadialValue") preserved
// in IL2CPP metadata; il2cpp_field_get_offset returns runtime-ready values
// (all parent ACTK shifts already baked into the dump layout).
uint32_t Gjj_OriginX    = 0x370;  // ICODPOCLEEL.x (was "GuiCanvasSwitcher" decoy pre-2026-08 build)
uint32_t Gjj_OriginY    = 0x374;  // ICODPOCLEEL.y (= OriginX+4)
uint32_t Gjj_DestX      = 0x370;  // IAJJLFBDJGE.x
uint32_t Gjj_DestY      = 0x374;  // IAJJLFBDJGE.y (= DestX+4)
uint32_t Gjj_DurationMs = 0x388;  // EAICINLCCJK

// ── FHOHCELBPDO visual throwable ─────────────────────────────────────────
// Origin is PosX/PosY (inherited from BMO base). No ACTK shift for LKFFPGONEOB.
uint32_t Fhoh_DurationMs = 0x140; // IEJNJENOCFP
uint32_t Fhoh_DestX      = 0x154; // PBHMINMBFOM.x
uint32_t Fhoh_DestY      = 0x158; // PBHMINMBFOM.y (= DestX+4)

// ── COEFCBBIBMC ShowEffect packet ────────────────────────────────────────
// OODFCLBKDJJ base (network packets have no ACTK shift).
//
// The two positions are NOT inline Vector2s — they are POINTERS to FFLIAABAAFP
// (the WorldPos reference type), so reading floats at these offsets reads the
// halves of a pointer. Deref first, then read x/y at Sfx_WposX / Sfx_WposY.
uint32_t Sfx_EffectType  = 0x10;  // MIDADCIKEBD
uint32_t Sfx_TargetObjId = 0x14;  // HNOKKCFIJHJ
uint32_t Sfx_Pos1Ptr     = 0x18;  // KMAIENKMNFA — FFLIAABAAFP* (source / centre)
uint32_t Sfx_Pos2Ptr     = 0x20;  // AEPOCACMOHI — FFLIAABAAFP* (destination; null for non-THROW)
uint32_t Sfx_Duration    = 0x2C;  // KPKIICOBBIM

// ── FFLIAABAAFP WorldPos (reference type) ────────────────────────────────
// class FFLIAABAAFP : DCBCCBKEIHN { float <x>k__BackingField; float <y>k__BackingField; }
// x/y are auto-property backing fields, whose metadata names ("<XXXX>k__BackingField")
// carry an obfuscated inner name that BeeByte re-rolls every build — the same reason
// GameState.cpp resolves AppMgr_WorldMgr by type instead of by name. So these are
// located STRUCTURALLY (see ResolveWorldPosLayout): the class carries exactly two
// adjacent instance floats, x first. Fallback is the current build's layout
// (object header 0x10 + the 0x10-byte DCBCCBKEIHN base).
uint32_t Sfx_WposX       = 0x20;
uint32_t Sfx_WposY       = 0x24;  // = Sfx_WposX + 4
bool     Sfx_WposResolved = false;  // true once the float pair was located structurally

// ── CustomExplosionEntrance ───────────────────────────────────────────────
uint32_t Cee_Distance    = 0x38;  // "distance" (XML data class, no ACTK)
uint32_t Cee_Speed       = 0x3C;  // "speed" (XML data class, no ACTK)

// ── FieldInfo pointer cache — initialised to nullptr ─────────────────────
FieldInfo* FI_HP               = nullptr;
FieldInfo* FI_MaxHP            = nullptr;
FieldInfo* FI_Defense          = nullptr;
FieldInfo* FI_CurMP            = nullptr;
FieldInfo* FI_MaxMP            = nullptr;
FieldInfo* FI_AbilityReady     = nullptr;  // PPBLNMIMIFP — bool abilityReady
FieldInfo* FI_LocalInvincible  = nullptr;  // BINDBHJLPMG — bool invincible (short-duration hit immunity)
FieldInfo* FI_ObjType          = nullptr;

// ── Internal helpers ──────────────────────────────────────────────────────

static FieldInfo* FindFieldOnHierarchy(Il2CppClass* klass, const char* name)
{
    for (Il2CppClass* k = klass; k; k = il2cpp_class_get_parent(k)) {
        FieldInfo* f = il2cpp_class_get_field_from_name(k, name);
        if (f) return f;
    }
    return nullptr;
}

// Generated targets are current metadata names. Enumerate directly so a target
// that also happens to be an old alias cannot be translated a second time by the
// il2cpp_class_get_field_from_name redirection init_il2cpp installs.
static FieldInfo* FindExactFieldOnHierarchy(Il2CppClass* klass, const char* name)
{
    for (Il2CppClass* k = klass; k; k = il2cpp_class_get_parent(k)) {
        void* iter = nullptr;
        while (FieldInfo* field = il2cpp_class_get_fields(k, &iter))
            if (strcmp(il2cpp_field_get_name(field), name) == 0) return field;
    }
    return nullptr;
}

// ── FFLIAABAAFP (WorldPos) x/y — resolved by SHAPE, not by name ────────────
// Its x/y are auto-property backing fields, so their metadata names embed an
// obfuscated inner name ("<CHOGDNLDCMD>k__BackingField") that BeeByte re-rolls
// every build; name resolution would silently fall back forever. The SHAPE is
// stable and unambiguous instead: the class declares exactly two instance
// floats, adjacent, x first. Anything else and we leave Sfx_WposResolved false
// so callers (AoeTracking's ShowEffect hook) fail closed rather than stamping
// garbage AoE discs into a system that now hard-blocks routing.
// Called once per frame from EnsureAll. Latches as soon as the class is seen
// (match or not) so a shape mismatch cannot spam the log, and gives up on the
// class lookup itself after a bounded number of frames so a renamed class does
// not cost a full metadata scan every frame forever.
static bool s_wposSettled = false;
static void ResolveWorldPosLayout()
{
    if (s_wposSettled) return;

    static int s_wposTries = 0;
    constexpr int kWposMaxTries = 600;   // ~10 s at 60 fps, matching the table's give-up spirit
    if (++s_wposTries > kWposMaxTries) {
        s_wposSettled = true;
        DBG_FILE_LOG("[RuntimeOffsets] FFLIAABAAFP (WorldPos) never appeared — ShowEffect "
            "positions stay UNTRUSTED (AoE ShowEffect hook will not install)");
        return;
    }

    Il2CppClass* klass = Resolver::FindClassLoose("FFLIAABAAFP");
    if (!klass) return;
    s_wposSettled = true;   // class found: this pass decides, match or not

    constexpr int kFieldAttrStatic = 0x0010;
    uint32_t offs[4] = {};
    int      n       = 0;
    void*      iter = nullptr;
    FieldInfo* f    = nullptr;
    while ((f = il2cpp_class_get_fields(klass, &iter)) != nullptr) {
        if (il2cpp_field_is_literal(f)) continue;
        if (il2cpp_field_get_flags(f) & kFieldAttrStatic) continue;
        const Il2CppType* ft = il2cpp_field_get_type(f);
        if (!ft || il2cpp_type_get_type(ft) != IL2CPP_TYPE_R4) continue;
        if (n < 4) offs[n] = static_cast<uint32_t>(il2cpp_field_get_offset(f));
        ++n;
    }

    // Exactly one adjacent float pair, or we do not know which fields these are.
    if (n != 2) {
        DBG_FILE_LOG("[RuntimeOffsets] FFLIAABAAFP WorldPos: expected 2 instance floats, saw "
            << n << " — keeping fallback 0x" << std::hex << Sfx_WposX << std::dec
            << " and leaving ShowEffect positions UNTRUSTED");
        return;
    }
    const uint32_t lo = offs[0] < offs[1] ? offs[0] : offs[1];
    const uint32_t hi = offs[0] < offs[1] ? offs[1] : offs[0];
    if (hi != lo + 4) {
        DBG_FILE_LOG("[RuntimeOffsets] FFLIAABAAFP WorldPos: floats not adjacent (0x"
            << std::hex << lo << ", 0x" << hi << std::dec
            << ") — leaving ShowEffect positions UNTRUSTED");
        return;
    }

    Sfx_WposX        = lo;
    Sfx_WposY        = lo + 4;
    Sfx_WposResolved = true;
    DBG_FILE_LOG("[RuntimeOffsets] FFLIAABAAFP WorldPos x/y resolved -> 0x"
        << std::hex << Sfx_WposX << "/0x" << Sfx_WposY << std::dec);
}

// ── Resolution table ─────────────────────────────────────────────────────
//
// ┌─ UPDATE THIS EACH GAME PATCH ───────────────────────────────────────────┐
// │ BeeByte re-randomizes class/field NAMES (and sometimes offsets) every    │
// │ Exalt build, so name-resolution silently fails and these fallbacks are   │
// │ used stale. To find what broke after a patch:                            │
// │   1. Build + in-game open  Test tab → OFFSET HEALTH.  Stale offsets show  │
// │      yellow (STALE renamed / no-class) or red (SUSPECT = read garbage).   │
// │   2. From a fresh Il2CppInspector dump of the new build, get the new      │
// │      obfuscated class + field name AND the offset for each flagged row.   │
// │   3. Update that row here: the className, the tryNames[] (put the NEW     │
// │      name first; old names can stay as extra candidates), and the         │
// │      `outPtr` variable's fallback initializer above (lines ~20-193).      │
// │ A row resolves automatically once its className+fieldName match metadata; │
// │ the fallback only bites when the NAME is wrong. So fixing the NAME is     │
// │ usually enough — the offset then comes live from il2cpp_field_get_offset. │
// │ CRITICAL rows (verify first): HP/MaxHP/Defense (LKHPPBEGNOM) and          │
// │ Hbeak_InstanceDamage (HBEAKBIHANL) — these feed AutoNexus damage calc.    │
// └─────────────────────────────────────────────────────────────────────────┘
//
// Each Entry:
//   className  — passed to Resolver::FindClassLoose
//   tryNames   — candidate field names tried in order (up to 4)
//   tryCount   — how many names to try
//   actkShift  — added to il2cpp_field_get_offset result (0 or 0x50)
//   outPtr     — pointer to the uint32_t to update
//   done       — set to true once class was found (even if field wasn't)

static constexpr uint32_t kActk = 0x50u;

struct Entry {
    const char* className;
    const char* tryNames[4];
    int         tryCount;
    uint32_t    actkShift;
    uint32_t*   outPtr;
    bool        done;
    const char* key;   // BuildBindings::FieldBinding::entry; always the outPtr variable's name
};

static Entry s_entries[] = {

    // ── KJMONHENJEN (no shift) ────────────────────────────────────────────
    { "KJMONHENJEN", { "CLFEOFKBNEJ" },                              1, 0,     &PosX,           false, "PosX" },
    { "KJMONHENJEN", { "PKEECFNFEIO" },                              1, 0,     &PosY,           false, "PosY" },
    { "KJMONHENJEN", { "HFDNHJFNEKA" },                              1, 0,     &ObjType,        false, "ObjType" },
    { "KJMONHENJEN", { "OBAKMCCDBJA" },                              1, 0,     &ObjProps,       false, "ObjProps" },
    { "KJMONHENJEN", { "MPGOFIHIDML" },                              1, 0,     &KJ_ViewHandler, false, "KJ_ViewHandler" },
    { "KJMONHENJEN", { "LGDCEJKHGFJ" },                              1, 0,     &KJ_SkinWidthObj,false, "KJ_SkinWidthObj" },
    { "KJMONHENJEN", { "HHPOJBFICAH" },                              1, 0,     &ObjId,          false, "ObjId" },
    { "KJMONHENJEN", { "IOKKOCEAJNA" },                              1, 0,     &KJ_BaseRadius,  false, "KJ_BaseRadius" },
    { "KJMONHENJEN", { "KEDBLBJIKCB" },                              1, 0,     &KJ_Scale,       false, "KJ_Scale" },
    { "KJMONHENJEN", { "DGNPJNFGFPE" },                              1, 0,     &KJ_Float3Pos,   false, "KJ_Float3Pos" },
    { "KJMONHENJEN", { "EOKJOGFPLOA" },                              1, 0,     &KJ_TileRef,     false, "KJ_TileRef" },
    { "KJMONHENJEN", { "FDNHINDAEHK" },                              1, 0,     &KJ_DictObjectId,false, "KJ_DictObjectId" },

    // ── LKHPPBEGNOM (+0x50 ACTK for own fields) ───────────────────────────
    { "LKHPPBEGNOM", { "KJNHLADHEMH", "KJNHLADEMH" },               2, kActk, &HP,            false, "HP" },
    { "LKHPPBEGNOM", { "NCBIICBDGAG" },                              1, kActk, &MaxHP,         false, "MaxHP" },
    { "LKHPPBEGNOM", { "HODJPKFINKF" },                              1, kActk, &Defense,       false, "Defense" },
    { "LKHPPBEGNOM", { "DPGEBOCBKEF" },                              1, 0,     &PlayerIGN,     false, "PlayerIGN" },
    { "LKHPPBEGNOM", { "COHCKAPOLCA" },                           1, kActk, &MoConditions,  false, "MoConditions" },
    { "LKHPPBEGNOM", { "ECGPFJKCCAN" },                           1, kActk, &MoVelocity,    false, "MoVelocity" },
    { "LKHPPBEGNOM", { "KKENJFFDMPO" },                           1, 0,     &MoObjectProps, false, "MoObjectProps" },
    { "LKHPPBEGNOM", { "GGBCADDBAPN" },                           1, 0,     &PlayerCollisionProps, false, "PlayerCollisionProps" },

    // ── FKALGHJIADI (+0x50 ACTK for own fields) ───────────────────────────
    { "FKALGHJIADI", { "HCMECDPHEMC" },                              1, kActk, &Tex1,          false, "Tex1" },
    { "FKALGHJIADI", { "HKPOMIBEGPK" },                              1, kActk, &Tex2,          false, "Tex2" },
    { "FKALGHJIADI", { "FMHMGKEPIDN" },                              1, kActk, &CurMP,              false, "CurMP" },
    { "FKALGHJIADI", { "NEDCKPIIIPN" },                              1, kActk, &MaxMP,              false, "MaxMP" },
    // DAGEMHFLJLK = groundDamageImmune (dump 0x458 / runtime 0x4A8)
    // This doesn't seem to work. I do not believe this is labeled correctly.
    { "FKALGHJIADI", { "DAGEMHFLJLK" },                              1, kActk, &GroundDmgImmune,    false, "GroundDmgImmune" },
    // BINDBHJLPMG = invincible bool (dump 0x459 / runtime 0x4A9) — per FKALGHJIADI_mapped.txt
    { "FKALGHJIADI", { "BINDBHJLPMG" },                              1, kActk, &LocalInvincible,    false, "LocalInvincible" },
    // PPBLNMIMIFP = abilityReady bool (dump 0x515 / runtime 0x565) — the correct ability gate
    { "FKALGHJIADI", { "PPBLNMIMIFP" },                              1, kActk, &AbilityReady,       false, "AbilityReady" },
    // CGCMALPMMJL = bool moving (dump 0x448 / runtime 0x498)
    { "FKALGHJIADI", { "CGCMALPMMJL" },                              1, kActk, &Player_Moving,      false, "Player_Moving" },
    // BHJFNEAHAOE = float moveDirX (dump 0x478 / runtime 0x4C8)
    { "FKALGHJIADI", { "BHJFNEAHAOE" },                              1, kActk, &Player_MoveDirX,    false, "Player_MoveDirX" },
    // GDNEBFDDDKM = float moveDirY (dump 0x47C / runtime 0x4CC)
    { "FKALGHJIADI", { "GDNEBFDDDKM" },                              1, kActk, &Player_MoveDirY,    false, "Player_MoveDirY" },

    // ── FKALGHJIADI player diagnostic stats (no ACTK shift) ──────────────
    // These resolve the same fields as above but WITHOUT the kActk shift,
    // producing the dump offset used by PlayerTAB for stat display. Some
    // share BeeByte names with movement entries (e.g. HCMECDPHEMC = Tex1/ATK,
    // BHJFNEAHAOE = MoveDirX/SPD, GDNEBFDDDKM = MoveDirY/DEX).
    { "FKALGHJIADI", { "NFJGJKLPLBA" },                              1, 0,     &PlayerGuildName,    false, "PlayerGuildName" },
    { "FKALGHJIADI", { "KABPJBJPGCM" },                              1, 0,     &PlayerClassNum,     false, "PlayerClassNum" },
    { "FKALGHJIADI", { "GBANOMPLGBH" },                              1, 0,     &PlayerGuildRank,    false, "PlayerGuildRank" },
    { "FKALGHJIADI", { "HCMECDPHEMC" },                              1, 0,     &PlayerAtk,          false, "PlayerAtk" },
    { "FKALGHJIADI", { "GDNEBFDDDKM" },                              1, 0,     &PlayerDex,          false, "PlayerDex" },
    { "FKALGHJIADI", { "CGFPEPCKKOK" },                              1, 0,     &PlayerVit,          false, "PlayerVit" },
    { "FKALGHJIADI", { "HDCDGHKGLDI" },                              1, 0,     &PlayerWis,          false, "PlayerWis" },
    { "FKALGHJIADI", { "MPJGAPJBBBF" },                              1, 0,     &PlayerCondInt,      false, "PlayerCondInt" },
    { "FKALGHJIADI", { "AJJJBDBNBLM" },                              1, 0,     &PlayerEquipMgr,     false, "PlayerEquipMgr" },

    // ── CameraManager (no shift — component fields) ────────────────────────
    { "CameraManager", { "mainCameraContainer" },                        1, 0,     &CM_Transform,  false, "CM_Transform" },
    { "CameraManager", { "KNAIAEFDCLM" },                                1, 0,     &CM_UnityCam,   false, "CM_UnityCam" },

    // ── EquipmentManager / ItemSlot (namespaced UI classes, no shift) ─────
    { "EquipmentManager", { "equipmentSlots" },                      1, 0,     &EM_EquipSlots, false, "EM_EquipSlots" },
    { "ItemSlot",         { "HLJFBHLMANJ" },                         1, 0,     &Item_ObjProps, false, "Item_ObjProps" },
    { "ItemSlot",         { "INAAIAHOEFE" },                         1, 0,     &Item_ObjType,  false, "Item_ObjType" },

    // ── HJMBOMEHGDJ WorldManager (no shift) ──────────────────────────────
    { "HJMBOMEHGDJ", { "OCLNLBHDEFK" },                              1, 0,     &WM_Local,      false, "WM_Local" },
    { "HJMBOMEHGDJ", { "DFALIKKKGLI" },                              1, 0,     &WM_AllDict,    false, "WM_AllDict" },
    { "HJMBOMEHGDJ", { "KHIHFNACEKJ" },                              1, 0,     &WM_MapDictA,   false, "WM_MapDictA" },
    { "HJMBOMEHGDJ", { "CIOIHEOEAEB" },                              1, 0,     &WM_MapDictB,   false, "WM_MapDictB" },
    { "HJMBOMEHGDJ", { "ONABHKFOJNE" },                              1, 0,     &WM_KjmonList,  false, "WM_KjmonList" },
    { "HJMBOMEHGDJ", { "NOJEHIAOAJM" },                              1, 0,     &WM_TileArr,    false, "WM_TileArr" },
    { "HJMBOMEHGDJ", { "IMAOBDCMPHC" },                              1, 0,     &WM_TileList,   false, "WM_TileList" },
    { "HJMBOMEHGDJ", { "FIAJOKGHGGK" },                              1, 0,     &WM_TickId,     false, "WM_TickId" },
    { "HJMBOMEHGDJ", { "HOMNPDGNOMO" },                              1, 0,     &WM_TickId2,    false, "WM_TickId2" },

    // ── BGAIOPJMHLO tile instance (no shift) ─────────────────────────────
    { "BGAIOPJMHLO", { "CLFEOFKBNEJ" },                              1, 0,     &TileX,         false, "TileX" },
    { "BGAIOPJMHLO", { "PKEECFNFEIO" },                              1, 0,     &TileY,         false, "TileY" },
    { "BGAIOPJMHLO", { "JOFEAFJPJEM" },                              1, 0,     &TileType,      false, "TileType" },
    { "BGAIOPJMHLO", { "KEOKJCIJIAD" },                              1, 0,     &TileProps,     false, "TileProps" },
    { "BGAIOPJMHLO", { "EBCLNFDKKEH" },                              1, 0,     &Sq_Layer,      false, "Sq_Layer" },
    { "BGAIOPJMHLO", { "EAPMKCKMNDI" },                              1, 0,     &Sq_DamageCached,false, "Sq_DamageCached" },
    { "BGAIOPJMHLO", { "JGMBPFJEGAH" },                              1, 0,     &Sq_Cover,      false, "Sq_Cover" },

    // ── CMFPKCJHKKB XmlTileProperties (no shift) ─────────────────────────
    { "CMFPKCJHKKB", { "MFEJMAABLIL" },                              1, 0,     &TP_Speed,      false, "TP_Speed" },
    { "CMFPKCJHKKB", { "BMGKCKHOIOH" },                              1, 0,     &TP_Sink,       false, "TP_Sink" },
    { "CMFPKCJHKKB", { "LFKLKFIEMAH" },                              1, 0,     &TP_NoWalk,     false, "TP_NoWalk" },
    { "CMFPKCJHKKB", { "MCMDAGNIGEB" },                              1, 0,     &TP_MinDmg,     false, "TP_MinDmg" },
    { "CMFPKCJHKKB", { "KHMCMAHEBNG" },                              1, 0,     &TP_MaxDmg,     false, "TP_MaxDmg" },
    { "CMFPKCJHKKB", { "FNCCEGBHNKG" },                              1, 0,     &TP_Push,       false, "TP_Push" },
    { "CMFPKCJHKKB", { "LCHPDCNHJCA" },                              1, 0,     &TP_Alpha,      false, "TP_Alpha" },
    { "CMFPKCJHKKB", { "JKIDGAADOLC" },                              1, 0,     &TP_Sinking,    false, "TP_Sinking" },

    // ── ObjectProperties (real names, no shift) ───────────────────────────
    { "ObjectProperties", { "id" },                                  1, 0,     &OP_IdStr,          false, "OP_IdStr" },
    { "ObjectProperties", { "NoCoverElement" },                      1, 0,     &OP_NoCover,        false, "OP_NoCover" },
    // InvincibleElement — XML <Invincible/> string; non-null = permanently invincible.
    { "ObjectProperties", { "InvincibleElement" },                   1, 0,     &OP_InvincibleElem, false, "OP_InvincibleElem" },
    { "ObjectProperties", { "NoWallTextureRepeatElement",
                             "NoWallTextureRepeat" },                2, 0,     &OP_NoWallRpt,      false, "OP_NoWallRpt" },
    { "ObjectProperties", { "occupySquare" },                        1, 0,     &OP_OccupySq,       false, "OP_OccupySq" },
    { "ObjectProperties", { "fullOccupy" },                          1, 0,     &OP_FullOcc,        false, "OP_FullOcc" },
    { "ObjectProperties", { "enemyOccupySquare" },                   1, 0,     &OP_EnemyOcc,       false, "OP_EnemyOcc" },
    { "ObjectProperties", { "isEnemy" },                             1, 0,     &OP_IsEnemy,        false, "OP_IsEnemy" },
    { "ObjectProperties", { "isStatic" },                            1, 0,     &OP_IsStatic,       false, "OP_IsStatic" },
    { "ObjectProperties", { "blockProjectiles" },                    1, 0,     &OP_BlockProj,      false, "OP_BlockProj" },
    // noHealthBar — true when entity type has no visible HP bar; must not be targeted.
    { "ObjectProperties", { "noHealthBar" },                         1, 0,     &OP_NoHealthBar,    false, "OP_NoHealthBar" },
    { "ObjectProperties", { "protectFromGroundDamage",
                             "ProtectFromGroundDamage" },            2, 0,     &OP_ProtGnd,        false, "OP_ProtGnd" },
    { "ObjectProperties", { "protectFromSink",
                             "ProtectFromSink" },                    2, 0,     &OP_ProtSink,       false, "OP_ProtSink" },
    { "ObjectProperties", { "flying" },                              1, 0,     &OP_Flying,         false, "OP_Flying" },
    { "ObjectProperties", { "connectType" },                         1, 0,     &OP_ConnectT,       false, "OP_ConnectT" },
    { "ObjectProperties", { "Projectiles", "projectiles" },          2, 0,     &OP_Projectiles,    false, "OP_Projectiles" },
    { "ObjectProperties", { "collisionRadiusMultiplier" },           1, 0,     &OP_CollRadiusMult, false, "OP_CollRadiusMult" },

    // ── ProjectileProperties (real names, no shift) ───────────────────────
    { "ProjectileProperties", { "Lifetime",   "lifetime" },          2, 0,     &PP_Lifetime,        false, "PP_Lifetime" },
    { "ProjectileProperties", { "ProjectileSpeed", "Speed" },        2, 0,     &PP_Speed,           false, "PP_Speed" },
    { "ProjectileProperties", { "IsWavy",     "Wavy" },              2, 0,     &PP_IsWavy,          false, "PP_IsWavy" },
    { "ProjectileProperties", { "IsBoomerang","Boomerang" },         2, 0,     &PP_IsBoomerang,     false, "PP_IsBoomerang" },
    { "ProjectileProperties", { "IsParametric","Parametric" },       2, 0,     &PP_IsParametric,    false, "PP_IsParametric" },
    { "ProjectileProperties", { "HasCustomHitbox","CustomHitbox" },  2, 0,     &PP_HasCustomHitbox, false, "PP_HasCustomHitbox" },
    { "ProjectileProperties", { "LaserDistance","laserDistance" },   2, 0,     &PP_LaserDist,       false, "PP_LaserDist" },
    { "ProjectileProperties", { "SpeedClampValue", "speedClampValue",
                                 "SpeedClamp", "speedClamp" },        4, 0,     &PP_SpeedClamp,      false, "PP_SpeedClamp" },
    { "ProjectileProperties", { "AccelerationDelayValue", "accelerationDelayValue",
                                 "AccelDelay", "accelDelay" },        4, 0,     &PP_AccelDelay,      false, "PP_AccelDelay" },
    { "ProjectileProperties", { "AccelerationValue", "accelerationValue",
                                 "Acceleration", "acceleration" },    4, 0,     &PP_Acceleration,    false, "PP_Acceleration" },
    { "ProjectileProperties", { "IsAccelerating", "isAccelerating" }, 2, 0, &PP_IsAccel,  false, "PP_IsAccel" },
    // UseAcceleration is the per-shot enable, NOT an alias for IsAccelerating.
    // Keep separate so cached game-authored projectile paths receive correct props.
    { "ProjectileProperties", { "UseAcceleration", "useAcceleration" }, 2, 0, &PP_UseAccel, false, "PP_UseAccel" },
    { "ProjectileProperties", { "AccelerationInv", "accelerationInv" },   2, 0,     &PP_AccelerationInv, false, "PP_AccelerationInv" },
    { "ProjectileProperties", { "VelocityChangeRate", "velocityChangeRate" }, 2, 0, &PP_VelocityChangeRate, false, "PP_VelocityChangeRate" },
    { "ProjectileProperties", { "VelocityChangeRateInv", "velocityChangeRateInv" }, 2, 0, &PP_VelocityChangeRateInv, false, "PP_VelocityChangeRateInv" },
    { "ProjectileProperties", { "ProjectileMagnitude", "Magnitude",  "magnitude" },  3, 0, &PP_Magnitude,       false, "PP_Magnitude" },
    { "ProjectileProperties", { "ProjectileFrequency", "Frequency",  "frequency" },  3, 0, &PP_Frequency,       false, "PP_Frequency" },
    { "ProjectileProperties", { "ProjectileAmplitude", "Amplitude",  "amplitude" },  3, 0, &PP_Amplitude,       false, "PP_Amplitude" },
    { "ProjectileProperties", { "IsAmplitudeApplied", "HasCustomAmplitude","CustomAmplitude","customAmplitude" }, 4, 0, &PP_HasCustomAmplitude, false, "PP_HasCustomAmplitude" },
    { "ProjectileProperties", { "CollisionMult","collisionMult",
                                 "ConditionEffectAmount" },          3, 0,     &PP_CollMult,        false, "PP_CollMult" },
    { "ProjectileProperties", { "ProjectileTurnRate", "TurnRate","turnRate"},     3, 0, &PP_TurnRate,        false, "PP_TurnRate" },
    { "ProjectileProperties", { "ProjectileTurnRateDelay","TurnRateDelay" },     2, 0, &PP_TurnRateDelay,   false, "PP_TurnRateDelay" },
    { "ProjectileProperties", { "ProjectileTurnStopTime", "TurnStopTime" },      2, 0, &PP_TurnStopTime,    false, "PP_TurnStopTime" },
    { "ProjectileProperties", { "ProjectileCircleTurnAngle","CircleTurnAngle" }, 2, 0, &PP_CircleTurnAngle, false, "PP_CircleTurnAngle" },
    { "ProjectileProperties", { "ProjectileCircleTurnDelay","CircleTurnDelay" }, 2, 0, &PP_CircleTurnDelay, false, "PP_CircleTurnDelay" },
    { "ProjectileProperties", { "ProjectileTurnAcceleration", "TurnAcceleration","turnAcceleration" },       3, 0, &PP_TurnAcceleration,false, "PP_TurnAcceleration" },
    { "ProjectileProperties", { "ProjectileTurnAccelerationDelay", "TurnAccelerationDelay","turnAccelerationDelay"}, 3, 0, &PP_TurnAccelDelay,  false, "PP_TurnAccelDelay" },
    { "ProjectileProperties", { "TurnClamp","turnClamp","ProjectileTurnClamp" }, 3, 0, &PP_TurnClamp,       false, "PP_TurnClamp" },
    { "ProjectileProperties", { "TurnAccelerationInv","turnAccelerationInv" },   2, 0, &PP_TurnAccelInv,    false, "PP_TurnAccelInv" },
    { "ProjectileProperties", { "IsTurning",  "isTurning","Turning"},            3, 0, &PP_IsTurning,       false, "PP_IsTurning" },
    { "ProjectileProperties", { "IsTurningDelayed","isTurningDelayed" },         2, 0, &PP_IsTurningDelayed,false, "PP_IsTurningDelayed" },

    // ── HBEAKBIHANL projectile instance (no shift) ───────────────────────────
    { "HBEAKBIHANL", { "HHFDCMIIIHF", "projRadius" },                            2, 0, &Hbeak_ProjRadius,      false, "Hbeak_ProjRadius" },
    { "HBEAKBIHANL", { "FOMOIBCKIFP" },                                           1, 0, &Hbeak_ProjPropsPtr,    false, "Hbeak_ProjPropsPtr" },
    { "HBEAKBIHANL", { "FFFFKPDHEFP" },                                           1, 0, &Hbeak_Angle,           false, "Hbeak_Angle" },
    { "HBEAKBIHANL", { "DBNNDLKNECM" },                                           1, 0, &Hbeak_InstanceDamage,  false, "Hbeak_InstanceDamage" },
    { "HBEAKBIHANL", { "GLEGBLDBOJF" },                                           1, 0, &Hbeak_SpawnAgeMs,      false, "Hbeak_SpawnAgeMs" },
    { "HBEAKBIHANL", { "KDAJOMOFMJB" },                                           1, 0, &Hbeak_SpeedMul,        false, "Hbeak_SpeedMul" },

    // ── HBEAKBIHANL noclip guard (no shift) ──────────────────────────────────
    // Fallback 0 = unresolved: ProjNoclip refuses to install its hook until this
    // resolves non-zero from live metadata (no reliable static fallback exists).
    { "HBEAKBIHANL", { "NPMECLDKGEF" },                                           1, 0, &Hbeak_NoclipGuard,     false, "Hbeak_NoclipGuard" },

    // ── ProjectileProperties continued ────────────────────────────────────────
    { "ProjectileProperties", { "CustomHitbox", "customHitbox" },                 2, 0, &PP_CustomHitbox,       false, "PP_CustomHitbox" },
    { "ProjectileProperties", { "IsArmorPiercing", "armorPiercing" },             2, 0, &PP_IsArmorPiercing,    false, "PP_IsArmorPiercing" },

    // ── ProjectileCustomHitbox (real names, no shift) ──────────────────────────
    { "ProjectileCustomHitbox", { "offsetX" },                                    1, 0, &CH_OffsetX,            false, "CH_OffsetX" },
    { "ProjectileCustomHitbox", { "offsetY" },                                    1, 0, &CH_OffsetY,            false, "CH_OffsetY" },

    // ── ViewHandler (real names, no shift) ─────────────────────────────────────
    { "ViewHandler", { "spriteShader" },                                          1, 0, &VH_SpriteShader,       false, "VH_SpriteShader" },
    { "ViewHandler", { "destroyEntity" },                                        1, 0, &VH_DestroyEntity,      false, "VH_DestroyEntity" },

    // ── LKHPPBEGNOM facing angle (+0x50 ACTK) ────────────────────────────────
    // ECHAFMAAKMD (dump 0x1DC + kActk = 0x22C runtime). Written by SendShotPacketDetour.
    { "LKHPPBEGNOM", { "ECHAFMAAKMD" },                                           1, kActk, &Player_FacingAngle, false, "Player_FacingAngle" },

    // ── GJJCEFJMNMK throwable entity (no extra shift — runtime offsets in dump) ──
    // "GuiCanvasSwitcher" and "IAJJLFBDJGE" are BeeByte field names for origin/dest Vector2.
    // ACTK shift from LKHPPBEGNOM parent is already reflected in the dump layout.
    { "GJJCEFJMNMK", { "ICODPOCLEEL", "GuiCanvasSwitcher" },                      2, 0, &Gjj_OriginX,   false, "Gjj_OriginX" },
    { "GJJCEFJMNMK", { "IAJJLFBDJGE" },                                           1, 0, &Gjj_DestX,     false, "Gjj_DestX" },
    { "GJJCEFJMNMK", { "EAICINLCCJK" },                                           1, 0, &Gjj_DurationMs,false, "Gjj_DurationMs" },

    // ── FHOHCELBPDO visual throwable (LKFFPGONEOB base, no ACTK shift) ─────────
    { "FHOHCELBPDO", { "IEJNJENOCFP" },                                           1, 0, &Fhoh_DurationMs,false, "Fhoh_DurationMs" },
    { "FHOHCELBPDO", { "PBHMINMBFOM" },                                           1, 0, &Fhoh_DestX,    false, "Fhoh_DestX" },

    // ── COEFCBBIBMC ShowEffect packet (OODFCLBKDJJ base, no ACTK shift) ─────────
    { "COEFCBBIBMC", { "MIDADCIKEBD" },                                           1, 0, &Sfx_EffectType, false, "Sfx_EffectType" },
    { "COEFCBBIBMC", { "HNOKKCFIJHJ" },                                           1, 0, &Sfx_TargetObjId,false, "Sfx_TargetObjId" },
    { "COEFCBBIBMC", { "KMAIENKMNFA" },                                           1, 0, &Sfx_Pos1Ptr,   false, "Sfx_Pos1Ptr" },
    { "COEFCBBIBMC", { "AEPOCACMOHI" },                                           1, 0, &Sfx_Pos2Ptr,   false, "Sfx_Pos2Ptr" },
    { "COEFCBBIBMC", { "KPKIICOBBIM" },                                           1, 0, &Sfx_Duration,  false, "Sfx_Duration" },

    // ── CustomExplosionEntrance (real XML field names, no shift) ─────────────────
    { "CustomExplosionEntrance", { "distance" },                                  1, 0, &Cee_Distance,  false, "Cee_Distance" },
    { "CustomExplosionEntrance", { "speed" },                                     1, 0, &Cee_Speed,     false, "Cee_Speed" },
};

static constexpr int kEntryCount = static_cast<int>(sizeof(s_entries) / sizeof(s_entries[0]));

// ── FieldInfo resolution table ────────────────────────────────────────────
// Separate from s_entries so we keep the offset table untouched.
// Populated once; used by ReadField<T> for type-correct dynamic reads.

struct FieldInfoEntry {
    const char* className;
    const char* fieldName;
    FieldInfo** out;
    bool        done;
};

static FieldInfoEntry s_fieldInfoEntries[] = {
    { "LKHPPBEGNOM", "KJNHLADHEMH", &FI_HP,                 false },
    { "LKHPPBEGNOM", "NCBIICBDGAG", &FI_MaxHP,              false },
    { "LKHPPBEGNOM", "HODJPKFINKF", &FI_Defense,            false },
    { "FKALGHJIADI", "FMHMGKEPIDN", &FI_CurMP,              false },
    { "FKALGHJIADI", "NEDCKPIIIPN", &FI_MaxMP,              false },
    // PPBLNMIMIFP = bool abilityReady (dump 0x515 / runtime 0x565)
    { "FKALGHJIADI", "PPBLNMIMIFP", &FI_AbilityReady,       false },
    // BINDBHJLPMG = bool invincible (dump 0x459 / runtime 0x4A9) — short-duration hit immunity
    { "FKALGHJIADI", "BINDBHJLPMG", &FI_LocalInvincible,    false },
    { "KJMONHENJEN", "HFDNHJFNEKA", &FI_ObjType,            false },
};
static constexpr int kFIEntryCount =
    static_cast<int>(sizeof(s_fieldInfoEntries) / sizeof(s_fieldInfoEntries[0]));

// ── EnsureAll ─────────────────────────────────────────────────────────────
//
// Called once per frame.  Iterates the table and attempts to resolve any
// entry whose class is now available in IL2CPP metadata.
// Resolved (or permanently-failed) entries are skipped on future calls.
//
// Perf notes:
//   - s_allDone: skips the entire loop once every entry is settled.
//   - Class-name dedup: entries are grouped by class, so we cache the last
//     FindClassLoose result and reuse it for consecutive same-class entries
//     instead of calling FindClassLoose once per entry.
//   - Rename timeout: if a class is still missing 5 s after first call, we
//     mark its entries done (accepting fallbacks) so we stop scanning metadata
//     every frame for a name that BeeByte has likely renamed.

// Atomic: EnsureAll and its readers run on the render thread and the game-update thread.
static std::atomic<bool> s_allDone{ false };
static std::atomic<bool> s_giveUpFired{ false };
static char      s_unresolvedClassNames[512] = {};
static ULONGLONG s_firstCallTick       = 0;
static constexpr ULONGLONG kGiveUpMs   = 5000ULL;

bool HasGivenUp() { return s_giveUpFired; }
bool AllResolved() { return s_allDone; }

const char* GetUnresolvedClassNames()  { return s_unresolvedClassNames; }

// ── Offset health status (parallel to s_entries) ─────────────────────────────
static OffsetState s_entryState[kEntryCount];     // OffsetState::Pending (0) by default
static uint32_t    s_entryFallback[kEntryCount];  // snapshot of each initial fallback
static bool        s_fallbackSnapped = false;
// Set when a live offset disagreed with the entry's binding, so the failure log can
// give both values; a Suspect set by a sanity check leaves it false.
static bool        s_entryDisagreed[kEntryCount];
static uint32_t    s_entryLiveOffset[kEntryCount];

int GetOffsetReport(OffsetReportRow* out, int maxRows)
{
    if (out) {
        for (int i = 0; i < kEntryCount && i < maxRows; ++i) {
            OffsetReportRow& r = out[i];
            r.className = s_entries[i].className;
            r.fieldName = s_entries[i].tryCount ? s_entries[i].tryNames[0] : "?";
            r.fallback  = s_fallbackSnapped ? s_entryFallback[i] : *s_entries[i].outPtr;
            r.value     = *s_entries[i].outPtr;
            r.state     = s_entryState[i];
        }
    }
    return kEntryCount;
}

void GetOffsetSummary(int& resolved, int& usingFallback, int& suspect, int& pending)
{
    resolved = usingFallback = suspect = pending = 0;
    for (int i = 0; i < kEntryCount; ++i) {
        switch (s_entryState[i]) {
            case OffsetState::ResolvedMatch:
            case OffsetState::ResolvedShifted:   ++resolved;      break;
            case OffsetState::FallbackFieldName:
            case OffsetState::FallbackGaveUp:    ++usingFallback; break;
            case OffsetState::Suspect:           ++suspect;       break;
            default:                             ++pending;       break;
        }
    }
}

void MarkSuspect(const uint32_t* offsetVar)
{
    for (int i = 0; i < kEntryCount; ++i)
        if (s_entries[i].outPtr == offsetVar) { s_entryState[i] = OffsetState::Suspect; return; }
}

OffsetState GetOffsetStateFor(const uint32_t* offsetVar)
{
    for (int i = 0; i < kEntryCount; ++i)
        if (s_entries[i].outPtr == offsetVar) return s_entryState[i];
    return OffsetState::Pending;
}

bool IsFieldWriteTrusted(const uint32_t* offsetVar)
{
    const OffsetState st = GetOffsetStateFor(offsetVar);
    return st == OffsetState::ResolvedMatch || st == OffsetState::ResolvedShifted;
}

// Conservative bounds — only values a CORRECT offset can never produce, so a
// legitimate edge state (0 def, huge-HP boss pet, etc.) is not false-flagged.
void SanityCheckPlayerStats(int32_t hp, int32_t maxHp, int32_t defense)
{
    // Player not loaded yet (char-select / between worlds): all-zero is "not
    // populated", not a stale offset — a stale offset reads WILD values, not clean
    // zeros. Skip so we don't falsely flag MaxHP at char-select.
    if (hp == 0 && maxHp == 0 && defense == 0) return;
    if (maxHp <= 0 || maxHp > 1000000) MarkSuspect(&MaxHP);
    if (hp < -1000 || (maxHp > 0 && maxHp <= 1000000 && hp > maxHp * 5)) MarkSuspect(&HP);
    if (defense < 0 || defense > 2000) MarkSuspect(&Defense);
}

void SanityCheckProjDamage(int32_t sampledDamage)
{
    if (sampledDamage < 0 || sampledDamage > 1000000) MarkSuspect(&Hbeak_InstanceDamage);
}

// A method row names its owner by short name, and short names are not unique: in
// build 86ad651b "Time" is both UnityEngine.Time and InputManagerProvider.Time, and
// "Component" is both UnityEngine.Component and System.ComponentModel.Component.
// FindClassLoose returns whichever class il2cpp_class_for_each reports first, so the
// row is proved when any class of that name declares the method at the bound
// address. The address is unique; the scan cannot accept a different method.
static bool BoundMethodLive(const BuildBindings::MethodBinding& row)
{
    struct Ctx { const BuildBindings::MethodBinding* row; uintptr_t expected; bool found; };
    Ctx ctx{ &row, reinterpret_cast<uintptr_t>(GetModuleHandleW(L"GameAssembly.dll")) + row.rva, false };
    il2cpp_class_for_each([](Il2CppClass* klass, void* ud) {
        auto* c = static_cast<Ctx*>(ud);
        if (c->found || strcmp(il2cpp_class_get_name(klass), c->row->targetOwner) != 0) return;
        const MethodInfo* method = il2cpp_class_get_method_from_name(klass, c->row->source, c->row->args);
        c->found = method && reinterpret_cast<uintptr_t>(method->methodPointer) == c->expected;
    }, &ctx);
    return ctx.found;
}

// ── Method lookup authentication ──────────────────────────────────────────
// init_il2cpp reports whether it installed BoundMethodFromName, which answers a bound
// method lookup only with the declared method at this build's address.
static std::atomic<bool> s_methodLookupAuthenticated{ false };
void SetMethodLookupAuthenticated(bool installed) { s_methodLookupAuthenticated.store(installed); }
bool MethodLookupAuthenticated() { return s_methodLookupAuthenticated.load(); }

namespace {

constexpr int kListedFailures = 20;
constexpr int kListedUnloaded = 8;

// Why one row holds readiness back.
enum class Why : uint8_t {
    EntryNoBinding, EntrySuspect, EntrySanityCheck, EntryNotDeclared, EntryGaveUp, EntryPending,
    FieldInfoUnresolved, FieldNotLoaded, FieldNotDeclared, FieldMoved,
    MethodNotLoaded, MethodNotDeclared, MethodMoved,
};

struct Failure { Why why; int index; uint64_t live; };

// What one ReadyForActivation() call found, kept per calling thread so the failure log is
// written from the check's own findings instead of a second pass over the loaded classes.
// Plain data with no constructor, so the thread_local needs no dynamic initialisation; the
// check resets it first.
struct CheckRecord {
    int      count;                              // rows holding readiness back
    uint64_t signature;                          // FNV-1a over every row held or left to its
                                                 // lookup, listed or not: the failing set
    Failure  listed[kListedFailures];
    int      unloaded;                           // method rows left to their lookups
    int      unloadedListed[kListedUnloaded];

    void Reset() { count = 0; signature = 14695981039346656037ULL; unloaded = 0; }
    void Mix(uint64_t part)
    {
        for (int shift = 0; shift < 64; shift += 8)
            signature = (signature ^ ((part >> shift) & 0xFFu)) * 1099511628211ULL;
    }
    void Hold(Why why, int index, uint64_t live)
    {
        Mix(static_cast<uint64_t>(why));
        Mix(static_cast<uint64_t>(index));
        Mix(live);
        if (count < kListedFailures) listed[count] = { why, index, live };
        ++count;
    }
    void LeaveToLookup(int index)
    {
        Mix(0xFFu);  // not a Why: a row left to its lookup
        Mix(static_cast<uint64_t>(index));
        if (unloaded < kListedUnloaded) unloadedListed[unloaded] = index;
        ++unloaded;
    }
};

thread_local CheckRecord t_check;

} // namespace

static bool EntryUnverified(int i)
{
    return (s_entryState[i] != OffsetState::ResolvedMatch && s_entryState[i] != OffsetState::ResolvedShifted) ||
           !BuildBindings::Field(s_entries[i].className, s_entries[i].tryNames[0], s_entries[i].key);
}

// A binding row whose table entry already holds readiness is named once, by the entry.
static bool NamedByUnverifiedEntry(const char* entry)
{
    if (!entry) return false;
    for (int i = 0; i < kEntryCount; ++i)
        if (s_entries[i].key && strcmp(s_entries[i].key, entry) == 0) return EntryUnverified(i);
    return false;
}

// A declared method by its exact name and arity, wherever it now lives: the installed
// method lookup refuses one away from its bound address, and the log wants that address.
static const MethodInfo* FindDeclaredMethod(Il2CppClass* klass, const char* name, int args)
{
    if (!il2cpp_class_get_methods || !il2cpp_method_get_name || !il2cpp_method_get_param_count) return nullptr;
    void* iter = nullptr;
    while (const MethodInfo* method = il2cpp_class_get_methods(klass, &iter))
        if (strcmp(il2cpp_method_get_name(method), name) == 0 &&
            static_cast<int>(il2cpp_method_get_param_count(method)) == args) return method;
    return nullptr;
}

// True once every table entry resolved and every generated binding matches the live
// process: each field row's offset, and each method row's address on a loaded class of
// its owner's name. Only BindingsReady() calls it, on a build with generated bindings.
//
// il2cpp_class_for_each reports initialised classes only, and some owners never
// initialise in a session (DeviceIdHolder and UnityApiResultsHolder on 86ad651b). A short
// name can also name a second class that does initialise: on 86ad651b the loaded "Time" is
// UnityEngine.InputForUI.InputManagerProvider.Time, which declares no get_deltaTime, while
// UnityEngine.Time may never initialise. So with BoundMethodFromName installed, a loaded
// class of the owner's name is the row's owner only if it declares the method's name and
// arity; if one does at another address, the method moved and the row holds. A row with no
// such class is left to its lookup instead of holding the gate: the build-time gate proved
// the method exists in this pinned build, and every lookup that reaches a class without it
// is refused. Without the redirection nothing refuses those lookups, and any class of the
// owner's name that fails to prove the row holds it.
//
// The check does not stop at the first failing row: t_check records every row that holds,
// for the failure log.
bool ReadyForActivation()
{
    CheckRecord& record = t_check;
    record.Reset();
    bool ok = true;
    for (int i = 0; i < kEntryCount; ++i) {
        if (!EntryUnverified(i)) continue;
        ok = false;
        const OffsetState state = s_entryState[i];
        Why why = Why::EntryPending;
        if (!BuildBindings::Field(s_entries[i].className, s_entries[i].tryNames[0], s_entries[i].key)) why = Why::EntryNoBinding;
        else if (state == OffsetState::Suspect) why = s_entryDisagreed[i] ? Why::EntrySuspect : Why::EntrySanityCheck;
        else if (state == OffsetState::FallbackFieldName) why = Why::EntryNotDeclared;
        else if (state == OffsetState::FallbackGaveUp) why = Why::EntryGaveUp;
        record.Hold(why, i, why == Why::EntrySuspect ? s_entryLiveOffset[i] : 0);
    }
    for (int i = 0; i < kFIEntryCount; ++i)
        if (!*s_fieldInfoEntries[i].out) { ok = false; record.Hold(Why::FieldInfoUnresolved, i, 0); }
    // One enumeration for the whole check. Resolver::FindClassLoose walks every
    // loaded class, so a per-row lookup would walk them once per bound row -- 177
    // times per call on 86ad651b -- on the frame path, while the answer is still false.
    std::vector<std::pair<const char*, Il2CppClass*>> byName;
    il2cpp_class_for_each([](Il2CppClass* klass, void* ud) {
        static_cast<std::vector<std::pair<const char*, Il2CppClass*>>*>(ud)
            ->emplace_back(il2cpp_class_get_name(klass), klass);
    }, &byName);
    for (const auto& row : BuildBindings::fields) {
        if (!row.owner[0]) continue;
        bool loaded = false, declared = false, matched = false;
        uint32_t live = 0;
        for (const auto& entry : byName) {
            if (strcmp(entry.first, row.targetOwner) != 0) continue;
            loaded = true;
            FieldInfo* field = FindExactFieldOnHierarchy(entry.second, row.target);
            if (!field) continue;
            const uint32_t offset = static_cast<uint32_t>(il2cpp_field_get_offset(field));
            if (offset == row.offset) { matched = true; break; }
            if (!declared) { declared = true; live = offset; }
        }
        if (matched) continue;
        ok = false;
        if (!NamedByUnverifiedEntry(row.entry))
            record.Hold(!loaded ? Why::FieldNotLoaded : !declared ? Why::FieldNotDeclared : Why::FieldMoved,
                static_cast<int>(&row - BuildBindings::fields), live);
    }
    const uintptr_t base = reinterpret_cast<uintptr_t>(GetModuleHandleW(L"GameAssembly.dll"));
    const bool authenticated = MethodLookupAuthenticated();
    for (const auto& row : BuildBindings::methods) {
        if (!row.owner[0]) continue;
        const int index = static_cast<int>(&row - BuildBindings::methods);
        bool owned = false, matched = false;
        const MethodInfo* declared = nullptr;
        for (const auto& entry : byName) {
            if (strcmp(entry.first, row.targetOwner) != 0) continue;
            const MethodInfo* method = il2cpp_class_get_method_from_name(entry.second, row.source, row.args);
            if (method && reinterpret_cast<uintptr_t>(method->methodPointer) == base + row.rva) { matched = true; break; }
            const MethodInfo* here = method ? method : FindDeclaredMethod(entry.second, row.target, row.args);
            if (here || !authenticated) owned = true;
            if (!declared) declared = here;
        }
        if (matched) continue;
        if (!owned && authenticated) { record.LeaveToLookup(index); continue; }
        ok = false;
        const uintptr_t pointer = declared ? reinterpret_cast<uintptr_t>(declared->methodPointer) : 0;
        record.Hold(!owned ? Why::MethodNotLoaded : !declared ? Why::MethodNotDeclared : Why::MethodMoved,
            index, pointer >= base ? pointer - base : 0);
    }
    return ok;
}

// One clause of the failure log, from the row the check recorded.
static void DescribeFailure(const Failure& failure, char* clause, size_t size)
{
    const int i = failure.index;
    switch (failure.why) {
    case Why::EntryNoBinding:
    case Why::EntrySuspect:
    case Why::EntrySanityCheck:
    case Why::EntryNotDeclared:
    case Why::EntryGaveUp:
    case Why::EntryPending: {
        const Entry& e = s_entries[i];
        const char* key = e.key ? e.key : "?";
        const auto* binding = BuildBindings::Field(e.className, e.tryNames[0], e.key);
        if (!binding || failure.why == Why::EntryNoBinding) { snprintf(clause, size, "field.%s has no generated binding", key); break; }
        if (failure.why == Why::EntrySuspect)
            snprintf(clause, size, "field.%s %s::%s bound offset 0x%X, live 0x%X", key, binding->targetOwner, binding->target,
                binding->offset, static_cast<uint32_t>(failure.live));
        else if (failure.why == Why::EntrySanityCheck)
            snprintf(clause, size, "field.%s %s::%s failed a live sanity check", key, binding->targetOwner, binding->target);
        else if (failure.why == Why::EntryNotDeclared)
            snprintf(clause, size, "field.%s %s::%s not declared (bound offset 0x%X)", key, binding->targetOwner, binding->target, binding->offset);
        else if (failure.why == Why::EntryGaveUp)
            snprintf(clause, size, "field.%s class %s not loaded before the give-up", key, binding->targetOwner);
        else
            snprintf(clause, size, "field.%s not resolved yet", key);
        break;
    }
    case Why::FieldInfoUnresolved:
        snprintf(clause, size, "FieldInfo %s::%s not resolved", s_fieldInfoEntries[i].className, s_fieldInfoEntries[i].fieldName);
        break;
    case Why::FieldNotLoaded:
    case Why::FieldNotDeclared:
    case Why::FieldMoved: {
        const auto& row = BuildBindings::fields[i];
        const char* key = row.entry ? row.entry : row.source;
        if (failure.why == Why::FieldNotLoaded) snprintf(clause, size, "field.%s class %s not loaded", key, row.targetOwner);
        else if (failure.why == Why::FieldNotDeclared) snprintf(clause, size, "field.%s %s::%s not declared", key, row.targetOwner, row.target);
        else snprintf(clause, size, "field.%s %s::%s bound offset 0x%X, live 0x%X", key, row.targetOwner, row.target, row.offset,
            static_cast<uint32_t>(failure.live));
        break;
    }
    case Why::MethodNotLoaded:
    case Why::MethodNotDeclared:
    case Why::MethodMoved: {
        const auto& row = BuildBindings::methods[i];
        if (failure.why == Why::MethodNotLoaded)
            snprintf(clause, size, "method.%s.%s/%d class %s not loaded", row.owner, row.source, row.args, row.targetOwner);
        else if (failure.why == Why::MethodNotDeclared)
            snprintf(clause, size, "method.%s.%s/%d %s::%s not declared", row.owner, row.source, row.args, row.targetOwner, row.target);
        else
            snprintf(clause, size, "method.%s.%s/%d %s::%s bound rva 0x%llX, live 0x%llX", row.owner, row.source, row.args,
                row.targetOwner, row.target, static_cast<unsigned long long>(row.rva), static_cast<unsigned long long>(failure.live));
        break;
    }
    }
}

static void Append(char* text, size_t size, size_t& used, const char* piece)
{
    if (used + 1 >= size) return;
    const int n = snprintf(text + used, size - used, "%s", piece);
    if (n > 0) used = (used + static_cast<size_t>(n) < size) ? used + static_cast<size_t>(n) : size - 1;
}

// One ungated line the first time verification fails, and again whenever the set of rows
// holding it changes: a Release build otherwise holds its features without saying why. It
// is formatted from the failing check's record, and only when that set changed. Method
// rows left to their lookups are named too, as not holding, so a held session stays
// diagnosable. A thread that finds another thread writing skips; the next check logs.
static void LogBindingFailures(const CheckRecord& record)
{
    static std::atomic<bool> s_busy{ false };
    if (record.count == 0 || s_busy.exchange(true)) return;
    static bool s_logged = false;
    static uint64_t s_signature = 0;
    if (!s_logged || record.signature != s_signature) {
        s_logged = true;
        s_signature = record.signature;
        static char text[4096], owners[1024], line[5400];
        size_t used = 0, ownersUsed = 0;
        text[0] = owners[0] = '\0';
        char clause[256];
        for (int n = 0; n < record.count && n < kListedFailures; ++n) {
            if (n) Append(text, sizeof(text), used, "; ");
            DescribeFailure(record.listed[n], clause, sizeof(clause));
            Append(text, sizeof(text), used, clause);
        }
        if (record.count > kListedFailures) {
            snprintf(clause, sizeof(clause), "; and %d more", record.count - kListedFailures);
            Append(text, sizeof(text), used, clause);
        }
        if (record.unloaded > 0) {
            Append(owners, sizeof(owners), ownersUsed, " (not holding: method rows no loaded class declares, proved when they are looked up: ");
            for (int n = 0; n < record.unloaded && n < kListedUnloaded; ++n) {
                const auto& row = BuildBindings::methods[record.unloadedListed[n]];
                snprintf(clause, sizeof(clause), "%smethod.%s.%s/%d", n ? ", " : "", row.owner, row.source, row.args);
                Append(owners, sizeof(owners), ownersUsed, clause);
            }
            if (record.unloaded > kListedUnloaded) {
                snprintf(clause, sizeof(clause), ", and %d more", record.unloaded - kListedUnloaded);
                Append(owners, sizeof(owners), ownersUsed, clause);
            }
            Append(owners, sizeof(owners), ownersUsed, ")");
        }
        snprintf(line, sizeof(line), "[RuntimeOffsets] Bindings not verified, gated features held. %d failing: %s%s",
            record.count, text, owners);
        DbgFileLogWrite(line);
    }
    s_busy.store(false);
}

static constexpr ULONGLONG kCheckIntervalMs      = 1000ULL;
static constexpr ULONGLONG kBackoffIntervalMs    = 5000ULL;
static constexpr int       kBackoffAfterFailures = 5;

// Latched, throttled readiness for the frame path. A build with no generated
// bindings has nothing to verify, so it is ready immediately and every developer
// build behaves exactly as it did before this header existed.
//
// Called from the game-update thread (dodge dispatch, feature installs) and the render
// thread (BootGate, the Test tab). The latch only ever goes from false to true, and a
// compare-exchange on the timestamp lets exactly one thread run each due check. No check
// runs until the table has settled, since none could pass. A held session is re-checked
// every second at first, then every five seconds after kBackoffAfterFailures failing checks
// with the same failing set; a set that changes starts the count again.
bool BindingsReady()
{
    static std::atomic<bool> s_ready{ false };
    static std::atomic<ULONGLONG> s_lastCheck{ 0 };
    static std::atomic<int> s_failedChecks{ 0 };
    static std::atomic<uint64_t> s_failingSet{ 0 };
    if (s_ready) return true;
    if (!BuildBindings::fields[0].owner[0] && !BuildBindings::methods[0].owner[0]) {
        s_ready = true;
        return true;
    }
    if (!s_allDone) return false;
    // The timestamp is read before the clock, so `now` never precedes it and the
    // unsigned difference cannot wrap.
    ULONGLONG last = s_lastCheck.load();
    const ULONGLONG now = GetTickCount64();
    const ULONGLONG interval = s_failedChecks.load() >= kBackoffAfterFailures ? kBackoffIntervalMs : kCheckIntervalMs;
    if (last != 0 && now - last < interval) return false;
    if (!s_lastCheck.compare_exchange_strong(last, now)) return s_ready;
    if (ReadyForActivation()) {
        s_failedChecks.store(0);
        if (!s_ready.exchange(true))
            DbgFileLogWrite("[RuntimeOffsets] Generated bindings verified against the live process.");
        return true;
    }
    // Only the thread that claimed this check writes the count and the set.
    if (s_failingSet.exchange(t_check.signature) != t_check.signature) s_failedChecks.store(1);
    else s_failedChecks.fetch_add(1);
    LogBindingFailures(t_check);
    return s_ready;
}

// Only the offset verifier sets REALM_OFFSET_REPORT. Normal clients do no IO here.
static void WriteVerificationReport()
{
    static wchar_t path[MAX_PATH] = {};
    static bool initialized = false;
    static char nonce[65] = {};
    static ULONGLONG lastWrite = 0;
    if (!initialized) {
        initialized = true;
        DWORD n = GetEnvironmentVariableW(L"REALM_OFFSET_REPORT", path, MAX_PATH);
        // Leave room for the ".tmp" suffix below: swprintf_s terminates the process on overflow.
        if (n == 0 || n + 4 >= MAX_PATH) path[0] = 0;
        DWORD count = GetEnvironmentVariableA("REALM_OFFSET_REPORT_NONCE", nonce, sizeof(nonce));
        if (count == 0 || count >= sizeof(nonce)) nonce[0] = 0;
        for (const char* c = nonce; *c; ++c)
            if (!((*c >= '0' && *c <= '9') || (*c >= 'a' && *c <= 'f'))) { nonce[0] = 0; break; }
    }
    if (!path[0] || GetTickCount64() - lastWrite < 1000) return;
    lastWrite = GetTickCount64();
    wchar_t tmp[MAX_PATH];
    if (swprintf_s(tmp, L"%ls.tmp", path) < 0) return;
    FILE* f = nullptr;
    if (_wfopen_s(&f, tmp, L"wb") != 0 || !f) return;
    static const char* states[] = { "Pending", "Match", "Shifted", "FieldRenamed", "ClassGaveUp", "Suspect" };
    fprintf(f, "{\"pid\":%lu,\"nonce\":\"%s\",\"gameassembly_sha256\":\"%s\",\"metadata_sha256\":\"%s\",\"entries\":[",
        GetCurrentProcessId(), nonce, BuildBindings::gameAssemblySha256, BuildBindings::metadataSha256);
    for (int i = 0; i < kEntryCount; ++i) {
        fprintf(f, "%s{\"key\":\"field.%s\",\"class\":\"%s\",\"field\":\"%s\",\"state\":\"%s\"}",
            i ? "," : "", s_entries[i].key, s_entries[i].className,
            s_entries[i].tryCount ? s_entries[i].tryNames[0] : "?",
            states[static_cast<int>(s_entryState[i])]);
    }
    for (int i = 0; i < kFIEntryCount; ++i) {
        fprintf(f, ",{\"class\":\"%s\",\"field\":\"%s (FieldInfo)\",\"state\":\"%s\"}",
            s_fieldInfoEntries[i].className, s_fieldInfoEntries[i].fieldName,
            *s_fieldInfoEntries[i].out ? "Match" : "FieldRenamed");
    }
    for (const auto& row : BuildBindings::fields) {
        if (!row.owner[0]) continue;
        Il2CppClass* klass = Resolver::FindClassLoose(row.owner);
        FieldInfo* field = klass ? FindExactFieldOnHierarchy(klass, row.target) : nullptr;
        const bool valid = field && static_cast<uint32_t>(il2cpp_field_get_offset(field)) == row.offset;
        fprintf(f, ",{\"class\":\"%s\",\"field\":\"%s (binding)\",\"state\":\"%s\"}",
            row.owner, row.source, valid ? "Match" : "Suspect");
    }
    for (const auto& row : BuildBindings::methods) {
        if (!row.owner[0]) continue;
        const bool valid = BoundMethodLive(row);
        fprintf(f, ",{\"class\":\"%s\",\"field\":\"%s (method)\",\"state\":\"%s\"}",
            row.owner, row.source, valid ? "Match" : "Suspect");
    }
    fprintf(f, "]}");
    const bool failed = ferror(f) != 0;
    const int closed = fclose(f);
    if (!failed && closed == 0) MoveFileExW(tmp, path, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
}

void EnsureAll()
{
    // FFLIAABAAFP x/y is resolved by shape, not through the entry table, so it
    // runs ahead of the s_allDone short-circuit (it self-latches once resolved).
    ResolveWorldPosLayout();
    Sfx_WposY = Sfx_WposX + 4;

    if (s_allDone) {
        WriteVerificationReport();
        Gjj_OriginY = Gjj_OriginX + 4;
        Gjj_DestY   = Gjj_DestX   + 4;
        Fhoh_DestY  = Fhoh_DestX  + 4;
        return;
    }

    // EnsureAll is called from the render thread (dPresent, BootGate::Tick) and the game-
    // update thread (AoeTracking::EnsureInstalled). One thread resolves the table at a time;
    // a caller arriving meanwhile returns and uses the table as it stands, so the give-up is
    // checked, set and logged exactly once.
    static std::atomic_flag s_resolving;  // clear: C++20 value-initialises atomic_flag
    if (s_resolving.test_and_set()) return;
    struct ReleaseResolving { ~ReleaseResolving() { s_resolving.clear(); } } releaseResolving;

    if (!s_fallbackSnapped) {
        s_fallbackSnapped = true;
        for (int i = 0; i < kEntryCount; ++i) s_entryFallback[i] = *s_entries[i].outPtr;
    }

    const ULONGLONG now = GetTickCount64();
    if (s_firstCallTick == 0) s_firstCallTick = now;
    const bool giveUp = (now - s_firstCallTick) >= kGiveUpMs;

    // First time give-up fires: collect unique unresolved class names before marking done.
    if (giveUp && !s_giveUpFired) {
        s_giveUpFired = true;
        const char* lastCls = nullptr;
        for (int i = 0; i < kEntryCount; ++i) {
            if (s_entries[i].done) continue;
            const char* cls = s_entries[i].className;
            if (lastCls && strcmp(cls, lastCls) == 0) continue;
            lastCls = cls;
            if (s_unresolvedClassNames[0] != '\0')
                strncat_s(s_unresolvedClassNames, sizeof(s_unresolvedClassNames), ",", _TRUNCATE);
            strncat_s(s_unresolvedClassNames, sizeof(s_unresolvedClassNames), cls, _TRUNCATE);
        }
        if (s_unresolvedClassNames[0] != '\0')
            DBG_FILE_LOG("[RuntimeOffsets] Unresolved (BeeByte renamed): " << s_unresolvedClassNames);
        // Terminal on a build with generated bindings: these entries are marked done on
        // their fallbacks, so ReadyForActivation cannot turn true again. Say so ungated.
        if (s_unresolvedClassNames[0] != '\0' && (BuildBindings::fields[0].owner[0] || BuildBindings::methods[0].owner[0])) {
            char line[768];
            snprintf(line, sizeof(line),
                "[RuntimeOffsets] Offset table gave up after %llu ms with classes not loaded: %s. "
                "Their entries keep fallback offsets and cannot verify, so gated features stay held for this session.",
                static_cast<unsigned long long>(kGiveUpMs), s_unresolvedClassNames);
            DbgFileLogWrite(line);
        }
    }

    // Cache last class lookup to avoid calling FindClassLoose once per entry
    // for entries that share a class name (entries are already grouped by class).
    const char*  lastClassName = nullptr;
    Il2CppClass* lastClass     = nullptr;

    bool anyPending = false;
    for (int i = 0; i < kEntryCount; ++i) {
        Entry& e = s_entries[i];
        if (e.done) continue;

        if (giveUp) {
            // Accept fallback value; stop retrying this entry.
            DBG_FILE_LOG("[RuntimeOffsets] " << e.className << "::"
                << (e.tryCount ? e.tryNames[0] : "?")
                << " GIVE UP after timeout — keeping fallback 0x"
                << std::hex << *e.outPtr << std::dec);
            s_entryState[i] = OffsetState::FallbackGaveUp;
            e.done = true;
            continue;
        }

        // Reuse cached class pointer when consecutive entries share a class name.
        Il2CppClass* klass;
        if (e.className == lastClassName) {
            klass = lastClass;
        } else {
            klass = Resolver::FindClassLoose(e.className);
            lastClassName = e.className;
            lastClass     = klass;
        }

        if (!klass) { anyPending = true; continue; }

        // Class found: attempt field resolution, then mark done regardless.
        FieldInfo* found = nullptr;
        const char* foundName = nullptr;
        // A generated binding names this build's field for this exact entry. Without
        // one -- a developer build -- the table's own names resolve it as before.
        const auto* binding = BuildBindings::Field(e.className, e.tryNames[0], e.key);
        if (binding) {
            foundName = binding->target;
            found = FindExactFieldOnHierarchy(klass, binding->target);
        } else for (int t = 0; t < e.tryCount && !found; ++t) {
            found = FindFieldOnHierarchy(klass, e.tryNames[t]);
            if (found) foundName = e.tryNames[t];
        }

        const uint32_t fallback = *e.outPtr;
        if (found) {
            const uint32_t rawOffset = static_cast<uint32_t>(il2cpp_field_get_offset(found));
            const uint32_t resolved = rawOffset + (binding ? binding->adjustment : e.actkShift);
            if (binding && rawOffset != binding->offset) {
                // The live layout disagrees with the build-time binding. The entry keeps its
                // fallback offset, which reads still use, and is marked Suspect, so writes
                // checked by IsFieldWriteTrusted are refused. Logged ungated: this fires at
                // most once per entry, and it is why ReadyForActivation never turns true.
                char line[256];
                snprintf(line, sizeof(line),
                    "[RuntimeOffsets] %s (%s::%s) disagrees with its binding: bound offset 0x%X, live offset 0x%X; keeping fallback 0x%X",
                    e.key ? e.key : "?", e.className, binding->target, binding->offset, rawOffset, fallback);
                DbgFileLogWrite(line);
                s_entryDisagreed[i] = true;
                s_entryLiveOffset[i] = rawOffset;
                s_entryState[i] = OffsetState::Suspect;
                e.done = true;
                continue;
            }
            DBG_FILE_LOG("[RuntimeOffsets] " << e.className << "::" << foundName
                << " resolved -> 0x" << std::hex << resolved
                << " (fallback was 0x" << fallback << std::dec
                << (resolved == fallback ? ", match)" : ", SHIFTED)"));
            *e.outPtr = resolved;
            s_entryState[i] = (resolved == fallback) ? OffsetState::ResolvedMatch
                                                     : OffsetState::ResolvedShifted;
        } else {
            DBG_FILE_LOG("[RuntimeOffsets] " << e.className << "::"
                << (e.tryCount ? e.tryNames[0] : "?")
                << " FIELD NAME NOT FOUND — using fallback 0x" << std::hex << fallback << std::dec);
            s_entryState[i] = OffsetState::FallbackFieldName;
        }

        e.done = true;
    }

    // ── FieldInfo pointer pass ────────────────────────────────────────────
    lastClassName = nullptr;
    lastClass     = nullptr;
    for (int i = 0; i < kFIEntryCount; ++i) {
        FieldInfoEntry& fe = s_fieldInfoEntries[i];
        if (fe.done) continue;

        if (giveUp) { fe.done = true; continue; }

        Il2CppClass* klass;
        if (fe.className == lastClassName) {
            klass = lastClass;
        } else {
            klass = Resolver::FindClassLoose(fe.className);
            lastClassName = fe.className;
            lastClass     = klass;
        }

        if (!klass) { anyPending = true; continue; }

        // Follow the generated rename: the offset pass binds by target name, and a
        // FieldInfo left null by a renamed field would veto activation for a build
        // whose bindings are correct. The name is translated here, once, and looked up
        // exactly: FindFieldOnHierarchy goes through the redirected
        // il2cpp_class_get_field_from_name, which would translate it a second time.
        FieldInfo* f = FindExactFieldOnHierarchy(klass, BuildBindings::FieldName(il2cpp_class_get_name(klass), fe.fieldName));
        if (f) *fe.out = f;
        fe.done = true;
    }

    if (!anyPending) s_allDone = true;
    WriteVerificationReport();

    // ── Vector2 .y derivation pass ────────────────────────────────────────
    // Unity Vector2 lays out {float x, float y} contiguously.
    // il2cpp_field_get_offset gives us x; y is always x+4.
    // We re-derive every call so the Y is always consistent with the resolved X,
    // even before X has been resolved (fallback X + 4 == fallback Y).
    Gjj_OriginY = Gjj_OriginX + 4;
    Gjj_DestY   = Gjj_DestX   + 4;
    Fhoh_DestY  = Fhoh_DestX  + 4;
}

// ── MapObject status conditions (COHCKAPOLCA UInt32[] — offset_map.md) ─────

bool MapObjectConditionsMakeUntargetable(uint32_t word0, uint32_t word1)
{
    // Confirmed from Flash client source: condition_ (COHCKAPOLCA UInt32[2]) is shared by ALL
    // GameObjects — players AND enemies receive CONDITION_STAT / NEW_CON_STAT from the server.
    const uint64_t full = GetFullConditions(word0, word1);
    return HasCondition(full, ConditionEffects::Stasis)       // bit 21 — frozen + immune
        || HasCondition(full, ConditionEffects::Invincible)   // bit 23 — temporary hit immunity
        || HasCondition(full, ConditionEffects::Invulnerable);// bit 24 — permanent immunity
}

// Guarded single-offset read + strict shape validation. COHCKAPOLCA is always a
// 1-D UInt32[2]: object header {klass, monitor, bounds==null, max_length==2}.
// A wrong offset reads some other field (this build: a float 1.0f dereferenced as
// a pointer → the 0x3F800018 first-chance AVs), which this validation rejects
// before we trust the data. Returns: 1 = validated array read, 0 = null array at
// this offset (legit "no conditions"), -1 = not a conditions array / fault.
static int TryReadCondArrayAt(void* entity, uint32_t off, uint32_t* outW0, uint32_t* outW1)
{
    __try {
        uint8_t* ent = reinterpret_cast<uint8_t*>(entity);
        void* arr = *reinterpret_cast<void**>(ent + off);
        if (!arr)
            return 0;
        const uintptr_t a = reinterpret_cast<uintptr_t>(arr);
        if (a < 0x10000 || a > 0x7FFFFFFFFFFFULL || (a & 7) != 0)
            return -1;
        uint8_t* ap = reinterpret_cast<uint8_t*>(arr);
        void*   klass  = *reinterpret_cast<void**>(ap + 0x00);
        void*   bounds = *reinterpret_cast<void**>(ap + 0x10);
        int32_t maxLen = *reinterpret_cast<int32_t*>(ap + 0x18);
        const uintptr_t k = reinterpret_cast<uintptr_t>(klass);
        if (k < 0x10000 || k > 0x7FFFFFFFFFFFULL || bounds != nullptr || maxLen != 2)
            return -1;
        auto* data = reinterpret_cast<uint32_t*>(ap + 0x20);
        *outW0 = data[0];
        *outW1 = data[1];
        return 1;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return -1;
    }
}

bool TryReadMapObjectConditions(void* mapObjectPtr, uint32_t* outWord0, uint32_t* outWord1)
{
    if (outWord0) *outWord0 = 0;
    if (outWord1) *outWord1 = 0;
    if (!mapObjectPtr || !outWord0 || !outWord1)
        return false;
    if (MoConditions == 0)
        return false;

    // ACTK's per-field runtime shuffle keeps moving COHCKAPOLCA relative to its
    // metadata offset (the fixed +0x50 assumption broke on the 2026-08 build).
    // Self-locate instead: once a candidate offset yields a validated UInt32[2]
    // on a live entity, lock it in for the rest of the session.
    static uint32_t s_lockedOff = 0;   // 0 = not yet locked

    if (s_lockedOff != 0) {
        const int r = TryReadCondArrayAt(mapObjectPtr, s_lockedOff, outWord0, outWord1);
        return r >= 0;   // null array at the right offset = "no conditions", still success
    }

    // Candidates around the name-resolved (metadata + kActk) value, most likely
    // first: as-resolved, ±8, +0x10, and the raw metadata offset (no ACTK shift).
    const uint32_t base = MoConditions;
    const uint32_t candidates[6] = {
        base, base + 8, base - 8, base + 0x10, base - 0x10, base - kActk,
    };
    for (int i = 0; i < 6; ++i) {
        const int r = TryReadCondArrayAt(mapObjectPtr, candidates[i], outWord0, outWord1);
        if (r == 1) {
            s_lockedOff = candidates[i];
            DBG_FILE_LOG("[RuntimeOffsets] MoConditions self-located at 0x" << std::hex
                << candidates[i] << " (name-resolved was 0x" << base << std::dec << ")");
            return true;
        }
    }
    // No candidate validated on this entity (its array may just be null) — report
    // "no conditions" without locking so a later entity with a live array decides.
    //
    // BUDGET (measured): locking only on r == 1 means a live, non-null conditions
    // array is required to settle the offset. Most entities carry no conditions
    // most of the time, so in practice this never locked at all — the trace showed
    // zero "self-located" lines across a whole session — and every entity paid all
    // six probes on every pass, forever. The probing is legacy self-heal; `base` is
    // now the collector's exact-build offset. Spend a bounded number of attempts
    // looking for a shifted layout, then settle on the baked value and stop.
    static int s_probeBudget = 256;
    if (s_probeBudget > 0 && --s_probeBudget == 0) {
        s_lockedOff = base;
        DBG_FILE_LOG("[RuntimeOffsets] MoConditions probe budget spent — settling on "
                     "baked offset 0x" << std::hex << base << std::dec
                     << " (no shifted layout found; single read from here on)");
    }
    *outWord0 = *outWord1 = 0;
    return true;
}

void FormatMapObjectConditionMask(uint32_t word0, uint32_t word1, char* buf, size_t bufSize)
{
    if (!buf || bufSize == 0)
        return;
    buf[0] = '\0';
    if ((word0 | word1) == 0)
        return;

    static const struct { ConditionEffects effect; const char* name; } kEffects[] = {
        { ConditionEffects::Dead,             "Dead"             },
        { ConditionEffects::Quiet,            "Quiet"            },
        { ConditionEffects::Weak,             "Weak"             },
        { ConditionEffects::Slowed,           "Slowed"           },
        { ConditionEffects::Sick,             "Sick"             },
        { ConditionEffects::Dazed,            "Dazed"            },
        { ConditionEffects::Stunned,          "Stunned"          },
        { ConditionEffects::Blind,            "Blind"            },
        { ConditionEffects::Hallucinating,    "Hallucinating"    },
        { ConditionEffects::Drunk,            "Drunk"            },
        { ConditionEffects::Confused,         "Confused"         },
        { ConditionEffects::StunImmune,       "StunImmune"       },
        { ConditionEffects::Invisible,        "Invisible"        },
        { ConditionEffects::Paralyzed,        "Paralyzed"        },
        { ConditionEffects::Speedy,           "Speedy"           },
        { ConditionEffects::Bleeding,         "Bleeding"         },
        { ConditionEffects::ArmorBreakImmune, "ArmorBreakImmune" },
        { ConditionEffects::Healing,          "Healing"          },
        { ConditionEffects::Damaging,         "Damaging"         },
        { ConditionEffects::Berserk,          "Berserk"          },
        { ConditionEffects::Paused,           "Paused"           },
        { ConditionEffects::Stasis,           "Stasis"           },
        { ConditionEffects::StasisImmune,     "StasisImmune"     },
        { ConditionEffects::Invincible,       "Invincible"       },
        { ConditionEffects::Invulnerable,     "Invulnerable"     },
        { ConditionEffects::Armored,          "Armored"          },
        { ConditionEffects::ArmorBroken,      "ArmorBroken"      },
        { ConditionEffects::Hexed,            "Hexed"            },
        { ConditionEffects::NinjaSpeedy,      "NinjaSpeedy"      },
        { ConditionEffects::Unstable,         "Unstable"         },
        { ConditionEffects::Darkness,         "Darkness"         },
        // conditions[1] — the ones that change a damage or motion prediction.
        { ConditionEffects::Petrified,        "Petrified"        },
        { ConditionEffects::PetrifiedImmune,  "PetrifiedImmune"  },
        { ConditionEffects::Curse,            "Curse"            },
        { ConditionEffects::CurseImmune,      "CurseImmune"      },
        { ConditionEffects::Silenced,         "Silenced"         },
        { ConditionEffects::Exposed,          "Exposed"          },
        { ConditionEffects::Energized,        "Energized"        },
        { ConditionEffects::InCombat,         "InCombat"         },
    };

    const uint64_t full = GetFullConditions(word0, word1);

    auto append = [&](const char* s) {
        if (!s || !s[0]) return;
        strncat_s(buf, bufSize, s, _TRUNCATE);
    };

    for (const auto& e : kEffects) {
        if (!HasCondition(full, e.effect)) continue;
        append(e.name);
        append(" ");
    }
}

} // namespace RuntimeOffsets
