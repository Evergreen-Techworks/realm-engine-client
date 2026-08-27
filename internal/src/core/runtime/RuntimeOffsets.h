#pragma once
#include <cstdint>

// ─────────────────────────────────────────────────────────────────────────────
// RuntimeOffsets — centralised, table-driven IL2CPP field offset resolver.
//
// Call EnsureAll() once per frame (from DirectX.cpp dPresent, before any tab
// Tick).  Each variable is pre-initialised to its fallback value; EnsureAll()
// overwrites it the first time the class is found in IL2CPP metadata.
//
// ACTK anti-tamper model (runtime = dump + shift):
//   KJMONHENJEN base fields           — no shift  (0x00)
//   LKHPPBEGNOM own fields >= 0x1B8d  — +0x50
//   FKALGHJIADI own fields            — +0x50
//   HJMBOMEHGDJ / BGAIOPJMHLO /
//     CMFPKCJHKKB / ObjectProperties /
//     ProjectileProperties            — no shift  (il2cpp returns live value)
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

    // True once the 5 s give-up timeout has fired.
    bool HasGivenUp();
    // True once resolution has SETTLED — every entry either resolved its class
    // (happy path, before the timeout) or was given up (stale path, at the
    // timeout). The single "name pass is done" signal the BootGate audits on.
    bool AllResolved();
    /// True once the boot deadline has passed: every renamed-field verdict is in
    /// and BootGate may proceed, even if a lazily-registered class is still
    /// pending. Use this, not AllResolved(), to gate boot progress.
    bool BootSettled();
    /// Bumped whenever an entry resolves AFTER the boot deadline (a lazily
    /// registered class finally appeared). BootGate re-audits when it changes so
    /// a fail-closed feature gate can reopen.
    uint32_t LateResolveGeneration();
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
    // Flag a specific offset variable SUSPECT from a live sanity check.
    void MarkSuspect(const uint32_t* offsetVar);

    // Live sanity checks: validate the critical offsets against plausible ranges
    // and MarkSuspect any that read CLEAR garbage (a stale offset usually reads a
    // wildly out-of-range int). The caller passes the live values it already has,
    // so this stays decoupled from the read path.
    void SanityCheckPlayerStats(int32_t hp, int32_t maxHp, int32_t defense);
    void SanityCheckProjDamage(int32_t sampledDamage);

    // ── Cached FieldInfo pointers ─────────────────────────────────────────────
    // Non-null once EnsureAll() has seen the owning class in IL2CPP metadata.
    // Use with ReadField<T> below instead of raw pointer arithmetic.
    extern FieldInfo* FI_HP;            // KJNHLADHEMH — current HP (LKHPPBEGNOM)
    extern FieldInfo* FI_MaxHP;         // NCBIICBDGAG — max HP    (LKHPPBEGNOM)
    extern FieldInfo* FI_Defense;       // HODJPKFINKF — defense   (LKHPPBEGNOM)
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

    // ── LKHPPBEGNOM own fields (+0x50 ACTK) ─────────────────────────────────
    extern uint32_t HP;         // KJNHLADHEMH   current HP, fallback 0x20C
    extern uint32_t MaxHP;     // NCBIICBDGAG   max HP, fallback 0x208
    extern uint32_t Defense;    // HODJPKFINKF   fallback 0x210
    extern uint32_t PlayerIGN;  // DPGEBOCBKEF   fallback 0x178  (below ACTK point, no shift)
    // MapObject (LKHPPBEGNOM) UInt32[] — first two elements = 64-bit status bitmask (offset_map.md)
    extern uint32_t MoConditions; // COHCKAPOLCA   fallback 0x2A0 (dump 0x248 + ACTK 0x50)
    // ECGPFJKCCAN — Vector2 velocity stored on LKHPPBEGNOM (and all PMMFLLAIPGN/enemy subclasses).
    // vx = *(entity + MoVelocity), vy = *(entity + MoVelocity + 4).
    // Fallback 0 = not yet resolved; AutoAim will fall back to position-history velocity.
    extern uint32_t MoVelocity;   // ECGPFJKCCAN   fallback 0x2C8
    extern uint32_t MoObjectProps; // KKENJFFDMPO   fallback 0x1C8 (runtime metadata, no ACTK shift)
    // Projectile tuning multipliers on MapObject, read by WeaponCalibrator.
    // Both are plain floats below the ACTK expansion point (no shift).
    extern uint32_t Mo_ProjSpeedMul;    // KFBOONBAFAC   fallback 0x188
    extern uint32_t Mo_ProjLifetimeMul; // CCPNMNIOMED   fallback 0x18C
    extern uint32_t PlayerCollisionProps; // GGBCADDBAPN fallback 0x2F8 (not ACTK-shifted)

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

    // Combine COHCKAPOLCA[0] and COHCKAPOLCA[1] into a single uint64_t.
    // Matches DIA4A MapObject::GetFullConditions(): conditions[0] | conditions[1] << 31.
    inline uint64_t GetFullConditions(uint32_t w0, uint32_t w1)
    {
        return static_cast<uint64_t>(w0) | (static_cast<uint64_t>(w1) << 31);
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

    // ── FKALGHJIADI own fields (+0x50 ACTK) ─────────────────────────────────
    extern uint32_t Tex1;             // HCMECDPHEMC   fallback 0x4CC
    extern uint32_t Tex2;             // HKPOMIBEGPK   fallback 0x54C
    extern uint32_t CurMP;            // FMHMGKEPIDN   fallback 0x5B4
    extern uint32_t MaxMP;            // NEDCKPIIIPN   fallback 0x5B0
    // DAGEMHFLJLK — bool groundDamageImmune (dump 0x458 / runtime 0x4A8).
    // Kept for potential use (e.g. skip nexus on ground tile damage); NOT ability cooldown.
    extern uint32_t GroundDmgImmune;
    // BINDBHJLPMG — bool invincible (dump 0x459 / runtime 0x4A9).
    // Short-duration hit invulnerability set by OnNewTick. NOT the same as COHCKAPOLCA bit 23.
    extern uint32_t LocalInvincible;
    // PPBLNMIMIFP — bool abilityReady (dump 0x515 / runtime 0x565).
    // True when the ability can fire this tick (server-driven).
    extern uint32_t AbilityReady;
    // CGCMALPMMJL — bool moving (dump 0x448 / runtime 0x498).
    extern uint32_t Player_Moving;
    // BHJFNEAHAOE — float moveDirX (dump 0x478 / runtime 0x4C8).
    extern uint32_t Player_MoveDirX;
    // GDNEBFDDDKM — float moveDirY (dump 0x47C / runtime 0x4CC).
    extern uint32_t Player_MoveDirY;
    // BHJFNEAHAOE — float SPD stat (same dump field 0x478; read without ACTK shift → runtime 0x478).
    // PlayerTAB and TestTAB both use runtime 0x478 for the speed formula (4 + 5.6 * spd/75).
    extern uint32_t Player_Spd;

    // ── ApplicationManager (no ACTK shift) ───────────────────────────────────
    // Resolved in GameState.cpp via type-scan (field name uses <>k__BackingField
    // syntax that changes with each BeeByte pass — type-scan is rename-proof).
    extern uint32_t AppMgr_WorldMgr;   // <CHDFAEBMILI>k__BackingField  fallback 0xC0

    // ── HJMBOMEHGDJ WorldManager (no shift) ─────────────────────────────────
    extern uint32_t WM_Local;       // OCLNLBHDEFK   fallback 0x48
    extern uint32_t WM_AllDict;     // DFALIKKKGLI   fallback 0xC0
    extern uint32_t WM_MapDictA;    // KHIHFNACEKJ   fallback 0xC8
    extern uint32_t WM_MapDictB;    // CIOIHEOEAEB   fallback 0xD0
    extern uint32_t WM_KjmonList;   // ONABHKFOJNE   fallback 0xF8
    extern uint32_t WM_TileArr;     // NOJEHIAOAJM   fallback 0x68
    extern uint32_t WM_TileList;    // IMAOBDCMPHC   fallback 0x70
    extern uint32_t WM_TickId;      // FIAJOKGHGGK   fallback 0xE8  (world tick counter UInt32)
    extern uint32_t WM_TickId2;     // HOMNPDGNOMO   fallback 0xEC  (secondary tick UInt32)

    // ── BGAIOPJMHLO tile instance (no shift) ────────────────────────────────
    extern uint32_t TileX;          // CLFEOFKBNEJ   fallback 0x38
    extern uint32_t TileY;          // PKEECFNFEIO   fallback 0x3C
    extern uint32_t TileType;       // JOFEAFJPJEM   fallback 0x40
    extern uint32_t TileProps;      // KEOKJCIJIAD   fallback 0x50

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
    extern uint32_t OP_InvincibleElem;  // "InvincibleElement"        fallback 0x468
    extern uint32_t OP_NoWallRpt;   // "NoWallTextureRepeat..."   fallback 0x210
    extern uint32_t OP_OccupySq;    // "occupySquare"             fallback 0x6B2
    extern uint32_t OP_FullOcc;     // "fullOccupy"               fallback 0x6E9
    extern uint32_t OP_EnemyOcc;    // "enemyOccupySquare"        fallback 0x6EA
    extern uint32_t OP_IsEnemy;     // "isEnemy"                  fallback 0x6E1 (live-client verified; stale dump said 0x6C9)
    extern uint32_t OP_IsStatic;    // "isStatic"                 fallback 0x6EB
    extern uint32_t OP_BlockProj;   // "blockProjectiles"         fallback 0x6EC
    // "noHealthBar" — true when the entity type has no visible HP bar. Enemies with this set
    // are not attackable characters and should be skipped. dump 0x6C6 + 0x10 = 0x6D6.
    extern uint32_t OP_NoHealthBar;     // "noHealthBar"              fallback 0x6EE
    extern uint32_t OP_ProtGnd;     // "protectFromGroundDamage"  fallback 0x6F4
    extern uint32_t OP_ProtSink;    // "protectFromSink"          fallback 0x6F5
    extern uint32_t OP_Flying;      // "flying"                   fallback 0x6FC
    extern uint32_t OP_ConnectT;    // "connectType"              fallback 0x784
    // "Projectiles" — ProjectileProperties[] array pointer on item
    // ObjectProperties. For weapon items, [0] is the primary
    // projectile from which passive consumers can read speed/lifetime
    // to derive weapon range without waiting for the player's first
    // shot. Same no-shift path as the other OP fields.
    extern uint32_t OP_Projectiles; // "Projectiles"              fallback 0x1C0

    // ── ProjectileProperties (real field names, no shift) ────────────────────
    extern uint32_t PP_Id;              // "Id"                fallback 0x164
    extern uint32_t PP_Lifetime;        // "Lifetime"          fallback 0x160
    extern uint32_t PP_Speed;           // "ProjectileSpeed"   fallback 0x168
    extern uint32_t PP_IsWavy;          // "IsWavy"            fallback 0x16C
    extern uint32_t PP_IsBoomerang;     // "IsBoomerang"       fallback 0x16D
    extern uint32_t PP_IsParametric;    // "IsParametric"      fallback 0x170
    extern uint32_t PP_HasCustomHitbox; // "HasCustomHitbox"   fallback 0x175
    extern uint32_t PP_LaserDist;       // "LaserDistance"     fallback 0x178
    extern uint32_t PP_SpeedClamp;      // SpeedClampValue, SpeedClamp, ...  fallback 0x17C
    extern uint32_t PP_AccelDelay;      // AccelerationDelayValue, AccelDelay, ...  fallback 0x180
    extern uint32_t PP_Acceleration;    // AccelerationValue, Acceleration, ...    fallback 0x184
    extern uint32_t PP_AccelerationInv; // AccelerationInv                      fallback 0x188
    extern uint32_t PP_IsAccel;         // IsAccelerating (type-level "can accelerate") fallback 0x18C
    extern uint32_t PP_UseAccel;        // UseAcceleration (per-shot "DO accelerate") fallback 0x198
    extern uint32_t PP_VelocityChangeRate; // VelocityChangeRate               fallback 0x190
    extern uint32_t PP_VelocityChangeRateInv; // VelocityChangeRateInv         fallback 0x194
    extern uint32_t PP_Magnitude;       // "Magnitude"         fallback 0x19C
    extern uint32_t PP_Frequency;       // "Frequency"         fallback 0x1A0
    extern uint32_t PP_Amplitude;       // "Amplitude"         fallback 0x1A4
    extern uint32_t PP_HasCustomAmplitude; // "HasCustomAmplitude" fallback 0x1A8 - if true, wavy uses Amplitude/Frequency fields instead of hardcoded π/64
    extern uint32_t PP_CollMult;           // "CollisionMult"              fallback 0xC0
    extern uint32_t PP_TurnRate;           // "ProjectileTurnRate"         fallback 0xD4
    extern uint32_t PP_TurnRateDelay;      // "ProjectileTurnRateDelay"    fallback 0xD8 — seconds; normalize ×1000
    extern uint32_t PP_TurnStopTime;       // "ProjectileTurnStopTime"     fallback 0xE8 — ms; omega = TurnRate/TurnStopTime
    extern uint32_t PP_CircleTurnAngle;    // "ProjectileCircleTurnAngle"  fallback 0xEC — arc-angle for IsTurningCircled path
    extern uint32_t PP_CircleTurnDelay;    // "ProjectileCircleTurnDelay"  fallback 0xF0 — ms straight-line before arc starts
    extern uint32_t PP_TurnAcceleration;   // "TurnAcceleration"           fallback 0xDC — boomerang turn accel rate
    extern uint32_t PP_TurnAccelDelay;     // "TurnAccelerationDelay"      fallback 0xE0 — time (sec) before boomerang kicks in
    extern uint32_t PP_TurnClamp;          // "TurnClamp"                  fallback 0xE4 — target turn rate for boomerang
    extern uint32_t PP_TurnAccelInv;       // "TurnAccelerationInv"        fallback 0x1B4 - threshold scale for boomerang
    extern uint32_t PP_IsTurning;          // "IsTurning"                  fallback 0x1B8
    extern uint32_t PP_IsTurningDelayed;   // "IsTurningDelayed"           fallback 0x1BA - uses TurnRateDelay before arc

    // HBEAKBIHANL — HHFDCMIIIHF (projRadius / Chebyshev T half-edge at runtime). Resolved via IL2CPP;
    // BeeByte name first; fallback 0x1D4 matches Il2CppInspector dump.
    extern uint32_t Hbeak_ProjRadius;

    // ── HBEAKBIHANL projectile instance (no shift) ───────────────────────────
    extern uint32_t Hbeak_ProjPropsPtr;    // FOMOIBCKIFP  fallback 0x118  (per-shot ProjectileProperties override)
    extern uint32_t Hbeak_Angle;           // FFFFKPDHEFP  fallback 0x148  (spawn angle Single)
    extern uint32_t Hbeak_InstanceDamage;  // DBNNDLKNECM  fallback 0x174  (per-instance damage Int32)
    extern uint32_t Hbeak_SpawnAgeMs;      // GLEGBLDBOJF  fallback 0x16C  (spawn-age ms; path anchoring / expiry)

    // ── ProjectileProperties continued ───────────────────────────────────────
    extern uint32_t PP_CustomHitbox;       // "CustomHitbox"  fallback 0x148  (ProjectileCustomHitbox* reference)
    extern uint32_t PP_IsArmorPiercing;    // "IsArmorPiercing"  fallback 0x174

    // ── ProjectileCustomHitbox (real field names, no shift) ──────────────────
    extern uint32_t CH_OffsetX;    // "offsetX"      fallback 0x10
    extern uint32_t CH_OffsetY;    // "offsetY"      fallback 0x14

    // ── ViewHandler (real field names, no shift) ─────────────────────────────
    extern uint32_t VH_SpriteShader;  // "spriteShader"  fallback 0x60
    extern uint32_t VH_DestroyEntity; // "destroyEntity" fallback 0x88

    // ── LKHPPBEGNOM continued — facing angle (+0x50 ACTK) ────────────────────
    // ECHAFMAAKMD — float facingAngle (dump 0x1DC + ACTK 0x50 → runtime 0x22C).
    // Written by SendShotPacketDetour to override the server-authoritative aim direction.
    extern uint32_t Player_FacingAngle;  // "ECHAFMAAKMD"  fallback 0x22C

    // ── GJJCEFJMNMK throwable entity (all parent ACTK shifts already baked into dump) ──
    // Fields live in the subclass region beyond LKHPPBEGNOM's shifted zone;
    // il2cpp_field_get_offset returns the runtime-ready value directly (actkShift=0).
    extern uint32_t Gjj_OriginX;    // "GuiCanvasSwitcher".x   fallback 0x370
    extern uint32_t Gjj_OriginY;    // "GuiCanvasSwitcher".y   fallback 0x374 (= OriginX+4)
    extern uint32_t Gjj_DestX;      // "IAJJLFBDJGE".x         fallback 0x378
    extern uint32_t Gjj_DestY;      // "IAJJLFBDJGE".y         fallback 0x37C (= DestX+4)
    extern uint32_t Gjj_DurationMs; // "EAICINLCCJK" int       fallback 0x390

    // ── FHOHCELBPDO visual throwable (LKFFPGONEOB base — no ACTK shift) ─────
    // Origin is inherited PosX/PosY from the BMO base (= RuntimeOffsets::PosX/PosY).
    extern uint32_t Fhoh_DurationMs; // "IEJNJENOCFP" int       fallback 0x140
    extern uint32_t Fhoh_DestX;      // "PBHMINMBFOM".x          fallback 0x154
    extern uint32_t Fhoh_DestY;      // "PBHMINMBFOM".y          fallback 0x158 (= DestX+4)

    // ── COEFCBBIBMC ShowEffect packet (OODFCLBKDJJ base — no ACTK shift) ────
    // Used by AoeTracking::ShowEffectDetour to decode effect type, positions, duration.
    extern uint32_t Sfx_EffectType;  // "MIDADCIKEBD" enum/int  fallback 0x10
    extern uint32_t Sfx_TargetObjId; // "HNOKKCFIJHJ" int       fallback 0x14
    extern uint32_t Sfx_Pos1X;       // "KMAIENKMNFA".x float   fallback 0x18
    extern uint32_t Sfx_Pos1Y;       // "KMAIENKMNFA".y float   fallback 0x1C (= Pos1X+4)
    extern uint32_t Sfx_Pos2X;       // "AEPOCACMOHI".x float   fallback 0x20
    extern uint32_t Sfx_Pos2Y;       // "AEPOCACMOHI".y float   fallback 0x24 (= Pos2X+4)
    extern uint32_t Sfx_Duration;    // "KPKIICOBBIM" float     fallback 0x2C

    // ── CustomExplosionEntrance (real XML field names, no shift) ─────────────
    extern uint32_t Cee_Distance;    // "distance" float         fallback 0x38
    extern uint32_t Cee_Speed;       // "speed" float            fallback 0x3C

} // namespace RuntimeOffsets
