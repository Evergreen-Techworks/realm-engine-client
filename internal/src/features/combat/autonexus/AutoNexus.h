#pragma once

#include <cstdint>

namespace CombatTAB {
namespace FeatAutoNexus {

void Tick();
void Render();
bool ConsumesLocalPlayer();

bool OverlayEnabled();

void RenderDebugPath(float camX, float camY, float angleRad, float zoom, float cx, float cy);

// ── Autonexus tunables ───────────────────────────────────────────────────
void  SetAutoNexusEnabled(bool on);
void  SetAutoNexusProjPredictEnabled(bool on);
void  SetAutoNexusTilePredictEnabled(bool on);
    
void  SetAutoNexusPredictedTimeMs(float ms);
void  SetAutoNexusDebugDraw(bool on);

} // namespace FeatAutoNexus
} // namespace CombatTAB
