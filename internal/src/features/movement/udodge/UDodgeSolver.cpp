#include "pch-il2cpp.h"
#include "UDodgeSolver.h"
#include "UDodgeCore.h"
#include "UDodgePathfinder.h"

#include <algorithm>
#include <cmath>

namespace UDodge { namespace Solver {
namespace {

// The solver's HARD safety constraint is Core::PointSafety / Core::PointSafe,
// which fold the player half-extent (kUPlayerHalf) into every bullet hit region
// and active-zone radius. That is the divergence fix (plan 64): without it a
// point the solver calls "safe" could still sit ~0.21 tiles inside the server's
// hit square and the player gets clipped. Assert the constant is live so this
// dependency is explicit at the solver boundary.
static_assert(kUPlayerHalf > 0.f, "safety test must include the player half-extent");

// ── Reachable candidate set (tiny, ≤ ~1.9 tiles) ────────────────────────────
// The stand point plus polar rings at 0.34/0.67/1.0 of the move budget over
// K headings, plus (when a goal exists) the goal-direction point clamped to the
// budget. K = 24 ≈ 15° resolution; three rings resolve any gap the player can
// physically fit through inside one tick's reach.
constexpr int   kSolveAngles = 32;
constexpr int   kSolveRings   = 4;
constexpr float kRingFrac[kSolveRings] = { 0.25f, 0.5f, 0.75f, 1.0f };
// stand + rings + goal-direction point + pocket-direction point.
constexpr int   kMaxCandidates = 1 + kSolveRings * kSolveAngles + 2;   // 131

struct Cand {
    Vec2  pos{};
    Vec2  dir{};        // unit(pos − player); {} for the stand point
    float moveDist = 0.f;
    float clr = 0.f;    // Core::PointSafety at pos
    bool  occOk = false;
    // FINDING J: `occOk` is the ENDPOINT rule (walkable + not standing inside an
    // enemy body). `pathOk` additionally SWEEPS the step player→pos against enemy
    // bodies, so a ~1.9-tile step can no longer slice clean through a ~1.01-tile
    // no-go circle with both ends clear. The safe set is admitted on pathOk; the
    // least-bad FALLBACK deliberately still uses occOk — in RotMG a mob does not
    // physically block the player, so this is an intent-level "don't melee" rule
    // and it must not make escaping a surround harder than it already was.
    bool  pathOk = false;
    bool  safe = false; // occOk && clr >= kULatencyPad
    bool  stand = false;
    float soft = 0.f;   // finding G-2: pending (telegraphed, unarmed) AoE penetration at pos,
                        // in tiles — the quantity CandidateDebug::softCost documents. SCORE only.
    bool  threaded = false;   // admitted via the arrival-time thread (in a lane NOW,
                              // clear on arrival) rather than open-space spatial safety
    // TEMPORAL DURABILITY in [0,1] (kSolveDurableW): how far past the dwell window
    // this candidate stays clear, normalized over the horizon. 0 = it survives
    // admission and nothing more (a bullet is already on its way in); 1 = nothing
    // reaches it anywhere in the horizon. Measured for EVERY scored candidate —
    // threaded and instantaneously-safe alike, the stand included — so "hold here"
    // and "step there" compete on the same basis. SCORE only; admission is
    // unchanged and still the pure dwell-window test (Core::Temporal::DwellClear).
    float dur = 0.f;
    // Signed gap (tiles) from pos to the NEAREST enemy body surface — the same
    // circle EnemyBlocked excludes on (radius + kUPlayerHalf). Clamped at
    // kSolveStandoffBand when nothing is near, i.e. "no standoff penalty". SCORE
    // only (kSolveStandoffW); never gates admission.
    float enemyGap = kSolveStandoffBand;
};

// Dominant projectile TRAVEL AXIS near the player. Using (player-lane.anchor)
// made the axis rotate as the player retreated, so running away could reinforce
// itself while the shot continued to chase down the same corridor. A weighted
// 2-D orientation tensor is sign-independent (opposing shots on the same axis do
// not cancel) and its principal eigenvector gives the true sidestep axis.
Vec2 FlowDir(const MapInput& in)
{
    if (!in.map) return {};
    float xx = 0.f, xy = 0.f, yy = 0.f, total = 0.f;
    for (int i = 0; i < in.map->laneCount; ++i) {
        const LaneThreat& L = in.map->lanes[i];
        if (L.pointCount < 2) continue;
        const Vec2 axis = Normalize(Sub(L.points[1], L.points[0]));
        if (LenSq(axis) < 1e-6f) continue;
        const float laneDistance = Len(Sub(in.player, L.points[0]));
        const float w = 1.f / (0.5f + laneDistance);
        xx += w * axis.x * axis.x;
        xy += w * axis.x * axis.y;
        yy += w * axis.y * axis.y;
        total += w;
    }
    if (total <= 1e-6f) return {};
    const float angle = 0.5f * std::atan2(2.f * xy, xx - yy);
    return { std::cos(angle), std::sin(angle) };
}

// ── General enemy standoff support (kSolveStandoffW / kSolveStandoffBand) ───
// The nearby enemies whose bodies the standoff score term keeps us off. Built
// ONCE per solve and culled to the bodies a candidate could possibly be scored
// against (every candidate lies within one move budget of the player), so the
// per-candidate lookup below runs over a handful of entries instead of all
// kMaxEnemies — see the cost note on Evaluate.
struct StandoffSet {
    Vec2  pos[kMaxEnemies]{};
    float noGo[kMaxEnemies]{};   // radius + kUPlayerHalf — EnemyBlocked's hard circle
    int   n = 0;
    // Gap from the PLAYER to the LOCKED body, which is kept out of the scored set
    // above (its annulus already penalises it) but still has to be visible to the
    // HOLD decline — being parked on the boss is exactly the case where declining
    // the early Hold lets kSolveInnerW pull us back out to the annulus.
    float lockGap = kSolveStandoffBand;
};

// Position match (squared tiles) used to recognise the LOCKED boss inside the
// enemy array. Both come from the same EnemyTracker entry in the same
// PopulateEnemies pass, so this only has to survive float copies.
constexpr float kSolveLockMatchEps2 = 0.01f;   // 0.1 tile

void BuildStandoffSet(const MapInput& in, const Goal& goal, float b, StandoffSet& out)
{
    out.n = 0;
    if (!in.map) return;
    // Composition with the locked-boss annulus: when the annulus is live it ALREADY
    // holds us off the lock (kSolveInnerW over [0, innerStandoff], a ring that is at
    // least kUInnerStandoffMinTiles = 2 tiles and normally wider than this band), so
    // the locked body is dropped here rather than penalised twice — double-counting
    // would bias the dodge outward off the annulus it is supposed to be holding.
    // Every OTHER enemy (adds crowding the boss included) still gets the term.
    const bool skipLock = goal.fromLock && goal.innerStandoff > 0.f;
    for (int i = 0; i < in.map->enemyCount; ++i) {
        const EnemyBlocker& e = in.map->enemies[i];
        const float noGo = e.radius + kUPlayerHalf + kUEnemyKeepoutGap;
        // Cull: a candidate is at most b from the player, so a body farther than
        // b + noGo + band away cannot reach any candidate's fade region.
        const float cull = b + noGo + kSolveStandoffBand;
        if (LenSq(Sub(e.pos, in.player)) > cull * cull) continue;
        if (skipLock && LenSq(Sub(e.pos, goal.lockPos)) < kSolveLockMatchEps2) {
            out.lockGap = std::min(out.lockGap, Len(Sub(e.pos, in.player)) - noGo);
            continue;                                   // scored by the annulus, not here
        }
        out.pos[out.n]  = e.pos;
        out.noGo[out.n] = noGo;
        ++out.n;
    }
}

// Gap from p to the nearest body surface in the set, clamped at the band (= no
// penalty). The squared pre-test keeps the common case (a candidate not near any
// body) free of the sqrt. Never negative for a SCORED candidate — occOk already
// excludes anything inside a body — so the ramp in ScoreCand needs no clamp of its own.
float StandoffGap(const StandoffSet& s, Vec2 p)
{
    float best = kSolveStandoffBand;
    for (int i = 0; i < s.n; ++i) {
        const float lim = s.noGo[i] + kSolveStandoffBand;
        const float d2  = LenSq(Sub(p, s.pos[i]));
        if (d2 >= lim * lim) continue;                   // outside the fade — cannot score
        const float g = std::sqrt(d2) - s.noGo[i];
        if (g < best) best = g;
    }
    return best;
}

// Smart-direction score over the SAFE set only (safety already guaranteed for
// every candidate scored here, so these terms only choose AMONG safe points and
// can never trade safety away). Baked weights (kSolve*), NO user sliders.
float ScoreCand(const Cand& c, Vec2 player, const Goal& goal,
                Vec2 flow, Vec2 prevDir, float b)
{
    float score = 0.f;

    // Continuity — reward continuing the last committed heading (kills jitter).
    // The stand point (dir {}) scores 0 here.
    if (LenSq(c.dir) > 1e-6f && LenSq(prevDir) > 1e-6f) {
        const float align = Dot(c.dir, prevDir);
        score += kSolveCommitW * std::max(0.f, align);
        // Plan 76: extra commitment bonus when the candidate closely matches the
        // committed heading — breaks near-equal SAFE options toward "keep going".
        // Every scored candidate is already safe, so this never trades safety away.
        if (align > 0.9f) score += kSolveCommitBonus;
    }

    // Advance toward the goal, but fade the pull to zero as the point approaches
    // the safety floor so near danger the dodge never chases the orbit line.
    if (goal.active) {
        const float progress = Len(Sub(player, goal.pos)) - Len(Sub(c.pos, goal.pos));
        const float ramp = std::clamp((c.clr - kULatencyPad) / kUScoreStyleBand, 0.f, 1.f);
        const float goalWeight = kSolveGoalW + (goal.fromLock ? kSolveLockGoalW : 0.f);
        score += goalWeight * progress * ramp;
    }

    // RePP-style perpendicular sidestep: reward moving ACROSS the incoming
    // stream, PENALIZE moving along its axis — both fleeing straight back and
    // charging straight in. (1 − 2|par|): +1 lateral, −1 radial. This is what
    // stops it from preferring a backpedal over a left/right sidestep.
    if (LenSq(flow) > 1e-6f && LenSq(c.dir) > 1e-6f) {
        const float par = Dot(c.dir, flow);
        score += kSolvePerpW * (1.f - 2.f * std::fabs(par));
    }

    // Minimal disruption — prefer the nearest safe point.
    score -= kSolveMoveW * c.moveDist / std::max(b, 1e-3f);

    // Gentle comfort tiebreak, capped so it never dominates.
    score += kSolveClearW * std::min(c.clr, kSolveClearComfort);

    // Tight-weave preference: a threaded (arrival-clear, in-gap) candidate is
    // rewarded so we hold the pattern instead of fleeing to open space. Safe by
    // construction — only arrival-clear candidates carry threaded=true.
    // Tight pellet-gap weaving is an aggressive locked-fight stance. With no
    // boss lock, prefer the durability gradient instead so a shotgun fan drives
    // toward genuinely open space rather than rewarding a narrow gap merely for
    // being threadable at the predicted instant.
    if (c.threaded && goal.fromLock) score += kSolveWeaveW;

    // TEMPORAL DURABILITY GRADIENT (kSolveDurableW). The one term that knows about
    // the FUTURE of the safe set: prefer the cell that stays clear longer. It is a
    // different quantity from the comfort tiebreak above — clr is how far the cell
    // sits from every lane RIGHT NOW, dur is how long before a bullet gets there —
    // and the two genuinely disagree in both directions (a wide-open cell a wall
    // will sweep has high clr and low dur; a cell a shot has just passed through
    // has negative clr and dur 1). They are only weakly correlated, which is why
    // the comfort cap stays low (kSolveClearComfort) and this one is the larger of
    // the two. Applied over the ALREADY-ADMITTED set only, so — like every term
    // here — it can only reorder safe candidates, never widen the safe set.
    score += kSolveDurableW * c.dur;

    // Stay in shooting range: penalize a dodge point that sits OUTSIDE the boss
    // weapon range, so we dodge inward/laterally and keep our range instead of
    // fleeing outward. Only when locked (goal.fromLock) with a real range.
    if (goal.fromLock && goal.maxRange > 0.f) {
        const float distToBoss = Len(Sub(c.pos, goal.lockPos));
        const float over = distToBoss - goal.maxRange;
        if (over > 0.f)
            score -= kSolveOutRangeW * over            // linear base (unchanged slope near the edge)
                   + kSolveOutRangeQuadW * over * over; // super-linear far-drift penalty
    }

    // Never fight point-blank: penalize a dodge point INSIDE the inner-standoff
    // ring so the annulus [innerStandoff, maxRange] — not the filled disk — is the
    // held manifold. A SCORE term over the SAFE set (never a hard filter): if the
    // only safe cells are inside the ring the player still dodges there (safety
    // wins) and this pulls back outward next tick. Only when locked.
    if (goal.fromLock && goal.innerStandoff > 0.f) {
        const float distToBoss = Len(Sub(c.pos, goal.lockPos));
        if (distToBoss < goal.innerStandoff)
            score -= kSolveInnerW * (goal.innerStandoff - distToBoss);
    }

    // Don't sit ON a mob — the general standoff, for EVERY enemy rather than only
    // a locked one (kSolveStandoffW). Quadratic ramp: full weight where the
    // candidate touches the body surface, zero by kSolveStandoffBand beyond it, so
    // the dodge prefers the outer part of its reach while still being free to come
    // in. Like kSolveInnerW this only REORDERS safe candidates — dodging inward
    // onto a mob stays available when that is where the safe cells are. The locked
    // boss is not in the set while its annulus is live (see BuildStandoffSet), so
    // the two never stack on the same body.
    if (c.enemyGap < kSolveStandoffBand) {
        const float t = 1.f - c.enemyGap / kSolveStandoffBand;   // 0 at the band edge, 1 on the body
        score -= kSolveStandoffW * t * t;
    }

    // Don't park under a telegraphed bomb (finding G-2). Pending zones are
    // COST-ONLY by contract, and until now that cost did not exist anywhere — a
    // blast 1.2 s out was invisible, so the solver would hold in its dead centre
    // and then have to flee the moment it armed. A SCORE term over the SAFE set,
    // exactly like kSolveInnerW: it can only reorder safe candidates, never remove
    // one, so if the telegraph covers everything safe the player still dodges
    // there. Capped so a large or overlapping telegraph cannot turn a preference
    // into a de-facto filter.
    if (c.soft > 0.f)
        score -= std::min(kSolvePendingW * c.soft, kSolvePendingMax);

    // Stand bias: when standing still is safe and nothing is clearly better,
    // hold (minimal disruption) instead of twitching off a safe stand.
    if (c.stand) score += kSolveStandBias;

    return score;
}

int BuildCandidates(const MapInput& in, float b, const Goal& goal,
                    bool pocketFound, Vec2 pocketPos, Cand* out)
{
    const Vec2 player = in.player;
    int n = 0;

    // Stand point.
    out[n].pos = player;
    out[n].dir = {};
    out[n].moveDist = 0.f;
    out[n].stand = true;
    ++n;

    // Polar rings.
    for (int ri = 0; ri < kSolveRings; ++ri) {
        const float r = b * kRingFrac[ri];
        for (int k = 0; k < kSolveAngles; ++k) {
            const float ang = kTwoPi * static_cast<float>(k) / static_cast<float>(kSolveAngles);
            const Vec2 dir{ std::cos(ang), std::sin(ang) };
            out[n].pos = Add(player, Mul(dir, r));
            out[n].dir = dir;
            out[n].moveDist = r;
            ++n;
        }
    }

    // Goal-direction point clamped to the budget.
    if (goal.active) {
        const Vec2 to = Sub(goal.pos, player);
        const float d = Len(to);
        if (d > 1e-4f) {
            const float r = std::min(d, b);
            const Vec2 dir = Mul(to, 1.f / d);
            out[n].pos = Add(player, Mul(dir, r));
            out[n].dir = dir;
            out[n].moveDist = r;
            ++n;
        }
    }

    // Pocket-direction point clamped to the budget — the exact reachable step
    // toward the nearest durable lookahead pocket, so the immediate solve always
    // has a candidate pointing straight at the gap (the rings only resolve to
    // ~15°). This is how a multi-tile pocket is approached one budget at a time.
    if (pocketFound) {
        const Vec2 to = Sub(pocketPos, player);
        const float d = Len(to);
        if (d > 1e-4f) {
            const float r = std::min(d, b);
            const Vec2 dir = Mul(to, 1.f / d);
            out[n].pos = Add(player, Mul(dir, r));
            out[n].dir = dir;
            out[n].moveDist = r;
            ++n;
        }
    }
    return n;
}

// True when p sits inside any enemy body (+ the player half-extent). Running
// over an enemy is NEVER acceptable, so this is a HARD exclusion (treated like a
// wall — removed from occupiable), not a soft score. Applies to the safe set AND
// the least-bad fallback, so even when surrounded the solver never routes onto a
// mob. The boss orbit sits at weapon range, far outside any body, so this never
// conflicts with staying in range.
bool EnemyBlocked(const MapInput& in, Vec2 p)
{
    return Core::EnemyBlocked(in, p);   // one shared radius source (solver + pathfinder + step re-validation)
}

// Evaluate occupancy + server-accurate clearance for every candidate.
// COST: the enemy-standoff gap adds one pass over the CULLED StandoffSet per
// candidate (typically 0-3 bodies within b + ~3 tiles; a squared pre-test keeps
// the miss free of the sqrt) — the same 131 x nearby-enemies shape the EnemyBlocked
// / EnemyPathBlocked passes in this very loop already have, and far cheaper than
// the PointSafety lane march beside it.
void Evaluate(const MapInput& in, const StandoffSet& so, Cand* c, int n)
{
    for (int i = 0; i < n; ++i) {
        const bool walkable = CanOccupyAt(in, c[i].pos);
        c[i].occOk = walkable && !EnemyBlocked(in, c[i].pos);
        c[i].pathOk = c[i].occOk && OccupancyPathClear(in, in.player, c[i].pos) &&
                      !Core::EnemyPathBlocked(in, in.player, c[i].pos);
        c[i].clr = Core::PointSafety(in, c[i].pos);
        c[i].soft = Core::PendingZoneCost(in, c[i].pos);   // finding G-2 (score only, never a filter)
        c[i].safe = c[i].occOk && c[i].clr >= kULatencyPad;
        c[i].enemyGap = StandoffGap(so, c[i].pos);         // score only, never a filter
    }
}

// ── Temporal lookahead: nearest pocket that is safe over the next N ticks ────
// The static test above (PointSafety ≥ margin) treats a lane as dangerous over
// its WHOLE forward path — correct but over-conservative, since it can't thread
// a gap in TIME. The temporal layer instead asks: given where every bullet is
// GOING (its traced trajectory, times and all), is the player's along-path
// position clear AT THE MOMENT the player is actually there? This threads
// time-gaps the static test forbids while keeping a comfort margin so a
// slightly-off prediction can't clip the player.

// The arrival-time temporal model (SampleLane / Build / PathClear) now lives in
// the shared Core::Temporal module (plan 72) — the immediate solver here and the
// worker pathfinder call the SAME implementation. The solver builds its context
// culling relative to the PLAYER (kUTemporalCullTiles); the query is PathClear
// (walk straight to a point and hold). See UDodgeCore.{h,cpp}.

// Normalized TEMPORAL DURABILITY of a candidate, in [0,1] — the score gradient
// that replaced the flat weave bonus's monopoly on temporal information (see
// kSolveDurableW). `timeToDangerMs` is Core::Temporal::TimeToDanger's answer for
// the walk-then-hold that admission already judged; the scale runs from the dwell
// window every admitted candidate clears (0) to the full horizon (1).
//
// `evidenceMs` is Core::Temporal::EvidenceHorizonMs — the point past which the
// context stops being evidence for every lane. This is what keeps Ctx::trust's
// honest freeze from INFLATING the score: past a truncated lane's trusted end the
// query falls back to "the whole traced path is dangerous", which is the right
// ADMISSION answer but says nothing about where that shot goes next, so a cell
// merely clear of the traced path must NOT read as "clear for 800 ms". Capping
// here can only LOWER a durability, never raise one, so when a lane goes blind the
// gradient quietly flattens toward 0 and the other terms decide — it degrades to
// the pre-gradient behaviour rather than to a confident wrong answer.
static_assert(Core::Temporal::kHorizonMs > kUDwellMs,
              "durability normalizes over the horizon PAST the dwell window — that span must be positive");
float Durability(float timeToDangerMs, float evidenceMs)
{
    const float t = std::min(timeToDangerMs, evidenceMs);
    return std::clamp((t - kUDwellMs) / (Core::Temporal::kHorizonMs - kUDwellMs), 0.f, 1.f);
}

// A durable TEMPORAL pocket: occupiable, off enemy bodies, and temporally clear
// (path + hold) over the horizon. For the STAND point we additionally require it
// be spatially safe RIGHT NOW (the conservative floor: never "hold" on a spot a
// bullet is currently inside), so temporal only ever makes us hold LESS, never
// more, than the instantaneous safety guarantees.
bool IsDurablePocketTemporal(const MapInput& in, const Core::Temporal::Ctx& ctx, Vec2 p, bool isStand)
{
    const bool walkable = CanOccupyAt(in, p);
    if (!walkable) return false;
    if (EnemyBlocked(in, p)) return false;
    if (isStand && Core::PointSafety(in, p) < kULatencyPad) return false;   // safe-now floor
    // A durable pocket must be clear of ACTIVE AoE discs. The isStand floor above
    // already covers this for a STAND (PointSafety subtracts active zones), but a
    // non-stand pocket goal would otherwise be validated by the zone-blind
    // Temporal alone and could sit inside a live blast. SWEPT along the same
    // straight walk PathClear models below — the endpoint test let a ~1.9-tile step
    // cross a 1-tile disc with both ends clear.
    if (!Core::ZonePathClear(in, in.player, p)) return false;
    // DWELL HORIZON: a STAND is the one query where "the player is still standing
    // there later" is literally true and worth knowing — judging it over the FULL
    // horizon is how a slow-closing wall gets us pre-positioning early (plan 95).
    // A pocket/goal we merely intend to WALK to is re-solved and re-validated long
    // before the horizon runs out, so it only has to hold up for kUDwellMs past
    // arrival; demanding the full horizon there is what made the dodge refuse to
    // enter shot-wall rooms it is supposed to weave through.
    const float dwellMs = isStand ? Core::Temporal::kHorizonMs : kUDwellMs;
    return Core::Temporal::PathClear(ctx, in.player, in.speed, p, dwellMs);
}

} // namespace

void Solve(const MapInput& in, float moveBudgetTiles, const Goal& goal,
           const Path::PlanResult& route, CoreState& state, SolveResult& out)
{
    out = SolveResult{};
    if (!in.map) { out.kind = SolveKind::Hold; return; }
    if (in.movementLocked || !std::isfinite(in.speed) || in.speed <= 0.f) {
        out.kind = SolveKind::Surrounded;
        out.target = in.player;
        out.clearance = Core::PointSafety(in, in.player);
        return; // Do not announce a reachable dodge while unable to move.
    }

    const float b = std::max(moveBudgetTiles, 1e-3f);

    // Committed heading from the last tick — the directional-continuity memory the
    // reflex scores AND the route-step anti-oscillation guard reads (plan: smoothing).
    const Vec2 prevDir = state.lastMoveDir;

    // ── Temporal lookahead: nearest pocket safe over the next N ticks ────────
    // Predict every relevant bullet's trajectory (reusing the traced polyline),
    // then find the nearest cell where the STRAIGHT walk to it — and holding
    // there — dodges the moving bullets in TIME. This threads gaps the static
    // whole-path test cannot, and it drives the pre-positioning below.
    static thread_local Core::Temporal::Ctx ctx;
    Core::Temporal::Build(*in.map, in.settings.hitScale, in.settings.positionUncertainty,
                          in.player, kUTemporalCullTiles, ctx);
    out.tempLanes = static_cast<uint16_t>(ctx.count);
    // How far into the horizon this context is EVIDENCE for every lane. Computed
    // once per solve (one int compare per lane), consumed only by the durability
    // gradient — see Durability() for why a blind tail must not score as durable.
    const float tEvidence = Core::Temporal::EvidenceHorizonMs(ctx);

    // ── HOLD gate: is the current spot a DURABLE temporal pocket? ────────────
    // Safe right now AND no bullet will sweep through it over the horizon. If a
    // wall is closing (a bullet WILL arrive) the stand is not durable, so we plan
    // a route out instead of waiting. This is the immediate-reflex floor for the
    // stand: temporal only ever makes us hold LESS than instantaneous safety.
    const bool standDurable = IsDurablePocketTemporal(in, ctx, in.player, true);

    // ── Grid route from the WORKER thread (lookahead direction / goal bias) ──
    // The bounded grid Dijkstra that routes AROUND obstacles to the nearest
    // durable-safe cell (with radius expansion + in-range-disk gating) runs
    // ASYNC on the worker; here we only CONSUME its latest plain-data result. It
    // supersedes the straight-line pocket search for choosing the lookahead
    // target, but it is advisory: the immediate micro-dodge below stays the hard
    // safety floor and re-validates the actual step taken temporally, so a stale
    // route can never cost us a hit. When the worker is cold / the route is too
    // stale the caller passes found=false and this is a pure immediate dodge.
    const bool lockedDisk = goal.fromLock && goal.maxRange > 0.f;
    out.inRangeDisk = lockedDisk;
    out.outOfRange  = route.outOfRange;

    // Route diagnostics (target selection is the grid route, not the ring pocket).
    const bool  pocketFound = route.found;
    const Vec2  pocketPos   = route.stepTarget;   // reflex candidate + fallback bias point
    out.pocketDist    = route.found ? route.goalDist : 0.f;
    out.routeWaypoints = static_cast<uint8_t>(std::min(route.waypoints, 255));
    out.routeExpanded  = route.expanded;
    out.routePops      = static_cast<uint16_t>(std::min(route.pops, 65535));
    out.routeRadius    = static_cast<uint8_t>(std::min(route.radiusCells, 255));

    Cand cands[kMaxCandidates];
    const int n = BuildCandidates(in, b, goal, pocketFound, pocketPos, cands);
    // Nearby bodies for the general standoff score (kSolveStandoffW) — built once
    // per solve, not per candidate.
    StandoffSet standoff;
    BuildStandoffSet(in, goal, b, standoff);
    Evaluate(in, standoff, cands, n);

    // A commanded walk-to route owns direction whenever its immediate corridor
    // step is fully safe. Previously this direct step was attempted only when
    // the CURRENT stand was durable. If a future lane made standing non-durable,
    // the generic nearest-pocket route won first and could send the player away
    // from a perfectly safe navigation corridor, producing visible back-and-
    // forth pacing (cyan route correct, yellow decision pointing elsewhere).
    //
    // This remains fail-closed: the exact step must pass every hard floor used
    // by movement below. Only an unsafe corridor step yields to dodge routing.
    if (goal.walkTo && goal.active &&
        Len(Sub(in.player, goal.pos)) > kUNavAnchorArriveTiles) {
        const Vec2  to = Sub(goal.pos, in.player);
        const float d  = Len(to);
        if (d > 1e-4f) {
            const Vec2 dir    = Mul(to, 1.f / d);
            const Vec2 target = Add(in.player, Mul(dir, std::min(d, b)));
            if (CanOccupyAt(in, target) &&
                OccupancyPathClear(in, in.player, target) &&
                !Core::EnemyPathBlocked(in, in.player, target) &&
                Core::ZonePathClear(in, in.player, target) &&
                Core::Temporal::PathClear(ctx, in.player, in.speed, target)) {
                out.kind          = SolveKind::Safe;
                out.target        = target;
                out.clearance     = Core::PointSafety(in, target);
                out.pendingCost   = Core::PendingZoneCost(in, target);
                out.shouldMove    = true;
                out.followedRoute = true;
                state.lastMoveDir = dir;
                state.dampStreak  = 0;
                return;
            }
        }
    }

    // ── Hold ONLY when the current spot is a DURABLE temporal pocket ─────────
    // The ONE exception: a boss lock drifted OUTSIDE weapon range repositions inward.
    if (standDurable) {
        bool repositionInward = false;
        if (goal.fromLock && goal.maxRange > 0.f)
            repositionInward = Len(Sub(in.player, goal.lockPos))
                               > goal.maxRange + kUReturnRangeSlack;   // hysteresis: only re-close past a small band
        // Shift+Click walk-to: keep progressing toward the commanded spot even when
        // the stand is safe (the user told us to go somewhere). Falls through to the
        // safe-set reflex below, which the goal-progress score (kSolveGoalW) steers
        // toward goal.pos one budget at a time. Safety is unchanged — only SAFE
        // candidates are considered, so this never walks into a shot.
        bool repositionToward = false;
        if (goal.walkTo && goal.active)
            repositionToward = Len(Sub(in.player, goal.pos)) > kUNavAnchorArriveTiles;
        // FINDING G-2: don't HOLD under a telegraphed blast. The stand can be a
        // perfectly durable temporal pocket (Temporal is lane-only and a pending
        // disc is not danger yet) and we would sit in the bomb's dead centre until
        // its arm window opened, then have to flee at ~0.9 s — churn, and the route
        // we spent a tick planning thrown away. This does NOT force a move: it only
        // declines the early Hold return so the normal reflex runs, where the
        // pending SCORE term (kSolvePendingW) drifts us out among SAFE candidates —
        // and re-picks the stand anyway if nothing better exists. Soft, as documented.
        const bool repositionOffTelegraph = Core::PendingZoneCost(in, in.player) > 0.f;
        // Don't HOLD while sitting ON a mob (the general standoff). Identical shape
        // to the telegraph decline above and for the same reason: the stand can be a
        // perfectly durable temporal pocket while the player is parked on a boss
        // body, and the kSolveStandoffW score can only act on candidates that are
        // actually SCORED — this early return never reaches them. It does NOT force
        // a move: it only declines the early Hold so the reflex runs, drifts us out
        // among SAFE candidates, and re-picks the stand anyway when nothing better
        // exists. cands[0] is the stand point; its gap came from Evaluate. The
        // LOCKED body counts here (standoff.lockGap) even though it is kept out of
        // the scored set: once the reflex runs it is the ANNULUS (kSolveInnerW) that
        // pulls us back out, which is exactly the right term for a lock — the two
        // still never penalise the same body twice.
        const bool repositionOffEnemy =
            std::min(cands[0].enemyGap, standoff.lockGap) < kSolveStandoffHoldGap;
        out.leftTelegraph = repositionOffTelegraph &&
                            !repositionInward && !repositionToward;
        if (!repositionInward && !repositionToward && !repositionOffTelegraph &&
            !repositionOffEnemy) {
            out.kind = SolveKind::Hold;
            out.target = in.player;
            // standDurable is PathClear over the FULL horizon, so by definition
            // nothing reaches the stand inside it — the top of the gradient.
            out.targetDurability = 1.f;
            out.clearance = cands[0].clr;
            out.pendingCost = cands[0].soft;
            out.shouldMove = false;
            // Keep lastMoveDir across a brief hold so a re-triggered dodge commits to
            // the same heading instead of flipping (plan 94). It is naturally refreshed
            // when the next move is chosen; only a genuine direction change overwrites
            // it. The Hold still returns shouldMove=false / target=player — only the
            // heading MEMORY persists, consumed by the next dodge's scoring.
            state.dampStreak = 0;     // a hold ends a route-damp run, but heading memory persists
            return;
        }

    }

    // ── Pre-position: step along the grid route toward the safe area ─────────
    // The stand is not durable but a route to a safe area exists. Step ≈ one
    // budget along the route (the curve around the obstacle the straight-line
    // solver cannot make). The IMMEDIATE FLOOR: validate the actual step taken
    // with the temporal check — if the straight step to stepTarget would eat a
    // shot in TIME, reject it and fall through to the conservative spatial reflex
    // so the route never costs us a hit. Occupancy is hard (walls/enemies).
    if (route.found && !standDurable) {
        Vec2  to = Sub(route.stepTarget, in.player);
        float d = Len(to);
        if (d > 1e-4f) {
            Vec2  dir = Mul(to, 1.f / d);
            bool engagementDirect = false;

            // Combat routes are replaced every server tick. If their first step
            // points away from the lock while a direct one-budget engagement step
            // is safe RIGHT NOW, take the short MPC step and re-evaluate next tick
            // instead of faithfully consuming stale outward runway. The direct
            // option passes the same hard floors as the route below; pathfinding
            // remains the fallback around walls or temporally closed shot lanes.
            if (goal.fromLock && goal.active) {
                const Vec2 goalVec = Sub(goal.pos, in.player);
                const float goalDist = Len(goalVec);
                if (goalDist > 1e-4f) {
                    const Vec2 directDir = Mul(goalVec, 1.f / goalDist);
                    const Vec2 directTarget = Add(in.player, Mul(directDir, std::min(goalDist, b)));
                    const Vec2 routeTarget = Add(in.player, Mul(dir, std::min(d, b)));
                    const bool improvesEngagement =
                        Len(Sub(directTarget, goal.pos)) + 0.05f < Len(Sub(routeTarget, goal.pos));
                    const bool directWalkable = CanOccupyAt(in, directTarget);
                    if (improvesEngagement && directWalkable &&
                        OccupancyPathClear(in, in.player, directTarget) &&
                        !Core::EnemyPathBlocked(in, in.player, directTarget) &&
                        Core::ZonePathClear(in, in.player, directTarget) &&
                        Core::Temporal::PathClear(ctx, in.player, in.speed, directTarget)) {
                        to = Sub(directTarget, in.player);
                        d = Len(to);
                        dir = directDir;
                        engagementDirect = true;
                    }
                }
            }
            out.routeStepDot = LenSq(prevDir) > 1e-6f ? Dot(dir, prevDir) : 1.f;

            // ── Anti-oscillation (movement smoothing) ────────────────────────────
            // A worker republish can FLIP the route's first-step direction when it
            // toggles between two near-equal durable-safe goals; consuming that raw
            // jerks the player back and forth. Two branches damp it (plan 76):
            //   • HARD reversal (>105°, Dot < kURouteReverseDot): always eligible.
            //   • SOFT toggle (>60°, Dot < 0.5): the ~90° left/right flip — eligible
            //     only while we have not been damping too long (dampStreak cap), so a
            //     genuine required turn is never delayed indefinitely.
            // In either case we keep the committed heading ONLY if continuing it is
            // ITSELF still walkable, enemy-free and temporally clear — the continuation
            // passes the SAME hard floor as the route step, so a reversal safety truly
            // needs is never damped away. Safety stays authoritative.
            if (!engagementDirect && LenSq(prevDir) > 1e-6f) {
                const float dp = Dot(dir, prevDir);
                const bool hardReversal = dp < kURouteReverseDot;
                const bool softToggle   = dp < 0.5f && state.dampStreak < kUMaxDampTicks;
                if (hardReversal || softToggle) {
                    const Vec2 contTarget = Add(in.player, Mul(prevDir, b));
                    const bool contWalkable = CanOccupyAt(in, contTarget);
                    if (contWalkable && OccupancyPathClear(in, in.player, contTarget) &&
                        !Core::EnemyPathBlocked(in, in.player, contTarget) &&
                        Core::ZonePathClear(in, in.player, contTarget) &&   // never hold a heading INTO or THROUGH a live blast
                        Core::Temporal::PathClear(ctx, in.player, in.speed, contTarget)) {
                        dir = prevDir;
                        to  = Sub(contTarget, in.player);
                        d   = Len(to);
                        out.routeDamped = true;
                    }
                }
            }

            const float r = std::min(d, b);
            const Vec2  target = Add(in.player, Mul(dir, r));
            const bool  walkable = CanOccupyAt(in, target);
            if (walkable && OccupancyPathClear(in, in.player, target) &&
                !Core::EnemyPathBlocked(in, in.player, target) &&  // enemy bodies, SWEPT (finding J)
                Core::ZonePathClear(in, in.player, target) &&                     // active-zone hard floor, SWEPT (Temporal is lane-only)
                Core::Temporal::PathClear(ctx, in.player, in.speed, target)) {   // immediate-step temporal floor
                // A safe retreat route used to return before lateral scoring ran.
                // Prefer a sidestep when it survives at least as long as that
                // retreat, with identical swept occupancy/zone/temporal floors.
                Vec2 chosen = target;
                bool lateral = false;
                const Vec2 flow = FlowDir(in);
                if (LenSq(flow) > 1e-6f && std::fabs(Dot(dir, flow)) > 0.7f) {
                    const float routeTtd = Core::Temporal::TimeToDanger(ctx, in.player, in.speed, target);
                    float lateralScore = -kHugeClearance;
                    for (int i = 0; i < n; ++i) {
                        Cand candidate = cands[i];
                        if (candidate.stand || !candidate.pathOk ||
                            std::fabs(Dot(candidate.dir, flow)) > 0.4f ||
                            !Core::ZonePathClear(in, in.player, candidate.pos)) continue;
                        const float ttd = Core::Temporal::TimeToDanger(ctx, in.player, in.speed, candidate.pos);
                        if (!Core::Temporal::DwellClear(in.player, in.speed, candidate.pos, ttd) ||
                            ttd < routeTtd) continue;
                        candidate.dur = Durability(ttd, tEvidence);
                        candidate.clr = std::max(candidate.clr, kUDurablePocketMargin);
                        const float score = ScoreCand(candidate, in.player, goal, flow, prevDir, b);
                        if (score > lateralScore) {
                            lateralScore = score; chosen = candidate.pos; lateral = true;
                        }
                    }
                }
                if (lateral) { dir = Normalize(Sub(chosen, in.player)); out.routeDamped = false; }
                out.kind = SolveKind::Safe;
                out.target = chosen;
                out.clearance = Core::PointSafety(in, chosen);   // spatial clr (may be <0 — time-threaded)
                out.pendingCost = Core::PendingZoneCost(in, chosen);
                out.shouldMove = true;
                out.prePosition = true;
                out.followedRoute = !lateral;
                state.lastMoveDir = dir;
                // Plan 76: count consecutive soft/hard damped ticks; reset when we
                // accept the fresh (undamped) step so the cap only bounds a run of damps.
                state.dampStreak = out.routeDamped
                    ? static_cast<uint8_t>(state.dampStreak + 1) : 0;
                return;
            }
        }
    }

    // ── Conservative reflex: choose AMONG the spatially-SAFE reachable cells ──
    // The instantaneous lane-based floor, unchanged. Runs when the stand is not
    // durable and no temporal pocket is reachable this tick (or a wall blocks the
    // straight path) — never gets less safe than the pre-temporal build.
    const Vec2 flow = FlowDir(in);
    int best = -1;
    float bestScore = -kHugeClearance;
    for (int i = 0; i < n; ++i) {
        // Walls / enemy bodies: hard block, never threaded. SWEPT for the bodies
        // (finding J) — the step itself must not cross a mob, not merely end clear of one.
        if (!cands[i].pathOk) continue;
        // Spatial clearance describes the painted prefix, not the complete
        // prediction. Keep it for scoring, but temporal safety gates EVERY
        // candidate, including points that look clear in the spatial map.
        const bool instSafe = cands[i].safe &&
                              Core::SegmentSafety(in, in.player, cands[i].pos) >= kULatencyPad;
        // Core::ZonePathClear is a HARD FLOOR here, not a refinement. Temporal models
        // BULLET LANES ONLY (Ctx has no zone storage), so PathClear happily returns
        // true for a cell dead-centre in a live blast disc — or for a step that
        // crosses one. Threading a moving bullet is the intended behaviour;
        // "threading" a static AoE disc is not a thing — it is just walking through
        // the bomb. Hence the SWEPT form. Without this floor, an active zone
        // makes instSafe false for EVERY candidate (SegmentSafety starts at the
        // player, who is inside the disc), admission falls entirely onto the
        // zone-blind path, the clr clamp below erases the negative penetration, and
        // the weave reward makes standing still the winning move.
        // Zone floor first (unchanged order): a candidate the live blast already
        // rejects is dropped before the temporal march, which is the expensive part.
        if (!instSafe && !Core::ZonePathClear(in, in.player, cands[i].pos)) continue;
        // One march supplies both the mandatory transit/dwell safety answer
        // and the durability score. A spatial pass cannot override a collision.
        const float ttd = Core::Temporal::TimeToDanger(ctx, in.player, in.speed, cands[i].pos);
        if (!Core::Temporal::DwellClear(in.player, in.speed, cands[i].pos, ttd)) continue;
        const bool tempSafe = !instSafe; // threading classification for scoring only
        // Durability recorded on the candidate itself (not just the scored copy) so
        // the winner can report it — same basis for the stand and for every step.
        cands[i].dur = Durability(ttd, tEvidence);
        // Score: an instantaneously-safe spot keeps its real (high) clearance, so an
        // open pocket still wins WHEN one exists; a time-threaded spot (in a lane now,
        // clear on arrival) is given the durable pocket margin so its negative instantaneous
        // clearance doesn't veto it — it then competes on goal-progress / lateral
        // sidestep / commitment, which is exactly the tight, smart gap-threading.
        Cand sc = cands[i];
        sc.threaded = tempSafe;
        if (tempSafe) sc.clr = std::max(sc.clr, kUDurablePocketMargin);
        const float s = ScoreCand(sc, in.player, goal, flow, prevDir, b);
        // Anti-jitter commitment tiebreak (plan 94): a clearly better SAFE cell is
        // taken outright; two SAFE cells within kSolveReflexHystEps of each other are
        // a near-tie, broken toward the committed heading so the reflex stops toggling
        // left/right between near-equal cells. Only admitted (instSafe/tempSafe)
        // candidates reach here, so this never widens admission or holds a heading
        // into danger — an unsafe committed heading simply is not among the candidates.
        if (best < 0 || s > bestScore + kSolveReflexHystEps) {
            bestScore = s; best = i;                         // clearly better → take it
        } else if (s > bestScore - kSolveReflexHystEps &&    // near-tie …
                   LenSq(prevDir) > 1e-6f && best >= 0 &&
                   Dot(sc.dir, prevDir) > Dot(cands[best].dir, prevDir)) {
            best = i;                                         // … break toward the committed heading
            // keep bestScore (the incumbent's) so a later clearly-better cand still wins
        }
    }

    if (best >= 0) {
        const Cand& w = cands[best];
        out.target = w.pos;
        out.clearance = w.clr;
        out.pendingCost = w.soft;
        out.targetDurability = w.dur;
        if (w.stand || w.moveDist <= 1e-4f) {
            out.kind = SolveKind::Hold;
            out.shouldMove = false;
        } else {
            out.kind = SolveKind::Safe;
            out.shouldMove = true;
            state.lastMoveDir = w.dir;
            state.dampStreak = 0;   // plan 76: conservative reflex step is a fresh commitment
        }
        return;
    }

    // ── Fallback: no safe reachable cell — least-bad, biased toward the gap ──
    // Maximize clearance (max-min-clearance) but bias the step toward the durable
    // pocket so we head for the gap, not a dead end. Clearance still leads so we
    // never step into materially worse danger just to chase the pocket.
    const float standClr = Core::PointSafety(in, in.player);
    const float playerToPocket = pocketFound ? Len(Sub(in.player, pocketPos)) : 0.f;
    int best2 = -1;
    float best2Val = -kHugeClearance;
    float best2Time = -1.f;
    const float standTime = Core::Temporal::TimeToDanger(ctx, in.player, in.speed,
                                                       in.player, kUDwellMs);
    for (int i = 0; i < n; ++i) {
        // Endpoint rule ON PURPOSE here (finding J): this is the surround-escape
        // path, reached only when nothing is safe. An enemy body is an intent-level
        // no-go, not a physical wall, so the swept rule must not be allowed to
        // shrink the set of ways out when the player is already boxed in.
        if (!cands[i].occOk) continue;
        if (!OccupancyPathClear(in, in.player, cands[i].pos) ||
            !Core::ZoneEscapePathClear(in, in.player, cands[i].pos)) continue;
        const float safeTime = Core::Temporal::TimeToDanger(ctx, in.player, in.speed,
                                                          cands[i].pos, kUDwellMs);
        float val = cands[i].clr;
        if (pocketFound) {
            const float prog = playerToPocket - Len(Sub(cands[i].pos, pocketPos));
            val += kSolveFallbackPocketW * prog;
        }
        if (route.retreatValid) {
            const float backProg = Len(Sub(in.player, route.retreatPos)) -
                                   Len(Sub(cands[i].pos, route.retreatPos));
            val += kSolveFallbackBackW * backProg;
        }
        // Avoid an earlier projectile collision before optimizing destination
        // clearance. If every path is already exposed, geometry still selects
        // progress out instead of freezing inside the threat.
        if (safeTime > best2Time || (safeTime == best2Time && val > best2Val)) {
            best2Time = safeTime;
            best2Val = val;
            best2 = i;
        }
    }

    if (best2 >= 0) {
        const Cand& w = cands[best2];
        // Move only if it actually helps: strictly higher clearance than standing,
        // OR it steps toward the route's gap without dropping clearance meaningfully.
        const float progToward = pocketFound
            ? playerToPocket - Len(Sub(w.pos, pocketPos)) : 0.f;
        const float backProg = route.retreatValid
            ? Len(Sub(in.player, route.retreatPos)) - Len(Sub(w.pos, route.retreatPos)) : 0.f;
        const bool helps = best2Time > standTime || w.clr > standClr + 1e-3f ||
                           (pocketFound && progToward > 1e-3f &&
                            w.clr >= standClr - kUDurablePocketMargin) ||
                           (route.retreatValid && backProg > 1e-3f &&
                            w.clr >= standClr - kUDurablePocketMargin);
        if (helps && w.moveDist > 1e-4f) {
            out.kind = SolveKind::Fallback;
            out.target = w.pos;
            out.clearance = w.clr;
            out.pendingCost = w.soft;
            out.shouldMove = true;
            out.prePosition = pocketFound && !standDurable;
            out.followedRoute = pocketFound && route.waypoints > 2;
            if (LenSq(w.dir) > 1e-6f) state.lastMoveDir = w.dir;
            state.dampStreak = 0;   // plan 76: least-bad fallback step is a fresh commitment
            return;
        }
    }

    // Nowhere reachable improves on standing still → hold and say so honestly.
    out.kind = SolveKind::Surrounded;
    out.target = in.player;
    out.clearance = standClr;
    out.pendingCost = Core::PendingZoneCost(in, in.player);
    out.shouldMove = false;
}

bool RevalidateAndSolve(const MapInput& in, float moveBudgetTiles, const Goal& goal,
                        const Path::PlanResult& route, CoreState& state,
                        SolveResult& committed, bool mapRebuilt)
{
    if (!in.map) return false;
    if (in.movementLocked || !std::isfinite(in.speed) || in.speed <= 0.f) {
        if (!committed.shouldMove) return false;
        Solve(in, moveBudgetTiles, goal, route, state, committed);
        return true;
    }
    // Keep the hot stationary path cheap between map rebuilds. On a new map,
    // even a spatially clear Hold must inspect the new shot's future trajectory.
    const auto decisionClear = [&]() -> bool {
        if (!committed.shouldMove) {
            if (Core::PointSafety(in, in.player) < kULatencyPad) return false;
            if (!mapRebuilt) return true;
        } else {
            const bool enemyClear = committed.kind == SolveKind::Fallback
                ? !Core::EnemyBlocked(in, committed.target)
                : !Core::EnemyPathBlocked(in, in.player, committed.target);
            if (!enemyClear || !OccupancyPathClear(in, in.player, committed.target) ||
                !Core::ZonePathClear(in, in.player, committed.target)) return false;
        }
        // Never approve a moving target solely from the shorter painted lane.
        static thread_local Core::Temporal::Ctx ctx;
        Core::Temporal::Build(*in.map, in.settings.hitScale, in.settings.positionUncertainty,
                              in.player, kUTemporalCullTiles, ctx);
        const Vec2 target = committed.shouldMove ? committed.target : in.player;
        const float dwell = committed.shouldMove ? kUDwellMs : Core::Temporal::kHorizonMs;
        return Core::Temporal::PathClear(ctx, in.player, in.speed, target, dwell);
    };
    if (decisionClear()) return false;
    // A rebuilt map contains the freshest evidence. It does not imply a solve
    // occurred: the worker may still be processing an older snapshot.
    Solve(in, moveBudgetTiles, goal, route, state, committed);
    return true;
}

} } // namespace UDodge::Solver
