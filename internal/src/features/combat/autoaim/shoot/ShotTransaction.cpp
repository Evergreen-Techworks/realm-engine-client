#include "pch-il2cpp.h"

#include "features/combat/autoaim/shoot/ShotTransaction.h"
#include "features/combat/autoaim/modes/KillAura.h"
#include "features/combat/autoaim/core/AimMath.h"
#include "features/projectiles/ProjectileTrajectory.h"
#include "ProjectileTracking.h"
#include "GameState.h"
#include "BootGate.h"
#include "RuntimeOffsets.h"
#include "Il2CppResolver.h"
#include "core/runtime/MemRead.h"
#include "game/symbols/GameClasses.h"
#include "game/objects/GameObjects.h"
#include "platform/hooks/Il2CppHook.h"
#include "DbgFileLog.h"

#include <Windows.h>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>

// See ShotTransaction.h for the hook order and the SendMessage finding.
//
// Evidence for the layout this file relies on (game 86ad651b, GameAssembly.dll
// disassembled with capstone; names from the live collector collection):
//   * LGJPEFJKHHP(int time, int slot, ADNDPMIHLGP attack, float angle, bool, bool,
//     bool, JGNMPKCFLGL source, int, int). The first int goes to the projectile's
//     startTime and PlayerShoot.time; the second is the equipment slot. The
//     container type is NOT a parameter: PlayerShoot.containerType is the weapon's
//     ObjectProperties.type (+0x6B4). Per projectile the loop runs
//     create (IEBBHLLOKNK.BLIGFBKNCHJ -> virtual KOBMINBDOBD) -> natural position
//     set -> MapViewService.AODEIADKBCC(proj) -> new PlayerShoot(time, bulletId,
//     containerType, slot, startingPos, angle, ..., source, playerPos) ->
//     SocketManager.SendMessage. startingPos is built from the loop's own
//     registers, not read back from the projectile, which is why the packet has to
//     be edited separately.
//   * Primary bullet ids run 0..127 and ability ids 128..255 (player +0x5EC / +0x5F0,
//     masked with 0x7F, ability +0x80).
//   * AODEIADKBCC(BasicMapObject) reads the object's x/y (+0x3C/+0x40) and passes
//     them to a virtual (float,float) move (vtable +0x5A8). On the projectile that
//     is inferred to be HBEAKBIHANL.CIJMIKDLLIG — its only (float,float) override,
//     and the method that copies x/y into the trajectory origin
//     (AADLFLPIDGF/EPFDHJLACEC, +0x140/+0x144). (When the map service is mid-
//     iteration it queues the object and adds it later, reading the same x/y.) The
//     trajectory (GIBLKPDHLBG) reads that origin and the angle (FFFFKPDHEFP, +0x148).
//     Writing x/y/angle BEFORE the original add is therefore enough to move the
//     whole flight; undoing it after the add must also put the trajectory origin back.
//   * KOBMINBDOBD's two trailing floats are the player's lifetime multiplier
//     (x ProjectileProperties.Lifetime -> +0x190) and speed multiplier (-> +0x184,
//     KDAJOMOFMJB).

namespace {

// ── Names (literals so the build's binding step can see the method lookups) ───
static const char* kPlayerClass        = "FKALGHJIADI";   // Player
static const char* kAttackMethod       = "LGJPEFJKHHP";   // the attack/shoot routine
static constexpr int kAttackArgs       = 10;
static const char* kSocketNamespace    = "DecaGames.RotMG.Managers.Net";
static const char* kSocketClass        = "SocketManager";
static const char* kSendMethod         = "SendMessage";
static constexpr int kSendArgs         = 1;
static const char* kShootMsgClass      = "HJNFJAHAOOE";   // outgoing PlayerShoot
static const char* kShootWriterMethod  = "IAEHBNKGNMH";   // its byte[] writer
static constexpr int kShootWriterArgs  = 0;
static const char* kMapAddMethod       = "AODEIADKBCC";   // MapViewService add (two overloads)

// Field names resolved by name at install (never used through a fallback).
static const char* kFShootBulletId     = "CLKDFFOGKJB";   // UInt32
static const char* kFShootContainer    = "PDEGBHOHKMO";   // UInt16
static const char* kFShootStartPos     = "FLADLOHHCCP";   // FFLIAABAAFP (WorldPos ref)
static const char* kFShootAngle        = "AIIGAFCMICI";   // Single
static const char* kFProjStartX        = "AADLFLPIDGF";   // Single, trajectory origin x
static const char* kFProjStartY        = "EPFDHJLACEC";   // Single, trajectory origin y
static const char* kAttackEntryClass   = "ADNDPMIHLGP";
static const char* kFAttackObjProps    = "HAGDPIBCFDM";   // ObjectProperties
static const char* kObjPropsNamespace  = "DecaGames.RotMG.Objects.Map.Data";
static const char* kObjPropsClass      = "ObjectProperties";
static const char* kFObjPropsType      = "type";          // Int32 (real name)
static const char* kFSocketConnection  = "IGCDAPOHBED";   // JOEMEFDPIIP, optional

// ── Tunables ──────────────────────────────────────────────────────────────────
// The final origin stays within this many tiles of the player (the guide's limit).
static constexpr float kMaxOriginAdvanceTiles = 2.0f;
// Tolerance on that limit for float rounding in the check after the solve.
static constexpr float kAdvanceEpsilon = 1e-3f;
// A target sample older than this is not used. KillAura::Tick runs once per
// rendered frame (41 ms at 24 FPS) and GetTickCount64 is 10-16 ms coarse, so 100 ms
// tolerates a slow frame; the target position is extrapolated by the sample's age.
static constexpr uint32_t kTargetMaxAgeMs = 100u;
// Primary bullet ids are 0..127, ability ids 128..255 (see the evidence block).
static constexpr uint32_t kAbilityBulletBase = 128u;
// Install retries walk every loaded class; never more often than this.
static constexpr ULONGLONG kInstallRetryMs = 1000ULL;

// ── Hook types (x64 IL2CPP: this, params..., MethodInfo*) ─────────────────────
using AttackFn  = void (*)(void* player, int32_t time, int32_t slot, void* attack, float angle,
                           bool b1, bool b2, bool b3, int32_t source, int32_t i9, int32_t i10,
                           const void* method);
using MapAddFn  = void (*)(void* mapView, void* obj, const void* method);
using SendFn    = void (*)(void* socketMgr, void* msg, const void* method);
using WriterFn  = void* (*)(void* msg, const void* method);

static AttackFn g_attackOrig = nullptr;
static MapAddFn g_mapAddOrig = nullptr;
static SendFn   g_sendOrig   = nullptr;
static WriterFn g_writerOrig = nullptr;
static void*    g_attackTarget = nullptr;
static void*    g_mapAddTarget = nullptr;
static void*    g_sendTarget   = nullptr;
static void*    g_writerTarget = nullptr;

static bool      s_installed = false;
static ULONGLONG s_lastInstallTryMs = 0;
static std::atomic<const char*> s_installStatus{ "not installed" };

// ── Resolved layout ───────────────────────────────────────────────────────────
struct Layout {
    Il2CppClass* shootMsgClass = nullptr;
    uint32_t shootBulletId  = 0;
    uint32_t shootContainer = 0;
    uint32_t shootStartPos  = 0;
    uint32_t shootAngle     = 0;
    uint32_t projStartX     = 0;
    uint32_t projStartY     = 0;
    uint32_t attackObjProps = 0;
    uint32_t objPropsType   = 0;
    uint32_t socketConn     = 0;   // 0 = not resolved (session then omits it)
};
static Layout s_layout;

// ── Counters (any thread) ─────────────────────────────────────────────────────
static std::atomic<uint64_t> c_scopes{0}, c_staged{0}, c_edited{0}, c_committed{0},
    c_restored{0}, c_skipped{0}, c_packetMismatch{0}, c_notSerialized{0},
    c_sessionChanged{0}, c_targetShots{0}, c_mouseShots{0}, c_containerDisagree{0};
static std::atomic<const char*> s_lastSkip{ "none" };
static std::atomic<const char*> s_lastRestore{ "none" };

// Transition-keyed trace lines: a steady reason logs once, a new one logs again,
// at most once a second so two alternating reasons cannot log every shot.
static const char* s_loggedSkip    = nullptr;
static const char* s_loggedRestore = nullptr;
static ULONGLONG   s_skipLogMs     = 0;
static ULONGLONG   s_restoreLogMs  = 0;

static bool LogTransition(const char* why, const char*& last, ULONGLONG& lastMs)
{
    if (why == last) return false;
    const ULONGLONG now = GetTickCount64();
    if (now - lastMs < 1000ULL) return false;
    last = why;
    lastMs = now;
    return true;
}

// ── Per-shot state (game thread only) ─────────────────────────────────────────
enum class StagedState : uint8_t { None, Created, Skipped, Edited, Committed, Restored };
enum class AimSource   : uint8_t { None, Target, Mouse };

struct Staged {
    StagedState state = StagedState::None;
    void*    proj = nullptr;
    int32_t  ownerId = 0;
    uint32_t bulletId = 0;
    int32_t  projId = 0;
    uint16_t containerType = 0;      // the projectile's ObjectProperties.type
    bool     haveContainer = false;
    float    nativeAngle = 0.f;      // KOBMINBDOBD's angle argument
    float    speedMul = 1.f, lifetimeMul = 1.f;
    float    lifetimeMs = 0.f;       // after the lifetime multiplier
    float    rangeTiles = 0.f;       // effective range: integrated speed x lifetime
    // Natural values read at the edit point, and what was written.
    float    natX = 0.f, natY = 0.f, natAngle = 0.f;
    float    newX = 0.f, newY = 0.f, newAngle = 0.f;
    AimSource source = AimSource::None;
};

struct Scope {
    void*    player = nullptr;
    int32_t  objectId = 0;
    int32_t  source = 0;             // 0 primary, 1 ability
    uint16_t containerType = 0;      // from the attack entry's ObjectProperties
    bool     haveContainer = false;
    float    baseAngle = 0.f;
    float    px = 0.f, py = 0.f;     // player position when the shot began
    uint32_t sessionGen = 0;
    Staged   staged;
};

// The one message currently borrowing edited fields (a stack object in the
// SendMessage detour).
struct PacketTxn;

thread_local Scope*     t_scope = nullptr;
thread_local PacketTxn* t_txn   = nullptr;

// ── Session ───────────────────────────────────────────────────────────────────
// One local player object + its object id + one connection (SocketManager and its
// JOEMEFDPIIP connection object). The generation moves whenever any part changes;
// a shot is only committed if the generation it started with is still current
// after its PlayerShoot was sent. Game thread only.
struct Session {
    void*    player = nullptr;
    int32_t  objectId = 0;
    void*    socket = nullptr;
    void*    conn = nullptr;
    bool     haveSocket = false;
    uint32_t gen = 1;
};
static Session s_session;

static void NoteScopePlayer(void* player, int32_t objectId)
{
    if (player != s_session.player || objectId != s_session.objectId) {
        s_session.player = player;
        s_session.objectId = objectId;
        s_session.socket = nullptr;
        s_session.conn = nullptr;
        s_session.haveSocket = false;
        ++s_session.gen;
    }
}

static void* ReadConnection(void* socketMgr)
{
    if (!s_layout.socketConn) return nullptr;
    return Mem::ReadPtr(socketMgr, s_layout.socketConn);
}

// The first send of a player session learns its connection; any later change is a
// new session.
static void NoteSendSocket(void* socketMgr)
{
    void* conn = ReadConnection(socketMgr);
    if (!s_session.haveSocket) {
        s_session.socket = socketMgr;
        s_session.conn = conn;
        s_session.haveSocket = true;
        return;
    }
    if (socketMgr != s_session.socket || conn != s_session.conn) {
        s_session.socket = socketMgr;
        s_session.conn = conn;
        ++s_session.gen;
    }
}

// ── Small helpers ─────────────────────────────────────────────────────────────
static float WrapPi(float a)
{
    const float twoPi = 6.28318530718f;
    a = std::fmod(a, twoPi);
    if (a > 3.14159265359f)   a -= twoPi;
    if (a <= -3.14159265359f) a += twoPi;
    return a;
}

static bool Finite2(float a, float b) { return std::isfinite(a) && std::isfinite(b); }

static void NoteSkip(Staged& st, const char* why)
{
    st.state = StagedState::Skipped;
    c_skipped.fetch_add(1, std::memory_order_relaxed);
    s_lastSkip.store(why, std::memory_order_relaxed);
    if (LogTransition(why, s_loggedSkip, s_skipLogMs)) {
        DBG_FILE_LOG("[ShotTxn] edit skipped: " << why << " (bullet " << st.bulletId << ")");
    }
}

static bool ReadNatural(void* proj, float& x, float& y, float& angle)
{
    return Game::Entity(proj).TryPosFinite(x, y) &&
           Mem::TryRead(proj, RuntimeOffsets::Hbeak_Angle, angle) && std::isfinite(angle);
}

// Writes position + angle onto the projectile. `trajectoryOrigin` also moves the
// fields the map add copies x/y into; it is used when undoing an edit, because by
// then the add has already run. Returns false if any write failed.
static bool WriteProjectile(void* proj, float x, float y, float angle, bool trajectoryOrigin)
{
    bool ok = Mem::TryWrite(proj, RuntimeOffsets::PosX, x);           // raw-access-ok: shot-edit WRITE, gated on IsFieldWriteTrusted(PosX/PosY) at install
    ok = Mem::TryWrite(proj, RuntimeOffsets::PosY, y) && ok;          // raw-access-ok: shot-edit WRITE, gated on IsFieldWriteTrusted(PosX/PosY) at install
    ok = Mem::TryWrite(proj, RuntimeOffsets::Hbeak_Angle, angle) && ok;
    if (trajectoryOrigin) {
        ok = Mem::TryWrite(proj, s_layout.projStartX, x) && ok;
        ok = Mem::TryWrite(proj, s_layout.projStartY, y) && ok;
    }
    return ok;
}

static void RestoreProjectile(Staged& st, const char* why)
{
    WriteProjectile(st.proj, st.natX, st.natY, st.natAngle, /*trajectoryOrigin*/true);
    st.state = StagedState::Restored;
    c_restored.fetch_add(1, std::memory_order_relaxed);
    s_lastRestore.store(why, std::memory_order_relaxed);
    if (LogTransition(why, s_loggedRestore, s_restoreLogMs)) {
        DBG_FILE_LOG("[ShotTxn] projectile restored to natural x/y/angle: " << why
                     << " (bullet " << st.bulletId << ")");
    }
}

// An edited projectile that will not be matched any more is put back.
static void AbandonStaged(Staged& st, const char* why)
{
    if (st.state == StagedState::Edited) RestoreProjectile(st, why);
    st.state = StagedState::None;
    st.proj = nullptr;
}

// ── Projectile properties (creation-time copy) ────────────────────────────────
// Straight-line flights only: speed x lifetime (with acceleration and speed clamp,
// which keep the direction) is a range the game's own trajectory reaches along the
// angle we write. Wavy, parametric, boomerang, turning, circling and laser shots
// do not travel along that angle, so the edit is skipped for them.
static const char* ClassifyProjProps(void* pp, float lifetimeMul, float speedMul, Staged& st)
{
    if (!Mem::AddrOk(pp)) return "no-projectile-properties";
    if (!(std::isfinite(speedMul) && speedMul > 0.f && speedMul < 100.f) ||
        !(std::isfinite(lifetimeMul) && lifetimeMul > 0.f && lifetimeMul < 100.f))
        return "bad-multipliers";

    bool wavy = false, param = false, boom = false, turning = false, turningDelayed = false;
    float turnRate = 0.f, circleTurn = 0.f, laser = 0.f;
    if (!Mem::TryRead(pp, RuntimeOffsets::PP_IsWavy, wavy) ||
        !Mem::TryRead(pp, RuntimeOffsets::PP_IsParametric, param) ||
        !Mem::TryRead(pp, RuntimeOffsets::PP_IsBoomerang, boom) ||
        !Mem::TryRead(pp, RuntimeOffsets::PP_IsTurning, turning) ||
        !Mem::TryRead(pp, RuntimeOffsets::PP_IsTurningDelayed, turningDelayed) ||
        !Mem::TryRead(pp, RuntimeOffsets::PP_TurnRate, turnRate) ||
        !Mem::TryRead(pp, RuntimeOffsets::PP_CircleTurnAngle, circleTurn) ||
        !Mem::TryRead(pp, RuntimeOffsets::PP_LaserDist, laser))
        return "projectile-properties-unreadable";
    if (wavy)            return "trajectory-wavy";
    if (param)           return "trajectory-parametric";
    if (boom)            return "trajectory-boomerang";
    if (turning || turningDelayed || (std::isfinite(turnRate) && turnRate != 0.f))
        return "trajectory-turning";
    if (std::isfinite(circleTurn) && circleTurn != 0.f) return "trajectory-circling";
    if (!std::isfinite(laser) || laser != 0.f)          return "trajectory-laser";

    int32_t rawSpeedI = 0;
    float   rawLife = 0.f;
    if (!Mem::TryRead(pp, RuntimeOffsets::PP_Speed, rawSpeedI) ||
        !Mem::TryRead(pp, RuntimeOffsets::PP_Lifetime, rawLife))
        return "projectile-properties-unreadable";
    if (rawSpeedI <= 0 || rawSpeedI >= 500000) return "speed-unusable";

    const float lifetimeMs = ProjectileTrajectory::NormalizeLifetimeMs(rawLife) * lifetimeMul;
    if (!std::isfinite(lifetimeMs) || lifetimeMs <= 1.f) return "lifetime-unusable";

    float range = 0.f;
    __try {
        range = AimMath::IntegratedProjectileDistance(reinterpret_cast<uint8_t*>(pp), lifetimeMs,
                                                      speedMul, static_cast<float>(rawSpeedI));
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return "projectile-properties-unreadable";
    }
    if (!std::isfinite(range) || range <= 0.05f) return "range-unusable";

    Mem::TryRead(pp, RuntimeOffsets::PP_ProjId, st.projId);
    st.lifetimeMs  = lifetimeMs;
    st.rangeTiles  = range;
    st.speedMul    = speedMul;
    st.lifetimeMul = lifetimeMul;
    return nullptr;
}

// ── The proposal ──────────────────────────────────────────────────────────────
struct Proposal { float ox, oy, angle; AimSource source; };

// The origin advances from the player toward the aim point, stopping `standoff`
// short of it and never more than kMaxOriginAdvanceTiles from the player.
static bool OriginToward(float px, float py, float ax, float ay, float standoff,
                         float& ox, float& oy)
{
    const float dx = ax - px, dy = ay - py;
    const float d = std::sqrt(dx * dx + dy * dy);
    if (!std::isfinite(d) || d < 1e-3f) return false;
    float adv = d - standoff;
    if (adv < 0.f) adv = 0.f;
    if (adv > kMaxOriginAdvanceTiles) adv = kMaxOriginAdvanceTiles;
    ox = px + dx / d * adv;
    oy = py + dy / d * adv;
    return Finite2(ox, oy);
}

static bool FitsRange(float ox, float oy, float ax, float ay, float range)
{
    const float dx = ax - ox, dy = ay - oy;
    return dx * dx + dy * dy <= range * range;
}

static const char* Propose(const Scope& sc, const Staged& st, Proposal& out)
{
    KillAura::ShotTarget t;
    if (!KillAura::GetShotTarget(t)) return "no-fresh-aim-input";
    const uint32_t now = static_cast<uint32_t>(GetTickCount64());
    const uint32_t age = now - t.stampMs;
    if (age > kTargetMaxAgeMs) return "aim-input-stale";

    float standoff = t.standoffTiles;
    if (!std::isfinite(standoff) || standoff < 0.f) standoff = 0.f;

    const char* why = "no-aim-point";

    // 1. The killaura target, when there is one and it can be reached.
    if (t.hasTarget && Finite2(t.ex, t.ey)) {
        float ex = t.ex, ey = t.ey;
        const bool moving = Finite2(t.vx, t.vy) && (t.vx != 0.f || t.vy != 0.f);
        if (moving) { ex += t.vx * static_cast<float>(age); ey += t.vy * static_cast<float>(age); }

        // Average flight speed over the whole life (accounts for acceleration).
        const float avgTps = st.rangeTiles / st.lifetimeMs * 1000.f;
        float ax = ex, ay = ey, ox = 0.f, oy = 0.f;
        bool ok = OriginToward(sc.px, sc.py, ax, ay, standoff, ox, oy);
        // Lead from the ORIGIN, not the player: the flight is shorter by the advance.
        // Two passes: the lead moves the aim point, which moves the origin a little.
        for (int pass = 0; ok && moving && pass < 2; ++pass) {
            AimMath::QuadraticIntercept(ox, oy, ex, ey, t.vx * 1000.f, t.vy * 1000.f,
                                        avgTps, ax, ay, st.lifetimeMs / 1000.f);
            ok = Finite2(ax, ay) && OriginToward(sc.px, sc.py, ax, ay, standoff, ox, oy);
        }
        if (!ok) {
            why = "target-degenerate";
        } else if (!FitsRange(ox, oy, ax, ay, st.rangeTiles)) {
            why = "target-out-of-reach";
        } else {
            out = { ox, oy, std::atan2(ay - oy, ax - ox), AimSource::Target };
            return nullptr;
        }
    }

    // 2. The mouse aim point.
    if (t.hasMouse && Finite2(t.mx, t.my)) {
        float ox = 0.f, oy = 0.f;
        if (!OriginToward(sc.px, sc.py, t.mx, t.my, standoff, ox, oy)) {
            why = "mouse-on-player";
        } else if (!FitsRange(ox, oy, t.mx, t.my, st.rangeTiles)) {
            why = t.hasTarget ? "target-and-mouse-out-of-reach" : "mouse-out-of-reach";
        } else {
            out = { ox, oy, std::atan2(t.my - oy, t.mx - ox), AimSource::Mouse };
            return nullptr;
        }
    }
    return why;
}

// ── Scope guard for the attack detour ─────────────────────────────────────────
struct ScopeGuard {
    Scope& sc;
    explicit ScopeGuard(Scope& s) : sc(s) { t_scope = &sc; }
    ~ScopeGuard()
    {
        // Runs on normal return and on a managed exception unwinding through us:
        // anything still edited never had its packet sent in our session.
        AbandonStaged(sc.staged, "shot-ended-before-send");
        t_scope = nullptr;
    }
    ScopeGuard(const ScopeGuard&) = delete;
    ScopeGuard& operator=(const ScopeGuard&) = delete;
};

// ── Packet transaction (SendMessage detour) ───────────────────────────────────
// Registered BEFORE any field of the borrowed PlayerShoot is changed. The
// destructor is the cleanup: it runs when the original send returns and also if a
// managed exception unwinds through the detour (/EHa).
struct PacketTxn {
    Scope&   sc;
    void*    msg;
    void*    socketMgr;
    void*    wpos;                         // the message's startingPos object
    float    origX = 0.f, origY = 0.f, origAngle = 0.f;
    float    ourX = 0.f, ourY = 0.f, ourAngle = 0.f;
    bool     wroteX = false, wroteY = false, wroteAngle = false;
    bool     writesOk = false;
    bool     returned = false;
    int      writerCalls = 0;
    bool     serializedOurs = false;
    bool     serializedForeign = false;

    PacketTxn(Scope& s, void* m, void* sock, void* w) : sc(s), msg(m), socketMgr(sock), wpos(w)
    {
        t_txn = this;
    }

    bool FieldsAreOurs() const
    {
        float x = 0.f, y = 0.f, a = 0.f;
        void* w = nullptr;
        return Mem::TryRead(msg, s_layout.shootStartPos, w) && w == wpos &&
               Mem::TryRead(wpos, RuntimeOffsets::Sfx_WposX, x) && x == ourX &&
               Mem::TryRead(wpos, RuntimeOffsets::Sfx_WposY, y) && y == ourY &&
               Mem::TryRead(msg, s_layout.shootAngle, a) && a == ourAngle;
    }

    void Borrow(float x, float y, float angle)
    {
        ourX = x; ourY = y; ourAngle = angle;
        wroteX = Mem::TryWrite(wpos, RuntimeOffsets::Sfx_WposX, x);
        wroteY = Mem::TryWrite(wpos, RuntimeOffsets::Sfx_WposY, y);
        wroteAngle = Mem::TryWrite(msg, s_layout.shootAngle, angle);
        writesOk = wroteX && wroteY && wroteAngle && FieldsAreOurs();
    }

    // Put the message's own values back, but only into fields that still hold ours.
    void Return()
    {
        float v = 0.f;
        if (wroteX && Mem::TryRead(wpos, RuntimeOffsets::Sfx_WposX, v) && v == ourX)
            Mem::TryWrite(wpos, RuntimeOffsets::Sfx_WposX, origX);
        if (wroteY && Mem::TryRead(wpos, RuntimeOffsets::Sfx_WposY, v) && v == ourY)
            Mem::TryWrite(wpos, RuntimeOffsets::Sfx_WposY, origY);
        if (wroteAngle && Mem::TryRead(msg, s_layout.shootAngle, v) && v == ourAngle)
            Mem::TryWrite(msg, s_layout.shootAngle, origAngle);
        wroteX = wroteY = wroteAngle = false;
    }

    ~PacketTxn()
    {
        t_txn = nullptr;
        Return();

        Staged& st = sc.staged;
        if (st.state != StagedState::Edited) return;

        // Session: same player/connection generation as when the shot began, and
        // the connection did not change underneath the send.
        bool sameSession = (sc.sessionGen == s_session.gen);
        if (sameSession && s_layout.socketConn && ReadConnection(socketMgr) != s_session.conn) {
            ++s_session.gen;
            sameSession = false;
        }

        const char* why = nullptr;
        if (!returned)                               why = "send-aborted";
        else if (!writesOk)                          why = "packet-write-failed";
        else if (!sameSession) {                     why = "session-changed";
            c_sessionChanged.fetch_add(1, std::memory_order_relaxed);
        }
        else if (serializedForeign)                  why = "packet-fields-not-owned";
        else if (!serializedOurs) {                  why = "send-suppressed";
            c_notSerialized.fetch_add(1, std::memory_order_relaxed);
        }

        if (why) {
            RestoreProjectile(st, why);
            st.proj = nullptr;
            return;
        }
        st.state = StagedState::Committed;
        c_committed.fetch_add(1, std::memory_order_relaxed);
        if (st.source == AimSource::Target) c_targetShots.fetch_add(1, std::memory_order_relaxed);
        else                                c_mouseShots.fetch_add(1, std::memory_order_relaxed);
        st.proj = nullptr;
    }
    PacketTxn(const PacketTxn&) = delete;
    PacketTxn& operator=(const PacketTxn&) = delete;
};

static bool IsShootMessage(void* msg)
{
    void* klass = nullptr;
    return s_layout.shootMsgClass && Mem::TryRead(msg, 0, klass) &&
           klass == static_cast<void*>(s_layout.shootMsgClass);
}

// ── Detours ───────────────────────────────────────────────────────────────────
void AttackDetour(void* player, int32_t time, int32_t slot, void* attack, float angle,
                  bool b1, bool b2, bool b3, int32_t source, int32_t i9, int32_t i10,
                  const void* method)
{
    if (!KillAura::IsEnabled() || t_scope != nullptr || (source != 0 && source != 1) ||
        player == nullptr || player != GameState::GetLocalPtr() || !std::isfinite(angle)) {
        g_attackOrig(player, time, slot, attack, angle, b1, b2, b3, source, i9, i10, method);
        return;
    }

    Scope sc;
    sc.player    = player;
    // The shooter id the game passes to KOBMINBDOBD is read from this same field
    // (player +0x34 on 86ad651b), so it is compared against the spawn's owner id.
    Mem::TryRead(player, RuntimeOffsets::ObjId, sc.objectId);
    sc.source    = source;
    sc.baseAngle = angle;
    const bool havePos = Game::Entity(player).TryPosFinite(sc.px, sc.py);
    int32_t type = 0;
    void* op = Mem::ReadPtr(attack, s_layout.attackObjProps);
    if (op && Mem::TryRead(op, s_layout.objPropsType, type) && type > 0 && type <= 0xFFFF) {
        sc.containerType = static_cast<uint16_t>(type);
        sc.haveContainer = true;
    }
    if (!havePos || sc.objectId == 0) {
        g_attackOrig(player, time, slot, attack, angle, b1, b2, b3, source, i9, i10, method);
        return;
    }
    NoteScopePlayer(player, sc.objectId);
    sc.sessionGen = s_session.gen;
    c_scopes.fetch_add(1, std::memory_order_relaxed);

    ScopeGuard guard(sc);
    g_attackOrig(player, time, slot, attack, angle, b1, b2, b3, source, i9, i10, method);
}

void MapAddDetour(void* mapView, void* obj, const void* method)
{
    Scope* sc = t_scope;
    if (!sc || obj == nullptr || obj != sc->staged.proj || sc->staged.state != StagedState::Created) {
        g_mapAddOrig(mapView, obj, method);
        return;
    }
    Staged& st = sc->staged;

    if (sc->sessionGen != s_session.gen) {
        NoteSkip(st, "session-changed-before-add");
    } else if (!ReadNatural(obj, st.natX, st.natY, st.natAngle)) {
        NoteSkip(st, "natural-position-unreadable");
    } else {
        Proposal p{};
        const char* why = Propose(*sc, st, p);
        if (why) {
            NoteSkip(st, why);
        } else {
            const float dx = p.ox - sc->px, dy = p.oy - sc->py;
            const float spread = WrapPi(st.natAngle - sc->baseAngle);
            const float newAngle = WrapPi(p.angle + spread);
            if (dx * dx + dy * dy >
                    (kMaxOriginAdvanceTiles + kAdvanceEpsilon) * (kMaxOriginAdvanceTiles + kAdvanceEpsilon) ||
                !std::isfinite(newAngle)) {
                NoteSkip(st, "origin-limit");
            } else if (!WriteProjectile(obj, p.ox, p.oy, newAngle, /*trajectoryOrigin*/false)) {
                WriteProjectile(obj, st.natX, st.natY, st.natAngle, false);
                NoteSkip(st, "projectile-write-failed");
            } else {
                st.newX = p.ox; st.newY = p.oy; st.newAngle = newAngle;
                st.source = p.source;
                st.state = StagedState::Edited;
                c_edited.fetch_add(1, std::memory_order_relaxed);
            }
        }
    }
    g_mapAddOrig(mapView, obj, method);
}

void SendDetour(void* socketMgr, void* msg, const void* method)
{
    Scope* sc = t_scope;
    if (!sc || sc->staged.state != StagedState::Edited || !IsShootMessage(msg)) {
        g_sendOrig(socketMgr, msg, method);
        return;
    }
    Staged& st = sc->staged;

    NoteSendSocket(socketMgr);

    uint32_t bulletId = 0;
    uint16_t container = 0;
    void* wpos = nullptr;
    float origAngle = 0.f, origX = 0.f, origY = 0.f;
    const bool readable =
        Mem::TryRead(msg, s_layout.shootBulletId, bulletId) &&
        Mem::TryRead(msg, s_layout.shootContainer, container) &&
        Mem::TryRead(msg, s_layout.shootStartPos, wpos) && Mem::AddrOk(wpos) &&
        Mem::TryRead(msg, s_layout.shootAngle, origAngle) &&
        Mem::TryRead(wpos, RuntimeOffsets::Sfx_WposX, origX) &&
        Mem::TryRead(wpos, RuntimeOffsets::Sfx_WposY, origY);

    const bool isAbilityId = bulletId >= kAbilityBulletBase;
    const bool containerOk = (st.haveContainer && container == st.containerType) ||
                             (sc->haveContainer && container == sc->containerType);
    const char* mismatch = nullptr;
    if (!readable)                                   mismatch = "packet-unreadable";
    else if (bulletId != st.bulletId)                mismatch = "packet-bullet-id";
    else if (isAbilityId != (sc->source == 1))       mismatch = "packet-source";
    else if (!containerOk)                           mismatch = "packet-container";
    else if (sc->sessionGen != s_session.gen) {      mismatch = "session-changed";
        c_sessionChanged.fetch_add(1, std::memory_order_relaxed);
    }

    if (mismatch) {
        c_packetMismatch.fetch_add(1, std::memory_order_relaxed);
        AbandonStaged(st, mismatch);
        g_sendOrig(socketMgr, msg, method);
        return;
    }

    PacketTxn txn(*sc, msg, socketMgr, wpos);
    txn.origX = origX; txn.origY = origY; txn.origAngle = origAngle;
    txn.Borrow(st.newX, st.newY, st.newAngle);
    if (!txn.writesOk) {
        // Nothing of ours may reach the wire: put the message back before sending.
        txn.Return();
    }
    g_sendOrig(socketMgr, msg, method);
    txn.returned = true;
}

void* WriterDetour(void* msg, const void* method)
{
    PacketTxn* txn = t_txn;
    if (txn && msg == txn->msg && txn->writesOk) {
        ++txn->writerCalls;
        if (txn->FieldsAreOurs()) txn->serializedOurs = true;
        else                      txn->serializedForeign = true;
    }
    return g_writerOrig(msg, method);
}

// ── Resolution ────────────────────────────────────────────────────────────────
// Resolved here rather than as RuntimeOffsets table rows ON PURPOSE: the
// PlayerShoot class is not initialised until the first shot, and a table row on
// an unloaded class holds the global readiness gate (FieldNotLoaded) — every
// gated feature would wait for that shot. By exact name, no fallback offset,
// and a failure only keeps THIS feature uninstalled (retried once a second).
static bool FieldOffset(Il2CppClass* klass, const char* name, uint32_t& out)
{
    for (Il2CppClass* k = klass; k; k = il2cpp_class_get_parent(k)) {
        if (FieldInfo* f = il2cpp_class_get_field_from_name(k, name)) {       // raw-access-ok: see the note above — a table row would hold the global gate until the first shot
            const size_t off = il2cpp_field_get_offset(f);                   // raw-access-ok: same lookup, exact name, fail-closed
            if (off == 0 || off > 0x10000) return false;
            out = static_cast<uint32_t>(off);
            return true;
        }
    }
    return false;
}

// AODEIADKBCC has two one-argument overloads on the map service; the one to hook
// takes the BasicMapObject, which is the projectile class's parent. Chosen by the
// parameter's CLASS, never by name and arity alone.
static void* ResolveMapAdd()
{
    Il2CppClass* mapView = GameClasses::WorldManager();
    Il2CppClass* proj    = GameClasses::Projectile();
    if (!mapView || !proj) return nullptr;
    Il2CppClass* basic = il2cpp_class_get_parent(proj);
    if (!basic) return nullptr;
    void* found = nullptr;
    int matches = 0;
    void* iter = nullptr;
    while (const MethodInfo* m = il2cpp_class_get_methods(mapView, &iter)) {
        if (strcmp(il2cpp_method_get_name(m), kMapAddMethod) != 0) continue;
        if (il2cpp_method_get_param_count(m) != 1) continue;
        const Il2CppType* t = il2cpp_method_get_param(m, 0);
        if (!t || il2cpp_class_from_type(t) != basic) continue;
        found = reinterpret_cast<void*>(m->methodPointer);
        ++matches;
    }
    return (matches == 1) ? found : nullptr;
}

static bool ResolveLayout(const char*& why)
{
    Layout L;
    L.shootMsgClass = Resolver::GetClass("", kShootMsgClass);
    if (!L.shootMsgClass) { why = "PlayerShoot class not loaded yet (fires on first shot)"; return false; }
    Il2CppClass* proj = GameClasses::Projectile();
    Il2CppClass* attack = Resolver::GetClass("", kAttackEntryClass);
    Il2CppClass* objProps = Resolver::GetClass(kObjPropsNamespace, kObjPropsClass);
    Il2CppClass* socket = Resolver::GetClass(kSocketNamespace, kSocketClass);
    if (!proj || !attack || !objProps || !socket) { why = "a class is not loaded yet"; return false; }

    if (!FieldOffset(L.shootMsgClass, kFShootBulletId, L.shootBulletId) ||
        !FieldOffset(L.shootMsgClass, kFShootContainer, L.shootContainer) ||
        !FieldOffset(L.shootMsgClass, kFShootStartPos, L.shootStartPos) ||
        !FieldOffset(L.shootMsgClass, kFShootAngle, L.shootAngle)) {
        why = "PlayerShoot field unresolved"; return false;
    }
    if (!FieldOffset(proj, kFProjStartX, L.projStartX) || !FieldOffset(proj, kFProjStartY, L.projStartY)) {
        why = "projectile trajectory-origin field unresolved"; return false;
    }
    if (!FieldOffset(attack, kFAttackObjProps, L.attackObjProps) ||
        !FieldOffset(objProps, kFObjPropsType, L.objPropsType)) {
        why = "attack-entry container field unresolved"; return false;
    }
    if (!RuntimeOffsets::Sfx_WposResolved) { why = "WorldPos x/y not shape-verified"; return false; }
    // Writing entity positions needs the same proof the teleport write uses.
    if (!RuntimeOffsets::IsFieldWriteTrusted(&RuntimeOffsets::PosX) ||   // raw-access-ok: offset-HEALTH query by variable address, reads no game memory
        !RuntimeOffsets::IsFieldWriteTrusted(&RuntimeOffsets::PosY) ||   // raw-access-ok: offset-HEALTH query by variable address, reads no game memory
        !RuntimeOffsets::IsFieldWriteTrusted(&RuntimeOffsets::Hbeak_Angle)) {
        why = "position/angle offsets not write-trusted"; return false;
    }
    if (!FieldOffset(socket, kFSocketConnection, L.socketConn)) L.socketConn = 0;   // optional

    s_layout = L;
    DBG_FILE_LOG("[ShotTxn] layout: PlayerShoot bulletId=0x" << std::hex << L.shootBulletId
                 << " container=0x" << L.shootContainer << " startingPos=0x" << L.shootStartPos
                 << " angle=0x" << L.shootAngle << " | WorldPos x=0x" << RuntimeOffsets::Sfx_WposX
                 << " y=0x" << RuntimeOffsets::Sfx_WposY << " | proj angle=0x" << RuntimeOffsets::Hbeak_Angle
                 << " startX=0x" << L.projStartX << " startY=0x" << L.projStartY
                 << " | attack.objProps=0x" << L.attackObjProps << " objProps.type=0x" << L.objPropsType
                 << " socket.conn=0x" << L.socketConn << std::dec);
    return true;
}

} // namespace

namespace ShotTransaction {

bool Install()
{
    if (s_installed) return true;
    const ULONGLONG now = GetTickCount64();
    if (now - s_lastInstallTryMs < kInstallRetryMs) return false;
    s_lastInstallTryMs = now;

    auto fail = [](const char* why) {
        if (s_installStatus.load(std::memory_order_relaxed) != why) {
            s_installStatus.store(why, std::memory_order_relaxed);
            DBG_FILE_LOG("[ShotTxn] not installed yet: " << why);
        }
        return false;
    };

    if (!BootGate::FeatureAllowed("KillAuraShot")) return fail("feature gate closed");
    if (!ProjectileTracking::IsInstalled()) return fail("waiting for the projectile spawn hook");

    const char* why = nullptr;
    if (!ResolveLayout(why)) return fail(why);

    g_attackTarget = Il2CppHook::ResolveMethod(kPlayerClass, kAttackMethod, kAttackArgs, /*loose*/false);
    g_sendTarget   = Il2CppHook::ResolveMethod(kSocketClass, kSendMethod, kSendArgs, /*loose*/false, kSocketNamespace);
    g_writerTarget = Il2CppHook::ResolveMethod(kShootMsgClass, kShootWriterMethod, kShootWriterArgs, /*loose*/false);
    g_mapAddTarget = ResolveMapAdd();
    if (!g_attackTarget) return fail("Player.LGJPEFJKHHP unresolved");
    if (!g_sendTarget)   return fail("SocketManager.SendMessage unresolved");
    if (!g_writerTarget) return fail("PlayerShoot writer unresolved");
    if (!g_mapAddTarget) return fail("MapViewService.AODEIADKBCC(BasicMapObject) unresolved or ambiguous");

    if (!Il2CppHook::EnsureRuntime("ShotTxn")) return fail("MinHook unavailable");

    // Inner hooks first, the scope-opening hook last: until the attack hook is live
    // no scope exists, so the others pass everything straight through.
    if (!Il2CppHook::InstallMinHook(g_writerTarget, reinterpret_cast<void*>(&WriterDetour),
                                    reinterpret_cast<void**>(&g_writerOrig), "ShotTxn.Writer"))
        return fail("writer hook failed");
    if (!Il2CppHook::InstallMinHook(g_sendTarget, reinterpret_cast<void*>(&SendDetour),
                                    reinterpret_cast<void**>(&g_sendOrig), "ShotTxn.Send")) {
        Il2CppHook::UninstallMinHook(g_writerTarget, "ShotTxn.Writer");
        return fail("send hook failed");
    }
    if (!Il2CppHook::InstallMinHook(g_mapAddTarget, reinterpret_cast<void*>(&MapAddDetour),
                                    reinterpret_cast<void**>(&g_mapAddOrig), "ShotTxn.MapAdd")) {
        Il2CppHook::UninstallMinHook(g_sendTarget, "ShotTxn.Send");
        Il2CppHook::UninstallMinHook(g_writerTarget, "ShotTxn.Writer");
        return fail("map-add hook failed");
    }
    if (!Il2CppHook::InstallMinHook(g_attackTarget, reinterpret_cast<void*>(&AttackDetour),
                                    reinterpret_cast<void**>(&g_attackOrig), "ShotTxn.Attack")) {
        Il2CppHook::UninstallMinHook(g_mapAddTarget, "ShotTxn.MapAdd");
        Il2CppHook::UninstallMinHook(g_sendTarget, "ShotTxn.Send");
        Il2CppHook::UninstallMinHook(g_writerTarget, "ShotTxn.Writer");
        return fail("attack hook failed");
    }

    s_installed = true;
    s_installStatus.store("installed", std::memory_order_relaxed);
    DBG_FILE_LOG("[ShotTxn] installed: LGJPEFJKHHP scope -> KOBMINBDOBD record -> AODEIADKBCC edit"
                 " -> SendMessage borrow -> writer proof; origin cap " << kMaxOriginAdvanceTiles << " tiles");
    return true;
}

void Uninstall()
{
    if (!s_installed) return;
    Il2CppHook::UninstallMinHook(g_attackTarget, "ShotTxn.Attack");
    Il2CppHook::UninstallMinHook(g_mapAddTarget, "ShotTxn.MapAdd");
    Il2CppHook::UninstallMinHook(g_sendTarget, "ShotTxn.Send");
    Il2CppHook::UninstallMinHook(g_writerTarget, "ShotTxn.Writer");
    g_attackOrig = nullptr; g_mapAddOrig = nullptr; g_sendOrig = nullptr; g_writerOrig = nullptr;
    s_installed = false;
    s_installStatus.store("uninstalled", std::memory_order_relaxed);
}

bool IsInstalled() { return s_installed; }

bool ScopeOpen() { return t_scope != nullptr; }

void OnProjectileCreated(void* proj, int32_t ownerId, int32_t bulletId, float angle,
                         void* objProps, void* projProps, float lifetimeMul, float speedMul)
{
    Scope* sc = t_scope;
    if (!sc || ownerId != sc->objectId || !proj) return;

    // One projectile is staged at a time: the game adds and sends each projectile
    // before creating the next, so a still-edited predecessor was never matched.
    AbandonStaged(sc->staged, "next-projectile-before-send");

    Staged& st = sc->staged;
    st = Staged{};
    st.proj = proj;
    st.ownerId = ownerId;
    st.bulletId = static_cast<uint32_t>(bulletId);
    st.nativeAngle = angle;
    int32_t type = 0;
    if (Mem::TryRead(objProps, s_layout.objPropsType, type) && type > 0 && type <= 0xFFFF) {
        st.containerType = static_cast<uint16_t>(type);
        st.haveContainer = true;
        if (sc->haveContainer && st.containerType != sc->containerType)
            c_containerDisagree.fetch_add(1, std::memory_order_relaxed);
    }
    c_staged.fetch_add(1, std::memory_order_relaxed);

    if (const char* why = ClassifyProjProps(projProps, lifetimeMul, speedMul, st)) {
        NoteSkip(st, why);
        return;
    }
    st.state = StagedState::Created;
}

Stats GetStats()
{
    Stats s;
    s.scopes            = c_scopes.load(std::memory_order_relaxed);
    s.staged            = c_staged.load(std::memory_order_relaxed);
    s.edited            = c_edited.load(std::memory_order_relaxed);
    s.committed         = c_committed.load(std::memory_order_relaxed);
    s.restored          = c_restored.load(std::memory_order_relaxed);
    s.skipped           = c_skipped.load(std::memory_order_relaxed);
    s.packetMismatch    = c_packetMismatch.load(std::memory_order_relaxed);
    s.notSerialized     = c_notSerialized.load(std::memory_order_relaxed);
    s.sessionChanged    = c_sessionChanged.load(std::memory_order_relaxed);
    s.targetShots       = c_targetShots.load(std::memory_order_relaxed);
    s.mouseShots        = c_mouseShots.load(std::memory_order_relaxed);
    s.containerDisagree = c_containerDisagree.load(std::memory_order_relaxed);
    return s;
}

const char* LastSkipReason()    { return s_lastSkip.load(std::memory_order_relaxed); }
const char* LastRestoreReason() { return s_lastRestore.load(std::memory_order_relaxed); }
const char* InstallStatus()     { return s_installStatus.load(std::memory_order_relaxed); }

} // namespace ShotTransaction
