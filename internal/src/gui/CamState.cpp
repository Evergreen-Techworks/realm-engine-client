#include "pch-il2cpp.h"
#include "gui/CamState.h"
#include "gui/tabs/CameraTAB.h"
#include "gui/tabs/WorldTAB.h"
#include "core/runtime/MemRead.h"
#include "core/runtime/RuntimeOffsets.h"
#include "game/objects/GameObjects.h"
#include "DirectX.h"
#include <windows.h>

namespace {

constexpr float kPI = 3.14159265358979323846f;

// The per-frame snapshot. Static so diagnostics that are only refreshed on
// some paths (camTileX/camTileY) persist across frames, matching the original
// BuildCamState static-global side-effect behaviour.
CamState::Snapshot s_snap;

// "Measured Unity basis" toggle — default ON.
bool s_useMeasuredBasis = true;

// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth for local player X/Y (same as Follow Mouse / S2W anchor).
// Always reads +0x3C/+0x40 from GetLocalPtr() when available — no (0,0) skip.
// ─────────────────────────────────────────────────────────────────────────────
static bool ReadLivePlayerXY(float& outX, float& outY)
{
    void* p = WorldTAB::GetLocalPtr();
    if (Game::Entity(p).TryPos(outX, outY))
        return true;
    outX = WorldTAB::GetLocalX();
    outY = WorldTAB::GetLocalY();
    return true;
}

} // namespace

namespace CamState {

bool* UseMeasuredBasisPtr() { return &s_useMeasuredBasis; }

const Snapshot& Get() { return s_snap; }

// ─────────────────────────────────────────────────────────────────────────────
// Build the per-frame camera state for W2S / S2W.
// Uses Camera.pixelRect (when available) for the true game viewport centre,
// properly excluding the game's right-side inventory/UI panel.
// ─────────────────────────────────────────────────────────────────────────────
void Tick()
{
    Snapshot& s = s_snap;

    // Live read every frame (Walk To, Follow Mouse, S2W all share this anchor).
    ReadLivePlayerXY(s.camX, s.camY);

    s.playerX = s.camX;
    s.playerY = s.camY;

    float angleDeg = CameraTAB::GetAngle();
    float ortho    = CameraTAB::GetZoom();
    // angleDeg == 0 is the valid RotMG default (north-up, no rotation) — do NOT replace with 45
    if (ortho == 0.f) ortho = 8.f;
    s.angleRad = angleDeg * (kPI / 180.f);

    HWND wnd = DirectX::window;
    if (!wnd) { s.valid = false; return; }
    RECT r;
    GetClientRect(wnd, &r);
    s.screenW = static_cast<float>(r.right  - r.left);
    s.screenH = static_cast<float>(r.bottom - r.top);
    if (s.screenW <= 0.f || s.screenH <= 0.f) { s.valid = false; return; }

    // This is the old (and worse) version that's just computed as a fallback.
    //
    // Unity Camera.pixelRect tells us which portion of the screen the game
    // renders to (excluding UI overlay panels). Layout: x = left edge,
    // y = bottom edge (Unity Y-up), w/h = extent. Zoom uses viewport height,
    // not full screen height.
    {
        const float prX = CameraTAB::GetPixelRectX();
        const float prY = CameraTAB::GetPixelRectY();
        const float prW = CameraTAB::GetPixelRectW();
        const float prH = CameraTAB::GetPixelRectH();
        if (prW > 16.f && prH > 16.f) {
            s.cx   = prX + prW * 0.5f;
            s.cy   = s.screenH - (prY + prH * 0.5f);
            s.zoom = prH / (2.f * ortho);
        } else {
            // Fallback while CameraTAB hasn't refreshed yet
            s.cx   = s.screenW * 0.5f;
            s.cy   = s.screenH * 0.5f;
            s.zoom = s.screenH / (2.f * ortho);
        }
    }

    // This is the actually good way of getting the basis using the player's position.
    // We use the player's position, and the position 1 to the left / right / up / down
    // to get the basis for the camera.
    if (s_useMeasuredBasis) {
        static CameraTAB::ScreenBasis s_basis{};
        static ULONGLONG s_lastRefineMs = 0;
        static ULONGLONG s_lastGoodMs   = 0;
        constexpr ULONGLONG kRefineEveryMs = 100;
        constexpr ULONGLONG kBasisMaxAgeMs = 1000;

        const ULONGLONG nowMs = GetTickCount64();

        const bool refine = (nowMs - s_lastRefineMs) >= kRefineEveryMs;
        CameraTAB::ScreenBasis fresh{};
        if (CameraTAB::CalibrateScreenBasis(WorldTAB::GetLocalPtr(), s.screenW, s.screenH, fresh, refine)) {
            s_basis.anchorTileX   = fresh.anchorTileX;
            s_basis.anchorTileY   = fresh.anchorTileY;
            s_basis.anchorScreenX = fresh.anchorScreenX;
            s_basis.anchorScreenY = fresh.anchorScreenY;
            s_basis.hasAnchor     = fresh.hasAnchor;
            s_lastGoodMs          = nowMs;

            if (fresh.hasScaleAndRotation) {
                s_basis.pixelsPerTile       = fresh.pixelsPerTile;
                s_basis.rotationRad         = fresh.rotationRad;
                s_basis.fitResidualPx       = fresh.fitResidualPx;
                s_basis.hasScaleAndRotation = true;
                s_lastRefineMs              = nowMs;
            }
        } else if (refine) {
            s_lastRefineMs = nowMs;
            CameraTAB::ForceRefresh();
        }
        s.basisAgeMs    = (s_lastGoodMs != 0) ? static_cast<float>(nowMs - s_lastGoodMs) : -1.f;
        s.basisResidual = s_basis.fitResidualPx;

        if (s_lastGoodMs != 0 && (nowMs - s_lastGoodMs) <= kBasisMaxAgeMs && s_basis.hasAnchor) {
            s.camX = s_basis.anchorTileX;
            s.camY = s_basis.anchorTileY;
            s.cx   = s_basis.anchorScreenX;
            s.cy   = s_basis.anchorScreenY;

            if (s_basis.hasScaleAndRotation) {
                // Keep the LIVE camera angle (set above from CameraTAB::GetAngle)
                // rather than the basis's rotationRad — the basis rotation only
                // refreshes every kRefineEveryMs (~100ms), so during a camera
                // rotation it is stale and the overlay "sticks" until the next
                // refine. The live angle updates every frame; the basis still
                // provides the accurate anchor + pixels-per-tile (which don't
                // change as the camera spins).
                s.zoom     = s_basis.pixelsPerTile;
            }
            s.basisMeasured = true;
            s.basisFull     = s_basis.hasScaleAndRotation;

            s.valid = true;
            return;
        }
        s.basisMeasured = false;
        s.basisFull     = false;
    }

    s.camTileX = CameraTAB::GetCamWorldX();
    s.camTileY = -CameraTAB::GetCamWorldY();

    s.valid = (s.camX != 0.f || s.camY != 0.f);
}

} // namespace CamState
