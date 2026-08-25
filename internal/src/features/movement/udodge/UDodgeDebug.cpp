#include "pch-il2cpp.h"
#include "UDodgeDebug.h"
#include "UDodgeCore.h"          // Core::PointSafety — per-cell weight for the heatmap
#include "gui/tabs/WorldTAB.h"   // IsTileBlocked — wall cells in the heatmap

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

// Viewport test: is a projected point within the display rect (expanded by a
// margin, in screen pixels)? Used to cull heatmap cells that fall outside the
// visible viewport so they are never projected/emitted.
bool OnScreen(ImVec2 s, ImVec2 disp, float margin)
{
    return s.x >= -margin && s.y >= -margin &&
           s.x <= disp.x + margin && s.y <= disp.y + margin;
}

// Filled cell quad (projects 4 world corners → screen; camera-rotation aware).
void DrawCellQuad(ImDrawList* d, const Cam& c, Vec2 center, float halfTile, ImU32 col)
{
    ImVec2 bl, br, tr, tl;
    if (!ToScreen({ center.x - halfTile, center.y - halfTile }, c.camX, c.camY, c.angle, c.zoom, c.cx, c.cy, bl) ||
        !ToScreen({ center.x + halfTile, center.y - halfTile }, c.camX, c.camY, c.angle, c.zoom, c.cx, c.cy, br) ||
        !ToScreen({ center.x + halfTile, center.y + halfTile }, c.camX, c.camY, c.angle, c.zoom, c.cx, c.cy, tr) ||
        !ToScreen({ center.x - halfTile, center.y + halfTile }, c.camX, c.camY, c.angle, c.zoom, c.cx, c.cy, tl))
        return;
    d->AddQuadFilled(bl, br, tr, tl, col);
}

// Map a cell's safety weight to a heatmap color. Wall = dark red; inside a shot
// (safety < 0) = red; marginal (0..durable pocket margin) = amber; safe = green (brighter
// with more clearance). Low alpha so it reads as a heatmap under the lanes/route.
ImU32 WeightColor(bool wall, float safety)
{
    constexpr int A = 70;
    if (wall)            return IM_COL32(60, 15, 15, 150);
    if (safety < 0.f)    return IM_COL32(225, 45, 45, A);
    if (safety < kUDurablePocketMargin) return IM_COL32(240, 190, 40, A);
    const float t = std::clamp(safety / kSolveClearComfort, 0.f, 1.f);
    const int g = 150 + static_cast<int>(90.f * t);   // brighter green with clearance
    return IM_COL32(40, g, 90, A);
}

// The pathfinder-visibility heatmap: every cell in the dodge search window colored
// by its server-accurate safety weight (+ walls). Recomputed only when the tick or
// the window center changes (cached), so the per-frame cost is just projection/draw.
void DrawWeightGrid(ImDrawList* d, const Cam& c, const DebugSnapshot& snap, Vec2 gridCenter)
{
    constexpr int   R  = kUPathMaxRadCells;
    constexpr int   S  = kUPathMaxSide;
    constexpr float cs = kUPathCellTiles;

    static ImU32    s_col[kUPathMaxCells];
    static uint32_t s_tick   = 0xFFFFFFFFu;
    static Vec2     s_center = { 1e30f, 1e30f };
    static bool     s_valid  = false;

    const bool moved = std::fabs(gridCenter.x - s_center.x) > cs ||
                       std::fabs(gridCenter.y - s_center.y) > cs;
    if (!s_valid || snap.tickId != s_tick || moved) {
        MapInput mi{};
        mi.player = snap.player;
        mi.settings.hitScale = snap.hitScale;
        mi.settings.safeWalk = snap.safeWalk;
        mi.map = &snap.map;
        const bool  locked   = snap.inRangeRadius > 0.f && snap.map.hasLock;
        const float diskLim  = snap.inRangeRadius + kUInRangeSlack;
        for (int gy = 0; gy < S; ++gy) {
            for (int gx = 0; gx < S; ++gx) {
                const Vec2 w{ gridCenter.x + static_cast<float>(gx - R) * cs,
                              gridCenter.y + static_cast<float>(gy - R) * cs };
                const bool wall = WorldTAB::IsTileBlocked(static_cast<int>(std::floor(w.x)),
                                                          static_cast<int>(std::floor(w.y)));
                const float safety = wall ? 0.f : Core::PointSafety(mi, w);
                // A valid durable-safe GOAL: safe enough to hold AND (when locked)
                // still inside weapon range. These are the spots the planner should
                // be routing to — drawn brighter/opaque so gaps stand out.
                const bool goalCell = !wall && safety >= kUDurablePocketMargin &&
                                      (!locked || Len(Sub(w, snap.map.lockPos)) <= diskLim);
                if (goalCell)
                    s_col[gy * S + gx] = IM_COL32(60, 235, 110, 150);
                else
                    s_col[gy * S + gx] = WeightColor(wall, safety);
            }
        }
        s_tick = snap.tickId; s_center = gridCenter; s_valid = true;
    }

    // Per-frame draw: project each cell's center once and viewport-cull it, so we
    // only emit quads for the cells the user can actually see (typically a few
    // hundred, not all kUPathMaxCells). The cull margin is ~2 cell widths in
    // screen space, estimated once from the projected cell size (zoom is constant
    // across the frame). Off-screen cells never reach DrawCellQuad's 4-corner
    // projection. This is a draw-count reduction only — colors are unchanged.
    const float  half = cs * 0.5f;
    const ImVec2 disp = ImGui::GetIO().DisplaySize;
    float margin = 64.f;   // fallback if the cell-size probe fails
    {
        ImVec2 s0, s1;
        if (ToScreen(gridCenter, c.camX, c.camY, c.angle, c.zoom, c.cx, c.cy, s0) &&
            ToScreen({ gridCenter.x + cs, gridCenter.y }, c.camX, c.camY, c.angle, c.zoom, c.cx, c.cy, s1)) {
            const float cellPx = std::sqrt((s1.x - s0.x) * (s1.x - s0.x) + (s1.y - s0.y) * (s1.y - s0.y));
            if (std::isfinite(cellPx) && cellPx > 0.f) margin = 2.f * cellPx;
        }
    }
    for (int gy = 0; gy < S; ++gy)
        for (int gx = 0; gx < S; ++gx) {
            const Vec2 w{ gridCenter.x + static_cast<float>(gx - R) * cs,
                          gridCenter.y + static_cast<float>(gy - R) * cs };
            ImVec2 sc;
            if (!ToScreen(w, c.camX, c.camY, c.angle, c.zoom, c.cx, c.cy, sc)) continue;
            if (!OnScreen(sc, disp, margin)) continue;   // viewport cull
            DrawCellQuad(d, c, w, half, s_col[gy * S + gx]);
        }
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

    // Route status line — WHY the plan looks the way it does (diagnostic).
    char rbuf[192];
    std::snprintf(rbuf, sizeof(rbuf),
                  "path: %s%s%s%s  dist:%.1ft  reach:%.0ft%s",
                  snap.hasRoute ? "planned" : "none",
                  snap.routePartial    ? "  PARTIAL(no durable pocket reachable)" : "",
                  snap.routeOutOfRange ? "  OUT-OF-RANGE(fled the disk)" : "",
                  snap.routeExpanded   ? "  expanded" : "",
                  snap.routeGoalDist,
                  static_cast<double>(kUPathMaxRadCells * kUPathCellTiles),
                  snap.inRangeRadius > 0.f ? "  [LOCKED]" : "");
    d->AddText(ImVec2(12.f, 28.f),
               snap.routeOutOfRange ? IM_COL32(255, 140, 60, 255) : IM_COL32(150, 230, 180, 255),
               rbuf);

    // The search grid is boss-centered when locked (region #2: the whole in-range
    // disk is searchable), else player-centered. Center the heatmap + reach ring
    // on the same point so the overlay shows the ACTUAL searched area.
    const bool locked = snap.inRangeRadius > 0.f && snap.map.hasLock;
    const Vec2 gridCenter = locked ? snap.map.lockPos : snap.player;

    // Pathfinder-visibility heatmap (bottom layer, under the lanes/route).
    if (snap.drawWeights)
        DrawWeightGrid(d, cam, snap, gridCenter);

    // The dodge planner's ACTUAL search reach (grid window radius), centered where
    // the search is. When locked this ring encircles the boss and should cover the
    // in-range disk — you should see it routing to safe (green) cells anywhere in it.
    if (snap.drawWeights)
        DrawWorldCircle(d, cam, gridCenter,
                        static_cast<float>(kUPathMaxRadCells) * kUPathCellTiles,
                        IM_COL32(90, 180, 255, 150), 2.f);

    // Danger lanes: live anchor + remaining-path polyline. The bright section is the
    // PAINT span (the "Danger lane length" slider) — what counts as dangerous RIGHT
    // NOW. The faint continuation is the rest of the traced spacetime polyline,
    // which exists so the temporal lookahead can see to its horizon; it is NOT
    // instantaneous danger, so it is drawn as the lookahead it is.
    for (int i = 0; i < std::min(snap.map.laneCount, kMaxProjectiles); ++i) {
        const LaneThreat& t = snap.map.lanes[i];
        const int n  = std::min(t.pointCount, kMaxLanePoints);
        const int ni = std::min(t.instantCount, n);
        for (int j = 0; j + 1 < n; ++j)
            DrawLine(d, cam, t.points[j], t.points[j + 1],
                     (j + 1 < ni) ? IM_COL32(235, 80, 80, 110) : IM_COL32(235, 80, 80, 40), 1.5f);
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

    // In-range disk (locked boss): the weapon-range manifold the route is
    // constrained to — every spot from which the boss is still hittable. Drawn
    // first (faint) so the route and enemies read on top.
    if (snap.inRangeRadius > 0.f && snap.map.hasLock)
        DrawWorldCircle(d, cam, snap.map.lockPos, snap.inRangeRadius, IM_COL32(90, 200, 140, 90), 1.5f);

    // Enemy bodies + their HARD exclusion circles (body radius + player half): the
    // no-go the solver and pathfinder route around. Filled dot = center; ring = the
    // exclusion the player edge is kept outside of, so the user SEES what the path
    // is avoiding and why it clears a mob.
    for (int i = 0; i < std::min(snap.map.enemyCount, kMaxEnemies); ++i) {
        const EnemyBlocker& e = snap.map.enemies[i];
        DrawDot(d, cam, e.pos, 4.f, IM_COL32(230, 60, 230, 150));
        DrawWorldCircle(d, cam, e.pos, e.radius + kUPlayerHalf, IM_COL32(230, 60, 230, 130), 1.5f);
    }

    // Worker grid route: the planned path the pathfinder curves around obstacles.
    // Colored polyline through the waypoints + a marker at the durable-safe goal.
    if (snap.drawPath && snap.pathCount >= 2) {
        const int np = std::min(snap.pathCount, kMaxPathPoints);
        for (int i = 0; i + 1 < np; ++i)
            DrawLine(d, cam, snap.path[i], snap.path[i + 1], IM_COL32(60, 230, 160, 220), 2.5f);
        for (int i = 0; i < np; ++i)
            DrawDot(d, cam, snap.path[i], 2.5f, IM_COL32(60, 230, 160, 200));
    }
    if (snap.hasRoute) {
        DrawWorldCircle(d, cam, snap.routeGoal, 0.35f, IM_COL32(60, 230, 160, 240), 2.5f);
        DrawDot(d, cam, snap.routeGoal, 4.f, IM_COL32(60, 230, 160, 240));
    }

    // Navigation (walk-to) A* corridor: the maze route, its search-window extent,
    // the clicked goal, and the immediate step target. Cyan = route; the window box
    // shows the area the nav planner can see this tick (re-centers as you move).
    if (snap.navActive) {
        // Window extent (the nav planner's visible area).
        const float navRad = static_cast<float>(kUNavRadCells);
        const Vec2  p = snap.player;
        const Vec2  c0{ p.x - navRad, p.y - navRad }, c1{ p.x + navRad, p.y - navRad };
        const Vec2  c2{ p.x + navRad, p.y + navRad }, c3{ p.x - navRad, p.y + navRad };
        DrawLine(d, cam, c0, c1, IM_COL32(80, 200, 255, 60), 1.f);
        DrawLine(d, cam, c1, c2, IM_COL32(80, 200, 255, 60), 1.f);
        DrawLine(d, cam, c2, c3, IM_COL32(80, 200, 255, 60), 1.f);
        DrawLine(d, cam, c3, c0, IM_COL32(80, 200, 255, 60), 1.f);
        // Route polyline (cyan; amber when only a partial route toward the goal).
        const ImU32 rc = snap.navPartial ? IM_COL32(255, 190, 60, 230)
                                         : IM_COL32(60, 210, 255, 235);
        const int nn = std::min(snap.navWptCount, kMaxNavWpts);
        for (int i = 0; i + 1 < nn; ++i)
            DrawLine(d, cam, snap.navWpts[i], snap.navWpts[i + 1], rc, 3.f);
        for (int i = 0; i < nn; ++i)
            DrawDot(d, cam, snap.navWpts[i], 2.5f, rc);
        // Clicked goal + step target.
        DrawWorldCircle(d, cam, snap.navGoal, 0.4f, IM_COL32(230, 90, 230, 230), 2.5f);
        DrawDot(d, cam, snap.navGoal, 4.f, IM_COL32(230, 90, 230, 230));
        DrawDot(d, cam, snap.navStepTarget, 3.5f, IM_COL32(255, 210, 0, 230));
    }

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
