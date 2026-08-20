#include "pch-il2cpp.h"
#include "UDodgeDebug.h"

#include "W2S.h"

#include <imgui/imgui.h>
#include <algorithm>
#include <cmath>
#include <cstdio>

namespace UDodge { namespace Debug {
namespace {

bool ToScreen(Vec2 p, float camX, float camY, float angle, float zoom, float cx, float cy, ImVec2& out)
{
    if (!std::isfinite(p.x) || !std::isfinite(p.y) || !std::isfinite(camX) || !std::isfinite(camY) ||
        !std::isfinite(angle) || !std::isfinite(zoom) || !std::isfinite(cx) || !std::isfinite(cy) || zoom <= 0.f)
        return false;
    float sx = 0.f, sy = 0.f;
    if (!W2S(p.x, p.y, sx, sy, camX, camY, angle, zoom, cx, cy)) return false;
    if (!std::isfinite(sx) || !std::isfinite(sy)) return false;
    out = ImVec2(sx, sy);
    return true;
}

// Solver::SolveKind label (published as a plain uint8 in the snapshot).
const char* SolveKindText(uint8_t k)
{
    switch (k) {
        case 0: return "hold";        // Hold — already safe, nothing better
        case 1: return "safe";        // Safe — moved to a provably-safe cell
        case 2: return "FALLBACK";    // Fallback — least-bad (no safe cell reachable)
        case 3: return "SURROUNDED";  // Surrounded — nowhere improves; holding
    }
    return "?";
}

struct Cam {
    float camX, camY, angle, zoom, cx, cy;
};

void DrawDot(ImDrawList* d, const Cam& c, Vec2 p, float r, ImU32 col)
{
    ImVec2 s;
    if (ToScreen(p, c.camX, c.camY, c.angle, c.zoom, c.cx, c.cy, s)) d->AddCircleFilled(s, r, col, 12);
}

void DrawLine(ImDrawList* d, const Cam& c, Vec2 a, Vec2 b, ImU32 col, float th)
{
    ImVec2 sa, sb;
    if (ToScreen(a, c.camX, c.camY, c.angle, c.zoom, c.cx, c.cy, sa) &&
        ToScreen(b, c.camX, c.camY, c.angle, c.zoom, c.cx, c.cy, sb))
        d->AddLine(sa, sb, col, th);
}

void DrawWorldCircle(ImDrawList* d, const Cam& c, Vec2 center, float radiusTiles, ImU32 col, float th)
{
    ImVec2 sc, se;
    if (!ToScreen(center, c.camX, c.camY, c.angle, c.zoom, c.cx, c.cy, sc)) return;
    if (!ToScreen({ center.x + radiusTiles, center.y }, c.camX, c.camY, c.angle, c.zoom, c.cx, c.cy, se)) return;
    const float r = std::sqrt((se.x - sc.x) * (se.x - sc.x) + (se.y - sc.y) * (se.y - sc.y));
    d->AddCircle(sc, r, col, 24, th);
}

} // namespace

// Simplified per-tick-solver overlay (plan 64): the danger map, the reachable
// ring (one tick's move budget), the chosen safe target, and the SolveKind label.
void Render(const DebugSnapshot& snap,
            float camX, float camY, float angle, float zoom, float cx, float cy)
{
    if (!snap.active) return;
    ImDrawList* d = ImGui::GetBackgroundDrawList();
    if (!d) return;
    const Cam cam{ camX, camY, angle, zoom, cx, cy };

    // Header: SolveKind + map contents + server-accurate stand clearance + tick sync.
    char clearBuf[24];
    if (snap.standClearance >= kHugeClearance)
        std::snprintf(clearBuf, sizeof(clearBuf), "safe");
    else
        std::snprintf(clearBuf, sizeof(clearBuf), "%.2f", snap.standClearance);
    char tickBuf[24];
    if (snap.tickValid)
        std::snprintf(tickBuf, sizeof(tickBuf), "tick:%u", snap.tickId);
    else
        std::snprintf(tickBuf, sizeof(tickBuf), "tick:--(deg)");
    char buf[192];
    std::snprintf(buf, sizeof(buf), "UDodge [%s]  lanes:%d  zones:%d  clear:%s  budget:%.1ft  %s %s",
                  SolveKindText(snap.solveKind),
                  snap.map.laneCount, snap.map.zoneCount, clearBuf, snap.stepTiles,
                  tickBuf, snap.rebuiltThisFrame ? "SYNC" : "hold");
    d->AddText(ImVec2(12.f, 12.f), IM_COL32(120, 220, 255, 255), buf);

    // Danger lanes: live anchor + remaining-path polyline.
    for (int i = 0; i < std::min(snap.map.laneCount, kMaxProjectiles); ++i) {
        const LaneThreat& t = snap.map.lanes[i];
        const int n = std::min(t.pointCount, kMaxLanePoints);
        for (int j = 0; j + 1 < n; ++j)
            DrawLine(d, cam, t.points[j], t.points[j + 1], IM_COL32(235, 80, 80, 110), 1.5f);
        if (n > 0) DrawDot(d, cam, t.points[0], 3.f, IM_COL32(255, 90, 90, 220));
    }

    // Zones: pending (telegraphed, soft cost) = faint orange; active
    // (detonated & persisting, hard danger) = strong red-orange.
    for (int i = 0; i < std::min(snap.map.zoneCount, kMaxAoes); ++i) {
        const ZoneThreat& z = snap.map.zones[i];
        if (z.active)
            DrawWorldCircle(d, cam, z.pos, z.radius, IM_COL32(255, 90, 40, 190), 3.f);
        else
            DrawWorldCircle(d, cam, z.pos, z.radius, IM_COL32(240, 150, 30, 100), 2.f);
    }

    // Enemy bodies.
    for (int i = 0; i < std::min(snap.map.enemyCount, kMaxEnemies); ++i)
        DrawDot(d, cam, snap.map.enemies[i].pos, 4.f, IM_COL32(230, 60, 230, 150));

    // Reachable ring: the disk the solver sampled this tick (radius = one tick's
    // move budget). The chosen target always lies within it.
    DrawWorldCircle(d, cam, snap.player, snap.stepTiles, IM_COL32(80, 180, 255, 110), 1.5f);

    // Goal marker (lock standoff / WASD intent), when a soft goal is active.
    if (snap.hasLockTarget) {
        DrawWorldCircle(d, cam, snap.lockTarget, 0.4f, IM_COL32(255, 70, 70, 200), 2.f);
        DrawLine(d, cam, snap.player, snap.lockTarget, IM_COL32(255, 70, 70, 120), 1.f);
    }

    // Chosen safe target: yellow dot (red on a failed MoveTo) + heading line.
    if (snap.overrideActive) {
        DrawLine(d, cam, snap.player, snap.moveTarget, IM_COL32(255, 210, 0, 200), 2.5f);
        DrawDot(d, cam, snap.moveTarget, 5.f,
                snap.moveFailed ? IM_COL32(255, 60, 60, 230) : IM_COL32(255, 210, 0, 230));
    }
}

} } // namespace UDodge::Debug
