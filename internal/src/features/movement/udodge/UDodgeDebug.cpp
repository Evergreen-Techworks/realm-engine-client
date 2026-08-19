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

const char* DecisionText(Decision d)
{
    switch (d) {
        case Decision::None:                   return "idle";
        case Decision::NoThreat:               return "clear";
        case Decision::MovementLocked:         return "locked";
        case Decision::PreserveSafeIntent:     return "intent-safe";
        case Decision::GentleOverride:         return "gentle";
        case Decision::GentleManualBlend:      return "gentle-blend";
        case Decision::EmergencyOverride:      return "EMERGENCY";
        case Decision::EmergencyManualBlend:   return "emergency-blend";
        case Decision::UnavoidableManualBlend: return "unavoidable-blend";
        case Decision::HazardEscape:           return "hazard-escape";
        case Decision::FieldEscape:            return "field-escape";
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

void Render(const DebugSnapshot& snap,
            float camX, float camY, float angle, float zoom, float cx, float cy)
{
    if (!snap.active) return;
    ImDrawList* d = ImGui::GetBackgroundDrawList();
    if (!d) return;
    const Cam cam{ camX, camY, angle, zoom, cx, cy };

    char buf[160];
    std::snprintf(buf, sizeof(buf), "UDodge [%s]  threats:%d  proj:%d  aoe:%d  impact:%s%.0fms  x%.1f",
                  DecisionText(snap.decision), snap.threatCount,
                  snap.sensors.projectileCount, snap.sensors.aoeCount,
                  snap.earliestImpactMs >= kMaxTimeMs ? ">" : "",
                  snap.earliestImpactMs >= kMaxTimeMs ? snap.horizonMs : snap.earliestImpactMs,
                  snap.speedScale);
    d->AddText(ImVec2(12.f, 12.f), IM_COL32(120, 220, 255, 255), buf);

    // Prediction-accuracy line: clock error corrected + residual model error.
    char pbuf[128];
    if (snap.predEnabled)
        std::snprintf(pbuf, sizeof(pbuf), "predict: ON  clock-err %.1fms  model-err %.03f tiles",
                      snap.predClockErrMs, snap.predModelErrTiles);
    else
        std::snprintf(pbuf, sizeof(pbuf), "predict: OFF (legacy tick clock)");
    d->AddText(ImVec2(12.f, 28.f),
               snap.predEnabled ? IM_COL32(120, 235, 150, 255) : IM_COL32(200, 200, 120, 255), pbuf);

    // Projectile predicted paths.
    for (int i = 0; i < std::min(snap.sensors.projectileCount, kMaxProjectiles); ++i) {
        const ProjectileThreat& t = snap.sensors.projectiles[i];
        const int n = std::min(t.sampleCount, kMaxPathSamples);
        for (int j = 0; j + 1 < n; ++j)
            DrawLine(d, cam, t.samples[j], t.samples[j + 1], IM_COL32(235, 80, 80, 110), 1.5f);
        if (n > 0) DrawDot(d, cam, t.samples[0], 3.f, IM_COL32(255, 90, 90, 220));
    }

    // AoE landing circles (orange, fading in as landing approaches).
    for (int i = 0; i < std::min(snap.sensors.aoeCount, kMaxAoes); ++i) {
        const AoeThreat& a = snap.sensors.aoes[i];
        const float urgency = 1.f - std::clamp(a.landingMs / std::max(1.f, snap.horizonMs), 0.f, 1.f);
        const int alpha = 90 + static_cast<int>(120.f * urgency);
        DrawWorldCircle(d, cam, a.pos, a.radius, IM_COL32(240, 150, 30, alpha), 2.f);
    }

    // Enemy bodies.
    for (int i = 0; i < std::min(snap.sensors.enemyCount, kMaxEnemies); ++i)
        DrawDot(d, cam, snap.sensors.enemies[i].pos, 4.f, IM_COL32(230, 60, 230, 150));

    // Candidate fan: ray endpoint = where the path first gets hit (or the full
    // horizon). Green = safe all the way, yellow→red = dies inside the window,
    // grey = blocked at the start.
    for (int i = 1; i <= kDirectionCount; ++i) {
        const CandidateDebug& c = snap.candidates[i];
        const float untilMs = std::min(c.impactMs, snap.horizonMs);
        const Vec2 end = Add(snap.player, Mul(c.dir, snap.speed * (snap.leadMs + untilMs)));
        ImU32 col;
        if (!c.valid) col = IM_COL32(120, 120, 120, 90);
        else if (c.impactMs >= snap.horizonMs && c.score >= kIntentSafeClearance)
            col = IM_COL32(60, 230, 90, 140);
        else {
            const float f = std::clamp(untilMs / std::max(1.f, snap.horizonMs), 0.f, 1.f);
            col = IM_COL32(230, static_cast<int>(60 + 160 * f), 50, 130);
        }
        DrawLine(d, cam, snap.player, end, col, i == snap.candidate ? 3.f : 1.f);
    }

    // Field candidate ray (orange) — the Dijkstra pocket's first step.
    if (snap.candidates[kFieldCandidate].valid) {
        const CandidateDebug& c = snap.candidates[kFieldCandidate];
        const float untilMs = std::min(c.impactMs, snap.horizonMs);
        const Vec2 end = Add(snap.player, Mul(c.dir, snap.speed * (snap.leadMs + untilMs)));
        DrawLine(d, cam, snap.player, end, IM_COL32(255, 160, 40, 200),
                 kFieldCandidate == snap.candidate ? 3.f : 1.5f);
    }

    // Field pocket marker: where the escape field routed to.
    if (snap.fieldActive) {
        DrawWorldCircle(d, cam, snap.fieldTarget, 0.4f, IM_COL32(255, 210, 0, 220), 2.f);
        DrawLine(d, cam, snap.player, snap.fieldTarget, IM_COL32(255, 210, 0, 140), 1.5f);
    }

    // Autopilot lock target (the biggest targetable enemy being orbited).
    if (snap.hasLockTarget) {
        ImVec2 s;
        if (ToScreen(snap.lockTarget, camX, camY, angle, zoom, cx, cy, s)) {
            d->AddCircle(s, 13.f, IM_COL32(255, 70, 70, 230), 16, 2.f);
            d->AddLine(ImVec2(s.x - 16.f, s.y), ImVec2(s.x + 16.f, s.y), IM_COL32(255, 70, 70, 200), 1.5f);
            d->AddLine(ImVec2(s.x, s.y - 16.f), ImVec2(s.x, s.y + 16.f), IM_COL32(255, 70, 70, 200), 1.5f);
        }
    }

    // Intent (cyan) and committed move (yellow).
    if (LenSq(snap.intentDir) > 1e-4f)
        DrawLine(d, cam, snap.player,
                 Add(snap.player, Mul(snap.intentDir, 1.5f)), IM_COL32(60, 220, 220, 200), 2.f);
    if (snap.overrideActive) {
        DrawDot(d, cam, snap.moveTarget, 5.f,
                snap.moveFailed ? IM_COL32(255, 60, 60, 230) : IM_COL32(255, 210, 0, 230));
        const CandidateDebug& c = snap.candidates[std::clamp(snap.candidate, 0, kCandidateCount - 1)];
        DrawLine(d, cam, snap.player,
                 Add(snap.player, Mul(c.dir, snap.speed * snap.speedScale * 300.f)),
                 IM_COL32(255, 210, 0, 200), 2.5f);
    }
}

} } // namespace UDodge::Debug
