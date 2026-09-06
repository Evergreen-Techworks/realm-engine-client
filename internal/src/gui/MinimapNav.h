#pragma once

// MinimapNav — minimap Shift+Click → world walk-to (live-calibration build).
//
// Converts a mouse click that lands inside the on-screen minimap rectangle into
// a ROTMG world position so TestTAB can hand it to DangerPlanner::SetWalkGoal.
//
// This is a CALIBRATION scaffold: the minimap→world transform is assembled from
// the fields we can resolve (miniMapCamera orthographicSize, the RawImage screen
// rect via RectTransform.GetWorldCorners, rotationActive, the camera angle) plus
// a set of clearly-named tunable constants (MinimapNav.cpp, kMinimap*). On every
// minimap Shift+click a single `[MinimapCal]` line is emitted with the raw mouse
// pixel, the resolved rect, orthoSize, zoom mults, rotation/angle, player world,
// and the computed world target — so the true scale / sign / offset can be dialed
// in from the log. All reads happen on the render/GUI thread (TestTAB), never the
// worker; the goal handed to DangerPlanner is plain float data.
namespace MinimapNav {

    // Resolve the MiniMapManager instance + its fields/methods. Cheap and
    // idempotent after the first success; safe to call every frame. Emits one
    // `[MinimapCal] resolve: ...` line the first time each piece resolves/fails.
    void EnsureResolved();

    // On-screen minimap rect in CLIENT top-down pixels (same frame as the mouse
    // pixel captured by GetCursorPos+ScreenToClient). `screenW`/`screenH` are the
    // client size (CamState screenW/H); screenH flips Unity's bottom-up corners,
    // screenW anchors the fallback rect to the top-right corner. Returns false
    // only if the client size is unusable. outFallback = true when the named
    // anchor constants were used.
    bool GetScreenRect(float screenW, float screenH,
                       float& outX, float& outY, float& outW, float& outH,
                       bool& outFallback);

    // True when (clientX, clientY) is inside the minimap rect (resolved or
    // fallback). Does not log.
    bool HitTest(float clientX, float clientY, float screenW, float screenH);

    // Convert a click inside the minimap to a ROTMG world position and emit the
    // `[MinimapCal]` calibration line. playerWorldX/Y are the player's ROTMG tile
    // coords (the same camX/camY the frame uses for S2W / SetWalkGoal);
    // camAngleDeg is CameraTAB::GetAngle(). Returns false (and still logs) when
    // the result is non-finite.
    bool ClickToWorld(float clientMouseX, float clientMouseY,
                      float screenW, float screenH,
                      float playerWorldX, float playerWorldY, float camAngleDeg,
                      float& outWorldX, float& outWorldY);

} // namespace MinimapNav
