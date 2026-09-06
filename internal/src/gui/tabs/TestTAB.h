#pragma once

#include <cstdint>
#include <vector>
#include <windows.h>
#include "WorldTAB.h"

namespace TestTAB {

enum class DodgeMode : int {
    Off         = 0,
    XDodge      = 1,  // Spacetime BFS ported from XRebuild/XDriver. Movement via NativeMoveTo.
    RolloutGrid = 2,  // Forward input-simulation, uniform-grid broad-phase (RolloutDodge).
    RolloutQuad = 3,  // Same engine, quadtree broad-phase (A/B against the grid version).
    ZDodge      = 4,  // Intent-preserving slide-assist dodge (zdodge).
    RePP        = 5,  // RE++ next-gen reactive dodge (repp).
    PJDodge     = 6,  // Predictive controller + escape search (pjdodge).
    UDodge      = 7,  // Unified dodge (PJDodge core + RePP field/goal layer).
};

DodgeMode GetDodgeMode();
void      SetDodgeMode(DodgeMode m);
void      SetDodgeModeWithEnter(DodgeMode m);
float     GetDodgeLookaheadMs();
void      SetDodgeLookaheadMs(float ms);
bool      IsAnyAutoDodgeEnabled();

    void Render();
    // Follow Mouse + Follow Entity (shown on Movement tab).
    void RenderMovementSection();

    // Called every frame from dPresent (outside menu visibility gate).
    void Tick(bool menuVisible);

    // W2S state accessors — updated every frame in Tick().
    bool  IsW2SValid();
    float GetMouseWorldX();
    float GetMouseWorldY();
    float GetMouseScreenX();
    float GetMouseScreenY();
    bool  IsFollowMouseEnabled();
    bool  IsAStarDodgeEnabled();
    float GetEnemyAvoidDist();

    void ReadDodgePlayerStats(int32_t& hp, int32_t& maxHp, float& spd, float& tilesPerSec);

    bool IsWalkPositionBlocked(float cx, float cy);
    bool IsDamagingPosition(float cx, float cy);
    bool IsWalkCircleBlocked(float cx, float cy);
    float GetCtrlTeleportMaxTiles();
    bool ComputeCtrlTeleportLanding(float playerX, float playerY, float cursorWorldX, float cursorWorldY,
                                    float& outX, float& outY);
    float GetPlayerHitboxSize();

    float ReadGameHitboxMult();
    float ReadGameHitbox1Mult();

    float GetGameHitboxMult();

    bool GetPlayerIntent(float& outX, float& outY);

    void SetBotWalkTarget(float worldX, float worldY, bool active);
}
