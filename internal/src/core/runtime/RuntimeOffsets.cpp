#include "pch-il2cpp.h"
#include "RuntimeOffsets.h"
#include "Il2CppResolver.h"
#include "DbgFileLog.h"
#include <cstdio>
#include <cstring>
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
uint32_t Sfx_EffectType  = 0x10;  // MIDADCIKEBD
uint32_t Sfx_TargetObjId = 0x14;  // HNOKKCFIJHJ
uint32_t Sfx_Pos1X       = 0x18;  // KMAIENKMNFA.x
uint32_t Sfx_Pos1Y       = 0x1C;  // KMAIENKMNFA.y (= Pos1X+4)
uint32_t Sfx_Pos2X       = 0x20;  // AEPOCACMOHI.x
uint32_t Sfx_Pos2Y       = 0x24;  // AEPOCACMOHI.y (= Pos2X+4)
uint32_t Sfx_Duration    = 0x2C;  // KPKIICOBBIM

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
};

static Entry s_entries[] = {

    // ── KJMONHENJEN (no shift) ────────────────────────────────────────────
    { "KJMONHENJEN", { "CLFEOFKBNEJ" },                              1, 0,     &PosX,           false },
    { "KJMONHENJEN", { "PKEECFNFEIO" },                              1, 0,     &PosY,           false },
    { "KJMONHENJEN", { "HFDNHJFNEKA" },                              1, 0,     &ObjType,        false },
    { "KJMONHENJEN", { "OBAKMCCDBJA" },                              1, 0,     &ObjProps,       false },
    { "KJMONHENJEN", { "MPGOFIHIDML" },                              1, 0,     &KJ_ViewHandler, false },
    { "KJMONHENJEN", { "LGDCEJKHGFJ" },                              1, 0,     &KJ_SkinWidthObj,false },
    { "KJMONHENJEN", { "HHPOJBFICAH" },                              1, 0,     &ObjId,          false },
    { "KJMONHENJEN", { "IOKKOCEAJNA" },                              1, 0,     &KJ_BaseRadius,  false },
    { "KJMONHENJEN", { "KEDBLBJIKCB" },                              1, 0,     &KJ_Scale,       false },
    { "KJMONHENJEN", { "DGNPJNFGFPE" },                              1, 0,     &KJ_Float3Pos,   false },
    { "KJMONHENJEN", { "EOKJOGFPLOA" },                              1, 0,     &KJ_TileRef,     false },
    { "KJMONHENJEN", { "FDNHINDAEHK" },                              1, 0,     &KJ_DictObjectId,false },

    // ── LKHPPBEGNOM (+0x50 ACTK for own fields) ───────────────────────────
    { "LKHPPBEGNOM", { "KJNHLADHEMH", "KJNHLADEMH" },               2, kActk, &HP,            false },
    { "LKHPPBEGNOM", { "NCBIICBDGAG" },                              1, kActk, &MaxHP,         false },
    { "LKHPPBEGNOM", { "HODJPKFINKF" },                              1, kActk, &Defense,       false },
    { "LKHPPBEGNOM", { "DPGEBOCBKEF" },                              1, 0,     &PlayerIGN,     false },
    { "LKHPPBEGNOM", { "COHCKAPOLCA" },                           1, kActk, &MoConditions,  false },
    { "LKHPPBEGNOM", { "ECGPFJKCCAN" },                           1, kActk, &MoVelocity,    false },
    { "LKHPPBEGNOM", { "KKENJFFDMPO" },                           1, 0,     &MoObjectProps, false },
    { "LKHPPBEGNOM", { "GGBCADDBAPN" },                           1, 0,     &PlayerCollisionProps, false },

    // ── FKALGHJIADI (+0x50 ACTK for own fields) ───────────────────────────
    { "FKALGHJIADI", { "HCMECDPHEMC" },                              1, kActk, &Tex1,          false },
    { "FKALGHJIADI", { "HKPOMIBEGPK" },                              1, kActk, &Tex2,          false },
    { "FKALGHJIADI", { "FMHMGKEPIDN" },                              1, kActk, &CurMP,              false },
    { "FKALGHJIADI", { "NEDCKPIIIPN" },                              1, kActk, &MaxMP,              false },
    // DAGEMHFLJLK = groundDamageImmune (dump 0x458 / runtime 0x4A8)
    // This doesn't seem to work. I do not believe this is labeled correctly.
    { "FKALGHJIADI", { "DAGEMHFLJLK" },                              1, kActk, &GroundDmgImmune,    false },
    // BINDBHJLPMG = invincible bool (dump 0x459 / runtime 0x4A9) — per FKALGHJIADI_mapped.txt
    { "FKALGHJIADI", { "BINDBHJLPMG" },                              1, kActk, &LocalInvincible,    false },
    // PPBLNMIMIFP = abilityReady bool (dump 0x515 / runtime 0x565) — the correct ability gate
    { "FKALGHJIADI", { "PPBLNMIMIFP" },                              1, kActk, &AbilityReady,       false },
    // CGCMALPMMJL = bool moving (dump 0x448 / runtime 0x498)
    { "FKALGHJIADI", { "CGCMALPMMJL" },                              1, kActk, &Player_Moving,      false },
    // BHJFNEAHAOE = float moveDirX (dump 0x478 / runtime 0x4C8)
    { "FKALGHJIADI", { "BHJFNEAHAOE" },                              1, kActk, &Player_MoveDirX,    false },
    // GDNEBFDDDKM = float moveDirY (dump 0x47C / runtime 0x4CC)
    { "FKALGHJIADI", { "GDNEBFDDDKM" },                              1, kActk, &Player_MoveDirY,    false },

    // ── FKALGHJIADI player diagnostic stats (no ACTK shift) ──────────────
    // These resolve the same fields as above but WITHOUT the kActk shift,
    // producing the dump offset used by PlayerTAB for stat display. Some
    // share BeeByte names with movement entries (e.g. HCMECDPHEMC = Tex1/ATK,
    // BHJFNEAHAOE = MoveDirX/SPD, GDNEBFDDDKM = MoveDirY/DEX).
    { "FKALGHJIADI", { "NFJGJKLPLBA" },                              1, 0,     &PlayerGuildName,    false },
    { "FKALGHJIADI", { "KABPJBJPGCM" },                              1, 0,     &PlayerClassNum,     false },
    { "FKALGHJIADI", { "GBANOMPLGBH" },                              1, 0,     &PlayerGuildRank,    false },
    { "FKALGHJIADI", { "HCMECDPHEMC" },                              1, 0,     &PlayerAtk,          false },
    { "FKALGHJIADI", { "GDNEBFDDDKM" },                              1, 0,     &PlayerDex,          false },
    { "FKALGHJIADI", { "CGFPEPCKKOK" },                              1, 0,     &PlayerVit,          false },
    { "FKALGHJIADI", { "HDCDGHKGLDI" },                              1, 0,     &PlayerWis,          false },
    { "FKALGHJIADI", { "MPJGAPJBBBF" },                              1, 0,     &PlayerCondInt,      false },
    { "FKALGHJIADI", { "AJJJBDBNBLM" },                              1, 0,     &PlayerEquipMgr,     false },

    // ── CameraManager (no shift — component fields) ────────────────────────
    { "CameraManager", { "mainCameraContainer" },                        1, 0,     &CM_Transform,  false },
    { "CameraManager", { "KNAIAEFDCLM" },                                1, 0,     &CM_UnityCam,   false },

    // ── EquipmentManager / ItemSlot (namespaced UI classes, no shift) ─────
    { "EquipmentManager", { "equipmentSlots" },                      1, 0,     &EM_EquipSlots, false },
    { "ItemSlot",         { "HLJFBHLMANJ" },                         1, 0,     &Item_ObjProps, false },
    { "ItemSlot",         { "INAAIAHOEFE" },                         1, 0,     &Item_ObjType,  false },

    // ── HJMBOMEHGDJ WorldManager (no shift) ──────────────────────────────
    { "HJMBOMEHGDJ", { "OCLNLBHDEFK" },                              1, 0,     &WM_Local,      false },
    { "HJMBOMEHGDJ", { "DFALIKKKGLI" },                              1, 0,     &WM_AllDict,    false },
    { "HJMBOMEHGDJ", { "KHIHFNACEKJ" },                              1, 0,     &WM_MapDictA,   false },
    { "HJMBOMEHGDJ", { "CIOIHEOEAEB" },                              1, 0,     &WM_MapDictB,   false },
    { "HJMBOMEHGDJ", { "ONABHKFOJNE" },                              1, 0,     &WM_KjmonList,  false },
    { "HJMBOMEHGDJ", { "NOJEHIAOAJM" },                              1, 0,     &WM_TileArr,    false },
    { "HJMBOMEHGDJ", { "IMAOBDCMPHC" },                              1, 0,     &WM_TileList,   false },
    { "HJMBOMEHGDJ", { "FIAJOKGHGGK" },                              1, 0,     &WM_TickId,     false },
    { "HJMBOMEHGDJ", { "HOMNPDGNOMO" },                              1, 0,     &WM_TickId2,    false },

    // ── BGAIOPJMHLO tile instance (no shift) ─────────────────────────────
    { "BGAIOPJMHLO", { "CLFEOFKBNEJ" },                              1, 0,     &TileX,         false },
    { "BGAIOPJMHLO", { "PKEECFNFEIO" },                              1, 0,     &TileY,         false },
    { "BGAIOPJMHLO", { "JOFEAFJPJEM" },                              1, 0,     &TileType,      false },
    { "BGAIOPJMHLO", { "KEOKJCIJIAD" },                              1, 0,     &TileProps,     false },
    { "BGAIOPJMHLO", { "EBCLNFDKKEH" },                              1, 0,     &Sq_Layer,      false },
    { "BGAIOPJMHLO", { "EAPMKCKMNDI" },                              1, 0,     &Sq_DamageCached,false },
    { "BGAIOPJMHLO", { "JGMBPFJEGAH" },                              1, 0,     &Sq_Cover,      false },

    // ── CMFPKCJHKKB XmlTileProperties (no shift) ─────────────────────────
    { "CMFPKCJHKKB", { "MFEJMAABLIL" },                              1, 0,     &TP_Speed,      false },
    { "CMFPKCJHKKB", { "BMGKCKHOIOH" },                              1, 0,     &TP_Sink,       false },
    { "CMFPKCJHKKB", { "LFKLKFIEMAH" },                              1, 0,     &TP_NoWalk,     false },
    { "CMFPKCJHKKB", { "MCMDAGNIGEB" },                              1, 0,     &TP_MinDmg,     false },
    { "CMFPKCJHKKB", { "KHMCMAHEBNG" },                              1, 0,     &TP_MaxDmg,     false },
    { "CMFPKCJHKKB", { "FNCCEGBHNKG" },                              1, 0,     &TP_Push,       false },
    { "CMFPKCJHKKB", { "LCHPDCNHJCA" },                              1, 0,     &TP_Alpha,      false },
    { "CMFPKCJHKKB", { "JKIDGAADOLC" },                              1, 0,     &TP_Sinking,    false },

    // ── ObjectProperties (real names, no shift) ───────────────────────────
    { "ObjectProperties", { "id" },                                  1, 0,     &OP_IdStr,          false },
    { "ObjectProperties", { "NoCoverElement" },                      1, 0,     &OP_NoCover,        false },
    // InvincibleElement — XML <Invincible/> string; non-null = permanently invincible.
    { "ObjectProperties", { "InvincibleElement" },                   1, 0,     &OP_InvincibleElem, false },
    { "ObjectProperties", { "NoWallTextureRepeatElement",
                             "NoWallTextureRepeat" },                2, 0,     &OP_NoWallRpt,      false },
    { "ObjectProperties", { "occupySquare" },                        1, 0,     &OP_OccupySq,       false },
    { "ObjectProperties", { "fullOccupy" },                          1, 0,     &OP_FullOcc,        false },
    { "ObjectProperties", { "enemyOccupySquare" },                   1, 0,     &OP_EnemyOcc,       false },
    { "ObjectProperties", { "isEnemy" },                             1, 0,     &OP_IsEnemy,        false },
    { "ObjectProperties", { "isStatic" },                            1, 0,     &OP_IsStatic,       false },
    { "ObjectProperties", { "blockProjectiles" },                    1, 0,     &OP_BlockProj,      false },
    // noHealthBar — true when entity type has no visible HP bar; must not be targeted.
    { "ObjectProperties", { "noHealthBar" },                         1, 0,     &OP_NoHealthBar,    false },
    { "ObjectProperties", { "protectFromGroundDamage",
                             "ProtectFromGroundDamage" },            2, 0,     &OP_ProtGnd,        false },
    { "ObjectProperties", { "protectFromSink",
                             "ProtectFromSink" },                    2, 0,     &OP_ProtSink,       false },
    { "ObjectProperties", { "flying" },                              1, 0,     &OP_Flying,         false },
    { "ObjectProperties", { "connectType" },                         1, 0,     &OP_ConnectT,       false },
    { "ObjectProperties", { "Projectiles", "projectiles" },          2, 0,     &OP_Projectiles,    false },
    { "ObjectProperties", { "collisionRadiusMultiplier" },           1, 0,     &OP_CollRadiusMult, false },

    // ── ProjectileProperties (real names, no shift) ───────────────────────
    { "ProjectileProperties", { "Lifetime",   "lifetime" },          2, 0,     &PP_Lifetime,        false },
    { "ProjectileProperties", { "ProjectileSpeed", "Speed" },        2, 0,     &PP_Speed,           false },
    { "ProjectileProperties", { "IsWavy",     "Wavy" },              2, 0,     &PP_IsWavy,          false },
    { "ProjectileProperties", { "IsBoomerang","Boomerang" },         2, 0,     &PP_IsBoomerang,     false },
    { "ProjectileProperties", { "IsParametric","Parametric" },       2, 0,     &PP_IsParametric,    false },
    { "ProjectileProperties", { "HasCustomHitbox","CustomHitbox" },  2, 0,     &PP_HasCustomHitbox, false },
    { "ProjectileProperties", { "LaserDistance","laserDistance" },   2, 0,     &PP_LaserDist,       false },
    { "ProjectileProperties", { "SpeedClampValue", "speedClampValue",
                                 "SpeedClamp", "speedClamp" },        4, 0,     &PP_SpeedClamp,      false },
    { "ProjectileProperties", { "AccelerationDelayValue", "accelerationDelayValue",
                                 "AccelDelay", "accelDelay" },        4, 0,     &PP_AccelDelay,      false },
    { "ProjectileProperties", { "AccelerationValue", "accelerationValue",
                                 "Acceleration", "acceleration" },    4, 0,     &PP_Acceleration,    false },
    { "ProjectileProperties", { "IsAccelerating", "isAccelerating" }, 2, 0, &PP_IsAccel,  false },
    // UseAcceleration is the per-shot enable, NOT an alias for IsAccelerating.
    // Keep separate so cached game-authored projectile paths receive correct props.
    { "ProjectileProperties", { "UseAcceleration", "useAcceleration" }, 2, 0, &PP_UseAccel, false },
    { "ProjectileProperties", { "AccelerationInv", "accelerationInv" },   2, 0,     &PP_AccelerationInv, false },
    { "ProjectileProperties", { "VelocityChangeRate", "velocityChangeRate" }, 2, 0, &PP_VelocityChangeRate, false },
    { "ProjectileProperties", { "VelocityChangeRateInv", "velocityChangeRateInv" }, 2, 0, &PP_VelocityChangeRateInv, false },
    { "ProjectileProperties", { "ProjectileMagnitude", "Magnitude",  "magnitude" },  3, 0, &PP_Magnitude,       false },
    { "ProjectileProperties", { "ProjectileFrequency", "Frequency",  "frequency" },  3, 0, &PP_Frequency,       false },
    { "ProjectileProperties", { "ProjectileAmplitude", "Amplitude",  "amplitude" },  3, 0, &PP_Amplitude,       false },
    { "ProjectileProperties", { "IsAmplitudeApplied", "HasCustomAmplitude","CustomAmplitude","customAmplitude" }, 4, 0, &PP_HasCustomAmplitude, false },
    { "ProjectileProperties", { "CollisionMult","collisionMult",
                                 "ConditionEffectAmount" },          3, 0,     &PP_CollMult,        false },
    { "ProjectileProperties", { "ProjectileTurnRate", "TurnRate","turnRate"},     3, 0, &PP_TurnRate,        false },
    { "ProjectileProperties", { "ProjectileTurnRateDelay","TurnRateDelay" },     2, 0, &PP_TurnRateDelay,   false },
    { "ProjectileProperties", { "ProjectileTurnStopTime", "TurnStopTime" },      2, 0, &PP_TurnStopTime,    false },
    { "ProjectileProperties", { "ProjectileCircleTurnAngle","CircleTurnAngle" }, 2, 0, &PP_CircleTurnAngle, false },
    { "ProjectileProperties", { "ProjectileCircleTurnDelay","CircleTurnDelay" }, 2, 0, &PP_CircleTurnDelay, false },
    { "ProjectileProperties", { "ProjectileTurnAcceleration", "TurnAcceleration","turnAcceleration" },       3, 0, &PP_TurnAcceleration,false },
    { "ProjectileProperties", { "ProjectileTurnAccelerationDelay", "TurnAccelerationDelay","turnAccelerationDelay"}, 3, 0, &PP_TurnAccelDelay,  false },
    { "ProjectileProperties", { "TurnClamp","turnClamp","ProjectileTurnClamp" }, 3, 0, &PP_TurnClamp,       false },
    { "ProjectileProperties", { "TurnAccelerationInv","turnAccelerationInv" },   2, 0, &PP_TurnAccelInv,    false },
    { "ProjectileProperties", { "IsTurning",  "isTurning","Turning"},            3, 0, &PP_IsTurning,       false },
    { "ProjectileProperties", { "IsTurningDelayed","isTurningDelayed" },         2, 0, &PP_IsTurningDelayed,false },

    // ── HBEAKBIHANL projectile instance (no shift) ───────────────────────────
    { "HBEAKBIHANL", { "HHFDCMIIIHF", "projRadius" },                            2, 0, &Hbeak_ProjRadius,      false },
    { "HBEAKBIHANL", { "FOMOIBCKIFP" },                                           1, 0, &Hbeak_ProjPropsPtr,    false },
    { "HBEAKBIHANL", { "FFFFKPDHEFP" },                                           1, 0, &Hbeak_Angle,           false },
    { "HBEAKBIHANL", { "DBNNDLKNECM" },                                           1, 0, &Hbeak_InstanceDamage,  false },
    { "HBEAKBIHANL", { "GLEGBLDBOJF" },                                           1, 0, &Hbeak_SpawnAgeMs,      false },
    { "HBEAKBIHANL", { "KDAJOMOFMJB" },                                           1, 0, &Hbeak_SpeedMul,        false },

    // ── HBEAKBIHANL noclip guard (no shift) ──────────────────────────────────
    // Fallback 0 = unresolved: ProjNoclip refuses to install its hook until this
    // resolves non-zero from live metadata (no reliable static fallback exists).
    { "HBEAKBIHANL", { "NPMECLDKGEF" },                                           1, 0, &Hbeak_NoclipGuard,     false },

    // ── ProjectileProperties continued ────────────────────────────────────────
    { "ProjectileProperties", { "CustomHitbox", "customHitbox" },                 2, 0, &PP_CustomHitbox,       false },
    { "ProjectileProperties", { "IsArmorPiercing", "armorPiercing" },             2, 0, &PP_IsArmorPiercing,    false },

    // ── ProjectileCustomHitbox (real names, no shift) ──────────────────────────
    { "ProjectileCustomHitbox", { "offsetX" },                                    1, 0, &CH_OffsetX,            false },
    { "ProjectileCustomHitbox", { "offsetY" },                                    1, 0, &CH_OffsetY,            false },

    // ── ViewHandler (real names, no shift) ─────────────────────────────────────
    { "ViewHandler", { "spriteShader" },                                          1, 0, &VH_SpriteShader,       false },
    { "ViewHandler", { "destroyEntity" },                                        1, 0, &VH_DestroyEntity,      false },

    // ── LKHPPBEGNOM facing angle (+0x50 ACTK) ────────────────────────────────
    // ECHAFMAAKMD (dump 0x1DC + kActk = 0x22C runtime). Written by SendShotPacketDetour.
    { "LKHPPBEGNOM", { "ECHAFMAAKMD" },                                           1, kActk, &Player_FacingAngle, false },

    // ── GJJCEFJMNMK throwable entity (no extra shift — runtime offsets in dump) ──
    // "GuiCanvasSwitcher" and "IAJJLFBDJGE" are BeeByte field names for origin/dest Vector2.
    // ACTK shift from LKHPPBEGNOM parent is already reflected in the dump layout.
    { "GJJCEFJMNMK", { "ICODPOCLEEL", "GuiCanvasSwitcher" },                      2, 0, &Gjj_OriginX,   false },
    { "GJJCEFJMNMK", { "IAJJLFBDJGE" },                                           1, 0, &Gjj_DestX,     false },
    { "GJJCEFJMNMK", { "EAICINLCCJK" },                                           1, 0, &Gjj_DurationMs,false },

    // ── FHOHCELBPDO visual throwable (LKFFPGONEOB base, no ACTK shift) ─────────
    { "FHOHCELBPDO", { "IEJNJENOCFP" },                                           1, 0, &Fhoh_DurationMs,false },
    { "FHOHCELBPDO", { "PBHMINMBFOM" },                                           1, 0, &Fhoh_DestX,    false },

    // ── COEFCBBIBMC ShowEffect packet (OODFCLBKDJJ base, no ACTK shift) ─────────
    { "COEFCBBIBMC", { "MIDADCIKEBD" },                                           1, 0, &Sfx_EffectType, false },
    { "COEFCBBIBMC", { "HNOKKCFIJHJ" },                                           1, 0, &Sfx_TargetObjId,false },
    { "COEFCBBIBMC", { "KMAIENKMNFA" },                                           1, 0, &Sfx_Pos1X,     false },
    { "COEFCBBIBMC", { "AEPOCACMOHI" },                                           1, 0, &Sfx_Pos2X,     false },
    { "COEFCBBIBMC", { "KPKIICOBBIM" },                                           1, 0, &Sfx_Duration,  false },

    // ── CustomExplosionEntrance (real XML field names, no shift) ─────────────────
    { "CustomExplosionEntrance", { "distance" },                                  1, 0, &Cee_Distance,  false },
    { "CustomExplosionEntrance", { "speed" },                                     1, 0, &Cee_Speed,     false },
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

static bool      s_allDone             = false;
static bool      s_giveUpFired         = false;
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

void EnsureAll()
{
    if (s_allDone) {
        Gjj_OriginY = Gjj_OriginX + 4;
        Gjj_DestY   = Gjj_DestX   + 4;
        Fhoh_DestY  = Fhoh_DestX  + 4;
        Sfx_Pos1Y   = Sfx_Pos1X   + 4;
        Sfx_Pos2Y   = Sfx_Pos2X   + 4;
        return;
    }

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
        for (int t = 0; t < e.tryCount && !found; ++t) {
            found = FindFieldOnHierarchy(klass, e.tryNames[t]);
            if (found) foundName = e.tryNames[t];
        }

        const uint32_t fallback = *e.outPtr;
        if (found) {
            const uint32_t resolved = static_cast<uint32_t>(il2cpp_field_get_offset(found)) + e.actkShift;
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

        FieldInfo* f = FindFieldOnHierarchy(klass, fe.fieldName);
        if (f) *fe.out = f;
        fe.done = true;
    }

    if (!anyPending) s_allDone = true;

    // ── Vector2 .y derivation pass ────────────────────────────────────────
    // Unity Vector2 lays out {float x, float y} contiguously.
    // il2cpp_field_get_offset gives us x; y is always x+4.
    // We re-derive every call so the Y is always consistent with the resolved X,
    // even before X has been resolved (fallback X + 4 == fallback Y).
    Gjj_OriginY = Gjj_OriginX + 4;
    Gjj_DestY   = Gjj_DestX   + 4;
    Fhoh_DestY  = Fhoh_DestX  + 4;
    Sfx_Pos1Y   = Sfx_Pos1X   + 4;
    Sfx_Pos2Y   = Sfx_Pos2X   + 4;
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
