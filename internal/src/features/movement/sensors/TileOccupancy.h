#pragma once
// TileOccupancy — the ONE player-occupancy rule, shared by every consumer.
//
// Why this exists (2026-09-13): the game-thread live check (TestTAB box test +
// the FullOccupy half-tile rule, reached through Sensors::CanOccupy) and the
// rasters the worker plans over (WorldTAB::CopyBoxBlocked → FillNavGrid /
// FillOccGrid) were two hand-written copies of "can the player stand here", and
// they disagreed: the rasters had no FullOccupy half-tile rule. The worker then
// planned routes the live follower refused, the stall timer re-planned onto the
// same raster, and the player held in place against walls and rock clusters.
// The offline scenario harness (internal/tests/scenario) reproduces that
// deadlock against the production planner. Both sides now call these functions.
//
// Pure, header-only, no locking and no game memory: every function takes a
// `flagsAt(tx, ty) -> uint8_t` callable over the per-square flag bits below, so
// WorldTAB can pass its locked map lookup and host tests can pass a plain table.
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace Movement { namespace TileOccupancy {

// Per-square flags (WorldTAB's s_tileFlags). Absence of kTileKnown is map void.
enum : uint8_t {
    kTileKnown       = 0x01,   // streamed map square
    kTileBlocked     = 0x02,   // NoWalk ground, or an OccupySquare / FullOccupy / EnemyOccupySquare object
    kTileFullOcc     = 0x04,   // FullOccupy object (drives the half-tile neighbour rule)
    kTileDamaging    = 0x08,   // damaging ground (or a spike object)
    kTileSink        = 0x10,   // sink / sinking ground (water): walkable, slow
};

// Square key: (uint16 tx << 16) | uint16 ty — WorldTAB's BlockedKey encoding.
inline uint32_t SquareKey(int tx, int ty)
{
    return (static_cast<uint32_t>(static_cast<uint16_t>(tx)) << 16) |
            static_cast<uint32_t>(static_cast<uint16_t>(ty));
}
inline int SquareKeyX(uint32_t key) { return static_cast<int16_t>(key >> 16); }
inline int SquareKeyY(uint32_t key) { return static_cast<int16_t>(key & 0xFFFF); }

// Raster cell bits (CopyBoxBlocked output).
enum : uint8_t {
    kCellWall     = 0x01,   // the player box overlaps a blocked square
    kCellHazard   = 0x02,   // the box overlaps damaging ground (only when foldHazard)
    kCellSink     = 0x04,   // the box overlaps sink ground
    kCellVoid     = 0x08,   // the box overlaps an unstreamed square
    kCellFullRing = 0x10,   // the centre breaks the FullOccupy half-tile rule (not a wall body)
    kCellFullBody = 0x20,   // a square under the box holds a FullOccupy object (exact for halfEdge 0)
};

constexpr float kPlayerHalfEdge = 0.2285f;   // the game's collision half-edge

// The FullOccupy rule splits each square at its centre line. A centre within this
// of the line counts as ON the line, where the rule allows the position. The
// game's own move code settles the player onto half-tile borders (the Flash
// client's modifyStep inset is 0.01), while a float position a hair off the line
// would otherwise make a one-tile gap between two FullOccupy objects unusable.
constexpr float kCentreLineTolerance = 0.01f;

// Ground square → flag bits (without kTileKnown).
//
// XML <NoWalk/> is authoritative. This used to be cleared for any square that
// also carried a <Speed> or <Push> element, on the theory that conveyor tiles
// misread as NoWalk. In the 86ad651b tiles.xml no <Push> square has <NoWalk/>,
// but 26 <NoWalk/> squares have <Speed> — deep water above all ("Crystal Cave Deep
// Water", "Red Earth Water Deep", "PC Dark Water", "DWD Dark Water", "SulfW
// Acidwater2") — so every one of them read as shallow, walkable water. Routes then
// waded into water the game refuses to enter. Push keeps the old exemption, which
// no current square uses.
inline uint8_t GroundFlags(bool noWalk, bool push, float /*speed*/, bool sink, bool damaging)
{
    uint8_t f = 0;
    if (noWalk && !push) f |= kTileBlocked;
    if (damaging)        f |= kTileDamaging;
    if (sink)            f |= kTileSink;
    return f;
}

// Does the player box centred at (cx, cy) overlap a blocked square? Unstreamed
// squares do not block here (the live check is optimistic; the raster marks void).
template <class FlagsAt>
bool BoxBlocked(const FlagsAt& flagsAt, float cx, float cy, float halfEdge = kPlayerHalfEdge)
{
    const int x0 = static_cast<int>(std::floor(cx - halfEdge));
    const int x1 = static_cast<int>(std::floor(cx + halfEdge));
    const int y0 = static_cast<int>(std::floor(cy - halfEdge));
    const int y1 = static_cast<int>(std::floor(cy + halfEdge));
    for (int tx = x0; tx <= x1; ++tx)
        for (int ty = y0; ty <= y1; ++ty)
            if (flagsAt(tx, ty) & kTileBlocked) return true;
    return false;
}

// Flash Player.isValidPosition section B: a centre in the left/right/top/bottom
// half of a walkable square is invalid when the neighbouring square(s) on that
// side hold a FullOccupy object. Effectively each FullOccupy square forbids
// centres within Chebyshev 1.0 of its own centre, the boundary itself allowed.
// (tx, ty) is the square holding the centre, (fx, fy) the centre's offset in it.
template <class FlagsAt>
bool FullOccupyBlockedAt(const FlagsAt& flagsAt, int tx, int ty, float fx, float fy)
{
    const int sx = fx < 0.5f - kCentreLineTolerance ? -1 : (fx > 0.5f + kCentreLineTolerance ? 1 : 0);
    const int sy = fy < 0.5f - kCentreLineTolerance ? -1 : (fy > 0.5f + kCentreLineTolerance ? 1 : 0);
    auto fo = [&](int x, int y) { return (flagsAt(x, y) & kTileFullOcc) != 0; };
    if (sx != 0) {
        if (fo(tx + sx, ty)) return true;
        if (sy != 0 && (fo(tx, ty + sy) || fo(tx + sx, ty + sy))) return true;
    } else if (sy != 0) {
        if (fo(tx, ty + sy)) return true;
    }
    return false;
}

template <class FlagsAt>
bool FullOccupyBlocked(const FlagsAt& flagsAt, float cx, float cy)
{
    const int tx = static_cast<int>(std::floor(cx));
    const int ty = static_cast<int>(std::floor(cy));
    return FullOccupyBlockedAt(flagsAt, tx, ty, cx - static_cast<float>(tx), cy - static_cast<float>(ty));
}

// Which squares of a rectangle have a FullOccupy neighbour (8-connected). Built once
// per raster from the list of FullOccupy squares, so the per-cell rule below pays
// for itself only next to those objects and the map rebuild pays nothing extra.
class NearFullOccupyMask {
public:
    // Covers squares [tx0, tx1] x [ty0, ty1]. Returns false (mask unusable, every
    // square reported as near) when the rectangle is implausibly large.
    bool Build(const uint32_t* fullKeys, size_t count, int tx0, int ty0, int tx1, int ty1)
    {
        tx0_ = tx0; ty0_ = ty0;
        w_ = tx1 - tx0 + 1; h_ = ty1 - ty0 + 1;
        all_ = w_ <= 0 || h_ <= 0 || static_cast<long long>(w_) * h_ > kMaxSquares;
        any_ = all_;
        if (all_) return false;
        bits_.assign(static_cast<size_t>(w_) * static_cast<size_t>(h_), 0);
        for (size_t i = 0; i < count; ++i) {
            const int fx = SquareKeyX(fullKeys[i]), fy = SquareKeyY(fullKeys[i]);
            if (fx < tx0_ - 1 || fx > tx0_ + w_ || fy < ty0_ - 1 || fy > ty0_ + h_) continue;
            any_ = true;
            for (int dy = -1; dy <= 1; ++dy)
                for (int dx = -1; dx <= 1; ++dx) {
                    if (dx == 0 && dy == 0) continue;
                    const int x = fx + dx - tx0_, y = fy + dy - ty0_;
                    if (x >= 0 && y >= 0 && x < w_ && y < h_) bits_[static_cast<size_t>(y) * w_ + x] = 1;
                }
        }
        return true;
    }
    // No square near a FullOccupy object: for a raster whose every centre sits on its
    // square's centre lines, where the half-tile rule can never refuse a position.
    void Clear() { all_ = false; any_ = false; w_ = h_ = 0; bits_.clear(); }
    bool Any() const { return any_; }   // false: no FullOccupy object touches the rectangle
    bool Near(int tx, int ty) const
    {
        if (all_) return true;
        const int x = tx - tx0_, y = ty - ty0_;
        return x >= 0 && y >= 0 && x < w_ && y < h_ && bits_[static_cast<size_t>(y) * w_ + x] != 0;
    }
private:
    static constexpr long long kMaxSquares = 1LL << 20;
    int tx0_ = 0, ty0_ = 0, w_ = 0, h_ = 0;
    bool all_ = true;
    bool any_ = true;
    std::vector<uint8_t> bits_;
};

// One raster cell centred at (cx, cy): the CopyBoxBlocked box scan plus the
// FullOccupy half-tile rule, which is evaluated only off the square's centre lines
// and next to a FullOccupy object (`nearFull`), so open ground pays nothing new.
template <class FlagsAt>
uint8_t RasterCell(const FlagsAt& flagsAt, const NearFullOccupyMask& nearFull,
                   float cx, float cy, float halfEdge, bool foldHazard)
{
    const int x0 = static_cast<int>(std::floor(cx - halfEdge));
    const int x1 = static_cast<int>(std::floor(cx + halfEdge));
    const int y0 = static_cast<int>(std::floor(cy - halfEdge));
    const int y1 = static_cast<int>(std::floor(cy + halfEdge));
    uint8_t f = 0;
    for (int tx = x0; tx <= x1; ++tx) {
        for (int ty = y0; ty <= y1; ++ty) {
            const uint8_t tf = flagsAt(tx, ty);
            if (tf & kTileFullOcc) f |= kCellFullBody;
            // Missing streamed squares are map void/boundary, not open floor.
            if ((tf & kTileKnown) == 0) { f |= kCellVoid; continue; }
            if (tf & kTileBlocked) { f |= kCellWall; continue; }
            if (foldHazard && (tf & kTileDamaging)) f |= kCellHazard;
            if (tf & kTileSink) f |= kCellSink;
        }
        if (f & kCellWall) break;   // a wall dominates; no need to keep scanning
    }
    if ((f & kCellWall) || !nearFull.Any()) return f;
    // The centre's square is x0 or x0 + 1 (halfEdge < 1), found without another floor.
    const int ctx = cx >= static_cast<float>(x0 + 1) ? x0 + 1 : x0;
    const int cty = cy >= static_cast<float>(y0 + 1) ? y0 + 1 : y0;
    const float fx = cx - static_cast<float>(ctx), fy = cy - static_cast<float>(cty);
    // A centre on both centre lines is never refused — every cell of the 1-tile nav
    // raster, so that raster pays two float compares and no lookup.
    if (std::fabs(fx - 0.5f) <= kCentreLineTolerance && std::fabs(fy - 0.5f) <= kCentreLineTolerance)
        return f;
    if (nearFull.Near(ctx, cty) && FullOccupyBlockedAt(flagsAt, ctx, cty, fx, fy))
        f |= kCellFullRing;
    return f;
}

// Prepare `mask` for one raster: cleared when every cell centre sits on its square's
// centre lines (whole-tile cells from a half-tile origin, like the nav raster),
// otherwise built over the squares the raster can touch.
inline void PrepareRasterMask(NearFullOccupyMask& mask, const uint32_t* fullKeys, size_t count,
                              float originX, float originY, int side, float cellTiles, float halfEdge);

// The square rectangle a raster of `side` cells of `cellTiles` from (originX,
// originY) with box half-edge `halfEdge` can touch, for NearFullOccupyMask::Build.
inline void RasterSquareBounds(float originX, float originY, int side, float cellTiles, float halfEdge,
                               int& tx0, int& ty0, int& tx1, int& ty1)
{
    const float extent = static_cast<float>(side - 1) * cellTiles;
    tx0 = static_cast<int>(std::floor(originX - halfEdge));
    ty0 = static_cast<int>(std::floor(originY - halfEdge));
    tx1 = static_cast<int>(std::floor(originX + extent + halfEdge));
    ty1 = static_cast<int>(std::floor(originY + extent + halfEdge));
}

inline void PrepareRasterMask(NearFullOccupyMask& mask, const uint32_t* fullKeys, size_t count,
                              float originX, float originY, int side, float cellTiles, float halfEdge)
{
    const auto onCentreLine = [](float v) {
        return std::fabs((v - std::floor(v)) - 0.5f) <= kCentreLineTolerance * 0.5f;
    };
    if (count == 0 || (cellTiles == 1.f && onCentreLine(originX) && onCentreLine(originY))) {
        mask.Clear();
        return;
    }
    int tx0 = 0, ty0 = 0, tx1 = 0, ty1 = 0;
    RasterSquareBounds(originX, originY, side, cellTiles, halfEdge, tx0, ty0, tx1, ty1);
    mask.Build(fullKeys, count, tx0, ty0, tx1, ty1);
}

} } // namespace Movement::TileOccupancy
