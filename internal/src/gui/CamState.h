#pragma once
namespace CamState {
    struct Snapshot {
        float camX = 0, camY = 0;      // camera world pos (tiles)
        float angleRad = 0;            // camera rotation
        float zoom = 0;                // pixels per tile
        float cx = 0, cy = 0;          // screen-space centre (px)
        float screenW = 0, screenH = 0;
        bool  valid = false;           // false => don't draw overlays

        // ── Diagnostics (Test tab OVERLAY PROJECTION panel) ─────────────────
        // Live player world pos before any measured-basis override.
        float playerX = 0, playerY = 0;
        // CameraTAB camera->tile mapping (only refreshed on the non-measured
        // path, matching the original BuildCamState side-effect behaviour).
        float camTileX = 0, camTileY = 0;
        // Measured ScreenBasis health: age since last good calibration (ms,
        // -1 = never), model fit residual, and whether the measured anchor /
        // full scale+rotation are in effect this frame.
        float basisAgeMs = -1;
        float basisResidual = -1;
        bool  basisMeasured = false;
        bool  basisFull = false;
    };
    // Rebuilds the snapshot (ScreenBasis-anchored when fresh, CameraTAB getters
    // otherwise). Call once per frame from the render thread AFTER CameraTAB's
    // refresh (TestTAB::Tick drives it). Cheap — reads cached getters only.
    // Render-thread only; no locks.
    void Tick();
    // Returns the snapshot built by the most recent Tick().
    const Snapshot& Get();

    // "Measured Unity basis" toggle (bound to the Test-tab checkbox). ON =
    // ask Unity where the player actually is; OFF = pixelRect estimate.
    bool* UseMeasuredBasisPtr();
}
