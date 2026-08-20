#include "pch-il2cpp.h"
#include "UDodgeCore.h"
#include "UDodgeField.h"

#include <algorithm>
#include <cmath>

namespace UDodge { namespace Core {
namespace {

// Min Euclidean distance from point q to segment a→b. Used for AoE zones
// (circles) against a straight player path.
float DistPointSeg(Vec2 q, Vec2 a, Vec2 b)
{
    const Vec2 ab = Sub(b, a);
    const float d = LenSq(ab);
    const float t = d > 1e-6f ? std::clamp(Dot(Sub(q, a), ab) / d, 0.f, 1.f) : 0.f;
    return Len(Sub(q, Add(a, Mul(ab, t))));
}

} // namespace

// ═══════════════════════════════════════════════════════════════════════════
// Instantaneous engine (plan 46) — pure spatial clearance against the
// tick-synced DangerMap. No time dimension anywhere below this line.
// ═══════════════════════════════════════════════════════════════════════════

namespace {

// Context for the instantaneous engine: candidate quality is spatial
// clearance along the step segment, never time.
struct MapCtx {
    const MapInput*  in = nullptr;
    const DangerMap* m  = nullptr;
    float step = 1.f;       // stepTiles (candidate commitment distance)
    float hitScale = 1.f;
    float reactMargin = 0.60f;
    bool  hazardEscape = false;
    Vec2  dirs[kCandidateCount]{};
    float clearance[kCandidateCount]{};   // min hard clearance along segment (tiles)
    float softCost[kCandidateCount]{};    // pending-zone penetration sum (tiles)
    float blockDist[kCandidateCount]{};   // wall-truncation distance (tiles)
    float enemyClear[kCandidateCount]{};
    float hazardExitDist[kCandidateCount]{};  // distance to first off-hazard probe
    bool  valid[kCandidateCount]{};
    int   relevant[kMaxProjectiles]{};    // lane indices that can matter
    int   relevantCount = 0;
    Vec2  probes[kCandidateCount][kCandProbes + 1]{};  // wall-clipped sample points
    int   probeCount[kCandidateCount]{};
};

// Min over the lane polyline of Chebyshev distance from p. A lane is
// dangerous NOW over its whole length — this is the spatial successor of the
// relative-motion CCD.
float LaneDistCheb(const LaneThreat& L, Vec2 p)
{
    if (L.pointCount <= 0) return kHugeClearance;
    if (L.pointCount == 1) return Cheb(L.points[0].x - p.x, L.points[0].y - p.y);
    float best = kHugeClearance;
    for (int j = 0; j + 1 < L.pointCount; ++j) {
        const Vec2 a = L.points[j];
        const Vec2 b = L.points[j + 1];
        best = std::min(best, MinChebOnSegment(a.x - p.x, a.y - p.y,
                                               b.x - p.x, b.y - p.y));
    }
    return best;
}

// How deep the segment a→b cuts into zone z (Euclidean — zones are circles).
// Pass a == b for a point probe.
float ZonePenetration(const ZoneThreat& z, Vec2 a, Vec2 b)
{
    return std::max(0.f, z.radius - DistPointSeg(z.pos, a, b));
}

bool CanOccupy(const MapCtx& c, float x, float y)
{
    if (!c.in->env.canOccupy) return true;
    // While escaping a hazard we stand on, damaging ground is passable transit
    // (only walls block) — otherwise every way out would read as blocked.
    return c.in->env.canOccupy(x, y, c.in->settings.safeWalk && !c.hazardEscape);
}

bool IsHazard(const MapCtx& c, float x, float y)
{
    if (!c.in->env.isHazard) return false;
    return c.in->env.isHazard(x, y);
}

float EnemyClearanceAt(const MapCtx& c, Vec2 p)
{
    float best = kHugeClearance;
    for (int i = 0; i < c.m->enemyCount; ++i) {
        const EnemyBlocker& e = c.m->enemies[i];
        best = std::min(best, Len(Sub(p, e.pos)) - e.radius);
    }
    return best;
}

// Per-lane effective hit half-size (the game's own IsHit threshold).
float HalfOf(const MapCtx& c, const LaneThreat& L)
{
    return std::clamp(L.hitHalf, 0.05f, 2.5f) * c.hitScale;
}

// ── Candidate probe construction (walls / hazards / enemy clearance) ────────
// Sample the step segment player → player + dir × step at kCandProbes equal
// intervals (plus the start point), truncating at the first wall-blocked
// probe. The stand candidate (zero dir) is a single point at the player.
void BuildProbes(MapCtx& c, int cand)
{
    const Vec2 player = c.in->player;
    const Vec2 dir = c.dirs[cand];
    c.probes[cand][0] = player;
    c.probeCount[cand] = 1;
    c.enemyClear[cand] = std::min(c.enemyClear[cand], EnemyClearanceAt(c, player));
    if (c.hazardEscape && !IsHazard(c, player.x, player.y))
        c.hazardExitDist[cand] = 0.f;
    if (LenSq(dir) <= 1e-6f) return;   // stand candidate: single point at player

    for (int i = 1; i <= kCandProbes; ++i) {
        const float f = static_cast<float>(i) / static_cast<float>(kCandProbes);
        const Vec2 p = Add(player, Mul(dir, c.step * f));
        // Enemy proximity is scored separately so it can never veto the only
        // safe escape.
        if (!CanOccupy(c, p.x, p.y)) {
            c.blockDist[cand] = f * c.step;
            if (i == 1) c.valid[cand] = false;   // blocked at the first step
            break;
        }
        c.probes[cand][c.probeCount[cand]++] = p;
        c.enemyClear[cand] = std::min(c.enemyClear[cand], EnemyClearanceAt(c, p));
        if (c.hazardEscape && c.hazardExitDist[cand] >= kHugeClearance &&
            !IsHazard(c, p.x, p.y))
            c.hazardExitDist[cand] = f * c.step;
    }
}

// ── Spatial scoring of one candidate against the whole map ──────────────────
// Hard clearance = min over relevant lanes (probe-sampled, Chebyshev) and
// active zones (exact — the candidate segment is straight). Soft cost = sum
// of pending-zone penetrations. The wall-truncated probe list bounds both.
void ScoreCandidate(MapCtx& c, int cand)
{
    if (!c.valid[cand] || c.probeCount[cand] <= 0) return;
    const int n = c.probeCount[cand];
    const Vec2 segStart = c.probes[cand][0];
    const Vec2 segEnd = c.probes[cand][n - 1];
    for (int r = 0; r < c.relevantCount; ++r) {
        const LaneThreat& L = c.m->lanes[c.relevant[r]];
        const float half = HalfOf(c, L);
        float minDist = kHugeClearance;
        for (int i = 0; i < n; ++i)
            minDist = std::min(minDist, LaneDistCheb(L, c.probes[cand][i]));
        c.clearance[cand] = std::min(c.clearance[cand], minDist - half);
    }
    for (int i = 0; i < c.m->zoneCount; ++i) {
        const ZoneThreat& z = c.m->zones[i];
        if (z.active)
            c.clearance[cand] = std::min(c.clearance[cand],
                DistPointSeg(z.pos, segStart, segEnd) - z.radius);
        else
            c.softCost[cand] += ZonePenetration(z, segStart, segEnd);
    }
}

// ── Corridor clearance (spatial port of CorridorSafety) ─────────────────────
float CorridorClearance(const MapCtx& c, int cand)
{
    const auto capped = [&](int idx) {
        return c.valid[idx] ? std::min(c.clearance[idx], kCorridorCap) : 0.f;
    };
    if (cand == kFieldCandidate) {
        // The field candidate has no compass index; map it to the nearest one
        // and fall through to the compass-corridor math below. The neighbor
        // window then uses the mapped index while capped() for the center
        // uses the mapped compass candidate — the conservative choice.
        const Vec2 d = c.dirs[kFieldCandidate];
        const float ang = std::atan2(d.y, d.x);
        int idx = static_cast<int>(std::lround(ang / kTwoPi * kDirectionCount));
        idx = ((idx % kDirectionCount) + kDirectionCount) % kDirectionCount;
        cand = idx + 1;
    }
    if (cand == kStandCandidate)
        return capped(kStandCandidate) * static_cast<float>(kCorridorNeighbors * 2 + 1);

    float s = capped(cand);
    const int direction = cand - 1;
    for (int gap = 1; gap <= kCorridorNeighbors; ++gap) {
        s += capped(((direction + gap) % kDirectionCount) + 1);
        s += capped(((direction - gap + kDirectionCount) % kDirectionCount) + 1);
    }
    return s;
}

// ── Selection (clearance-lexicographic) ─────────────────────────────────────
// The full quality tuple of one candidate; BetterCandidate is the one
// lexicographic compare every selection path shares.
struct CandKey {
    float bucket    = -kHugeClearance;  // bucketed hard clearance
    float corridor  = -kHugeClearance;
    float soft      = kHugeClearance;   // pending-zone cost (lower wins)
    float clearance = -kHugeClearance;  // raw hard clearance
    float enemy     = -kHugeClearance;
    float dot       = -kHugeClearance;  // intent alignment
};

CandKey KeyOf(const MapCtx& c, int cand, Vec2 intent)
{
    CandKey k;
    k.bucket    = std::floor(std::min(c.clearance[cand], 1.5f) / kClearBucket);
    k.corridor  = CorridorClearance(c, cand);
    k.soft      = c.softCost[cand];
    k.clearance = c.clearance[cand];
    k.enemy     = c.enemyClear[cand];
    k.dot       = Dot(c.dirs[cand], intent);
    return k;
}

bool BetterCandidate(const CandKey& a, const CandKey& b)
{
    if (a.bucket != b.bucket)       return a.bucket > b.bucket;
    if (a.corridor != b.corridor)   return a.corridor > b.corridor;
    if (a.soft != b.soft)           return a.soft < b.soft;
    if (a.clearance != b.clearance) return a.clearance > b.clearance;
    if (a.enemy != b.enemy)         return a.enemy > b.enemy;
    return a.dot > b.dot;
}

// ── Threat flow (plan 63) — anti-flee ───────────────────────────────────────
// Aggregate travel direction of the relevant danger lanes near the player, with
// a coherence measure. Each lane's travel is Normalize(points[last]-points[0])
// (points[0] = live bullet position); near lanes dominate via proximity weight.
// Zones (static discs) have no travel and are omitted (RePP parity). Pure math
// over the plain-data map, O(relevantCount) ≤ 96.
struct ThreatFlow { Vec2 dir{}; float coherence = 0.f; bool has = false; };

ThreatFlow ComputeThreatFlow(const MapCtx& c)
{
    Vec2 sum{}; float total = 0.f;
    for (int r = 0; r < c.relevantCount; ++r) {
        const LaneThreat& L = c.m->lanes[c.relevant[r]];
        if (L.pointCount < 2) continue;
        const Vec2 travel = Normalize(Sub(L.points[L.pointCount - 1], L.points[0]));
        if (LenSq(travel) <= 1e-4f) continue;
        const float standDist = LaneDistCheb(L, c.in->player);   // near lanes dominate
        const float w = 1.f / (1.f + std::max(0.f, standDist));
        sum = Add(sum, Mul(travel, w));
        total += w;
    }
    ThreatFlow f{};
    if (total <= 0.f) return f;
    const float mag = Len(sum);
    f.coherence = std::clamp(mag / total, 0.f, 1.f);
    f.has = mag > 1e-4f;
    f.dir = f.has ? Mul(sum, 1.f / mag) : Vec2{};
    return f;
}

// ── Weighted candidate score (plan 63) — replaces the lexicographic RANKING ──
// Re-ranks ONLY within the already-safety-floored candidate set: rewards
// clearance (safety), goal/WASD alignment, moving PERPENDICULAR to the threat
// flow (a lateral sidestep, not a retreat), and CONTINUING the current heading
// (directional commitment — kills the flip-flop); penalizes pending-zone
// penetration. Every hard-safety filter stays byte-for-byte; this only decides
// which SAFE candidate wins.
float ScoreOf(const MapCtx& c, int cand, Vec2 intent,
              const ThreatFlow& flow, Vec2 prevDir)
{
    if (!c.valid[cand]) return -kHugeClearance;
    const Vec2 d = c.dirs[cand];
    const bool moving = LenSq(d) > 1e-6f;

    float score = std::clamp(c.clearance[cand], -2.f, 4.f) * kUScoreClearW;  // safety
    if (LenSq(intent) > 1e-6f)
        score += Dot(d, intent) * kUScoreIntentW;                            // goal/WASD
    if (flow.has && moving) {                                                // sidestep
        const float parallel = std::fabs(Dot(d, flow.dir));
        score += (1.f - 2.f * parallel) * flow.coherence * kUScorePerpW;
    }
    if (moving && LenSq(prevDir) > 1e-6f)                                     // commitment
        score += Dot(d, prevDir) * kUScoreCommitW;
    score -= c.softCost[cand] * kUScoreSoftW;                                 // pending zones
    return score;
}

int SelectProposed(const MapCtx& c, Vec2 intent, const ThreatFlow& flow, Vec2 prevDir)
{
    int proposed = kStandCandidate;
    float best = ScoreOf(c, kStandCandidate, intent, flow, prevDir);

    // Also considers the field candidate; only the intent candidate is skipped
    // (it is judged by the ladder, not the weighted-score selection).
    for (int cand = 1; cand < kCandidateCount; ++cand) {
        if (cand == kIntentCandidate) continue;
        if (!c.valid[cand]) continue;
        const float s = ScoreOf(c, cand, intent, flow, prevDir);
        if (s > best) {
            best = s;
            proposed = cand;
        }
    }
    return proposed;
}

// Hazard-escape pick: leave damaging ground within the fewest tiles; the
// clearance chain breaks ties inside the same exit-distance bucket.
// (Iterates every candidate and skips !valid, so the field candidate
// competes here too once it exists.)
int SelectHazardEscapeMap(const MapCtx& c, Vec2 intentDir)
{
    constexpr float kExitBucketTiles = 0.3f;
    int choice = kStandCandidate;
    float bestExit = kHugeClearance;
    CandKey best{};
    bool haveBest = false;
    for (int cand = 0; cand < kCandidateCount; ++cand) {
        if (!c.valid[cand]) continue;
        const float exitBucket =
            std::floor(std::min(c.hazardExitDist[cand], c.step) / kExitBucketTiles);
        const CandKey k = KeyOf(c, cand, intentDir);
        const bool better = !haveBest ||
            exitBucket < bestExit ||
            (exitBucket == bestExit && BetterCandidate(k, best));
        if (better) {
            bestExit = exitBucket;
            best = k;
            choice = cand;
            haveBest = true;
        }
    }
    return choice;
}

// ── Speed matching (keep gentle overrides close to the player's own speed) ──
// The scaled step segment (length = step × scale) must be wall-walkable and
// keep hard clearance ≥ c.reactMargin (lanes and active zones alike —
// zero active-zone penetration follows).
bool IsVelocitySafeMap(const MapCtx& c, int cand, float scale)
{
    const Vec2 player = c.in->player;
    const Vec2 dir = c.dirs[cand];
    const float len = c.step * scale;
    Vec2 probes[kCandProbes + 1];
    int n = 0;
    for (int i = 0; i <= kCandProbes; ++i) {
        const float f = static_cast<float>(i) / static_cast<float>(kCandProbes);
        const Vec2 p = Add(player, Mul(dir, len * f));
        if (i > 0 && !CanOccupy(c, p.x, p.y)) return false;
        probes[n++] = p;
    }
    for (int r = 0; r < c.relevantCount; ++r) {
        const LaneThreat& L = c.m->lanes[c.relevant[r]];
        const float half = HalfOf(c, L);
        for (int i = 0; i < n; ++i)
            if (LaneDistCheb(L, probes[i]) - half < c.reactMargin) return false;
    }
    for (int i = 0; i < c.m->zoneCount; ++i) {
        const ZoneThreat& z = c.m->zones[i];
        if (z.active &&
            DistPointSeg(z.pos, probes[0], probes[n - 1]) - z.radius < c.reactMargin)
            return false;
    }
    return true;
}

float SelectAlignedSpeedMap(const MapCtx& c, int cand, Vec2 intentVel, float speed)
{
    float bestScale = 1.f;
    const Vec2 full = Mul(c.dirs[cand], speed);
    float bestDiff = LenSq(Sub(full, intentVel));
    for (int step = 1; step <= 4; ++step) {
        const float scale = static_cast<float>(step) * 0.2f;
        const Vec2 v = Mul(full, scale);
        const float diff = LenSq(Sub(v, intentVel));
        if (diff >= bestDiff || !IsVelocitySafeMap(c, cand, scale)) continue;
        bestDiff = diff;
        bestScale = scale;
    }
    return bestScale;
}

void FinishMap(const MapCtx& c, CoreOutput& out, Vec2 velocity, bool overrideActive,
               int candidate, float speedScale, int threatCount, Decision decision)
{
    out.overrideActive = overrideActive;
    out.velocity = velocity;
    out.candidate = candidate;
    out.speedScale = speedScale;
    out.threatCount = threatCount;
    out.standClearance = c.clearance[kStandCandidate];
    out.decision = decision;
    for (int i = 0; i < kCandidateCount; ++i) {
        out.candidates[i].dir = c.dirs[i];
        out.candidates[i].valid = c.valid[i];
        out.candidates[i].clearance = c.clearance[i];
        out.candidates[i].softCost = c.softCost[i];
        out.candidates[i].blockDist = c.blockDist[i];
    }
}

} // namespace

// ── Field-search goal probe (instantaneous) ─────────────────────────────────
// "Could the player stand at `pos` right now?" — the field search's spatial
// goal test. Enemy bodies deliberately NOT checked (score-only).
bool PointClear(const MapInput& in, Vec2 pos)
{
    if (!in.map) return false;
    if (in.env.canOccupy && !in.env.canOccupy(pos.x, pos.y, in.settings.safeWalk))
        return false;   // wall, or hazard endpoint when safeWalk is on
    const float hitScale = std::clamp(in.settings.hitScale, 0.25f, 2.5f);
    for (int i = 0; i < in.map->laneCount; ++i) {
        const LaneThreat& L = in.map->lanes[i];
        const float half = std::clamp(L.hitHalf, 0.05f, 2.5f) * hitScale;
        if (LaneDistCheb(L, pos) <= half) return false;
    }
    for (int i = 0; i < in.map->zoneCount; ++i) {
        const ZoneThreat& z = in.map->zones[i];
        // Pending (not-yet-landed) zones do NOT block — they are cost-only.
        if (z.active && Len(Sub(z.pos, pos)) <= z.radius) return false;
    }
    return true;
}

void Evaluate(const MapInput& in, CoreState& state, CoreOutput& out)
{
    out = CoreOutput{};
    // Every FinishMap exit must leave the field readout consistent —
    // initialize it up front (FinishMap itself never writes these).
    out.fieldActive = false;
    out.fieldTarget = {};
    if (!in.map) return;

    MapCtx c{};
    c.in = &in;
    c.m = in.map;
    c.step = std::clamp(in.stepTiles, 0.4f, 3.0f);
    c.hitScale = std::clamp(in.settings.hitScale, 0.25f, 2.5f);
    c.reactMargin = std::clamp(in.settings.reactMargin, 0.05f, 2.0f);

    for (int i = 0; i < kDirectionCount; ++i) {
        const float ang = kTwoPi * static_cast<float>(i) / static_cast<float>(kDirectionCount);
        c.dirs[i + 1] = { std::cos(ang), std::sin(ang) };
    }
    c.dirs[kStandCandidate] = {};
    c.dirs[kIntentCandidate] = Normalize(in.intentDir);
    const Vec2 player = in.player;
    const Vec2 intentDir = c.dirs[kIntentCandidate];
    const bool hasIntent = LenSq(intentDir) > 1e-6f;
    const float speed = std::max(0.f, in.speed);
    const Vec2 intentVel = Mul(intentDir, speed);

    for (int i = 0; i < kCandidateCount; ++i) {
        c.clearance[i] = kHugeClearance;
        c.softCost[i] = 0.f;
        c.blockDist[i] = kHugeClearance;
        c.enemyClear[i] = kHugeClearance;
        c.hazardExitDist[i] = kHugeClearance;
        c.valid[i] = true;
    }
    c.valid[kFieldCandidate] = false;   // only real when the field produces a step
    c.dirs[kFieldCandidate] = {};
    c.hazardEscape = in.playerOnHazard && in.settings.safeWalk;

    // ── Relevance pass (spatial) ─────────────────────────────────────────────
    // Intent-segment sample points, reused for the direct test and threat
    // counting (idle intent collapses to the single player point).
    Vec2 intentProbes[kCandProbes + 1];
    int intentProbeCount = 0;
    const int intentSamples = hasIntent ? kCandProbes : 0;
    for (int i = 0; i <= intentSamples; ++i) {
        const float f = static_cast<float>(i) / static_cast<float>(kCandProbes);
        intentProbes[intentProbeCount++] = Add(player, Mul(intentDir, c.step * f));
    }
    const Vec2 intentEnd = Add(player, Mul(intentDir, c.step));

    int directLaneThreats = 0;
    c.relevantCount = 0;
    for (int i = 0; i < c.m->laneCount; ++i) {
        const LaneThreat& L = c.m->lanes[i];
        if (L.pointCount <= 0) continue;
        const float half = HalfOf(c, L);
        const float standDist = LaneDistCheb(L, player);
        if (standDist <= c.step + half + kRelevanceClearance &&
            c.relevantCount < kMaxProjectiles)
            c.relevant[c.relevantCount++] = i;
        // Unify the threat gate with the scoring-relevance threshold above
        // (c.step + half + kRelevanceClearance): any lane worth SCORING must
        // also trip the NoThreat gate, else a relevant-but-not-counted lane
        // returns NoThreat before scoring ever runs.
        float direct = standDist;
        for (int j = 0; j < intentProbeCount && direct > c.step + half + kRelevanceClearance; ++j)
            direct = std::min(direct, LaneDistCheb(L, intentProbes[j]));
        if (direct <= c.step + half + kRelevanceClearance) ++directLaneThreats;
    }

    // ── Threat flow (plan 63): computed once after the relevance pass. Used by
    // the weighted selection score below and published to the debug overlay.
    const ThreatFlow flow = ComputeThreatFlow(c);
    out.flowDir = flow.dir;
    out.flowCoherence = flow.coherence;

    bool directZoneThreat = false;
    for (int i = 0; i < c.m->zoneCount; ++i) {
        const ZoneThreat& z = c.m->zones[i];
        if (z.active) {
            // A live zone is a direct threat when its disc already crowds the
            // player — it is dangerous right now.
            if (Len(Sub(z.pos, player)) - z.radius <= kRelevanceClearance) {
                directZoneThreat = true;
                break;
            }
        } else if (ZonePenetration(z, player, player) > 0.f ||
                   ZonePenetration(z, intentEnd, intentEnd) > 0.f) {
            // Pending zones gate only when we (or the intent endpoint) are
            // actually inside the telegraph — soft danger has no standoff pad.
            directZoneThreat = true;
            break;
        }
    }

    if (directLaneThreats == 0 && !directZoneThreat && !c.hazardEscape) {
        FinishMap(c, out, intentVel, false, state.selectedCandidate, 1.f, 0, Decision::NoThreat);
        return;
    }

    // ── Score every candidate ────────────────────────────────────────────────
    for (int cand = 0; cand < kCandidateCount; ++cand) {
        if (!c.valid[cand]) continue;   // field candidate not installed yet
        BuildProbes(c, cand);
        ScoreCandidate(c, cand);
    }

    // Intent candidate untouched by scoring (no relevant lane / active zone
    // reached it) and not wall-blocked: inherit standing's values so the
    // ladder has a baseline. A wall-blocked intent stays invalid so
    // PreserveSafeIntent doesn't walk into a wall.
    if (c.clearance[kIntentCandidate] >= kHugeClearance && c.valid[kIntentCandidate]) {
        c.clearance[kIntentCandidate] = c.clearance[kStandCandidate];
        c.softCost[kIntentCandidate]  = c.softCost[kStandCandidate];
        c.blockDist[kIntentCandidate] = c.blockDist[kStandCandidate];
        c.valid[kIntentCandidate]     = c.valid[kStandCandidate];
    }

    // Threats = lanes/zones whose stand-or-intent clearance crowds the player.
    int threatCount = 0;
    const bool intentValid = c.valid[kIntentCandidate];
    for (int r = 0; r < c.relevantCount; ++r) {
        const LaneThreat& L = c.m->lanes[c.relevant[r]];
        const float half = HalfOf(c, L);
        const float standClear = LaneDistCheb(L, player) - half;
        float intentClear = kHugeClearance;
        for (int j = 0; j < intentProbeCount; ++j)
            intentClear = std::min(intentClear, LaneDistCheb(L, intentProbes[j]) - half);
        const float effectiveIntent = intentValid ? intentClear : standClear;
        if (std::min(standClear, effectiveIntent) <= kRelevanceClearance) ++threatCount;
    }
    for (int i = 0; i < c.m->zoneCount; ++i) {
        const ZoneThreat& z = c.m->zones[i];
        const float standClear = Len(Sub(z.pos, player)) - z.radius;
        const float intentClear = DistPointSeg(z.pos, player, intentEnd) - z.radius;
        const float effectiveIntent = intentValid ? intentClear : standClear;
        if (std::min(standClear, effectiveIntent) <= kRelevanceClearance) ++threatCount;
    }

    if ((threatCount == 0 && !c.hazardEscape) || speed <= 0.f || in.movementLocked) {
        FinishMap(c, out, intentVel, false, state.selectedCandidate, 1.f, threatCount,
                  (threatCount == 0 && !c.hazardEscape) ? Decision::NoThreat
                                                        : Decision::MovementLocked);
        return;
    }

    // ── Field escape: the ONLY fallback layer (no timed search exists) ──────
    out.fieldActive = false;
    if (in.settings.fieldEscape && speed > 0.f) {
        bool boxedIn = true;   // no compass candidate has safe clearance
        for (int cand = 1; cand <= kDirectionCount; ++cand)
            if (c.valid[cand] && c.clearance[cand] >= c.reactMargin) {
                boxedIn = false;
                break;
            }
        bool hazardStuck = c.hazardEscape;
        if (hazardStuck)
            for (int cand = 0; cand < kCandidateCount; ++cand)
                if (c.valid[cand] && c.hazardExitDist[cand] < kHugeClearance) {
                    hazardStuck = false;
                    break;
                }
        if (boxedIn || hazardStuck) {
            const Field::EscapeResult esc = Field::FindEscape(in);
            if (esc.found) {
                const int fc = kFieldCandidate;
                c.dirs[fc] = esc.firstDir;
                c.valid[fc] = true;
                BuildProbes(c, fc);
                ScoreCandidate(c, fc);
                out.fieldActive = true;
                out.fieldTarget = esc.target;
            }
        }
    }

    // ── Hazard escape: get off damaging ground first, dodging on the way ────
    if (c.hazardEscape) {
        const int choice = SelectHazardEscapeMap(c, intentDir);
        state.selectedCandidate = choice;
        state.selectedTick = in.tickId;
        state.haveTick = true;
        FinishMap(c, out, Mul(c.dirs[choice], speed), true, choice, 1.f,
                  threatCount, Decision::HazardEscape);
        return;
    }

    // Directional-commitment memory (plan 63): the heading committed last frame,
    // used by ScoreOf below to reward continuing it (anti-jitter).
    const Vec2 prevDir = state.lastMoveDir;
    const int proposed = SelectProposed(c, intentDir, flow, prevDir);

    // ── Intent-preservation ladder ───────────────────────────────────────────
    // Wall-blocked intent can't be preserved — fall through to the override
    // path so the core picks a heading that's both danger- and wall-safe.
    if (c.valid[kIntentCandidate] &&
        c.clearance[kIntentCandidate] >= c.reactMargin &&
        c.softCost[kIntentCandidate] == 0.f) {
        state.lastMoveDir = intentDir;   // remember the orbit/goal heading
        FinishMap(c, out, intentVel, false, state.selectedCandidate, 1.f, threatCount,
                  Decision::PreserveSafeIntent);
        return;
    }

    // Emergency ⇔ danger covers where we stand right now.
    const bool emergency = c.clearance[kStandCandidate] <= 0.f;
    int choice = proposed;
    Decision decision = emergency ? Decision::EmergencyOverride : Decision::GentleOverride;

    if (!emergency) {
        // Not urgent: among all fully-safe candidates, pick the best weighted
        // score (perp-sidestep + commitment + intent). The clearance floor is
        // unchanged, so this only re-ranks the ALREADY-SAFE set. (Iterates every
        // candidate and skips !valid — the field candidate, once real, competes.)
        float bestScore = -kHugeClearance;
        for (int cand = 0; cand < kCandidateCount; ++cand) {
            if (!c.valid[cand] || c.clearance[cand] < c.reactMargin) continue;
            const float s = ScoreOf(c, cand, intentDir, flow, prevDir);
            if (s > bestScore) { bestScore = s; choice = cand; }
        }
        if (choice != proposed) decision = Decision::GentleManualBlend;
    } else if (hasIntent && c.clearance[proposed] >= c.reactMargin) {
        // Survival is achievable: allow a slightly-worse-but-still-safe
        // candidate that better matches intent/sidestep/commitment.
        const float acceptable =
            std::max(c.reactMargin, c.clearance[proposed] - kEmergencyIntentBand);
        float bestScore = -kHugeClearance;
        for (int cand = 0; cand < kCandidateCount; ++cand) {
            if (!c.valid[cand] || c.clearance[cand] < acceptable) continue;
            const float s = ScoreOf(c, cand, intentDir, flow, prevDir);
            if (s > bestScore) { bestScore = s; choice = cand; }
        }
        if (choice != proposed) decision = Decision::EmergencyManualBlend;
    } else if (hasIntent) {
        // A hit may be unavoidable: trade only within a tight clearance band.
        const float acceptableClearance =
            c.clearance[proposed] - kUnavoidableClearanceBand;
        float bestScore = -kHugeClearance;
        for (int cand = 0; cand < kCandidateCount; ++cand) {
            if (!c.valid[cand] || c.clearance[cand] < acceptableClearance) continue;
            const float s = ScoreOf(c, cand, intentDir, flow, prevDir);
            if (s > bestScore) { bestScore = s; choice = cand; }
        }
        if (choice != proposed) decision = Decision::UnavoidableManualBlend;
    }

    // ── Directional-commitment hysteresis (plan 63): keep the heading committed
    // last frame across ticks unless it went unsafe or a new pick clearly beats
    // it by more than the score deadband. Dropping the per-tick gate makes the
    // commitment persist; the clearance[held] >= reactMargin guard still forces
    // an immediate switch the instant the held heading becomes unsafe. ────────
    const int held = state.selectedCandidate;
    if (held != choice && c.valid[held] &&
        LenSq(c.dirs[held]) > 1e-6f &&
        c.clearance[held] >= c.reactMargin &&
        ScoreOf(c, held, intentDir, flow, prevDir)
            >= ScoreOf(c, choice, intentDir, flow, prevDir) - kUScoreDeadband) {
        choice = held;
    } else {
        state.selectedCandidate = choice;
    }
    state.selectedTick = in.tickId; state.haveTick = true;

    float speedScale = 1.f;
    if (in.settings.speedScale && choice != kStandCandidate &&
        c.clearance[choice] >= c.reactMargin)
        speedScale = SelectAlignedSpeedMap(c, choice, intentVel, speed);

    // Invariant: an override must never emit a zero move when SOME escape
    // exists. If the chosen override direction is degenerate (stand), re-pick
    // the best MOVING candidate by the shared clearance ladder — biased to the
    // field escape when one is active — so "emergency + any escape ⇒ a real
    // move" always holds. Only when no valid moving candidate exists at all does
    // choice stay stand (genuinely nowhere to move).
    if (LenSq(c.dirs[choice]) < 1e-6f) {
        int moving = -1;
        float bestMoving = -kHugeClearance;
        for (int cand = 0; cand < kCandidateCount; ++cand) {
            if (!c.valid[cand] || LenSq(c.dirs[cand]) < 1e-6f) continue;
            const float s = ScoreOf(c, cand, intentDir, flow, prevDir);
            if (moving < 0 || s > bestMoving) {
                bestMoving = s;
                moving = cand;
            }
        }
        if (out.fieldActive && c.valid[kFieldCandidate] &&
            LenSq(c.dirs[kFieldCandidate]) > 1e-6f)
            moving = kFieldCandidate;
        if (moving >= 0) {
            choice = moving;
            state.selectedCandidate = choice;
        }
    }

    // A pure survival win by the field candidate is a field escape; a blend
    // that happens to pick it keeps its blend decision.
    if (choice == kFieldCandidate &&
        (decision == Decision::GentleOverride || decision == Decision::EmergencyOverride))
        decision = Decision::FieldEscape;

    // Remember the committed heading for next-frame directional commitment.
    state.lastMoveDir = Normalize(c.dirs[choice]);

    FinishMap(c, out, Mul(c.dirs[choice], speed * speedScale), true, choice, speedScale,
              threatCount, decision);
}

} } // namespace UDodge::Core
