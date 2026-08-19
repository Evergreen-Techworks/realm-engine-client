#include "pch-il2cpp.h"
#include "TestTAB.h"
#include "DangerPlanner.h"
#include "MovementRuntime.h"
#include "ProjectileCatalog.h"
#include "XDodge.h"
#include "RolloutDodge.h"
#include "ZDodge.h"
#include "ZDodgeTarget.h"
#include "RePP.h"
#include "PJDodge.h"
#include "features/movement/udodge/UDodge.h"
#include "AutoNexus.h"
#include "DbgFileLog.h"
#include "BootGate.h"
#include <windows.h>

using TestTAB::DodgeMode;
#include <cmath>
#include <cstdlib>
#include <algorithm>
#include <vector>
#include <cstdint>
#include <atomic>
#include "W2S.h"
#include "gui/CamState.h"
#include "game/math/MoveSpeed.h"
#include "WorldTAB.h"
#include "CameraTAB.h"
#include "DirectX.h"
#include "ProjectileTracking.h"
#include "AutoAim.h"
#include "BagLooter.h"
#include "RuntimeOffsets.h"
#include "core/runtime/MemRead.h"
#include "GameState.h"
#include "LocalPlayer.h"
#include "FeatureState.h"
#include "SpeedHack.h"
#include "Noclip.h"
#include "NoclipHook.h"
#include "settings.h"
#include "PlayerCollider.h"
#include <imgui/imgui.h>

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
static bool  g_followMouse        = false;
static bool  g_ctrlClickTeleport  = true;  // Ctrl+LMB: instant TP toward cursor (max 2 tiles)
static bool  s_prevCtrlTpLmbDown  = false; // per-frame LMB edge-detect for Ctrl+TP
// Max Euclidean distance (tiles) for Ctrl+click teleport clamp — shared with debug preview.
static constexpr float kCtrlTeleportMaxTiles = 2.0f;

// Cached per-frame values for display
static float g_mouseWorldX  = 0.f, g_mouseWorldY  = 0.f;
static float g_mouseSX      = 0.f, g_mouseSY      = 0.f;
static bool  g_w2sValid     = false;

static bool  g_basisMeasured = false;
// Readout values
static float g_dbgCx = 0.f, g_dbgCy = 0.f, g_dbgZoom = 0.f, g_dbgAngleRad = 0.f;
static float g_dbgPlayerX = 0.f,  g_dbgPlayerY = 0.f;
static float g_dbgCamTileX = 0.f, g_dbgCamTileY = 0.f;

static float g_basisAgeMs = -1.f;
static bool  g_basisFull = false;
static float g_basisResidual = -1.f;

// Auto-refresh for World + Camera tabs
static float g_refreshTimer    = 0.f;
static float g_refreshInterval = 0.1f;  // 100 ms

// Combat debug overlay
static bool g_showAimOverlay = false;

// Fixed timestep speed (Time.fixedDeltaTime — not Time.timeScale)

// WorldManager +0xD8 / +0xDC uint — experimental per-frame adds

// Local LKHPPBEGNOM fields — KJNHLADHEMH (skin id) + HODJPKFINKF (defense int)
static bool    g_showLocalSkinDefenseHud = false;
static int32_t s_hudKJNHLADHEMH          = 0;
static int32_t s_hudHODJPKFINKF          = 0;
static int32_t g_kjnhladEdit              = 0;
static bool    s_kjnladInputActivePrev    = false;

static void WriteLocalKjnhlademh(int32_t v)
{
    void* p = LocalPlayer::GetPtr();
    if (!p) return;
    Mem::TryWrite<int32_t>(p, RuntimeOffsets::HP, v);
}

// Walk To target
static float g_walkX = 0.f, g_walkY = 0.f;
static bool  g_walkActive = false;

// Walk To ObjectID (one-shot: resolves entity position then walks there once)
static char    g_walkObjIdStr[16]  = {};
static char    g_walkObjStatus[48] = {};  // last status message for the UI

static constexpr float kPI = 3.14159265358979323846f;

// ─────────────────────────────────────────────────────────────────────────────
// Auto-Dodge state
// ─────────────────────────────────────────────────────────────────────────────
static DodgeMode g_dodgeMode = DodgeMode::Off;

// Player intent direction: read directly from the game's movement fields each frame.
// These are already camera-rotated and normalized by the game's InputHandler.
// +0x498 = moving (bool), +0x4C8 = moveDirX (float), +0x4CC = moveDirY (float).
// When the player is typing or idle, moving=false → no intent.
static float s_intentDirX     = 0.f;
static float s_intentDirY     = 0.f;
static bool  s_hasIntent      = false;

// Player environment-collision Chebyshev half-edge = kPlayerChebyshevScale × CRM.
// Used for wall/entity collision display ONLY — NOT for projectile hit detection.
// Projectile T: runtime HBEAKBIHANL+0x1D4 = CollisionMult × 0.5 (confirmed from IIOFFEHLMBC assembly).
// The game checks |player.pos - proj.pos| < T with the player as a point; no CRM term is added.
static constexpr float kPlayerChebyshevScale   = 0.2285f;
static float g_collisionDist       = 0.5f;  // legacy UI slider (standard T for CollisionMult=1.0)
static float g_enemyAvoidDist      = 1.0f;

// Legacy: VO/BFS/MPC/Flow dodge modes were removed in the Offsets merge. A*
// doesn't use a lookahead window, but IpcBridge still forwards the value for
// state-sync with the dashboard. Keep a no-op store so the getter/setter stay
// compilable and don't reject calls.
static float g_dodgeLookaheadMs = 800.f;
static inline float ClampDodgeLookaheadMs(float v)
{
    if (v < 100.f)  return 100.f;
    if (v > 4000.f) return 4000.f;
    return v;
}

namespace {

// ApplyDodgeModeWithEnter — single entry point used by the dashboard/IpcBridge
// and the local UI to transition dodge modes.
void ApplyDodgeModeWithEnter(DodgeMode nextMode)
{
    static DodgeMode s_prevDodgeMode = DodgeMode::Off;
    const bool enabling = nextMode != DodgeMode::Off && s_prevDodgeMode == DodgeMode::Off;
    (void)enabling;

    // On a patched/degraded game the offsets are stale. Running the dodge engines'
    // enter/disable machinery below reaches a crash on every mode switch: disabling
    // ZDodge publishes a debug snapshot whose whole-struct copy faults (confirmed by
    // map-symbolicating the minidump — ZDodge::PublishDebug -> g_debug). Leave every
    // engine untouched until offsets recover; the per-frame dispatch is gated the
    // same way (DangerPlanner), so nothing runs, and this re-applies once healed.
    if (BootGate::Degraded()) {
        static int s_gn = 0;
        if ((s_gn++ % 60) == 0)
            DBG_FILE_LOG("[DodgeSwap] ApplyDodgeModeWithEnter gated — BootGate degraded "
                         "(stale offsets after game patch); dodge engines untouched until recovery");
        return;
    }

    // XDodge and Rollout both run from Detour_AppEngineUpdate; only one is
    // enabled at a time (mutual exclusivity enforced here).
    const bool rollout = (nextMode == DodgeMode::RolloutGrid
                       || nextMode == DodgeMode::RolloutQuad);
    XDodge::SetEnabled(nextMode == DodgeMode::XDodge);
    RolloutDodge::SetEnabled(rollout);
    ZDodge::SetEnabled(nextMode == DodgeMode::ZDodge);
    RePP::SetEnabled(nextMode == DodgeMode::RePP);
    PJDodge::SetEnabled(nextMode == DodgeMode::PJDodge);
    UDodge::SetEnabled(nextMode == DodgeMode::UDodge);


    DBG_FILE_LOG("[DodgeSwap] ApplyDodgeModeWithEnter nextMode=" << static_cast<int>(nextMode)
        << " (0=Off 1=XDodge 2=RollGrid 3=RollQuad 4=ZDodge 5=RePP 6=PJDodge 7=UDodge)"
        << " -> enabled{ XDodge=" << XDodge::IsEnabled()
        << " Rollout=" << RolloutDodge::IsEnabled()
        << " ZDodge=" << ZDodge::IsEnabled()
        << " RePP=" << RePP::IsEnabled()
        << " PJDodge=" << PJDodge::IsEnabled()
        << " UDodge=" << UDodge::IsEnabled() << " }");
    if (nextMode == DodgeMode::XDodge) {
        XDodge::OnEnter();
        // Install the AppEngineManager::Update detour that drives the dodge Tick.
        // Previously this only happened in the in-game TestTAB render path, so
        // dashboard/IPC-driven dodge (production client, ImGui menu stripped)
        // never installed the hook → Detour_AppEngineUpdate never fired →
        // Tick never ran → dodge silently did nothing while other IPC features
        // (autoaim) worked. The detour is gated on XDodge/RolloutDodge
        // IsEnabled(), independent of DangerPlanner steering.
        DangerPlanner::TryInstall();
    } else if (rollout) {
        // Both RE-Sim modes are the same engine; the mode selects the
        // broad-phase backend (Grid vs Quadtree) for the A/B comparison.
        RolloutDodge::SetBroadPhase(nextMode == DodgeMode::RolloutQuad ? 3 : 2);
        RolloutDodge::OnEnter();
        DangerPlanner::TryInstall();
    } else if (nextMode == DodgeMode::ZDodge) {
        ZDodge::OnEnter();
        DangerPlanner::TryInstall();
    } else if (nextMode == DodgeMode::RePP) {
        RePP::OnEnter();
        DangerPlanner::TryInstall();
    } else if (nextMode == DodgeMode::PJDodge) {
        PJDodge::OnEnter();
        DangerPlanner::TryInstall();
    } else if (nextMode == DodgeMode::UDodge) {
        UDodge::OnEnter();
        DangerPlanner::TryInstall();
    }

    // DangerPlanner steering is disabled; the active dodge engine drives moves.
    DangerPlanner::SetEnabled(false);

    g_dodgeMode = nextMode;
    s_prevDodgeMode = g_dodgeMode;
}

} // namespace

// ─────────────────────────────────────────────────────────────────────────────
// Legacy game hitbox display helpers. PlayerCollider is the only writer for
// ObjectProperties.collisionRadiusMultiplier; this tab may read it for debug UI.
// ─────────────────────────────────────────────────────────────────────────────
// Native speed mult: HBEAKBIHANL KDAJOMOFMJB via il2cpp_field_get_offset; optional UI scale in ProjectileTracking.
static float g_flashSpeedMulUi = 1.f;




// ─────────────────────────────────────────────────────────────────────────────
// Reads ObjectProperties.collisionRadiusMultiplier from the local player.
// Returns 1.0 on failure or if the stored value looks unset (0.0 / NaN).
// ─────────────────────────────────────────────────────────────────────────────
static float ReadCollisionMult(void* entityPtr)
{
    if (!entityPtr) return 1.0f;
    __try {
        uint8_t* e = reinterpret_cast<uint8_t*>(entityPtr);
        void* op = *reinterpret_cast<void**>(e + RuntimeOffsets::ObjProps);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
        if (!op) return 1.0f;
        if (!Mem::AddrOk(op)) return 1.0f;
        float mult = *reinterpret_cast<float*>(reinterpret_cast<uint8_t*>(op) + RuntimeOffsets::OP_CollRadiusMult);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
        if (mult != mult || mult < 0.f || mult > 20.f) return 1.0f;  // NaN / invalid
        return mult;
    } __except (EXCEPTION_EXECUTE_HANDLER) {}
    return 1.0f;
}

static float ReadCollisionMultAlt(void* entityPtr)
{
    if (!entityPtr) return 1.0f;
    __try {
        uint8_t* e = reinterpret_cast<uint8_t*>(entityPtr);
        void* op = *reinterpret_cast<void**>(e + RuntimeOffsets::MoObjectProps);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
        if (!op) return 1.0f;
        if (!Mem::AddrOk(op)) return 1.0f;
        float mult = *reinterpret_cast<float*>(reinterpret_cast<uint8_t*>(op) + RuntimeOffsets::OP_CollRadiusMult);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
        if (mult != mult || mult < 0.f || mult > 20.f) return 1.0f;
        return mult;
    } __except (EXCEPTION_EXECUTE_HANDLER) {}
    return 1.0f;
}

// Player dodge Chebyshev half-edge from live CRM (matches in-game hitbox overlay).
static float GamePlayerChebyshevHalf()
{
    return kPlayerChebyshevScale * ReadCollisionMult(WorldTAB::GetLocalPtr());
}


// ─────────────────────────────────────────────────────────────────────────────
// MovePlayer — direct position write.
//
// Writes to 4 fields on the player object:
//   +0x3C / +0x40  server-side world X / Y  (read by MOVE packets)
//   +0x68 / +0x6C  Unity visual X / -Y      (Transform world position)
//
// Step budget uses the official SPD formula:
//   base T/s = 4 + 5.6 * (SPD / 75)
//   Speedy (tile speed > 1.0): T/s * 1.5
//
// Collision model (hitbox-aware):
//   - Player hitbox is a 0.457 × 0.457 square centred on (x, y).
//   - Collision is checked against ALL tiles the hitbox would overlap.
//   - The leading EDGE of the hitbox is clamped at tile boundaries so the
//     player never visually overlaps a wall.
//   - When the diagonal step is blocked, X-only and Y-only slides are
//     attempted so the player glides smoothly along walls.
//
// playerX/playerY must be the same live values used for this frame's S2W / Walk
// checks (from the CamState snapshot) — do not re-read from memory here.
// ─────────────────────────────────────────────────────────────────────────────

static constexpr float kTileInset   = 0.01f;

static bool NoclipWalkabilityOverride(float cx, float cy, bool& outBlocked)
{
    if (!Noclip::ShouldBypassWalkable())
        return false;

    outBlocked = false;
    return true;
}

// Check whether the player hitbox centred at (cx, cy) overlaps any blocked tile.
static bool IsPositionBlocked(float cx, float cy)
{
    bool noclipBlocked = false;
    if (NoclipWalkabilityOverride(cx, cy, noclipBlocked))
        return noclipBlocked;

    int x0 = static_cast<int>(floorf(cx - kPlayerChebyshevScale));
    int x1 = static_cast<int>(floorf(cx + kPlayerChebyshevScale));
    int y0 = static_cast<int>(floorf(cy - kPlayerChebyshevScale));
    int y1 = static_cast<int>(floorf(cy + kPlayerChebyshevScale));
    for (int tx = x0; tx <= x1; ++tx)
        for (int ty = y0; ty <= y1; ++ty)
            if (WorldTAB::IsTileBlocked(tx, ty))
                return true;
    return false;
}

// Flash isValidPosition section B — sub-tile FullOccupy neighbour check.
// A walkable tile can still constrain sub-tile positions: if the player centre
// fractional position is in the left/right/top/bottom half of the tile, the
// corresponding adjacent tile(s) must not be FullOccupy.
//
// Replicates Player.isFullOccupy() neighbour queries exactly as in the Flash client:
//   frac_x < 0.5 → check left cardinal + left diagonals
//   frac_x > 0.5 → check right cardinal + right diagonals
//   frac_x == 0.5 → only cardinal Y checks apply
// (The original splits at exactly 0.5 with no hysteresis.)
static bool IsCircleBlocked(float cx, float cy)
{
    bool noclipBlocked = false;
    if (NoclipWalkabilityOverride(cx, cy, noclipBlocked))
        return noclipBlocked;

    const int   tx = static_cast<int>(floorf(cx));
    const int   ty = static_cast<int>(floorf(cy));
    const float fx = cx - static_cast<float>(tx);
    const float fy = cy - static_cast<float>(ty);

    auto fo = [](int x, int y) { return WorldTAB::IsTileFullOccupied(x, y); };

    if (fx < 0.5f) {
        if (fo(tx - 1, ty)) return true;
        if      (fy < 0.5f) { if (fo(tx, ty - 1) || fo(tx - 1, ty - 1)) return true; }
        else if (fy > 0.5f) { if (fo(tx, ty + 1) || fo(tx - 1, ty + 1)) return true; }
    } else if (fx > 0.5f) {
        if (fo(tx + 1, ty)) return true;
        if      (fy < 0.5f) { if (fo(tx, ty - 1) || fo(tx + 1, ty - 1)) return true; }
        else if (fy > 0.5f) { if (fo(tx, ty + 1) || fo(tx + 1, ty + 1)) return true; }
    } else {
        if      (fy < 0.5f) { if (fo(tx, ty - 1)) return true; }
        else if (fy > 0.5f) { if (fo(tx, ty + 1)) return true; }
    }
    return false;
}

// Clamp movement along one axis so the hitbox's LEADING EDGE doesn't cross
// into a blocked tile.  axis 0 = X, axis 1 = Y.
// otherCenter = player's perpendicular-axis centre (fixed during this slide).
static float ClampAxisHitbox(float from, float to, float otherCenter, int axis)
{
    if (fabsf(to - from) < 1e-6f) return to;

    bool noclipBlocked = false;
    const float targetX = (axis == 0) ? to : otherCenter;
    const float targetY = (axis == 0) ? otherCenter : to;
    if (NoclipWalkabilityOverride(targetX, targetY, noclipBlocked))
        return noclipBlocked ? from : to;

    int dir = (to > from) ? 1 : -1;

    // Leading edge of the hitbox on this axis
    float fromEdge = from + dir * kPlayerChebyshevScale;
    float toEdge   = to   + dir * kPlayerChebyshevScale;

    int fromEdgeTile = static_cast<int>(floorf(fromEdge));
    int toEdgeTile   = static_cast<int>(floorf(toEdge));

    // All perpendicular tiles the hitbox spans (by the other axis extent)
    int oMin = static_cast<int>(floorf(otherCenter - kPlayerChebyshevScale));
    int oMax = static_cast<int>(floorf(otherCenter + kPlayerChebyshevScale));

    // Walk each tile boundary the leading edge would cross
    for (int t = fromEdgeTile + dir;
         dir > 0 ? t <= toEdgeTile : t >= toEdgeTile;
         t += dir)
    {
        for (int o = oMin; o <= oMax; ++o) {
            int tx = (axis == 0) ? t : o;
            int ty = (axis == 0) ? o : t;
            if (WorldTAB::IsTileBlocked(tx, ty)) {
                // Stop the edge just before the boundary of this blocked tile.
                float boundary = static_cast<float>(dir > 0 ? t : t + 1);
                float edgeStop = boundary - dir * kTileInset;
                return edgeStop - dir * kPlayerChebyshevScale;
            }
        }
    }
    return to;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-Dodge: evaluate bullet threat and find safest walkable position
// ─────────────────────────────────────────────────────────────────────────────

static void ReadPlayerStats(int32_t& hp, int32_t& maxHp, float& spd, float& tilesPerSec) {
    hp = 0; maxHp = 0; spd = 0.f; tilesPerSec = 0.f;
    void* lp = WorldTAB::GetLocalPtr();
    if (!lp) return;
    __try { hp    = *(int32_t*)((uint8_t*)lp + RuntimeOffsets::HP);    } __except(EXCEPTION_EXECUTE_HANDLER) {}
    __try { maxHp = *(int32_t*)((uint8_t*)lp + RuntimeOffsets::MaxHP); } __except(EXCEPTION_EXECUTE_HANDLER) {}
    // Move budget from the game's own CalcMoveSpeed (name-stable GCFKGLKAPND).
    // The old raw read at player+0x478 landed on a pointer field after the
    // 2026-08 layout shift, failed the 0<spd<=120 guard, left tilesPerSec at 0,
    // and PJDodgeCore's `c.speed <= 0` gate silently disabled every dodge.
    tilesPerSec = DodgeRuntime::GetTilesPerSec(lp);
    if (tilesPerSec <= 0.f) {
        // Unresolved (e.g. first frames in world): assume SPD 50 so the dodge
        // planner always has a non-zero move budget. Server-authoritative
        // clamping tolerates a modest under/over-estimate.
        tilesPerSec = GameMath::TilesPerSecFromSpd(50.f);
    }
    // Display-equivalent SPD stat back-derived from the speed curve
    // (Flash: tilesPerSec = 4.0 + 5.6 * spd/75, capped at SPD 75).
    spd = GameMath::SpdFromTilesPerSec(tilesPerSec);
}



static void MovePlayer(float targetWorldX, float targetWorldY, float dt,
                       float playerX, float playerY, void* player,
                       float speedMult = 1.0f)
{
    if (!player) return;

    float dx  = targetWorldX - playerX;
    float dy  = targetWorldY - playerY;
    float mag = sqrtf(dx * dx + dy * dy);

    if (mag < 0.01f) return;

    // Step budget from the game's own CalcMoveSpeed; SPD-50 curve fallback
    // when unresolved. (The old raw +0x478 SPD read broke on the 2026-08 build.)
    float tps = DodgeRuntime::GetTilesPerSec(player);
    if (tps <= 0.f) tps = GameMath::TilesPerSecFromSpd(50.f);

    float maxStep = tps * dt * speedMult;

    {
        float tileSpd = WorldTAB::GetTileSpeed(
            static_cast<int>(floorf(playerX)),
            static_cast<int>(floorf(playerY)));
        if (tileSpd > 1.0f) maxStep *= 1.5f;
    }

    float step  = (mag < maxStep) ? mag : maxStep;
    float wantX = playerX + (dx / mag) * step;
    float wantY = playerY + (dy / mag) * step;

    // ── Hitbox-aware collision: tiles (AABB) + FullOccupy sub-tile check ─────
    // Tile blocking (IsPositionBlocked): AABB sweep via ClampAxisHitbox.
    //   Blocks on NoWalk, OccupySquare, and FullOccupy tiles (Flash isWalkable parity).
    // Sub-tile check (IsCircleBlocked): Flash isValidPosition section B parity.
    //   Constrains fractional position within a walkable tile based on FullOccupy neighbours.
    bool alreadyTileBlocked   = IsPositionBlocked(playerX, playerY);
    bool alreadyCircleBlocked = !alreadyTileBlocked && IsCircleBlocked(playerX, playerY);
    bool alreadyBlocked       = alreadyTileBlocked || alreadyCircleBlocked;

    float moveX, moveY;
    if (!IsPositionBlocked(wantX, wantY) && !IsCircleBlocked(wantX, wantY)) {
        moveX = wantX;
        moveY = wantY;
    } else {
        // Diagonal blocked — try axis-split sliding.
        // Tile slide: clamp the leading edge to the wall boundary.
        float slideX = ClampAxisHitbox(playerX, wantX, playerY, 0);
        // Also reject X slide if it would violate a FullOccupy neighbour constraint.
        bool  okX    = fabsf(slideX - playerX) > kTileInset * 2.f &&
                       !IsCircleBlocked(slideX, playerY);

        float slideY = ClampAxisHitbox(playerY, wantY, playerX, 1);
        bool  okY    = fabsf(slideY - playerY) > kTileInset * 2.f &&
                       !IsCircleBlocked(playerX, slideY);

        if (!okX && !okY) {
                        return;
        }

        moveX = okX ? slideX : playerX;
        moveY = okY ? slideY : playerY;
    }

    if (!alreadyBlocked && (IsPositionBlocked(moveX, moveY) || IsCircleBlocked(moveX, moveY))) {
                return;
    }

    // Route through the native move function (FKALGHJIADI::DGLCONCOIBO)
    // instead of raw-writing position fields. Raw writes bypass ACTk's
    // rigidbody velocity tracking → server sees inconsistent position
    // deltas → snap-back. The native function does its own collision
    // and speed-clamp, so our pre-clamped (moveX, moveY) target is
    // accepted as-is when it's within one frame's speed budget.
    DangerPlanner::NativeMoveTo(player, moveX, moveY);
}


// ─────────────────────────────────────────────────────────────────────────────
// TestTAB::Tick — called every frame from dPresent
// ─────────────────────────────────────────────────────────────────────────────
void TestTAB::Tick(bool menuVisible)
{
    // ImGui DeltaTime is sometimes 0 or huge on injected Present paths — use QPC when needed.
    static LARGE_INTEGER s_qpcPrev = {}, s_qpcFreq = {};
    if (!s_qpcFreq.QuadPart)
        QueryPerformanceFrequency(&s_qpcFreq);
    LARGE_INTEGER qpcNow;
    QueryPerformanceCounter(&qpcNow);

    float dt = ImGui::GetIO().DeltaTime;
    if (s_qpcPrev.QuadPart && s_qpcFreq.QuadPart) {
        float qpcDt = static_cast<float>(qpcNow.QuadPart - s_qpcPrev.QuadPart) /
                      static_cast<float>(s_qpcFreq.QuadPart);
        if (dt < 0.0005f || dt > 0.25f)
            dt = qpcDt;
    }
    s_qpcPrev = qpcNow;
    dt = std::clamp(dt, 1.f / 500.f, 1.f / 15.f);

    ProjectileTracking::SetFlashSpeedMultiplier(g_flashSpeedMulUi);

    // ── Auto-refresh World + Camera (keep local ptr + camera live for movement)
    if (g_followMouse || g_walkActive || IsAnyAutoDodgeEnabled() ||
        CombatTAB::FeatAutoNexus::OverlayEnabled()) {
        g_refreshTimer += dt;
        if (g_refreshTimer >= g_refreshInterval) {
            g_refreshTimer = 0.f;
            WorldTAB::ForceRefresh();
            CameraTAB::ForceRefresh();
        }
    }

    // Feed Follow-Mouse target into the dodge planner as an external goal.
    if (!g_walkActive) {
        if (g_followMouse && g_w2sValid) {
            DangerPlanner::SetExternalGoal(g_mouseWorldX, g_mouseWorldY);
        } else if (BagLooter::GetActiveBagId() == 0) {
            // Only clear when no other subsystem owns the goal.
            // BagLooter sets ext-goal at 250ms cadence; without this
            // guard TestTAB's per-frame ClearExternalGoal would wipe
            // it on every render frame and the looter could never
            // actually drive movement.
            DangerPlanner::ClearExternalGoal();
        }
    }

    // ── Build camera/screen state for this frame ─────────────────────────────
    CamState::Tick();
    const CamState::Snapshot& cs = CamState::Get();
    float camX = cs.camX, camY = cs.camY, angleRad = cs.angleRad, zoom = cs.zoom;
    float cx = cs.cx, cy = cs.cy;
    g_w2sValid = cs.valid;
    g_dbgCx = cx; g_dbgCy = cy; g_dbgZoom = zoom; g_dbgAngleRad = angleRad;
    // Mirror the OVERLAY PROJECTION diagnostics for the Test-tab readout.
    g_dbgPlayerX    = cs.playerX;       g_dbgPlayerY    = cs.playerY;
    g_dbgCamTileX   = cs.camTileX;      g_dbgCamTileY   = cs.camTileY;
    g_basisAgeMs    = cs.basisAgeMs;    g_basisResidual = cs.basisResidual;
    g_basisMeasured = cs.basisMeasured; g_basisFull     = cs.basisFull;

    // ── Mouse position (screen coords, relative to game client area) ────────
    POINT pt;
    GetCursorPos(&pt);
    if (DirectX::window) ScreenToClient(DirectX::window, &pt);
    g_mouseSX = static_cast<float>(pt.x);
    g_mouseSY = static_cast<float>(pt.y);

    // ── Update debug world position of mouse ────────────────────────────────
    if (g_w2sValid) {
        S2W(g_mouseSX, g_mouseSY,
            g_mouseWorldX, g_mouseWorldY,
            camX, camY, angleRad, zoom, cx, cy);
    }

    // ── Draw overlay lines ─────────────────────────────────────────────────
    ImDrawList* dl = ImGui::GetForegroundDrawList();
    if (dl && g_w2sValid) {
        if (g_followMouse) {
            dl->AddLine(
                ImVec2(cx, cy),
                ImVec2(g_mouseSX, g_mouseSY),
                IM_COL32(255, 230, 50, 220),    // yellow
                2.0f);
            dl->AddCircleFilled(ImVec2(cx, cy), 4.f, IM_COL32(255, 100, 50, 255));
        }

        if (g_walkActive) {
            float tSX, tSY;
            if (W2S(g_walkX, g_walkY, tSX, tSY,
                    camX, camY, angleRad, zoom, cx, cy)) {
                dl->AddLine(
                    ImVec2(cx, cy),
                    ImVec2(tSX, tSY),
                    IM_COL32(50, 220, 255, 220),    // cyan
                    2.0f);
                dl->AddCircleFilled(ImVec2(tSX, tSY), 5.f, IM_COL32(50, 220, 255, 255));
            }
        }

        // Planned-path overlay. Each engine's RenderDebugPath only gates on its
        // own "draw path" toggle, which persists across mode switches — so gate
        // on the active engine here too, otherwise a disabled engine keeps
        // drawing its stale viz buffers after you switch modes.
        if (g_w2sValid) {
            if (XDodge::IsEnabled())       XDodge::RenderDebugPath(camX, camY, angleRad, zoom, cx, cy);
            if (RolloutDodge::IsEnabled()) RolloutDodge::RenderDebugPath(camX, camY, angleRad, zoom, cx, cy);
            if (ZDodge::IsEnabled()) {
                ZDodge::RenderDebugOverlay(camX, camY, angleRad, zoom, cx, cy);
                ZDodge::Target::Render(dl, camX, camY, angleRad, zoom, cx, cy);
            }
            if (RePP::IsEnabled()) {
                RePP::RenderDebugOverlay(camX, camY, angleRad, zoom, cx, cy);
            }
            if (PJDodge::IsEnabled()) {
                PJDodge::RenderDebugOverlay(camX, camY, angleRad, zoom, cx, cy);
            }
            if (UDodge::IsEnabled()) {
                UDodge::RenderDebugOverlay(camX, camY, angleRad, zoom, cx, cy);
            }
            CombatTAB::FeatAutoNexus::RenderDebugPath(camX, camY, angleRad, zoom, cx, cy);
        }

        // Locked enemy visualization — red reticle + two rings:
        //   outer (solid red)  = your actual weapon range (where shots hit)
        //   inner (dashed red) = planner's park distance (where it holds you)
        {
            float ex, ey, rr, weaponR;
            if (DangerPlanner::GetLockTarget(ex, ey, rr, weaponR)) {
                float eSX, eSY;
                if (W2S(ex, ey, eSX, eSY, camX, camY, angleRad, zoom, cx, cy)) {
                    const ImU32 colLock     = IM_COL32(255, 80, 80, 230);
                    const ImU32 colWeapon   = IM_COL32(255, 120, 60, 180);
                    const ImU32 colFollow   = IM_COL32(255, 80, 80, 120);
                    // Crosshair on the enemy.
                    dl->AddCircle(ImVec2(eSX, eSY), 10.f, colLock, 16, 2.0f);
                    dl->AddLine(ImVec2(eSX - 14.f, eSY), ImVec2(eSX - 6.f, eSY), colLock, 2.0f);
                    dl->AddLine(ImVec2(eSX + 6.f, eSY), ImVec2(eSX + 14.f, eSY), colLock, 2.0f);
                    dl->AddLine(ImVec2(eSX, eSY - 14.f), ImVec2(eSX, eSY - 6.f), colLock, 2.0f);
                    dl->AddLine(ImVec2(eSX, eSY + 6.f), ImVec2(eSX, eSY + 14.f), colLock, 2.0f);

                    // Helper: project a world-space radius R around the enemy
                    // to an approximate screen-space radius by averaging 4
                    // cardinal projections (accounts for camera rotation/zoom).
                    auto projectRing = [&](float worldR, float& outAvgRPx) -> bool {
                        ImVec2 pts[4];
                        const float offs[4][2] = { { 1, 0 }, { 0, 1 }, { -1, 0 }, { 0, -1 } };
                        for (int i = 0; i < 4; ++i) {
                            float rx, ry;
                            if (!W2S(ex + offs[i][0] * worldR, ey + offs[i][1] * worldR, rx, ry,
                                     camX, camY, angleRad, zoom, cx, cy)) return false;
                            pts[i] = ImVec2(rx, ry);
                        }
                        outAvgRPx = 0.25f * (
                            sqrtf((pts[0].x - eSX) * (pts[0].x - eSX) + (pts[0].y - eSY) * (pts[0].y - eSY)) +
                            sqrtf((pts[1].x - eSX) * (pts[1].x - eSX) + (pts[1].y - eSY) * (pts[1].y - eSY)) +
                            sqrtf((pts[2].x - eSX) * (pts[2].x - eSX) + (pts[2].y - eSY) * (pts[2].y - eSY)) +
                            sqrtf((pts[3].x - eSX) * (pts[3].x - eSX) + (pts[3].y - eSY) * (pts[3].y - eSY)));
                        return true;
                    };

                    float rPxOuter = 0.f, rPxInner = 0.f;
                    if (weaponR > 0.f && projectRing(weaponR, rPxOuter)) {
                        dl->AddCircle(ImVec2(eSX, eSY), rPxOuter, colWeapon, 48, 1.8f);
                    }
                    if (rr > 0.f && projectRing(rr, rPxInner)) {
                        dl->AddCircle(ImVec2(eSX, eSY), rPxInner, colFollow, 48, 1.5f);
                    }
                }
            }
        }

        if (g_showAimOverlay && AutoAim::HasTarget()) {
            float awx = 0.f, awy = 0.f;
            AutoAim::GetAimTarget(awx, awy);
            float tSX, tSY;
            if (W2S(awx, awy, tSX, tSY, camX, camY, angleRad, zoom, cx, cy)) {
                // Line from player centre to aim target
                dl->AddLine(
                    ImVec2(cx, cy),
                    ImVec2(tSX, tSY),
                    IM_COL32(255, 60, 60, 220),     // red
                    2.0f);
                // Cross-hair circle at aim target
                dl->AddCircle(ImVec2(tSX, tSY), 8.f,  IM_COL32(255, 60, 60, 255), 16, 2.f);
                dl->AddCircleFilled(ImVec2(tSX, tSY), 3.f, IM_COL32(255, 200, 60, 255));
                // World coords label
                char lbl[48];
                std::snprintf(lbl, sizeof(lbl), "(%.1f, %.1f)", (double)awx, (double)awy);
                dl->AddText(ImVec2(tSX + 10.f, tSY - 8.f), IM_COL32(255, 200, 60, 255), lbl);
            }
        }

    }

    // ── Local player KJNHLADHEMH / HODJPKFINKF — live read + HUD (runs every frame when enabled) ─
    if (g_showLocalSkinDefenseHud) {
        void* lp = LocalPlayer::GetPtr();
        if (lp) {
            // LKHPPBEGNOM own fields need direct raw reads — ACTK +0x50 shift means
            // il2cpp_field_get_value reads dump offsets which land in ACTK bytes.
            s_hudKJNHLADHEMH = Mem::ReadOr<int32_t>(lp, RuntimeOffsets::HP,      0);
            s_hudHODJPKFINKF = Mem::ReadOr<int32_t>(lp, RuntimeOffsets::Defense, 0);
        } else {
            s_hudKJNHLADHEMH = 0;
            s_hudHODJPKFINKF = 0;
        }

        ImDrawList* hudDl = ImGui::GetForegroundDrawList();
        if (hudDl) {
            char l1[56], l2[56];
            std::snprintf(l1, sizeof(l1), "KJNHLADEMH  %d", static_cast<int>(s_hudKJNHLADHEMH));
            std::snprintf(l2, sizeof(l2), "HODJPKFINKF  %d", static_cast<int>(s_hudHODJPKFINKF));
            const float hx = 14.f, hy = 14.f;
            hudDl->AddText(ImVec2(hx + 1.f, hy + 1.f), IM_COL32(0, 0, 0, 200), l1);
            hudDl->AddText(ImVec2(hx + 1.f, hy + 19.f), IM_COL32(0, 0, 0, 200), l2);
            hudDl->AddText(ImVec2(hx, hy), IM_COL32(235, 235, 240, 255), l1);
            hudDl->AddText(ImVec2(hx, hy + 18.f), IM_COL32(235, 235, 240, 255), l2);
            hudDl->AddLine(ImVec2(hx, hy + 34.f), ImVec2(hx + 200.f, hy + 34.f), IM_COL32(80, 80, 90, 160), 1.f);
        }
    }

    // ── Movement priority: AutoDodge > Follow Entity > Walk To > Follow Mouse ─
    void* localPlayer = WorldTAB::GetLocalPtr();

    // ── Dodge → Follow Entity → Walk To → Follow Mouse ─────────────────────────
    bool dodgeMoved     = false;
    bool dodgeHandlesNav = false;
    {
        bool active = false;

        if (localPlayer && IsAnyAutoDodgeEnabled()) {
            // XDodge runs from Detour_AppEngineUpdate — install the hook lazily.
            // DangerPlanner steering is kept off; XDodge handles movement itself.
            DangerPlanner::TryInstall();
            active = true;   // dodge is steering.
            dodgeMoved = true;
            dodgeHandlesNav = true;

            // Draw intent vector overlay (green) when the player is pressing WASD
            if (dl && g_w2sValid && s_hasIntent && active) {
                const float intentLen = 0.8f;
                const float iWorldX = camX + s_intentDirX * intentLen;
                const float iWorldY = camY + s_intentDirY * intentLen;
                float iSX, iSY;
                if (W2S(iWorldX, iWorldY, iSX, iSY, camX, camY, angleRad, zoom, cx, cy)) {
                    const ImU32 intentCol = dodgeMoved
                        ? IM_COL32(50, 220, 50, 180)   // green: dodge is steering, intent shown alongside
                        : IM_COL32(220, 255, 220, 200); // white-green: passthrough active, user has control
                    dl->AddLine(ImVec2(cx, cy), ImVec2(iSX, iSY), intentCol, 2.0f);
                    dl->AddCircleFilled(ImVec2(iSX, iSY), 3.5f, intentCol);
                }
            }
        }

        if (!dodgeMoved && !dodgeHandlesNav && g_walkActive) {
            if (localPlayer) {
                float dx = g_walkX - camX;
                float dy = g_walkY - camY;
                if (sqrtf(dx * dx + dy * dy) < 0.15f) {
                    FeatureState::SetWalkTarget(g_walkX, g_walkY, false);
                } else {
                    MovePlayer(g_walkX, g_walkY, dt, camX, camY, localPlayer);
                }
            } else {
                FeatureState::SetWalkTarget(g_walkX, g_walkY, false);
            }
        }
        else if (!dodgeMoved && !dodgeHandlesNav && g_followMouse && !menuVisible && g_w2sValid && localPlayer) {
            MovePlayer(g_mouseWorldX, g_mouseWorldY, dt, camX, camY, localPlayer);
        }

        // ── Ctrl+Click instant teleport (max 2 tiles, avoids blocked tiles) ──
        // KeyBinds::WndProc is never called from dWndProc so KeyState never updates.
        // Use GetAsyncKeyState with a manual per-frame edge-detect for LMB instead.
        {
            const bool lmbDown  = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0;
            const bool lmbEdge  = lmbDown && !s_prevCtrlTpLmbDown;
            s_prevCtrlTpLmbDown = lmbDown;

            if (g_ctrlClickTeleport && localPlayer && g_w2sValid && !menuVisible
                && (GetAsyncKeyState(VK_CONTROL) & 0x8000) && lmbEdge)
            {
                float tpX = 0.f, tpY = 0.f;
                const bool okLand = ComputeCtrlTeleportLanding(
                    camX, camY, g_mouseWorldX, g_mouseWorldY, tpX, tpY);

                if (okLand) {
                    Mem::TryWrite<float>(localPlayer, RuntimeOffsets::PosX, tpX);
                    Mem::TryWrite<float>(localPlayer, RuntimeOffsets::PosY, tpY);
                    Mem::TryWrite<float>(localPlayer, RuntimeOffsets::KJ_Float3Pos, tpX);
                    Mem::TryWrite<float>(localPlayer, RuntimeOffsets::KJ_Float3Pos + 4u, -tpY);
                }
            }
        }

        // Right-click goal removed — DangerPlanner is WASD-driven + external
        // goal pipe. See DangerPlanner::SetExternalGoal for plugin overrides.

        // ── Shift + LMB → Enemy lock toggle ─────────────────────────────
        // Click-on-enemy to follow it at weapon range; click the same enemy
        // again to unlock. Requires Shift to avoid interfering with the
        // game's normal LMB-to-shoot input.
        {
            static bool s_prevLockChord = false;
            const bool shiftDown = (GetAsyncKeyState(VK_SHIFT)   & 0x8000) != 0;
            const bool lmbDown   = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0;
            const bool chord     = shiftDown && lmbDown;
            const bool chordEdge = chord && !s_prevLockChord;
            s_prevLockChord = chord;

            if (chordEdge && g_w2sValid && !menuVisible) {
                // Dual-target click: closest enemy OR closest player
                // wins, whichever is nearer to the cursor. Enemies get
                // lock-follow (orbit at weapon range), players get
                // follow-pursuit (walk toward them while dodging).
                // 2.0 tile click radius squared = 4.0.
                int32_t bestEnemyId = 0;
                float   bestEnemyD2 = 4.0f;
                int32_t bestPlayerId = 0;
                float   bestPlayerD2 = 4.0f;

                struct HoverCtx {
                    float   mx, my;
                    float   bestD2;
                    int32_t bestId;
                };
                HoverCtx ectx{ g_mouseWorldX, g_mouseWorldY, 4.0f, 0 };
                AutoAim::EnumerateLiveEnemies(
                    [](float ex, float ey, int32_t id, void* user) {
                        HoverCtx* c = static_cast<HoverCtx*>(user);
                        const float dx = ex - c->mx;
                        const float dy = ey - c->my;
                        const float d2 = dx * dx + dy * dy;
                        if (d2 < c->bestD2) { c->bestD2 = d2; c->bestId = id; }
                    },
                    &ectx);
                bestEnemyId = ectx.bestId;
                bestEnemyD2 = ectx.bestD2;

                // Players: iterate WorldTAB::GetEntities and pick the
                // closest one that has a non-empty playerName and
                // isn't flagged as enemy or the local player.
                const auto& ents = WorldTAB::GetEntities();
                for (const auto& e : ents) {
                    if (e.playerName[0] == 0) continue;    // not a player
                    if (e.objConds & OCOND_IS_ENEMY) continue;
                    if (e.isLocal) continue;               // don't follow self
                    const float dx = e.x - g_mouseWorldX;
                    const float dy = e.y - g_mouseWorldY;
                    const float d2 = dx * dx + dy * dy;
                    if (d2 < bestPlayerD2) {
                        bestPlayerD2 = d2;
                        bestPlayerId = e.objectId;
                    }
                }

                if (bestPlayerId != 0 && bestPlayerD2 <= bestEnemyD2) {
                    const int32_t current = DangerPlanner::GetFollowPlayer();
                    if (current == bestPlayerId) DangerPlanner::ClearFollowPlayer();
                    else                         DangerPlanner::SetFollowPlayer(bestPlayerId);
                } else if (bestEnemyId != 0) {
                    const int32_t current = DangerPlanner::GetEnemyLock();
                    if (current == bestEnemyId) DangerPlanner::ClearEnemyLock();
                    else                        DangerPlanner::SetEnemyLock(bestEnemyId);
                }
            }
        }

        // ── MMB: ZDodge target lock ─────────────────────────────────────
        // Middle-click near an enemy to lock it as the ZDodge range-keeping
        // target. Click the same enemy again to release (toggle). Picks by screen
        // distance so the click maps exactly to what the player sees on screen.
        {
            static bool s_prevMmb = false;
            const bool mmbDown = (GetAsyncKeyState(VK_MBUTTON) & 0x8000) != 0;
            const bool mmbEdge = mmbDown && !s_prevMmb;
            s_prevMmb = mmbDown;
            if (mmbEdge && g_w2sValid && !menuVisible && !ImGui::GetIO().WantCaptureMouse)
                ZDodge::Target::ProcessClick(g_mouseSX, g_mouseSY,
                                                  camX, camY, angleRad, zoom, cx, cy);
        }

        // ── Player intent tracking ────────────────────────────────────────────
        // Read directly from the game's movement fields on the player object.
        // These are written by the game's InputHandler (WASD → camera-rotated world dir)
        // and are NOT affected by our position writes or dodge steering.
        if (localPlayer) {
            const bool  gameMoving = Mem::ReadOr<bool>(localPlayer,  RuntimeOffsets::Player_Moving,   false);
            const float gameDirX   = Mem::ReadOr<float>(localPlayer, RuntimeOffsets::Player_MoveDirX, 0.f);
            const float gameDirY   = Mem::ReadOr<float>(localPlayer, RuntimeOffsets::Player_MoveDirY, 0.f);
            if (gameMoving && std::isfinite(gameDirX) && std::isfinite(gameDirY)) {
                const float len = sqrtf(gameDirX * gameDirX + gameDirY * gameDirY);
                if (len > 0.01f) {
                    s_intentDirX = gameDirX / len;
                    s_intentDirY = gameDirY / len;
                    s_hasIntent  = true;
                } else {
                    s_hasIntent = false;
                }
            } else {
                s_hasIntent = false;
            }
        } else {
            s_hasIntent = false;
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TestTAB::RenderMovementSection — Follow Mouse + Follow Entity (Movement tab)
// ─────────────────────────────────────────────────────────────────────────────
void TestTAB::RenderMovementSection()
{
    ImGui::TextColored(ImVec4(1.f, 0.45f, 0.45f, 1.f), "AUTO-DODGE");
    ImGui::Indent(8.f);

    int modeIdx = static_cast<int>(g_dodgeMode);
    const char* modeLabels[] = { "Off", "RE-Plus", "RE-Sim (Grid)", "RE-Sim (Quadtree)", "zDodge", "RE++", "PJDodge", "Unified" };
    ImGui::SetNextItemWidth(240.f);
    if (ImGui::Combo("Mode##dodgeModeCombo", &modeIdx, modeLabels, IM_ARRAYSIZE(modeLabels))) {
        ApplyDodgeModeWithEnter(static_cast<DodgeMode>(modeIdx));
        FeatureState::SetAutoDodgeMode(modeIdx);
    }

    ImGui::Spacing();

    if (g_dodgeMode == DodgeMode::XDodge) {
        ImGui::Spacing();
        XDodge::RenderSettings();
    } else if (g_dodgeMode == DodgeMode::RolloutGrid || g_dodgeMode == DodgeMode::RolloutQuad) {
        ImGui::Spacing();
        RolloutDodge::RenderSettings();
    } else if (g_dodgeMode == DodgeMode::ZDodge) {
        ImGui::Spacing();
        ZDodge::RenderSettings();
    } else if (g_dodgeMode == DodgeMode::RePP) {
        ImGui::Spacing();
        RePP::RenderSettings();
    } else if (g_dodgeMode == DodgeMode::PJDodge) {
        ImGui::Spacing();
        PJDodge::RenderSettings();
    } else if (g_dodgeMode == DodgeMode::UDodge) {
        ImGui::Spacing();
        UDodge::RenderSettings();
    }

    ImGui::Unindent(8.f);

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    // ── Auto-loot (phase 1: walk to bags) ────────────────────────────────────
    ImGui::TextColored(ImVec4(0.6f, 0.85f, 1.f, 1.f), "AUTO-LOOT BAGS");
    ImGui::Indent(8.f);
    {
        bool blEnabled = BagLooter::IsEnabled();
        if (ImGui::Checkbox("Enable auto-walk to bags##blen", &blEnabled))
            BagLooter::SetEnabled(blEnabled);
        ImGui::SameLine();
        ImGui::TextDisabled("phase 1: walks over the bag (drink/pickup is manual)");

        ImGui::TextDisabled("Tier filter:");
        struct { const char* label; BagLooter::BagTier tier; } rows[] = {
            { "Brown##bltb",     BagLooter::Brown     },
            { "Pink##bltpk",     BagLooter::Pink      },
            { "Purple##bltpu",   BagLooter::Purple    },
            { "Cyan##bltc",      BagLooter::Cyan      },
            { "Blue##bltbl",     BagLooter::Blue      },
            { "White##bltwh",    BagLooter::White     },
            { "Soulbound##blts", BagLooter::Soulbound },
        };
        for (int i = 0; i < 7; ++i) {
            bool on = BagLooter::IsTierEnabled(rows[i].tier);
            if (ImGui::Checkbox(rows[i].label, &on))
                BagLooter::SetTierEnabled(rows[i].tier, on);
            if ((i % 4) != 3 && i != 6) ImGui::SameLine();
        }

        float walkDist = BagLooter::GetMaxWalkDistance();
        ImGui::SetNextItemWidth(160.f);
        if (ImGui::SliderFloat("Max walk distance##blwd", &walkDist, 1.f, 40.f, "%.0f t"))
            BagLooter::SetMaxWalkDistance(walkDist);

        const int32_t activeId = BagLooter::GetActiveBagId();
        const char* status = BagLooter::GetLastStatusTag();
        if (activeId != 0) {
            ImGui::TextColored(ImVec4(0.7f, 1.f, 0.7f, 1.f),
                               "Pursuing bag id %d  (%.1f t)  status=%s",
                               activeId, BagLooter::GetActiveBagDistance(), status);
        } else {
            ImGui::TextDisabled("No active bag.  status=%s", status);
        }
        // AutoDrink stub trimmed in production cleanup — the toggle had
        // no consumer (the module was a never-finished phase-2 feature).
        ImGui::Spacing();

        // Planner-state readout: why isn't the character moving toward
        // the bag? Surfaces the four most likely blockers.
        {
            const bool plannerOn = DangerPlanner::IsEnabled();
            const bool hasExt    = DangerPlanner::HasExternalGoal();
            const bool noPath    = DangerPlanner::IsNoPath();
            const int  goalSrc   = DangerPlanner::GetGoalSource();
            float execX = 0.f, execY = 0.f;
            const bool haveExec  = DangerPlanner::GetExecTarget(execX, execY);
            const char* srcLabel = "?";
            switch (goalSrc) {
                case 0: srcLabel = "none"; break;
                case 1: srcLabel = "external"; break;
                case 2: srcLabel = "lock"; break;
                case 3: srcLabel = "idle"; break;
                case 4: srcLabel = "stayput"; break;
                case 5: srcLabel = "expansion"; break;
                case 6: srcLabel = "eatHits"; break;
                case 7: srcLabel = "hysteresis"; break;
            }
            ImGui::TextDisabled(
                "Planner: en=%d ext=%d src=%s exec=%d noPath=%d",
                (int)plannerOn, (int)hasExt, srcLabel, (int)haveExec, (int)noPath);
        }

        ImGui::TextDisabled("Auto-pickup UT from white bags (phase 3) is not yet wired.");
    }
    ImGui::Unindent(8.f);

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    // ── Follow Mouse ─────────────────────────────────────────────────────────
    ImGui::TextColored(ImVec4(0.6f, 1.f, 0.6f, 1.f), "FOLLOW MOUSE");
    ImGui::Indent(8.f);
    ImGui::Checkbox("Follow Mouse (active when menu hidden)", &g_followMouse);
    ImGui::Checkbox("Ctrl+click teleport##ctrlcmtp", &g_ctrlClickTeleport);
    ImGui::TextDisabled("Hold Ctrl and left-click to move toward cursor (max 2 tiles).\nAvoids blocked tiles; only when menu is hidden.");
    ImGui::Unindent(8.f);

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    // ── Player Noclip ─────────────────────────────────────────────────────────
    ImGui::TextColored(ImVec4(0.6f, 1.f, 0.6f, 1.f), "PLAYER NOCLIP");
    ImGui::Indent(8.f);
    bool playerNoclip = Noclip::IsEnabled() && Noclip::GetMode() != 0;
    if (ImGui::Checkbox("Player Noclip##playerNoclip", &playerNoclip)) {
        Noclip::SetEnabled(playerNoclip);
        Noclip::SetMode(playerNoclip ? 1 : 0);
    }

    ImGui::TextDisabled("Lets movement, follow, and walk targets ignore wall walkability checks.");

    // Hook probe — "forced" rows override the game's answer, the rest only count
    // calls so we can tell which Map predicate actually gates player movement.
    if (NoclipHook::IsInstalled())
        ImGui::TextColored(ImVec4(0.5f, 1.f, 0.5f, 1.f), "Map hooks: INSTALLED");
    else if (NoclipHook::IsResolved())
        ImGui::TextColored(ImVec4(1.f, 0.8f, 0.3f, 1.f), "Map hooks: resolved, not installed (enable noclip)");
    else
        ImGui::TextColored(ImVec4(1.f, 0.4f, 0.4f, 1.f), "Map hooks: HJMBOMEHGDJ unresolved");

    for (int i = 0; i < NoclipHook::Count(); ++i) {
        ImGui::Text("  %-12s %-9s %s  calls=%u",
            NoclipHook::TargetName(i),
            NoclipHook::TargetForced(i) ? "[forced]" : "[observe]",
            NoclipHook::TargetHooked(i) ? "hooked" : "  --  ",
            NoclipHook::TargetHits(i));
    }
    ImGui::Unindent(8.f);

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

}

void TestTAB::SetBotWalkTarget(float worldX, float worldY, bool active)
{
    if (active) {
        g_walkX        = worldX;
        g_walkY        = worldY;
        g_walkActive   = true;
        // Feed the DangerPlanner as an external goal override so the planner
        // prefers this target over WASD/idle cell selection while dodging.
        DangerPlanner::SetExternalGoal(worldX, worldY);
    } else {
        g_walkActive = false;
        DangerPlanner::ClearExternalGoal();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TestTAB::Render — ImGui UI
// ─────────────────────────────────────────────────────────────────────────────
void TestTAB::Render()
{
    ImGui::Spacing();
    ImGui::TextColored(ImVec4(1.f, 0.8f, 0.2f, 1.f), "TEST TOOLS");
    ImGui::Separator();
    ImGui::Spacing();

    // ── Developer diagnostics / MCP bridge ────────────────────────────────────
    // Runtime opt-in for the re-mcp diagnostics egress. Compiled in for everyone,
    // dormant until flipped on here (settings.bEnableDiagBridge gates DiagBridge::Tick).
    ImGui::TextColored(ImVec4(0.6f, 1.f, 0.7f, 1.f), "DIAGNOSTICS BRIDGE (MCP)");
    ImGui::Checkbox("Enable diagnostics egress (MCP bridge)##diagbridge", &settings.bEnableDiagBridge);
    if (ImGui::IsItemHovered()) {
        ImGui::SetTooltip("%s",
            "Developer tool. Mirrors live BootGate / dodge state to\n"
            "%LOCALAPPDATA%\\RealmEngine\\*.json so the re-mcp server (internal/tools/re-mcp)\n"
            "can runtime-test the DLL from an MCP client. Off = nothing is written.");
    }
    ImGui::TextDisabled("%s", settings.bEnableDiagBridge
        ? "Writing %LOCALAPPDATA%\\RealmEngine\\{diag,cmd,resp}.json (~1 Hz)."
        : "Off — no files written. Enable to use the re_* MCP tools.");

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    // Debug Overlay
    ImGui::TextColored(ImVec4(0.55f, 0.85f, 1.f, 1.f), "OVERLAY PROJECTION");
    ImGui::Checkbox("Measured Unity basis##w2sbasis", CamState::UseMeasuredBasisPtr());
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("%s",
            "ON (default) = ask Unity where the player actually is. The only\n"
            "projection that is correct when the camera is not centred.\n"
            "OFF = pixelRect estimate, the projection every overlay used before\n"
            "the camera work. Turn off if the game misbehaves — the measured\n"
            "path calls managed Unity code from the render thread.");
    if (!g_w2sValid) {
        ImGui::TextColored(ImVec4(1.f, 0.45f, 0.2f, 1.f),
            "INVALID — no overlay is drawn this frame (no local player / no window).");
    } else if (g_basisMeasured) {
        ImGui::TextColored(ImVec4(0.5f, 1.f, 0.6f, 1.f),
            g_basisFull ? "Measured: anchor + zoom/angle (last good %.0f ms ago)"
                        : "Measured: anchor only, zoom/angle estimated (%.0f ms ago)",
            g_basisAgeMs);
        if (g_basisResidual >= 0.f)
            ImGui::TextDisabled("model fit residual: %.3f px/unit%s", g_basisResidual,
                g_basisResidual > 1.f ? "  (high — projection may skew)" : "");
    } else {
        ImGui::TextColored(ImVec4(1.f, 0.85f, 0.35f, 1.f),
            "Fallback (pixelRect estimate) — calibration rejected or camera unresolved");
    }
    ImGui::TextDisabled("centre (%.0f, %.0f)  zoom %.2f px/tile  angle %.1f deg",
        g_dbgCx, g_dbgCy, g_dbgZoom, g_dbgAngleRad * (180.f / kPI));
    ImGui::TextDisabled("player (%.2f, %.2f)   camera->tile (%.2f, %.2f)",
        g_dbgPlayerX, g_dbgPlayerY, g_dbgCamTileX, g_dbgCamTileY);
    ImGui::TextDisabled("%s", "While centred these two should match; a mismatch means the\n"
                              "camera->tile mapping is wrong, not the offset handling.");

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    ImGui::TextColored(ImVec4(0.55f, 0.85f, 1.f, 1.f), "CLIENT TIME SCALE");
    bool enabled = SpeedHack::IsActive();
    if (ImGui::Checkbox("Enable client time scale + ACTk bypass##clienttimescale", &enabled)) {
        SpeedHack::SetMultiplier(enabled ? 2.0f : 1.0f);
    }
    if (ImGui::IsItemHovered()) {
        ImGui::SetTooltip(
            "Scales UnityEngine.Time dt getters, patches ACTk proof statics after SpeedHackProofTime::Update, "
            "and skips SpeedHackDetector::Update while active.");
    }

    ImGui::BeginDisabled(!enabled);
    float scale = SpeedHack::GetMultiplier();
    ImGui::SetNextItemWidth(240.f);
    if (ImGui::InputFloat("Time scale##clienttimescale_input", &scale, 0.1f, 1.0f, "%.2f")) {
        SpeedHack::SetMultiplier(scale);
    }
    ImGui::EndDisabled();

    if (ImGui::Button("Reset time scale##clienttimescale_reset")) {
        SpeedHack::SetMultiplier(1.0f);
    }
    ImGui::SameLine();
    ImGui::TextDisabled("Hooks: %s", SpeedHack::IsHookInstalled() ? "installed" : (SpeedHack::IsResolved() ? "resolved" : "waiting"));

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();
    ImGui::TextColored(ImVec4(1.f, 0.5f, 0.5f, 1.f), "COMBAT DEBUG");
    ImGui::Checkbox("Show aim target overlay", &g_showAimOverlay);
    if (g_showAimOverlay) {
        ImGui::Indent(8.f);
        if (AutoAim::IsEnabled() && AutoAim::HasTarget()) {
            float awx = 0.f, awy = 0.f;
            AutoAim::GetAimTarget(awx, awy);
            ImGui::TextDisabled("Aim target: world (%.2f, %.2f)", (double)awx, (double)awy);
        } else {
            ImGui::TextDisabled("No active aim target");
        }
        ImGui::Unindent(8.f);
    }

    ImGui::Spacing();
    ImGui::Checkbox("HUD: local KJNHLADHEMH + HODJPKFINKF##localskindef", &g_showLocalSkinDefenseHud);
    ImGui::TextDisabled("Live int32s on local player (LKHPPBEGNOM). Shown on-screen every frame when enabled.");
    if (g_showLocalSkinDefenseHud) {
        ImGui::Indent(8.f);
        if (LocalPlayer::GetPtr()) {
            ImGui::PushID("kjnladinp");
            if (!s_kjnladInputActivePrev)
                g_kjnhladEdit = s_hudKJNHLADHEMH;
            ImGui::SetNextItemWidth(160.f);
            if (ImGui::InputInt("KJNHLADEMH##kjnlad", &g_kjnhladEdit, 0, 0,
                    ImGuiInputTextFlags_EnterReturnsTrue))
                WriteLocalKjnhlademh(g_kjnhladEdit);
            s_kjnladInputActivePrev = ImGui::IsItemActive();
            ImGui::TextColored(ImVec4(0.85f, 0.88f, 0.92f, 1.f), "HODJPKFINKF  %d",
                static_cast<int>(s_hudHODJPKFINKF));
            ImGui::PopID();
        } else {
            ImGui::TextDisabled("No local player pointer yet.");
        }
        ImGui::Unindent(8.f);
    } else {
        s_kjnladInputActivePrev = false;
    }

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    // ── Offset Health (resolution status of every game-version offset) ────────
    ImGui::TextColored(ImVec4(1.f, 0.75f, 0.2f, 1.f), "OFFSET HEALTH");
    ImGui::Indent(8.f);
    {
        // Live sanity: auto-flag any critical offset reading clear garbage
        // (e.g. a stale defense/damage offset behind over-estimated damage).
        if (LocalPlayer::GetPtr())
            RuntimeOffsets::SanityCheckPlayerStats(LocalPlayer::GetHP(), LocalPlayer::GetMaxHP(), LocalPlayer::GetDefense());
        {
            static std::vector<WorldProjectile> s_sanityProjs;
            s_sanityProjs.clear();
            ProjectileTracking::CopyActiveForDraw(s_sanityProjs);
            for (const WorldProjectile& pr : s_sanityProjs)
                if (pr.valid && pr.damage != 0) { RuntimeOffsets::SanityCheckProjDamage(pr.damage); break; }
        }

        int nResolved = 0, nFallback = 0, nSuspect = 0, nPending = 0;
        RuntimeOffsets::GetOffsetSummary(nResolved, nFallback, nSuspect, nPending);
        ImGui::Text("resolved %d", nResolved);
        ImGui::SameLine();
        ImGui::TextColored(nFallback > 0 ? ImVec4(1.f, 0.85f, 0.2f, 1.f) : ImVec4(0.55f, 0.55f, 0.55f, 1.f),
            "  fallback %d", nFallback);
        ImGui::SameLine();
        ImGui::TextColored(nSuspect > 0 ? ImVec4(1.f, 0.35f, 0.35f, 1.f) : ImVec4(0.55f, 0.55f, 0.55f, 1.f),
            "  suspect %d", nSuspect);
        ImGui::SameLine();
        ImGui::TextDisabled("  pending %d", nPending);
        if (nFallback > 0 || nSuspect > 0)
            ImGui::TextColored(ImVec4(1.f, 0.45f, 0.2f, 1.f),
                "STALE OFFSETS after this patch — update RuntimeOffsets (names/values).");

        static bool s_showAllOffsets = false;
        ImGui::Checkbox("Show all (not just problems)##offhealth", &s_showAllOffsets);

        static RuntimeOffsets::OffsetReportRow s_offRows[256];
        const int total = RuntimeOffsets::GetOffsetReport(s_offRows, 256);
        const int shown = (total < 256) ? total : 256;
        const ImGuiTableFlags tf = ImGuiTableFlags_Borders | ImGuiTableFlags_RowBg | ImGuiTableFlags_ScrollY;
        if (ImGui::BeginTable("offhealth", 4, tf, ImVec2(-1.f, 220.f))) {
            ImGui::TableSetupColumn("class::field");
            ImGui::TableSetupColumn("fallback");
            ImGui::TableSetupColumn("live");
            ImGui::TableSetupColumn("status");
            ImGui::TableHeadersRow();
            for (int i = 0; i < shown; ++i) {
                const RuntimeOffsets::OffsetReportRow& r = s_offRows[i];
                const bool healthy = (r.state == RuntimeOffsets::OffsetState::ResolvedMatch ||
                                      r.state == RuntimeOffsets::OffsetState::ResolvedShifted ||
                                      r.state == RuntimeOffsets::OffsetState::Pending);  // pending = transient (first ~5s)
                if (!s_showAllOffsets && healthy) continue;
                const char* st = "pending";
                ImVec4 col(0.55f, 0.55f, 0.55f, 1.f);
                switch (r.state) {
                    case RuntimeOffsets::OffsetState::ResolvedMatch:     st = "resolved";        col = ImVec4(0.5f, 0.85f, 0.5f, 1.f); break;
                    case RuntimeOffsets::OffsetState::ResolvedShifted:   st = "resolved (moved)"; col = ImVec4(0.5f, 0.8f, 0.95f, 1.f); break;
                    case RuntimeOffsets::OffsetState::FallbackFieldName: st = "STALE (renamed)";  col = ImVec4(1.f, 0.85f, 0.2f, 1.f);  break;
                    case RuntimeOffsets::OffsetState::FallbackGaveUp:    st = "STALE (no class)"; col = ImVec4(1.f, 0.7f, 0.2f, 1.f);   break;
                    case RuntimeOffsets::OffsetState::Suspect:          st = "SUSPECT";          col = ImVec4(1.f, 0.35f, 0.35f, 1.f); break;
                    default:                                            break;
                }
                ImGui::TableNextRow();
                ImGui::TableNextColumn(); ImGui::Text("%s::%s", r.className, r.fieldName);
                ImGui::TableNextColumn(); ImGui::Text("0x%X", r.fallback);
                ImGui::TableNextColumn(); ImGui::Text("0x%X", r.value);
                ImGui::TableNextColumn(); ImGui::TextColored(col, "%s", st);
            }
            ImGui::EndTable();
        }
    }
    ImGui::Unindent(8.f);

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    // ── Game Hitbox Debug (client collisionRadiusMultiplier) ──────────────────
    ImGui::TextColored(ImVec4(1.f, 0.75f, 0.2f, 1.f), "GAME HITBOX DEBUG");
    ImGui::Indent(8.f);
    ImGui::TextDisabled("PlayerCollider owns collisionRadiusMultiplier writes.");

    {
        void* lp = WorldTAB::GetLocalPtr();
        float liveMult = ReadCollisionMult(lp);
        ImGui::TextColored(ImVec4(0.6f, 0.9f, 1.f, 1.f),
            "Current game multiplier: %.4f  (effective half = %.4f tiles)",
            liveMult, 0.2285f * liveMult);
    }

    ImGui::Unindent(8.f);

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    // ── Walk To ───────────────────────────────────────────────────────────────
    ImGui::TextColored(ImVec4(0.6f, 1.f, 0.6f, 1.f), "WALK TO");
    ImGui::Indent(8.f);

    ImGui::SetNextItemWidth(90.f);
    const bool walkXChanged = ImGui::InputFloat("X##wtx", &g_walkX, 0.f, 0.f, "%.1f");
    ImGui::SameLine();
    ImGui::SetNextItemWidth(90.f);
    const bool walkYChanged = ImGui::InputFloat("Y##wty", &g_walkY, 0.f, 0.f, "%.1f");
    if ((walkXChanged || walkYChanged) && g_walkActive)
        FeatureState::SetWalkTarget(g_walkX, g_walkY, true);

    ImGui::Spacing();

    if (g_walkActive) {
        ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.6f, 0.15f, 0.15f, 1.f));
        if (ImGui::Button("Stop##wtstop", ImVec2(90.f, 0.f)))
            FeatureState::SetWalkTarget(g_walkX, g_walkY, false);
        ImGui::PopStyleColor();
        ImGui::SameLine();
        ImGui::TextColored(ImVec4(1.f, 0.8f, 0.2f, 1.f),
            "Walking to (%.1f, %.1f)", g_walkX, g_walkY);
    } else {
        if (ImGui::Button("Walk To##wtgo", ImVec2(90.f, 0.f))) {
            WorldTAB::ForceRefresh();
            FeatureState::SetWalkTarget(g_walkX, g_walkY, true);
        }
    }

    ImGui::Unindent(8.f);

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    // ── Walk To ObjectID ──────────────────────────────────────────────────────
    ImGui::TextColored(ImVec4(0.6f, 1.f, 0.6f, 1.f), "WALK TO OBJECT ID");
    ImGui::Indent(8.f);

    ImGui::SetNextItemWidth(110.f);
    ImGui::InputText("Object ID##wtoid", g_walkObjIdStr, sizeof(g_walkObjIdStr),
                     ImGuiInputTextFlags_CharsDecimal);

    ImGui::Spacing();

    if (ImGui::Button("Walk Once##wtostart", ImVec2(90.f, 0.f))) {
        int32_t oid = (int32_t)std::strtol(g_walkObjIdStr, nullptr, 10);
        if (oid != 0) {
            WorldTAB::ForceRefresh();
            float ex = 0.f, ey = 0.f;
            if (WorldTAB::GetEntityLivePos(oid, ex, ey)) {
                FeatureState::SetWalkTarget(ex, ey, true);
                snprintf(g_walkObjStatus, sizeof(g_walkObjStatus),
                    "Walking to #%d  (%.1f, %.1f)", oid, ex, ey);
            } else {
                snprintf(g_walkObjStatus, sizeof(g_walkObjStatus),
                    "Object #%d not found", oid);
            }
        }
    }

    if (g_walkObjStatus[0]) {
        ImGui::SameLine();
        ImGui::TextColored(ImVec4(0.5f, 0.9f, 1.f, 1.f), "%s", g_walkObjStatus);
    }

    ImGui::Unindent(8.f);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public W2S state accessors (for CameraTAB's W2S debug panel)
// ─────────────────────────────────────────────────────────────────────────────
namespace TestTAB {

    bool  IsW2SValid()        { return g_w2sValid; }
    float GetMouseWorldX()    { return g_mouseWorldX; }
    float GetMouseWorldY()    { return g_mouseWorldY; }
    float GetMouseScreenX()   { return g_mouseSX; }
    float GetMouseScreenY()   { return g_mouseSY; }
    bool  IsFollowMouseEnabled()      { return g_followMouse; }
    DodgeMode GetDodgeMode() { return g_dodgeMode; }
    void      SetDodgeMode(DodgeMode m)
    {
        const int v = static_cast<int>(m);
        ApplyDodgeModeWithEnter((v >= 0 && v <= static_cast<int>(DodgeMode::UDodge))
            ? m : DodgeMode::Off);
    }
    // SetDodgeModeWithEnter — IpcBridge calls this to route a dashboard dodge-mode
    // change into the DLL. Routes through ApplyDodgeModeWithEnter so the planner
    // install/enable-state stays in sync.
    void SetDodgeModeWithEnter(DodgeMode m) { ApplyDodgeModeWithEnter(m); }
    float GetDodgeLookaheadMs()       { return g_dodgeLookaheadMs; }
    // A* doesn't use the lookahead window, but IpcBridge still forwards the value
    // for legacy state-sync — store it so GetDodgeLookaheadMs returns what the UI set.
    void SetDodgeLookaheadMs(float ms) { g_dodgeLookaheadMs = ClampDodgeLookaheadMs(ms); }
    bool IsAnyAutoDodgeEnabled()      { return g_dodgeMode != DodgeMode::Off; }
    bool  IsAStarDodgeEnabled()        { return false; }
    float GetEnemyAvoidDist()         { return g_enemyAvoidDist; }

    void ReadDodgePlayerStats(int32_t& hp, int32_t& maxHp, float& spd, float& tilesPerSec)
    {
        ReadPlayerStats(hp, maxHp, spd, tilesPerSec);
    }


    bool IsWalkPositionBlocked(float cx, float cy) { return IsPositionBlocked(cx, cy); }
    
    bool IsDamagingPosition(float cx, float cy) {
        int x0 = static_cast<int>(floorf(cx - kPlayerChebyshevScale));
        int x1 = static_cast<int>(floorf(cx + kPlayerChebyshevScale));
        int y0 = static_cast<int>(floorf(cy - kPlayerChebyshevScale));
        int y1 = static_cast<int>(floorf(cy + kPlayerChebyshevScale));
        for (int tx = x0; tx <= x1; ++tx)
            for (int ty = y0; ty <= y1; ++ty)
                if (WorldTAB::IsDamagingTile(tx, ty))
                    return true;
        return false;
    }
    bool IsWalkCircleBlocked(float cx, float cy)   { return IsCircleBlocked(cx, cy); }

    float GetCtrlTeleportMaxTiles() { return kCtrlTeleportMaxTiles; }

    bool ComputeCtrlTeleportLanding(float playerX, float playerY,
                                    float cursorWorldX, float cursorWorldY,
                                    float& outX, float& outY)
    {
        float dx = cursorWorldX - playerX;
        float dy = cursorWorldY - playerY;
        float dist = sqrtf(dx * dx + dy * dy);
        float tpX = cursorWorldX, tpY = cursorWorldY;
        if (dist > kCtrlTeleportMaxTiles && dist > 1e-5f) {
            tpX = playerX + dx * (kCtrlTeleportMaxTiles / dist);
            tpY = playerY + dy * (kCtrlTeleportMaxTiles / dist);
        }

        bool tpBlocked = IsPositionBlocked(tpX, tpY) || IsCircleBlocked(tpX, tpY);
        if (tpBlocked) {
            float clampDist = std::min(dist, kCtrlTeleportMaxTiles);
            float ndx = (dist > 1e-5f) ? dx / dist : 0.f;
            float ndy = (dist > 1e-5f) ? dy / dist : 0.f;
            float lo = 0.f, hi = clampDist;
            for (int i = 0; i < 12; ++i) {
                float mid = (lo + hi) * 0.5f;
                float mx = playerX + ndx * mid;
                float my = playerY + ndy * mid;
                if (IsPositionBlocked(mx, my) || IsCircleBlocked(mx, my))
                    hi = mid;
                else
                    lo = mid;
            }
            tpX = playerX + ndx * lo;
            tpY = playerY + ndy * lo;
            tpBlocked = IsPositionBlocked(tpX, tpY) || IsCircleBlocked(tpX, tpY);
        }

        outX = tpX;
        outY = tpY;
        return !tpBlocked;
    }
    float GetPlayerHitboxSize() { return 2.f * GamePlayerChebyshevHalf(); }

    bool GetPlayerIntent(float& outX, float& outY) {
        if (!s_hasIntent) return false;
        outX = s_intentDirX;
        outY = s_intentDirY;
        return true;
    }

    float ReadGameHitboxMult()
    {
        void* lp = WorldTAB::GetLocalPtr();
        return ReadCollisionMult(lp);
    }
    float ReadGameHitbox1Mult()
    {
        void* lp = WorldTAB::GetLocalPtr();
        return ReadCollisionMultAlt(lp);
    }

    float GetGameHitboxMult() { return ReadGameHitboxMult(); }

}
