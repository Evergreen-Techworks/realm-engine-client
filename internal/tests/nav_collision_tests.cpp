// Movement::Collision — the game's point rule (navigation rebuild Stage 1).
// Every expectation below is the 86ad651b move routine's answer, modelled line for
// line by the scenario harness's TruthMove/TruthValid (tests/scenario).
#include "features/movement/nav/Collision.h"

#include <cstdio>
#include <cstdlib>
#include <unordered_map>
#include <vector>

namespace TO = Movement::TileOccupancy;
namespace C = Movement::Collision;

namespace {
int g_checks = 0;
void Check(bool ok, const char* name)
{
    ++g_checks;
    if (!ok) { std::fprintf(stderr, "FAIL: %s\n", name); std::exit(1); }
}

std::unordered_map<uint32_t, uint8_t> g_flags;
uint8_t FlagsAt(int tx, int ty)
{
    const auto it = g_flags.find(TO::SquareKey(tx, ty));
    return it == g_flags.end() ? 0 : it->second;
}
const auto kFlags = [](int tx, int ty) { return FlagsAt(tx, ty); };
void Open(int x0, int y0, int x1, int y1)
{
    g_flags.clear();
    for (int y = y0; y <= y1; ++y) for (int x = x0; x <= x1; ++x) g_flags[TO::SquareKey(x, y)] = TO::kTileKnown;
}
void NoWalk(int tx, int ty) { g_flags[TO::SquareKey(tx, ty)] = TO::kTileKnown | TO::kTileBlocked; }
void Occupy(int tx, int ty) { g_flags[TO::SquareKey(tx, ty)] |= TO::kTileBlocked; }
void FullOccupy(int tx, int ty) { g_flags[TO::SquareKey(tx, ty)] |= TO::kTileBlocked | TO::kTileFullOcc; }
void Forget(int tx, int ty) { g_flags.erase(TO::SquareKey(tx, ty)); }
} // namespace

int main()
{
    // ── The toggle ───────────────────────────────────────────────────────────
    Check(C::GetRule() == C::Rule::Legacy, "navCollisionRule defaults to legacy");
    C::SetRuleText("game");
    Check(C::GetRule() == C::Rule::Game, "\"game\" selects the game's rule");
    C::SetRuleText("GAME");
    Check(C::GetRule() == C::Rule::Legacy, "anything but \"game\" is legacy");
    C::SetRuleText("game");
    C::SetRuleText(nullptr);
    Check(C::GetRule() == C::Rule::Legacy, "a missing value is legacy");

    // ── Standable: a centre point, no box ──────────────────────────────────────
    Open(-5, -5, 5, 5);
    NoWalk(1, 0);
    Check(C::Standable(kFlags, 0.99f, 0.5f), "a centre 0.01 from a NoWalk square stands (no 0.2285 box)");
    Check(!C::Standable(kFlags, 1.01f, 0.5f), "a centre on the NoWalk square does not");
    Occupy(-2, 0);
    Check(!C::Standable(kFlags, -1.5f, 0.5f), "an OccupySquare object's square is refused");
    Check(C::Standable(kFlags, -0.99f, 0.5f), "and the square beside it stands up to its edge");
    Forget(3, 3);
    Check(!C::Standable(kFlags, 3.5f, 3.5f), "an unstreamed square is refused, as the game refuses tile 0xFF");
    Check(!C::Standable(kFlags, NAN, 0.5f), "a non-finite point is refused");

    // ── The FullOccupy half-tile rule at 0.5 ───────────────────────────────────
    Open(-5, -5, 5, 5);
    FullOccupy(1, 0);
    Check(!C::Standable(kFlags, 0.7f, 0.5f), "the half facing a FullOccupy neighbour is refused");
    Check(C::Standable(kFlags, 0.5f, 0.5f), "its centre line stands");
    Check(C::Standable(kFlags, 0.3f, 0.5f), "the far half stands");
    Check(C::StepClear(kFlags, 0.7f, 0.5f, 0.3f, 0.5f), "a start inside the refused half may walk out of it");
    Check(!C::StepClear(kFlags, 0.3f, 0.5f, 0.7f, 0.5f), "but nothing may walk into it");
    Check(!C::Standable(kFlags, 0.7f, 0.7f), "the diagonal quarter toward it is refused");

    // ── StepClear: diagonal pinches ────────────────────────────────────────────
    // Squares (8,0) and (9,1) touch only at the corner (9,1); (8,1) and (9,0) are open.
    Open(0, -5, 16, 5);
    NoWalk(8, 0); NoWalk(9, 1);
    Check(C::StepClear(kFlags, 8.5f, 1.5f, 9.5f, 0.5f), "a NoWalk corner pinch is walkable centre to centre");
    Check(C::StepClear(kFlags, 8.2f, 1.8f, 9.8f, 0.2f), "and along any diagonal through the shared corner");
    Check(!C::StepClear(kFlags, 8.5f, 1.5f, 9.5f, 1.5f), "but not into the NoWalk square beside it");
    Check(!C::StepClear(kFlags, 8.6f, 0.4f, 7.5f, 0.5f),
          "from inside a NoWalk square, crossing into its other half is refused (modifyStep checks borders)");
    Open(0, -5, 16, 5);
    Occupy(8, 0); Occupy(9, 1);
    Check(C::StepClear(kFlags, 8.5f, 1.5f, 9.5f, 0.5f), "an object-corner pinch (OccupySquare) is walkable");
    Open(0, -5, 16, 5);
    FullOccupy(8, 0); FullOccupy(9, 1);
    Check(!C::StepClear(kFlags, 8.5f, 1.5f, 9.5f, 0.5f), "a FullOccupy corner pinch is refused (the half-tile ring)");
    Open(0, -5, 16, 5);
    FullOccupy(8, 0); NoWalk(9, 1);
    Check(!C::StepClear(kFlags, 8.5f, 1.5f, 9.5f, 0.5f), "one FullOccupy side is enough to refuse the pinch");

    // ── StepClear: one-tile gaps and walls ────────────────────────────────────
    Open(-5, -5, 5, 5);
    FullOccupy(-1, 0); FullOccupy(1, 0);
    Check(C::StepClear(kFlags, 0.5f, -2.5f, 0.5f, 2.5f), "a one-tile FullOccupy gap is walkable on its centre line");
    Check(!C::StepClear(kFlags, 0.6f, -2.5f, 0.6f, 2.5f), "but not 0.1 off it");
    Open(-5, -5, 5, 5);
    NoWalk(0, 0);
    Check(!C::StepClear(kFlags, -2.5f, 0.5f, 2.5f, 0.5f), "a straight move through a wall is refused");
    Check(!C::StepClear(kFlags, -0.4f, 0.6f, 0.6f, -0.4f), "a diagonal clipping a wall square's corner is refused");
    Check(C::StepClear(kFlags, -0.5f, 0.52f, 0.52f, -0.5f),
          "a 0.028-tile graze shorter than kStepResolutionTiles (0.05 tiles) is walked, as the game's slide walks it");
    Check(C::StepClear(kFlags, -2.5f, 1.5f, 2.5f, 1.5f), "a move along the wall's edge row stands");
    Check(C::StepClear(kFlags, 1.5f, 1.5f, 1.5f, 1.5f), "a zero-length move stands where it is");
    const auto allOpen = [](int, int) -> uint8_t { return TO::kTileKnown; };
    Check(C::StepClear(allOpen, 0.25f, 0.25f, 2000.25f, 0.25f), "a 2000-tile open move is walked piece by piece");
    Check(!C::StepClear(allOpen, 0.25f, 0.25f, 2100.25f, 0.25f), "a move beyond kMaxPieces crossings is refused, not guessed");

    // ── DiagonalStepClear equals StepClear for every neighbourhood ─────────────
    // The squares a centre-to-centre diagonal can touch besides its standable start —
    // the destination and the two shared orthogonals — each open, blocked (NoWalk and
    // OccupySquare set the same bit), FullOccupy or unstreamed: 4^3 = 64 neighbourhoods
    // in each of the 4 directions.
    {
        const auto put = [](int tx, int ty, int state) {
            const uint32_t k = TO::SquareKey(tx, ty);
            switch (state) {
                case 0: g_flags[k] = TO::kTileKnown; break;
                case 1: g_flags[k] = TO::kTileKnown | TO::kTileBlocked; break;
                case 2: g_flags[k] = TO::kTileKnown | TO::kTileBlocked | TO::kTileFullOcc; break;
                default: g_flags.erase(k); break;
            }
        };
        int compared = 0; bool agree = true;
        for (int dir = 0; dir < 4; ++dir) {
            const int dx = (dir & 1) ? -1 : 1, dy = (dir & 2) ? -1 : 1;
            for (int sb = 0; sb < 4; ++sb) for (int sx = 0; sx < 4; ++sx) for (int sy = 0; sy < 4; ++sy) {
                Open(-3, -3, 3, 3);
                put(dx, dy, sb); put(dx, 0, sx); put(0, dy, sy);
                const bool closed = C::DiagonalStepClear(kFlags, 0, 0, dx, dy);
                const bool walked = C::StepClear(kFlags, 0.5f, 0.5f, 0.5f + dx, 0.5f + dy);
                if (closed != walked) agree = false;
                ++compared;
            }
        }
        Check(agree && compared == 256, "DiagonalStepClear equals StepClear over every diagonal neighbourhood");
    }

    // ── RasterSquares: a halfEdge-0 raster reads back losslessly ───────────────
    Open(-5, -5, 5, 5);
    FullOccupy(1, 0); NoWalk(-1, 0); Forget(0, 2);
    std::vector<uint32_t> full{ TO::SquareKey(1, 0) };
    TO::NearFullOccupyMask mask;
    constexpr int S = 5;
    uint8_t cells[S * S];
    TO::PrepareRasterMask(mask, full.data(), full.size(), -1.5f, -1.5f, S, 1.f, 0.f);
    for (int gy = 0; gy < S; ++gy)
        for (int gx = 0; gx < S; ++gx)
            cells[gy * S + gx] = TO::RasterCell(kFlags, mask, -1.5f + gx, -1.5f + gy, 0.f, true);
    const C::RasterSquares view{ cells, -2, -2, S };
    bool same = true;
    for (int ty = -2; ty <= 2; ++ty)
        for (int tx = -2; tx <= 2; ++tx) {
            const uint8_t mine = view(tx, ty);
            const uint8_t truth = FlagsAt(tx, ty) & (TO::kTileKnown | TO::kTileBlocked | TO::kTileFullOcc);
            if (mine != truth) same = false;
        }
    Check(same, "a whole-tile, halfEdge-0 raster carries every bit Standable reads");
    Check(view(3, 0) == 0 && view(-3, 0) == 0, "outside the raster window a square is unknown");
    for (float y = -1.4f; y <= 1.4f; y += 0.1f)
        for (float x = -1.4f; x <= 1.4f; x += 0.1f)
            if (C::Standable(view, x, y) != C::Standable(kFlags, x, y)) same = false;
    Check(same, "Standable over the raster copy equals Standable over the live squares");

    std::printf("Collision rule tests: %d checks, 0 failures\n", g_checks);
    return 0;
}
