#pragma once
// Movement::Collision — the game's own walkability rule, one copy for every mover.
//
// Measured in 86ad651b (ledger "DIAGONAL PINCH measured", commit 68d8485): the move
// routine FKALGHJIADI::CJCEGCEMIGE splits a move, runs modifyStep
// (LKHPPBEGNOM::EOIKMCEKEPG, axis slides) and validates each endpoint with
// HJMBOMEHGDJ::PEGDEDNHEHD. That test is a POINT test: the square under the centre
// must be streamed and walkable with no occupying object, then the FullOccupy
// half-tile rule applies at 0.5. There is no player box — no 0.2285 or 0.457 exists
// anywhere in GameAssembly.
//
// Pure and header-only. Every function takes `flagsAt(tx, ty) -> uint8_t` over the
// per-square TileOccupancy bits (kTileKnown, kTileBlocked, kTileFullOcc): the game
// thread passes WorldTAB's lookup, the worker a plain raster copy (RasterSquares).
//
// navCollisionRule picks this rule (Rule::Game) or the pre-rebuild player box
// (Rule::Legacy) at every consumer; each consumer keeps one signature for both.
#include "features/movement/sensors/TileOccupancy.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>

namespace Movement { namespace Collision {

enum class Rule : uint8_t { Legacy = 0, Game = 1 };

inline std::atomic<uint8_t>& RuleSlot()
{
    static std::atomic<uint8_t> slot{ static_cast<uint8_t>(Rule::Legacy) };
    return slot;
}
inline void SetRule(Rule rule) { RuleSlot().store(static_cast<uint8_t>(rule), std::memory_order_relaxed); }
inline Rule GetRule() { return static_cast<Rule>(RuleSlot().load(std::memory_order_relaxed)); }
// Feature command "navCollisionRule": "game" selects the game's rule; anything else
// (including a missing value) is the legacy box.
inline void SetRuleText(const char* text)
{
    SetRule(text && std::strcmp(text, "game") == 0 ? Rule::Game : Rule::Legacy);
}
inline const char* RuleName(Rule rule) { return rule == Rule::Game ? "game" : "legacy"; }

// Can the player's centre stand at (x, y)? Walls and occupying objects on the square
// under the point, then the FullOccupy half-tile rule. A square the DLL has never
// seen streamed is refused: the game refuses it too (its tile type is still 0xFF).
template <class FlagsAt>
bool Standable(const FlagsAt& flagsAt, float x, float y)
{
    if (!std::isfinite(x) || !std::isfinite(y)) return false;
    const int tx = static_cast<int>(std::floor(x));
    const int ty = static_cast<int>(std::floor(y));
    const uint8_t f = flagsAt(tx, ty);
    if ((f & TileOccupancy::kTileKnown) == 0 || (f & TileOccupancy::kTileBlocked) != 0) return false;
    return !TileOccupancy::FullOccupyBlockedAt(flagsAt, tx, ty,
                                               x - static_cast<float>(tx), y - static_cast<float>(ty));
}

// Wall contact shorter than this (tiles) does not refuse a move: the game validates
// step END POINTS and slides along the refused axis, so a route that grazes a wall
// corner by less than one step is walked in game. 0.05 is the sub-step of the
// harness's model of the game move (tests/scenario TruthMove); the game's own split
// threshold is not measured.
constexpr double kStepResolutionTiles = 0.05;
// Longest segment walked piece by piece (half-tile lines crossed on both axes).
constexpr int kMaxPieces = 4096;

// Does the straight move a -> b keep the centre standable the whole way?
//
// Standable is constant inside each half-tile cell (square halves split at 0.5), so
// the segment is cut at every x or y multiple of 0.5 it crosses, and every piece
// longer than kStepResolutionTiles is tested once at its midpoint, plus the end
// point. The lattice points between pieces are never tested: a diagonal through the
// corner two NoWalk squares share is walkable in game (the slide goes round it),
// while one between FullOccupy walls is not — its pieces fall in the half-tile ring.
// A start that is not standable blocks nothing inside its own half-tile cell, so the
// player can always leave where it stands.
template <class FlagsAt>
bool StepClear(const FlagsAt& flagsAt, float ax, float ay, float bx, float by)
{
    if (!Standable(flagsAt, bx, by)) return false;
    const double dx = static_cast<double>(bx) - ax, dy = static_cast<double>(by) - ay;
    const double len = std::sqrt(dx * dx + dy * dy);
    if (len <= 0.0) return true;
    const bool startFree = Standable(flagsAt, ax, ay);
    const double startCellX = std::floor(static_cast<double>(ax) * 2.0);
    const double startCellY = std::floor(static_cast<double>(ay) * 2.0);
    constexpr double kNone = 2.0;
    const auto firstCrossing = [](double a, double d) {
        if (d == 0.0) return kNone;
        const double line = d > 0.0 ? (std::floor(a * 2.0) + 1.0) * 0.5 : (std::ceil(a * 2.0) - 1.0) * 0.5;
        return (line - a) / d;
    };
    double tX = firstCrossing(ax, dx), tY = firstCrossing(ay, dy);
    const double stepX = dx != 0.0 ? 0.5 / std::fabs(dx) : kNone;
    const double stepY = dy != 0.0 ? 0.5 / std::fabs(dy) : kNone;
    const double tie = kStepResolutionTiles / len;
    double t0 = 0.0;
    for (int piece = 0; piece < kMaxPieces; ++piece) {
        const double t1 = std::min(std::min(tX, tY), 1.0);
        if (t1 - t0 > tie) {
            const double tm = 0.5 * (t0 + t1);
            const double px = ax + dx * tm, py = ay + dy * tm;
            const bool inStartCell = std::floor(px * 2.0) == startCellX && std::floor(py * 2.0) == startCellY;
            if (!(inStartCell && !startFree) &&
                !Standable(flagsAt, static_cast<float>(px), static_cast<float>(py)))
                return false;
        }
        if (t1 >= 1.0) return true;
        if (tX <= t1 + tie) tX += stepX;
        if (tY <= t1 + tie) tY += stepY;
        t0 = t1;
    }
    return false;   // longer than kMaxPieces half-tile crossings: refuse rather than guess
}

// StepClear between the centres of two diagonal neighbours (tx, ty) -> (tx+dx, ty+dy),
// |dx| = |dy| = 1, in closed form: the two pieces lie in the two squares' facing
// quarters, so the move is clear exactly when the destination stands and neither
// shared orthogonal square holds a FullOccupy object. A NoWalk or OccupySquare
// orthogonal does not close it. Equal to StepClear for every neighbourhood
// (tests/nav_collision_tests.cpp checks all of them); a whole-tile search pays three
// lookups instead of a segment walk.
template <class FlagsAt>
bool DiagonalStepClear(const FlagsAt& flagsAt, int tx, int ty, int dx, int dy)
{
    if (!Standable(flagsAt, static_cast<float>(tx + dx) + 0.5f, static_cast<float>(ty + dy) + 0.5f)) return false;
    return (flagsAt(tx + dx, ty) & TileOccupancy::kTileFullOcc) == 0 &&
           (flagsAt(tx, ty + dy) & TileOccupancy::kTileFullOcc) == 0;
}

// A whole-tile raster copied at square centres with no box (WorldTAB::CopyBoxBlocked,
// halfEdge 0, cellTiles 1, origin on a square centre), read back as TileOccupancy
// square bits. kCellFullBody keeps it lossless for Standable. Outside the window a
// square is unknown, so it is refused.
struct RasterSquares {
    const uint8_t* cells = nullptr;
    int tx0 = 0, ty0 = 0;   // the square held by cell 0
    int side = 0;
    uint8_t operator()(int tx, int ty) const
    {
        const int x = tx - tx0, y = ty - ty0;
        if (!cells || x < 0 || y < 0 || x >= side || y >= side) return 0;
        const uint8_t c = cells[y * side + x];
        uint8_t f = 0;
        if ((c & TileOccupancy::kCellVoid) == 0) f |= TileOccupancy::kTileKnown;
        if (c & TileOccupancy::kCellWall)       f |= TileOccupancy::kTileBlocked;
        if (c & TileOccupancy::kCellFullBody)   f |= TileOccupancy::kTileFullOcc;
        return f;
    }
};

} } // namespace Movement::Collision
