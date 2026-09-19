#pragma once
#include <cstdint>
#include "ConditionWords.h"

// ─────────────────────────────────────────────────────────────────────────────
// RuntimeOffsets — centralised, table-driven IL2CPP field offset resolver.
//
// Call EnsureAll() once per frame (from DirectX.cpp dPresent, before any tab
// Tick).  Each variable is pre-initialised to its fallback value; EnsureAll()
// overwrites it the first time the class is found in IL2CPP metadata.
//
// No field is shifted. IL2CPP's generated code reads and writes every instance field at the offset
// its metadata records (measured on GameAssembly 86ad651b, 2026-09-14). The old "ACTK +0x50" model
// came from rows that named the wrong field: LKHPPBEGNOM keeps two Int32 trios 0x50 apart, so
// KJNHLADHEMH + 0x50 happened to be HP. The binding gate now refuses any adjustment.
//
// IL2CPP container layouts (List, Dictionary, Array, String) are .NET runtime
// invariants — they are NOT game-specific and are intentionally NOT here.
// ─────────────────────────────────────────────────────────────────────────────

namespace RuntimeOffsets {

    // Resolves all pending entries.  No-ops for entries already resolved.
    // Exits in O(1) once everything is settled (s_allDone fast-path).
    // Unresolvable entries (BeeByte renames) are given up after 5 s so
    // FindClassLoose is never called every frame indefinitely.
    void EnsureAll();

    // True once every entry resolved and every generated binding matches the live
    // process. Walks every loaded class, so call BindingsReady() on a frame path.
    bool ReadyForActivation();

    // BootGate's per-frame view of the same answer: latched once true, and re-checked
    // while false at most once a second, then once every five seconds after five failing
    // checks, so an unverified build costs one class enumeration per check instead of one
    // per frame. Always true on a build with no generated bindings, which is every
    // developer build.
    bool BindingsReady();

    // init_il2cpp reports here whether it installed BoundMethodFromName, the method lookup
    // that answers a bound method only at this build's address. With it, readiness leaves
    // a method row whose owner class is not loaded to that lookup.
    void SetMethodLookupAuthenticated(bool installed);
    bool MethodLookupAuthenticated();

    // True once the 5 s give-up timeout has fired.
    bool HasGivenUp();
    // True once resolution has SETTLED — every entry either resolved its class
    // (happy path, before the timeout) or was given up (stale path, at the
    // timeout). The single "name pass is done" signal the BootGate audits on.
    bool AllResolved();
    // Comma-separated class names that could not be resolved before give-up.
    // Empty string if every class resolved successfully.
    const char* GetUnresolvedClassNames();

    // ── Offset health report (in-GUI panel + diagnostics) ────────────────────
    // Per-offset resolution status, so a stale / BeeByte-renamed offset is
    // visible at a glance instead of silently falling back to a hardcoded value.
    enum class OffsetState : uint8_t {
        Pending,           // class not resolved yet (still retrying)
        ResolvedMatch,     // resolved from live metadata, == fallback (healthy)
        ResolvedShifted,   // resolved from live metadata, != fallback (auto-corrected a stale fallback)
        FallbackFieldName, // class found but field NAME not found (BeeByte renamed -> STALE fallback)
        FallbackGaveUp,    // class never resolved before timeout -> STALE fallback
        Suspect,           // value failed a live sanity check (resolved-to-wrong-field or stale)
    };
    struct OffsetReportRow {
        const char* className;
        const char* fieldName;
        uint32_t    fallback;   // the hardcoded fallback value
        uint32_t    value;      // the value currently in use
        OffsetState state;
    };
    // Fills `out` with up to `maxRows` rows; returns the TOTAL offset count.
    int  GetOffsetReport(OffsetReportRow* out, int maxRows);
    // Health tallies across all offsets.
    void GetOffsetSummary(int& resolved, int& usingFallback, int& suspect, int& pending);
    // "ok" when every ProjectileProperties offset came from live name resolution,
    // else "baked:<n>" — the baked PP_* defaults are stale against live 86ad651b,
    // so this decides whether the projectile sensor read fields or junk.
    const char* ProjectilePropsWitness();
    // Flag a specific offset variable SUSPECT from a live sanity check.
    void MarkSuspect(const uint32_t* offsetVar);

    // Health state for a specific offset variable (reverse lookup by address).
    // Returns OffsetState::Pending if the variable is not a table entry.
    OffsetState GetOffsetStateFor(const uint32_t* offsetVar);

    // Fail-closed gate for FLOAT WRITES that fail OPEN (a wrong float offset writes
    // successfully onto another valid, writable float — silent corruption). Returns
    // true ONLY when the offset was resolved from live IL2CPP metadata this session
    // (ResolvedMatch or ResolvedShifted). Fallback / Suspect / Pending -> false ->
    // the caller MUST refuse the write. Reads may still use the fallback; this gate
    // is specifically for writes.
    bool IsFieldWriteTrusted(const uint32_t* offsetVar);

    // Live sanity checks: validate the critical offsets against plausible ranges
    // and MarkSuspect any that read CLEAR garbage (a stale offset usually reads a
    // wildly out-of-range int). The caller passes the live values it already has,
    // so this stays decoupled from the read path.
    void SanityCheckPlayerStats(int32_t hp, int32_t maxHp, int32_t defense);
    void SanityCheckProjDamage(int32_t sampledDamage);

    // ── Cached FieldInfo pointers ─────────────────────────────────────────────
    // Non-null once EnsureAll() has seen the owning class in IL2CPP metadata.
    // Use with ReadField<T> below instead of raw pointer arithmetic.
    // FI_HP is a misnomer kept for SkinChanger: KJNHLADHEMH is stat 25's field (Player_Stat25), not HP.
    extern FieldInfo* FI_HP;            // KJNHLADHEMH — stat 25 / skin override (LKHPPBEGNOM)
    extern FieldInfo* FI_MaxHP;         // OADOHPKBPJB — max HP    (LKHPPBEGNOM)
    extern FieldInfo* FI_Defense;       // NCBIICBDGAG — defense   (LKHPPBEGNOM)
    extern FieldInfo* FI_CurMP;         // FMHMGKEPIDN — current MP (float, FKALGHJIADI)
    extern FieldInfo* FI_MaxMP;         // NEDCKPIIIPN — max MP     (FKALGHJIADI)
    // PPBLNMIMIFP — bool abilityReady (FKALGHJIADI dump 0x515 / runtime 0x565):
    //   true when the ability can be fired this tick. Server-controlled per-tick flag.
    extern FieldInfo* FI_AbilityReady;
    // BINDBHJLPMG — bool invincible (FKALGHJIADI dump 0x459 / runtime 0x4A9):
    //   short-duration hit invulnerability set from OnNewTick isInvincible param.
    //   Distinct from the COHCKAPOLCA condition-bit 23 Invincible.
    extern FieldInfo* FI_LocalInvincible;
    extern FieldInfo* FI_ObjType;

    // SEH-wrapped il2cpp_field_get_value.
    // Returns false when fi is null, obj is null, or an access violation occurs.
    template<typename T>
    inline bool ReadField(Il2CppObject* obj, FieldInfo* fi, T& out)
    {
        if (!fi || !obj) return false;
        __try {
            il2cpp_field_get_value(obj, fi, &out);
            return true;
        }
        __except (EXCEPTION_EXECUTE_HANDLER) {
            return false;
        }
    }

    // ── KJMONHENJEN (no ACTK shift) ──────────────────────────────────────────
    extern uint32_t PosX;           // CLFEOFKBNEJ   fallback 0x3C
    extern uint32_t PosY;           // PKEECFNFEIO   fallback 0x40
    extern uint32_t ObjType;        // HFDNHJFNEKA   fallback 0x30
    extern uint32_t ObjProps;       // OBAKMCCDBJA   fallback 0x18
    extern uint32_t KJ_ViewHandler; // MPGOFIHIDML   fallback 0x10  (ViewHandler component pointer)
    extern uint32_t KJ_SkinWidthObj;// LGDCEJKHGFJ   fallback 0x28  (IPKAMAAPAGA ref)
    extern uint32_t ObjId;          // HHPOJBFICAH   fallback 0x34  (objectId Int32)
    extern uint32_t KJ_BaseRadius;  // IOKKOCEAJNA   fallback 0x44  (base bullet radius Single)
    extern uint32_t KJ_Scale;       // KEDBLBJIKCB   fallback 0x74  (scale float3 — first component)
    extern uint32_t KJ_Float3Pos;   // DGNPJNFGFPE   fallback 0x68  (Unity.Mathematics.float3 world position — written on teleport/move)
    extern uint32_t KJ_TileRef;     // EOKJOGFPLOA   fallback 0x58  (BGAIOPJMHLO* current tile)
    extern uint32_t KJ_DictObjectId;// FDNHINDAEHK   fallback 0xC0  (dict-key object id; NOT ObjId/HHPOJBFICAH)

    // ── LKHPPBEGNOM own fields ──────────────────────────────────────────────
    extern uint32_t HP;         // ABCPKBGJPEP   current HP (stat 1), fallback 0x20C
    extern uint32_t MaxHP;     // OADOHPKBPJB   max HP (stat 0), fallback 0x208
    extern uint32_t Defense;    // NCBIICBDGAG   total defense (stat 21), fallback 0x1B8
    extern uint32_t Player_Stat25; // KJNHLADHEMH stat 25's field (SkinChanger's skin override), fallback 0x1BC
    extern uint32_t PlayerIGN;  // DPGEBOCBKEF   fallback 0x178
    // MapObject (LKHPPBEGNOM) Int32[3] — first two elements = 64-bit status bitmask.
    // The game's own condition checks and constructor use the metadata offset.
    extern uint32_t MoConditions; // COHCKAPOLCA   fallback 0x250
    // ECGPFJKCCAN — Vector2 velocity stored on LKHPPBEGNOM (and all PMMFLLAIPGN/enemy subclasses).
    // vx = *(entity + MoVelocity), vy = *(entity + MoVelocity + 4).
    // Fallback 0 = not yet resolved; AutoAim will fall back to position-history velocity.
    extern uint32_t MoVelocity;   // ECGPFJKCCAN   fallback 0
    extern uint32_t MoObjectProps; // KKENJFFDMPO   fallback 0x1C8
    extern uint32_t PlayerCollisionProps; // GGBCADDBAPN fallback 0x2F0

    // ── ConditionEffects — bitmask values matching DIA4A SDK.h / Flash client layout ─────────────
    // COHCKAPOLCA UInt32[2] encodes a 64-bit bitmask split across 31-bit words.
    // Use GetFullConditions(w0, w1) to combine, then HasCondition(full, effect) to test.
    enum class ConditionEffects : uint64_t
    {
        None             = 0,
        Dead             = 1ull << 0,
        Quiet            = 1ull << 1,
        Weak             = 1ull << 2,
        Slowed           = 1ull << 3,
        Sick             = 1ull << 4,
        Dazed            = 1ull << 5,
        Stunned          = 1ull << 6,
        Blind            = 1ull << 7,
        Hallucinating    = 1ull << 8,
        Drunk            = 1ull << 9,
        Confused         = 1ull << 10,
        StunImmune       = 1ull << 11,
        Invisible        = 1ull << 12,
        Paralyzed        = 1ull << 13,
        Speedy           = 1ull << 14,
        Bleeding         = 1ull << 15,
        ArmorBreakImmune = 1ull << 16,
        Healing          = 1ull << 17,
        Damaging         = 1ull << 18,
        Berserk          = 1ull << 19,
        Paused           = 1ull << 20,
        Stasis           = 1ull << 21,
        StasisImmune     = 1ull << 22,
        Invincible       = 1ull << 23,
        Invulnerable     = 1ull << 24,
        Armored          = 1ull << 25,
        ArmorBroken      = 1ull << 26,
        Hexed            = 1ull << 27,
        NinjaSpeedy      = 1ull << 28,
        Unstable         = 1ull << 29,
        Darkness         = 1ull << 30,
        SlowedImmune     = 1ull << 31,
        DazedImmune      = 1ull << 32,
        ParalyzeImmune   = 1ull << 33,
        Petrified        = 1ull << 34,
        PetrifiedImmune  = 1ull << 35,
        PetDisable       = 1ull << 36,
        Curse            = 1ull << 37,
        CurseImmune      = 1ull << 38,
        HpBoost          = 1ull << 39,
        MpBoost          = 1ull << 40,
        AttBoost         = 1ull << 41,
        DefBoost         = 1ull << 42,
        SpdBoost         = 1ull << 43,
        VitBoost         = 1ull << 44,
        WisBoost         = 1ull << 45,
        DexBoost         = 1ull << 46,
        Silenced         = 1ull << 47,
        Exposed          = 1ull << 48,
        Energized        = 1ull << 49,
        InCombat         = 1ull << 58,
    };

    // Combine COHCKAPOLCA[0] and COHCKAPOLCA[1] into a single uint64_t. The game
    // batches 32 bits per word (its bit-63 check tests word1 & 0x80000000), so
    // word 1 starts at bit 32 — the old `<< 31` put every bit above 31 one low.
    inline uint64_t GetFullConditions(uint32_t w0, uint32_t w1)
    {
        return RuntimeConditions::Combine(w0, w1);
    }

    // Test a single condition effect. Matches DIA4A MapObject::HasCondition().
    inline bool HasCondition(uint64_t fullConds, ConditionEffects effect)
    {
        return (fullConds & static_cast<uint64_t>(effect)) != 0;
    }

    // Read conditions[0..1] from a MapObject* / Character* / Player* (SEH-safe). True if no AV.
    bool TryReadMapObjectConditions(void* mapObjectPtr, uint32_t* outWord0, uint32_t* outWord1);
    // Human-readable active effect names from the combined condition mask.
    void FormatMapObjectConditionMask(uint32_t word0, uint32_t word1, char* buf, size_t bufSize);
    // True if the entity cannot be damaged and should be skipped by auto-aim:
    //   Stasis (bit 21, frozen + immune), Invincible (bit 23), Invulnerable (bit 24).
    // Confirmed from Flash client: condition_ applies to all GameObjects incl. enemies.
    bool MapObjectConditionsMakeUntargetable(uint32_t word0, uint32_t word1);

    // ── Player fields (textures on LKHPPBEGNOM; the rest FKALGHJIADI) ───────
    extern uint32_t Tex1;             // BAEKCAIIKNO   texture 1 (stat 32), LKHPPBEGNOM, fallback 0x25C
    extern uint32_t Tex2;             // PLABGIEFNBH   texture 2 (stat 33), LKHPPBEGNOM, fallback 0x260
    extern uint32_t CurMP;            // FMHMGKEPIDN   current MP (stat 4, Single), fallback 0x564
    extern uint32_t MaxMP;            // NEDCKPIIIPN   max MP (stat 3), fallback 0x560
    // DAGEMHFLJLK / BINDBHJLPMG / PPBLNMIMIFP — bools named groundDamageImmune, invincible and
    // abilityReady by old tooling. Bound at their metadata offsets; the meanings are not proven.
    extern uint32_t GroundDmgImmune;
    extern uint32_t LocalInvincible;
    extern uint32_t AbilityReady;
    // CGCMALPMMJL — a bool the game sets and clears; "moving" is not proven (see RuntimeOffsets.cpp).
    extern uint32_t Player_Moving;
    // World velocity, LKHPPBEGNOM.ECGPFJKCCAN (tiles per ms): the player tick writes its rotated input
    // there. MoveDirY = MoveDirX + 4, derived in EnsureAll. A direction, not a unit vector.
    extern uint32_t Player_MoveDirX;
    extern uint32_t Player_MoveDirY;
    // BHJFNEAHAOE — float SPD stat (stat 22), read by the game's speed getter, fallback 0x480.
    extern uint32_t Player_Spd;

    // ── Player diagnostic stats (FKALGHJIADI), used by PlayerTAB for display ──
    extern uint32_t PlayerGuildName;  // NFJGJKLPLBA   fallback 0x470  (Il2CppString* — GUILD name;
                                      // verified 2026-08-19 via builds.him.is: InvitedToGuild {name, guildName}
                                      // packet's 2nd string is NFJGJKLPLBA. Player IGN is PlayerIGN (0x178).
    extern uint32_t PlayerClassNum;   // KABPJBJPGCM   fallback 0x4B0  (int32)
    extern uint32_t PlayerGuildRank;  // MPEPBMGKGHL   fallback 0x530  (int32, stat 63)
    extern uint32_t PlayerAtk;        // HCMECDPHEMC   fallback 0x474  (int32)
    extern uint32_t PlayerDex;        // GDNEBFDDDKM   fallback 0x47C  (Single on 86ad651b, stat 28)
    extern uint32_t PlayerVit;        // CGFPEPCKKOK   fallback 0x480  (int32)
    extern uint32_t PlayerWis;        // HDCDGHKGLDI   fallback 0x484  (int32)
    extern uint32_t PlayerCondInt;    // MPJGAPJBBBF   fallback 0x514  (int32, single-int condition)
    extern uint32_t PlayerEquipMgr;   // AJJJBDBNBLM   fallback 0x668  (EquipmentManager pointer)

    // ── EquipmentManager / ItemSlot (namespaced UI classes, no ACTK shift) ──
    extern uint32_t EM_EquipSlots;    // "equipmentSlots"  fallback 0x48  (ItemSlot[] on EquipmentManager)
    extern uint32_t Item_ObjProps;    // HLJFBHLMANJ       fallback 0x58  (ObjectProperties* on ItemSlot)
    extern uint32_t Item_ObjType;     // INAAIAHOEFE       fallback 0x60  (int32 type id on ItemSlot)

    // ── ApplicationManager (no ACTK shift) ───────────────────────────────────
    // Resolved in GameState.cpp via type-scan (field name uses <>k__BackingField
    // syntax that changes with each BeeByte pass — type-scan is rename-proof).
    extern uint32_t AppMgr_WorldMgr;   // <CHDFAEBMILI>k__BackingField  fallback 0xC0

    // ── CameraManager (no ACTK shift) ────────────────────────────────────────
    extern uint32_t CM_Transform;      // mainCameraContainer  Transform*   fallback 0x28
    extern uint32_t CM_UnityCam;       // KNAIAEFDCLM          Camera*      fallback 0x50

    // ── HJMBOMEHGDJ WorldManager (no shift) ─────────────────────────────────
    extern uint32_t WM_Local;       // OCLNLBHDEFK   fallback 0x48
    extern uint32_t WM_AllDict;     // DFALIKKKGLI   fallback 0xB0
    extern uint32_t WM_MapDictA;    // KHIHFNACEKJ   fallback 0xB8
    extern uint32_t WM_MapDictB;    // CIOIHEOEAEB   fallback 0xC0
    extern uint32_t WM_KjmonList;   // ONABHKFOJNE   fallback 0xE8
    extern uint32_t WM_TileArr;     // NOJEHIAOAJM   fallback 0x58
    extern uint32_t WM_TileList;    // IMAOBDCMPHC   fallback 0x60
    extern uint32_t WM_TickId;      // FIAJOKGHGGK   fallback 0xD8  (world tick counter UInt32)
    extern uint32_t WM_TickId2;     // HOMNPDGNOMO   fallback 0xDC  (secondary tick UInt32)

    // ── BGAIOPJMHLO tile instance (no shift) ────────────────────────────────
    extern uint32_t TileX;          // CLFEOFKBNEJ   fallback 0x38
    extern uint32_t TileY;          // PKEECFNFEIO   fallback 0x3C
    extern uint32_t TileType;       // JOFEAFJPJEM   fallback 0x40
    extern uint32_t TileProps;      // KEOKJCIJIAD   fallback 0x50
    extern uint32_t Sq_Layer;       // EBCLNFDKKEH   fallback 0x44  (int32 layer enum; ProjNoclip writes 37)
    extern uint32_t Sq_DamageCached;// EAPMKCKMNDI   fallback 0x10  (int32 current-damage cache)
    extern uint32_t Sq_Cover;       // JGMBPFJEGAH   fallback 0x48  (ref; non-null = square has cover)

    // ── CMFPKCJHKKB XmlTileProperties (no shift) ────────────────────────────
    extern uint32_t TP_Speed;       // MFEJMAABLIL   fallback 0x50
    extern uint32_t TP_Sink;        // BMGKCKHOIOH   fallback 0x58
    extern uint32_t TP_NoWalk;      // LFKLKFIEMAH   fallback 0x78
    extern uint32_t TP_MinDmg;      // MCMDAGNIGEB   fallback 0xB0
    extern uint32_t TP_MaxDmg;      // KHMCMAHEBNG   fallback 0xB8
    extern uint32_t TP_Push;        // FNCCEGBHNKG   fallback 0xC8
    extern uint32_t TP_Alpha;       // LCHPDCNHJCA   fallback 0xD0
    extern uint32_t TP_Sinking;     // JKIDGAADOLC   fallback 0xD8

    // ── ObjectProperties (real field names, no shift) ────────────────────────
    extern uint32_t OP_IdStr;           // "id"                       fallback 0x38
    extern uint32_t OP_NoCover;         // "NoCoverElement"           fallback 0x98
    // "InvincibleElement" — XML <Invincible/> string field. Non-null pointer = entity is
    // permanently invincible (no runtime condition bit required). dump 0x450 + 0x10 = 0x460.
    extern uint32_t OP_InvincibleElem;  // "InvincibleElement"        fallback 0x460
    extern uint32_t OP_NoWallRpt;   // "NoWallTextureRepeat..."   fallback 0x210
    extern uint32_t OP_OccupySq;    // "occupySquare"             fallback 0x69A
    extern uint32_t OP_FullOcc;     // "fullOccupy"               fallback 0x6D1
    extern uint32_t OP_EnemyOcc;    // "enemyOccupySquare"        fallback 0x6D2
    extern uint32_t OP_IsEnemy;     // "isEnemy"                  fallback 0x6D1 (live-client verified; stale dump said 0x6C9)
    extern uint32_t OP_IsStatic;    // "isStatic"                 fallback 0x6D3
    extern uint32_t OP_BlockProj;   // "blockProjectiles"         fallback 0x6D4
    // "noHealthBar" — true when the entity type has no visible HP bar. Enemies with this set
    // are not attackable characters and should be skipped. dump 0x6C6 + 0x10 = 0x6D6.
    extern uint32_t OP_NoHealthBar;     // "noHealthBar"              fallback 0x6D6
    extern uint32_t OP_ProtGnd;     // "protectFromGroundDamage"  fallback 0x6DC
    extern uint32_t OP_ProtSink;    // "protectFromSink"          fallback 0x6DD
    extern uint32_t OP_Flying;      // "flying"                   fallback 0x6E4
    extern uint32_t OP_ConnectT;    // "connectType"              fallback 0x754
    // "Projectiles" — ProjectileProperties[] array pointer on item
    // ObjectProperties. For weapon items, [0] is the primary
    // projectile from which passive consumers can read speed/lifetime
    // to derive weapon range without waiting for the player's first
    // shot. Same no-shift path as the other OP fields.
    extern uint32_t OP_Projectiles; // "Projectiles"              fallback 0x1C0
    extern uint32_t OP_CollRadiusMult; // "collisionRadiusMultiplier"  fallback 0x798

    // ── ProjectileProperties (real field names, no shift) ────────────────────
    extern uint32_t PP_Lifetime;        // "Lifetime"          fallback 0x158
    extern uint32_t PP_Speed;           // "ProjectileSpeed"   fallback 0x160
    extern uint32_t PP_IsWavy;          // "IsWavy"            fallback 0x164
    extern uint32_t PP_IsBoomerang;     // "IsBoomerang"       fallback 0x165
    extern uint32_t PP_IsParametric;    // "IsParametric"      fallback 0x168
    extern uint32_t PP_HasCustomHitbox; // "HasCustomHitbox"   fallback 0x16D
    extern uint32_t PP_LaserDist;       // "LaserDistance"     fallback 0x170
    extern uint32_t PP_SpeedClamp;      // SpeedClampValue, SpeedClamp, …  fallback 0x174
    extern uint32_t PP_AccelDelay;      // AccelerationDelayValue, AccelDelay, …  fallback 0x178
    extern uint32_t PP_Acceleration;    // AccelerationValue, Acceleration, …    fallback 0x17C
    extern uint32_t PP_AccelerationInv; // AccelerationInv                      fallback 0x180
    extern uint32_t PP_IsAccel;         // IsAccelerating (type-level "can accelerate") fallback 0x184
    extern uint32_t PP_UseAccel;        // UseAcceleration (per-shot "DO accelerate") fallback 0x185
    extern uint32_t PP_VelocityChangeRate; // VelocityChangeRate               fallback 0x188
    extern uint32_t PP_VelocityChangeRateInv; // VelocityChangeRateInv         fallback 0x18C
    extern uint32_t PP_Magnitude;       // "Magnitude"         fallback 0x194
    extern uint32_t PP_Frequency;       // "Frequency"         fallback 0x198
    extern uint32_t PP_Amplitude;       // "Amplitude"         fallback 0x19C
    extern uint32_t PP_HasCustomAmplitude; // "HasCustomAmplitude" fallback 0x1A0 — if true, wavy uses Amplitude/Frequency fields instead of hardcoded π/64
    extern uint32_t PP_CollMult;           // "CollisionMult"              fallback 0xC0
    extern uint32_t PP_TurnRate;           // "ProjectileTurnRate"         fallback 0xD4
    extern uint32_t PP_TurnRateDelay;      // "ProjectileTurnRateDelay"    fallback 0xD8 — seconds; normalize ×1000
    extern uint32_t PP_TurnStopTime;       // "ProjectileTurnStopTime"     fallback 0xE8 — ms; omega = TurnRate/TurnStopTime
    extern uint32_t PP_CircleTurnAngle;    // "ProjectileCircleTurnAngle"  fallback 0xEC — arc-angle for IsTurningCircled path
    extern uint32_t PP_CircleTurnDelay;    // "ProjectileCircleTurnDelay"  fallback 0xF0 — ms straight-line before arc starts
    extern uint32_t PP_TurnAcceleration;   // "TurnAcceleration"           fallback 0xDC — boomerang turn accel rate
    extern uint32_t PP_TurnAccelDelay;     // "TurnAccelerationDelay"      fallback 0xE0 — time (sec) before boomerang kicks in
    extern uint32_t PP_TurnClamp;          // "TurnClamp"                  fallback 0xE4 — target turn rate for boomerang
    extern uint32_t PP_TurnAccelInv;       // "TurnAccelerationInv"        fallback 0x1AC — threshold scale for boomerang
    extern uint32_t PP_IsTurning;          // "IsTurning"                  fallback 0x1B0
    extern uint32_t PP_IsTurningDelayed;   // "IsTurningDelayed"           fallback 0x1B2 — uses TurnRateDelay before arc

    // HBEAKBIHANL — HHFDCMIIIHF (projRadius / Chebyshev T half-edge at runtime). Resolved via IL2CPP;
    // BeeByte name first; fallback 0x1D4 matches Il2CppInspector dump.
    extern uint32_t Hbeak_ProjRadius;

    // ── HBEAKBIHANL projectile instance (no shift) ───────────────────────────
    extern uint32_t Hbeak_ProjPropsPtr;    // FOMOIBCKIFP  fallback 0x118  (per-shot ProjectileProperties override)
    extern uint32_t Hbeak_Angle;           // FFFFKPDHEFP  fallback 0x148  (spawn angle Single)
    extern uint32_t Hbeak_InstanceDamage;  // DBNNDLKNECM  fallback 0x174  (per-instance damage Int32)
    extern uint32_t Hbeak_SpawnAgeMs;      // GLEGBLDBOJF  fallback 0x16C  (spawn-age ms; path anchoring / expiry)
    extern uint32_t Hbeak_NoclipGuard;     // NPMECLDKGEF  fallback 0     (bool; 0 = unresolved — ProjNoclip
                                           // MUST NOT install until this is non-zero, preserving today's gate)

    // HBEAKBIHANL — KDAJOMOFMJB (Flash speedMul_ per-shot projectile speed multiplier).
    // Resolved via IL2CPP; fallback 0 = unresolved (consumer treats as speed-mul 1.0,
    // exactly like the old private resolver and like Hbeak_NoclipGuard).
    extern uint32_t Hbeak_SpeedMul;   // KDAJOMOFMJB  fallback 0

    // ── ProjectileProperties continued ───────────────────────────────────────
    extern uint32_t PP_CustomHitbox;       // "CustomHitbox"  fallback 0x148  (ProjectileCustomHitbox* reference)
    extern uint32_t PP_IsArmorPiercing;    // "IsArmorPiercing"  fallback 0x138

    // ── ProjectileCustomHitbox (real field names, no shift) ──────────────────
    extern uint32_t CH_OffsetX;    // "offsetX"      fallback 0x10
    extern uint32_t CH_OffsetY;    // "offsetY"      fallback 0x14

    // ── ViewHandler (real field names, no shift) ─────────────────────────────
    extern uint32_t VH_SpriteShader;  // "spriteShader"  fallback 0x60
    extern uint32_t VH_DestroyEntity; // "destroyEntity" fallback 0x88

    // ── LKHPPBEGNOM continued — attack angle ────────────────────────────────
    // IHEFJFFIJOL — Single the game's shoot routine stores its angle in; the sprite faces it.
    // Written by SendShotPacketDetour to match the redirected shot.
    extern uint32_t Player_FacingAngle;  // "IHEFJFFIJOL"  fallback 0x184

    // ── GJJCEFJMNMK throwable entity (all parent ACTK shifts already baked into dump) ──
    // Fields live in the subclass region beyond LKHPPBEGNOM's shifted zone;
    // il2cpp_field_get_offset returns the runtime-ready value directly (actkShift=0).
    extern uint32_t Gjj_OriginX;    // "GuiCanvasSwitcher".x   fallback 0x368
    extern uint32_t Gjj_OriginY;    // "GuiCanvasSwitcher".y   fallback 0x36C (= OriginX+4)
    extern uint32_t Gjj_DestX;      // "IAJJLFBDJGE".x         fallback 0x370
    extern uint32_t Gjj_DestY;      // "IAJJLFBDJGE".y         fallback 0x374 (= DestX+4)
    extern uint32_t Gjj_DurationMs; // "EAICINLCCJK" int       fallback 0x388

    // ── FHOHCELBPDO visual throwable (LKFFPGONEOB base — no ACTK shift) ─────
    // Origin is inherited PosX/PosY from the BMO base (= RuntimeOffsets::PosX/PosY).
    extern uint32_t Fhoh_DurationMs; // "IEJNJENOCFP" int       fallback 0x140
    extern uint32_t Fhoh_DestX;      // "PBHMINMBFOM".x          fallback 0x154
    extern uint32_t Fhoh_DestY;      // "PBHMINMBFOM".y          fallback 0x158 (= DestX+4)

    // ── COEFCBBIBMC ShowEffect packet (OODFCLBKDJJ base — no ACTK shift) ────
    // Used by AoeTracking::ShowEffectDetour to decode effect type, positions, duration.
    //
    // The two positions are REFERENCE-TYPE POINTERS to FFLIAABAAFP (WorldPos), not
    // inline Vector2s — reading floats at Sfx_Pos1Ptr/Sfx_Pos2Ptr reads the halves
    // of a pointer. Deref, then read x/y at Sfx_WposX / Sfx_WposY.
    extern uint32_t Sfx_EffectType;  // "MIDADCIKEBD" enum/int   fallback 0x10
    extern uint32_t Sfx_TargetObjId; // "HNOKKCFIJHJ" int        fallback 0x14
    extern uint32_t Sfx_Pos1Ptr;     // "KMAIENKMNFA" FFLIAABAAFP* fallback 0x18
    extern uint32_t Sfx_Pos2Ptr;     // "AEPOCACMOHI" FFLIAABAAFP* fallback 0x20 (null unless THROW)
    extern uint32_t Sfx_Duration;    // "KPKIICOBBIM" float      fallback 0x2C

    // ── FFLIAABAAFP WorldPos (reference type) ────────────────────────────────
    // x/y are auto-property backing fields whose obfuscated names re-roll every
    // build, so they are located by SHAPE (exactly two adjacent instance floats)
    // rather than by name. Sfx_WposResolved says whether that scan succeeded —
    // consumers that would write world data from an unverified layout must fail
    // closed on it, NOT trust the fallback.
    extern uint32_t Sfx_WposX;        // x backing field         fallback 0x20
    extern uint32_t Sfx_WposY;        // y backing field         fallback 0x24 (= WposX+4)
    extern bool     Sfx_WposResolved; // false until the float pair is confirmed

    // ── CustomExplosionEntrance (real XML field names, no shift) ─────────────
    extern uint32_t Cee_Distance;    // "distance" float         fallback 0x38
    extern uint32_t Cee_Speed;       // "speed" float            fallback 0x3C

    // ── MANUAL OFFSETS — no known IL2CPP field name; NOT table-resolved.  ──────
    // These were reverse-engineered numerically (disassembly / .lst / probing).
    // They do NOT self-heal and do NOT appear in OFFSET HEALTH. After a game
    // patch, re-derive each one (source cited per line) and update here.
    // constexpr (not extern) — nothing ever overwrites them at runtime.
    inline constexpr uint32_t Char_ProjSpeedMul    = 0x188; // player proj-speed mult (WeaponProfile RE)
    inline constexpr uint32_t Char_ProjLifetimeMul = 0x18C; // player proj-lifetime mult (WeaponProfile RE)
    inline constexpr uint32_t Char_RangeMul        = 0x6B8; // player range mult (WeaponProfile RE)
    inline constexpr uint32_t PP_ProjId            = 0x15C; // ProjectileProperties projectile id (WeaponProfile RE)
    // Shot_Angle (0x1C) DELETED — docs/plans/108. It was ServerPlayerShoot.angle,
    // but its one consumer (AimHooks' SendShotPacketDetour) held a 0x18-byte
    // UniqueDataContainer, so the write was 4 bytes out of bounds. The redirect
    // is angle-only now and needs no shot-packet offset at all.
    inline constexpr uint32_t Player_CondRaw       = 0x440; // raw [this+0x440] HasConditionEffect reads (.lst)
    // WorldManager diagnostic words (WorldTAB World-tab display only):
    inline constexpr uint32_t WM_DiagE0  = 0xE0;  // uint32
    inline constexpr uint32_t WM_DiagF4  = 0xF4;  // float
    inline constexpr uint32_t WM_DiagF8  = 0xF8;  // float
    inline constexpr uint32_t WM_DiagFC  = 0xFC;  // int32
    inline constexpr uint32_t WM_Diag100 = 0x100; // int32

} // namespace RuntimeOffsets
