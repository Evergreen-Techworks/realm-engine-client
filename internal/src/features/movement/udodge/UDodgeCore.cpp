#include "pch-il2cpp.h"
#include "UDodgeCore.h"
#include "UDodgeField.h"

#include <algorithm>
#include <cmath>

namespace UDodge { namespace Core {
namespace {

// ── Layer-2 escape-search budgets ────────────────────────────────────────────
constexpr int   kSearchSeeds     = 12;    // straight headings the search expands
constexpr int   kSearchDepth     = 3;     // heading segments (1 straight + 2 re-decisions)
constexpr int   kSearchBudget    = 1500;  // max segment sweeps per frame
constexpr float kMinSegmentMs    = 60.f;  // never re-decide more often than this
constexpr float kBranchBackoffMs = 45.f;  // re-decide this long before the predicted hit
constexpr int   kDepth1Dirs      = 16;    // second-segment headings (+ stand)
constexpr int   kDepth2Dirs      = 8;     // third-segment headings (+ stand)

// PointDwellClear timing pad (RePP value): threat samples within ±pad of the
// dwell window still count as hits.
constexpr float kTimingPadMs = 15.f;

struct Ctx {
    const CoreInput* in = nullptr;
    const Snapshot*  sn = nullptr;
    float speed = 0.f;     // tiles/ms
    float lead = 0.f;      // ms
    float horizon = 0.f;   // ms
    float hitScale = 1.f;  // multiplier on each projectile's hit threshold
    bool  hazardEscape = false;           // standing on damaging ground (safeWalk on)
    Vec2  dirs[kCandidateCount]{};
    float score[kCandidateCount]{};       // min clearance over the horizon
    float impactMs[kCandidateCount]{};    // first time clearance reaches zero
    float blockMs[kCandidateCount]{};     // first time the path is unwalkable
    float enemyClear[kCandidateCount]{};
    float hazardExitMs[kCandidateCount]{};// first time the path leaves damaging ground
    bool  valid[kCandidateCount]{};
    int   relevant[kMaxProjectiles]{};
    int   relevantCount = 0;
};

bool CanOccupy(const Ctx& c, float x, float y)
{
    if (!c.in->env.canOccupy) return true;
    // While escaping a hazard we stand on, damaging ground is passable transit
    // (only walls block) — otherwise every way out would read as blocked.
    return c.in->env.canOccupy(x, y, c.in->settings.safeWalk && !c.hazardEscape);
}

bool IsHazard(const Ctx& c, float x, float y)
{
    if (!c.in->env.isHazard) return false;
    return c.in->env.isHazard(x, y);
}

// Per-projectile effective hit half-size (the game's own IsHit threshold).
float HalfOf(const Ctx& c, const ProjectileThreat& p)
{
    return std::clamp(p.hitHalf, 0.05f, 2.5f) * c.hitScale;
}

float EnemyClearanceAt(const Ctx& c, Vec2 p)
{
    float best = kMaxTimeMs;
    for (int i = 0; i < c.sn->enemyCount; ++i) {
        const EnemyBlocker& e = c.sn->enemies[i];
        best = std::min(best, Len(Sub(p, e.pos)) - e.radius);
    }
    return best;
}

// Player position along candidate/heading `dir` at threat-time t (ms from now).
// The command-latency lead is folded in: we plan for where the player will
// actually be when the command takes effect.
Vec2 PlayerAt(const Ctx& c, Vec2 dir, float t)
{
    return Add(c.in->player, Mul(dir, c.speed * (c.lead + t)));
}

// Threat position linearly interpolated at time t inside sample segment j.
Vec2 ThreatLerp(const ProjectileThreat& p, int j, float t)
{
    const float tA = p.sampleTimesMs[j];
    const float tB = p.sampleTimesMs[j + 1];
    const float denom = tB - tA;
    const float f = denom > 1e-4f ? std::clamp((t - tA) / denom, 0.f, 1.f) : 0.f;
    return Add(p.samples[j], Mul(Sub(p.samples[j + 1], p.samples[j]), f));
}

// Min Euclidean distance from point q to segment a→b. Used for lingering AoE
// zones (circles) against a straight player path.
float DistPointSeg(Vec2 q, Vec2 a, Vec2 b)
{
    const Vec2 ab = Sub(b, a);
    const float d = LenSq(ab);
    const float t = d > 1e-6f ? std::clamp(Dot(Sub(q, a), ab) / d, 0.f, 1.f) : 0.f;
    return Len(Sub(q, Add(a, Mul(ab, t))));
}

// ── Relevance pass (which shots can possibly matter this frame) ─────────────
// envelope: could the shot enter the player's reachable set within the horizon?
// direct:   does it threaten the player standing still OR continuing intent?
void ClassifyProjectile(const Ctx& c, const ProjectileThreat& p, Vec2 intentDir,
                        bool& envelopeRelevant, bool& directRelevant)
{
    envelopeRelevant = false;
    directRelevant = false;
    const Vec2 player = c.in->player;
    const float half = HalfOf(c, p);
    const float directPad = half + kRelevanceClearance;

    for (int j = 0; j < p.sampleCount && p.sampleTimesMs[j] <= c.horizon; ++j) {
        const float t = p.sampleTimesMs[j];
        const Vec2 s = p.samples[j];
        if (j == 0) {
            const float reachable = c.speed * (c.lead + t) + half + kRelevanceClearance;
            if (Cheb(s.x - player.x, s.y - player.y) <= reachable) envelopeRelevant = true;
            const Vec2 ip = PlayerAt(c, intentDir, t);
            if (std::min(Cheb(s.x - player.x, s.y - player.y),
                         Cheb(s.x - ip.x, s.y - ip.y)) <= directPad) directRelevant = true;
            continue;
        }
        const float tPrev = p.sampleTimesMs[j - 1];
        const Vec2 sPrev = p.samples[j - 1];
        const float reachable = c.speed * (c.lead + t) + half + kRelevanceClearance;
        if (!envelopeRelevant &&
            MinChebOnSegment(sPrev.x - player.x, sPrev.y - player.y,
                             s.x - player.x, s.y - player.y) <= reachable)
            envelopeRelevant = true;
        if (!directRelevant) {
            const Vec2 ipPrev = PlayerAt(c, intentDir, tPrev);
            const Vec2 ip = PlayerAt(c, intentDir, t);
            const float direct = std::min(
                MinChebOnSegment(sPrev.x - player.x, sPrev.y - player.y,
                                 s.x - player.x, s.y - player.y),
                MinChebOnSegment(sPrev.x - ipPrev.x, sPrev.y - ipPrev.y,
                                 s.x - ip.x, s.y - ip.y));
            if (direct <= directPad) directRelevant = true;
        }
        if (envelopeRelevant && directRelevant) return;
    }
}

// ── Candidate path validation (walls / hazards / enemy clearance) ───────────
void ValidateCandidatePaths(Ctx& c)
{
    c.enemyClear[kStandCandidate] = EnemyClearanceAt(c, c.in->player);
    for (int cand = 1; cand < kCandidateCount; ++cand) {
        if (!c.valid[cand]) continue;   // field candidate not set yet this frame
        for (float t = 0.f; t <= c.horizon; t += kSampleMs) {
            const Vec2 p = PlayerAt(c, c.dirs[cand], t);
            c.enemyClear[cand] = std::min(c.enemyClear[cand], EnemyClearanceAt(c, p));
            if (c.hazardEscape && c.hazardExitMs[cand] >= kMaxTimeMs && !IsHazard(c, p.x, p.y))
                c.hazardExitMs[cand] = t;
            // Enemy proximity is scored separately so it can never veto the
            // only safe escape.
            if (CanOccupy(c, p.x, p.y)) continue;
            c.blockMs[cand] = t;
            c.impactMs[cand] = t;
            if (t <= 0.f) c.valid[cand] = false;
            break;
        }
    }
}

float CorridorSafety(const Ctx& c, int cand);

// Hazard-escape pick: leave damaging ground as fast as possible; survival
// ordering breaks ties inside the same exit-time bucket. (Iterates every
// candidate and skips !valid, so the field candidate competes here too once
// it exists — no change needed for it.)
int SelectHazardEscape(const Ctx& c, Vec2 intentDir)
{
    constexpr float kExitBucketMs = 60.f;
    int choice = kStandCandidate;
    float bestExit = kMaxTimeMs;
    float bestImpact = -1.f, bestCorridor = -1.f, bestScore = -kMaxTimeMs, bestDot = -kMaxTimeMs;
    for (int cand = 0; cand < kCandidateCount; ++cand) {
        if (!c.valid[cand]) continue;
        const float exitBucket = std::floor(std::min(c.hazardExitMs[cand], c.horizon) / kExitBucketMs);
        const float impact = c.impactMs[cand];
        const float corridor = CorridorSafety(c, cand);
        const float score = c.score[cand];
        const float dot = Dot(c.dirs[cand], intentDir);
        const bool better =
            exitBucket < bestExit ||
            (exitBucket == bestExit && impact > bestImpact) ||
            (exitBucket == bestExit && impact == bestImpact && corridor > bestCorridor) ||
            (exitBucket == bestExit && impact == bestImpact && corridor == bestCorridor && score > bestScore) ||
            (exitBucket == bestExit && impact == bestImpact && corridor == bestCorridor && score == bestScore &&
             dot > bestDot);
        if (better) {
            bestExit = exitBucket;
            bestImpact = impact;
            bestCorridor = corridor;
            bestScore = score;
            bestDot = dot;
            choice = cand;
        }
    }
    return choice;
}

// ── Exact CCD scoring of every candidate against one projectile ─────────────
// Both the player (constant velocity) and the projectile (linear between path
// samples) move linearly inside a sample segment, so the relative motion is a
// line segment and the minimum Chebyshev distance has a closed form.
void ScoreProjectile(Ctx& c, const ProjectileThreat& p,
                     float& earliestImpactMs, int& threatCount)
{
    float standingClearance = kMaxTimeMs;
    float intentClearance = kMaxTimeMs;
    const float half = HalfOf(c, p);

    for (int j = 0; j < p.sampleCount; ++j) {
        const bool isPoint = (j == 0);
        float tA, tB;
        Vec2 sA, sB;
        if (isPoint) {
            tA = tB = p.sampleTimesMs[0];
            if (tA > c.horizon) break;
            sA = sB = p.samples[0];
        } else {
            tA = p.sampleTimesMs[j - 1];
            if (tA > c.horizon) break;      // segment starts past the window
            tB = p.sampleTimesMs[j];
            sA = p.samples[j - 1];
            sB = p.samples[j];
            if (tB < tA) continue;
            if (tB > c.horizon) {           // clip the final segment to the horizon
                sB = ThreatLerp(p, j - 1, c.horizon);
                tB = c.horizon;
            }
        }

        for (int cand = 0; cand < kCandidateCount; ++cand) {
            if (!c.valid[cand] || tA >= c.blockMs[cand]) continue;
            const Vec2 pA = PlayerAt(c, c.dirs[cand], tA);
            const Vec2 pB = PlayerAt(c, c.dirs[cand], tB);
            const float clearance = isPoint
                ? Cheb(sA.x - pA.x, sA.y - pA.y) - half
                : MinChebOnSegment(sA.x - pA.x, sA.y - pA.y,
                                   sB.x - pB.x, sB.y - pB.y) - half;
            if (clearance < c.score[cand]) c.score[cand] = clearance;
            if (clearance <= 0.f && tA < c.impactMs[cand]) c.impactMs[cand] = tA;
            if (cand == kStandCandidate) {
                standingClearance = std::min(standingClearance, clearance);
                if (clearance <= 0.f) earliestImpactMs = std::min(earliestImpactMs, tA);
            } else if (cand == kIntentCandidate) {
                intentClearance = std::min(intentClearance, clearance);
                if (clearance <= 0.f) earliestImpactMs = std::min(earliestImpactMs, tA);
            }
        }
    }

    const float effectiveIntent = c.valid[kIntentCandidate] ? intentClearance : standingClearance;
    if (std::min(standingClearance, effectiveIntent) <= kRelevanceClearance) ++threatCount;
}

void ScoreAoes(Ctx& c, float& earliestImpactMs, int& threatCount)
{
    for (int i = 0; i < c.sn->aoeCount; ++i) {
        const AoeThreat& a = c.sn->aoes[i];
        if (a.activeNow) {
            // Lingering zone: the disc blocks for t ∈ [0, min(remainMs, horizon)].
            // Candidate paths are straight segments over that interval, so the
            // exact check is point-to-segment distance (Euclidean — AoEs are
            // circles). Impact time is approximated as 0 when inside: we are,
            // or will be, inside a live zone — maximum urgency.
            const float endT = std::min(a.remainMs, c.horizon);
            if (endT <= 0.f) continue;
            const float centerDist = Len(Sub(a.pos, c.in->player));
            if (centerDist > a.radius + c.speed * (c.lead + endT) + kRelevanceClearance) continue;

            float standingClearance = kMaxTimeMs;
            float intentClearance = kMaxTimeMs;
            for (int cand = 0; cand < kCandidateCount; ++cand) {
                if (!c.valid[cand]) continue;
                const float clearance = DistPointSeg(a.pos, PlayerAt(c, c.dirs[cand], 0.f),
                                                     PlayerAt(c, c.dirs[cand], endT)) - a.radius;
                if (clearance < c.score[cand]) c.score[cand] = clearance;
                if (clearance <= 0.f && 0.f < c.impactMs[cand]) c.impactMs[cand] = 0.f;
                if (cand == kStandCandidate) standingClearance = clearance;
                else if (cand == kIntentCandidate) intentClearance = clearance;
            }
            const float effectiveIntent = c.valid[kIntentCandidate] ? intentClearance : standingClearance;
            if (std::min(standingClearance, effectiveIntent) <= kRelevanceClearance) {
                ++threatCount;
                if (std::min(standingClearance, effectiveIntent) <= 0.f)
                    earliestImpactMs = std::min(earliestImpactMs, 0.f);
            }
            continue;
        }

        const float landing = a.landingMs;
        if (landing <= 0.f || landing > c.horizon) continue;
        const float centerDist = Len(Sub(a.pos, c.in->player));
        if (centerDist > a.radius + c.speed * (c.lead + landing) + kRelevanceClearance) continue;

        float standingClearance = kMaxTimeMs;
        float intentClearance = kMaxTimeMs;
        for (int cand = 0; cand < kCandidateCount; ++cand) {
            if (!c.valid[cand] || landing >= c.blockMs[cand]) continue;
            const Vec2 p = PlayerAt(c, c.dirs[cand], landing);
            const float clearance = Len(Sub(a.pos, p)) - a.radius;
            if (clearance < c.score[cand]) c.score[cand] = clearance;
            if (clearance <= 0.f && landing < c.impactMs[cand]) c.impactMs[cand] = landing;
            if (cand == kStandCandidate) standingClearance = clearance;
            else if (cand == kIntentCandidate) intentClearance = clearance;
        }
        const float effectiveIntent = c.valid[kIntentCandidate] ? intentClearance : standingClearance;
        if (std::min(standingClearance, effectiveIntent) <= kRelevanceClearance) {
            ++threatCount;
            if (std::min(standingClearance, effectiveIntent) <= 0.f)
                earliestImpactMs = std::min(earliestImpactMs, landing);
        }
    }
}

// ── Layer 2: piecewise-heading escape search (receding-horizon) ─────────────
struct SegEval {
    float endMs = 0.f;      // min(first impact, wall, horizon)
    float minClearance = kMaxTimeMs;
};

// Sweep one constant-heading segment from (startPos, t0) until it dies, hits a
// wall, or reaches the horizon. leadSeg carries the command-latency lead for
// the first segment only.
SegEval SweepSegment(const Ctx& c, Vec2 startPos, float t0, Vec2 dir, float leadSeg)
{
    SegEval e{};
    e.endMs = c.horizon;

    const auto posAt = [&](float t) {
        return Add(startPos, Mul(dir, c.speed * ((t - t0) + leadSeg)));
    };

    // Walls / hazards.
    for (float t = t0; t <= e.endMs; t += kSampleMs) {
        const Vec2 p = posAt(t);
        if (!CanOccupy(c, p.x, p.y)) { e.endMs = std::max(t0, t); break; }
    }

    // Projectiles (exact relative-segment CCD, clipped to [t0, endMs]).
    for (int r = 0; r < c.relevantCount; ++r) {
        const ProjectileThreat& p = c.sn->projectiles[c.relevant[r]];
        const float half = HalfOf(c, p);
        for (int j = 0; j + 1 < p.sampleCount; ++j) {
            float tA = p.sampleTimesMs[j];
            float tB = p.sampleTimesMs[j + 1];
            if (tB < tA || tB < t0) continue;
            if (tA > e.endMs) break;
            Vec2 sA = p.samples[j];
            Vec2 sB = p.samples[j + 1];
            if (tA < t0)     { sA = ThreatLerp(p, j, t0);     tA = t0; }
            if (tB > e.endMs){ sB = ThreatLerp(p, j, e.endMs); tB = e.endMs; }
            const Vec2 pA = posAt(tA);
            const Vec2 pB = posAt(tB);
            const float clearance = MinChebOnSegment(sA.x - pA.x, sA.y - pA.y,
                                                     sB.x - pB.x, sB.y - pB.y) - half;
            e.minClearance = std::min(e.minClearance, clearance);
            if (clearance <= 0.f && tA < e.endMs) e.endMs = tA;
        }
        // First-sample point check (segment loop starts at the pair 0→1).
        if (p.sampleCount > 0 && p.sampleTimesMs[0] >= t0 && p.sampleTimesMs[0] <= e.endMs) {
            const Vec2 pp = posAt(p.sampleTimesMs[0]);
            const float clearance = Cheb(p.samples[0].x - pp.x, p.samples[0].y - pp.y) - half;
            e.minClearance = std::min(e.minClearance, clearance);
            if (clearance <= 0.f) e.endMs = std::min(e.endMs, std::max(t0, p.sampleTimesMs[0]));
        }
    }

    // AoE landings (and live zones) inside this segment's window.
    for (int i = 0; i < c.sn->aoeCount; ++i) {
        const AoeThreat& a = c.sn->aoes[i];
        if (a.activeNow) {
            // Live zone blocks its disc over [0, remainMs] ∩ [t0, endMs].
            if (a.remainMs < t0) continue;
            const float clearance = DistPointSeg(a.pos, posAt(std::max(t0, 0.f)),
                                                 posAt(std::min(e.endMs, a.remainMs))) - a.radius;
            e.minClearance = std::min(e.minClearance, clearance);
            if (clearance <= 0.f) e.endMs = t0;   // the segment enters a live zone
            continue;
        }
        if (a.landingMs < t0 || a.landingMs > e.endMs) continue;
        const Vec2 p = posAt(a.landingMs);
        const float clearance = Len(Sub(a.pos, p)) - a.radius;
        e.minClearance = std::min(e.minClearance, clearance);
        if (clearance <= 0.f) e.endMs = std::max(t0, a.landingMs);
    }
    return e;
}

struct SearchResult {
    float survivalMs = 0.f;
    float minClearance = kMaxTimeMs;
};

SearchResult SearchSurvival(const Ctx& c, Vec2 pos, float t0, Vec2 dir,
                            int depth, float leadSeg, int& budget)
{
    SearchResult r{};
    r.survivalMs = t0;
    if (budget <= 0) return r;
    --budget;

    const SegEval e = SweepSegment(c, pos, t0, dir, leadSeg);
    r.survivalMs = e.endMs;
    r.minClearance = e.minClearance;
    if (e.endMs >= c.horizon - 0.5f || depth + 1 >= kSearchDepth) return r;

    const float branchT = e.endMs - kBranchBackoffMs;
    if (branchT < t0 + kMinSegmentMs) return r;
    const Vec2 branchPos = Add(pos, Mul(dir, c.speed * ((branchT - t0) + leadSeg)));

    const int dirCount = depth == 0 ? kDepth1Dirs : kDepth2Dirs;
    for (int d = 0; d <= dirCount && budget > 0; ++d) {
        // d == dirCount is the "wait here" primitive.
        Vec2 nd{};
        if (d < dirCount) {
            const float ang = kTwoPi * static_cast<float>(d) / static_cast<float>(dirCount);
            nd = { std::cos(ang), std::sin(ang) };
        }
        const SearchResult child = SearchSurvival(c, branchPos, branchT, nd, depth + 1, 0.f, budget);
        const float childClr = std::min(e.minClearance, child.minClearance);
        if (child.survivalMs > r.survivalMs ||
            (child.survivalMs == r.survivalMs && childClr > r.minClearance)) {
            r.survivalMs = child.survivalMs;
            r.minClearance = childClr;
        }
        if (r.survivalMs >= c.horizon - 0.5f) break;
    }
    return r;
}

// When no straight heading survives the whole horizon, refine the most
// promising candidates with the multi-segment search. Only the first heading
// is ever committed — the next frame replans (receding horizon). (Runs BEFORE
// the field candidate exists, so it never touches it.)
void RefineWithEscapeSearch(Ctx& c)
{
    float bestStraight = 0.f;
    for (int cand = 0; cand < kCandidateCount; ++cand)
        if (c.valid[cand]) bestStraight = std::max(bestStraight, c.impactMs[cand]);
    if (bestStraight >= c.horizon) return;   // something straight already survives

    // Seed order: candidates by (impact desc, clearance desc).
    int order[kCandidateCount];
    for (int i = 0; i < kCandidateCount; ++i) order[i] = i;
    std::sort(order, order + kCandidateCount, [&](int a, int b) {
        if (c.valid[a] != c.valid[b]) return c.valid[a];
        if (c.impactMs[a] != c.impactMs[b]) return c.impactMs[a] > c.impactMs[b];
        return c.score[a] > c.score[b];
    });

    int budget = kSearchBudget;
    int expanded = 0;
    for (int i = 0; i < kCandidateCount && expanded < kSearchSeeds && budget > 0; ++i) {
        const int cand = order[i];
        if (!c.valid[cand]) break;
        // Never refine stand/intent: their numbers gate the "hand control back"
        // paths, which must mean safe WITHOUT the turns a refinement plans.
        if (cand == kStandCandidate || cand == kIntentCandidate) continue;
        ++expanded;
        const SearchResult r = SearchSurvival(c, c.in->player, 0.f, c.dirs[cand], 0, c.lead, budget);
        if (r.survivalMs > c.impactMs[cand]) {
            c.impactMs[cand] = r.survivalMs;
            // A trajectory that survives the whole horizon (with a planned turn
            // we re-derive every frame) is a real escape: let it qualify for the
            // safe-blend ladder paths and hysteresis.
            if (r.survivalMs >= c.horizon - 0.5f)
                c.score[cand] = std::max(c.score[cand], kIntentSafeClearance + 0.01f);
        }
    }
}

// ── Selection (survival-lexicographic, reference parity) ────────────────────
float CorridorSafety(const Ctx& c, int cand)
{
    const auto cappedImpact = [&](int idx) {
        return c.valid[idx] ? std::min(c.impactMs[idx], c.horizon + kSampleMs) : 0.f;
    };
    if (cand == kFieldCandidate) {
        // The field candidate has no compass index; map it to the nearest one
        // and fall through to the compass-corridor math below. The neighbor
        // window then uses the mapped index while cappedImpact for the center
        // uses the mapped compass candidate — the conservative choice.
        const Vec2 d = c.dirs[kFieldCandidate];
        const float ang = std::atan2(d.y, d.x);
        int idx = static_cast<int>(std::lround(ang / kTwoPi * kDirectionCount));
        idx = ((idx % kDirectionCount) + kDirectionCount) % kDirectionCount;
        cand = idx + 1;
    }
    if (cand == kStandCandidate)
        return cappedImpact(kStandCandidate) * static_cast<float>(kCorridorNeighbors * 2 + 1);

    float s = cappedImpact(cand);
    const int direction = cand - 1;
    for (int gap = 1; gap <= kCorridorNeighbors; ++gap) {
        s += cappedImpact(((direction + gap) % kDirectionCount) + 1);
        s += cappedImpact(((direction - gap + kDirectionCount) % kDirectionCount) + 1);
    }
    return s;
}

int SelectProposedCandidate(const Ctx& c)
{
    int proposed = kStandCandidate;
    float bestScore = c.score[kStandCandidate];
    float bestImpact = c.impactMs[kStandCandidate];
    float bestCorridor = CorridorSafety(c, kStandCandidate);
    float bestEnemy = c.enemyClear[kStandCandidate];
    const Vec2 intent = c.dirs[kIntentCandidate];
    float bestIntentDot = Dot(c.dirs[kStandCandidate], intent);

    // Also considers the field candidate; only the intent candidate is skipped
    // (it is judged by the ladder, not survival selection).
    for (int cand = 1; cand < kCandidateCount; ++cand) {
        if (cand == kIntentCandidate) continue;
        if (!c.valid[cand]) continue;
        const float impact = c.impactMs[cand];
        const float corridor = CorridorSafety(c, cand);
        const float score = c.score[cand];
        const float enemy = c.enemyClear[cand];
        const float intentDot = Dot(c.dirs[cand], intent);
        const bool better =
            impact > bestImpact ||
            (impact == bestImpact && corridor > bestCorridor) ||
            (impact == bestImpact && corridor == bestCorridor && score > bestScore) ||
            (impact == bestImpact && corridor == bestCorridor && score == bestScore && enemy > bestEnemy) ||
            (impact == bestImpact && corridor == bestCorridor && score == bestScore && enemy == bestEnemy &&
             intentDot > bestIntentDot);
        if (better) {
            bestScore = score;
            bestImpact = impact;
            bestCorridor = corridor;
            bestEnemy = enemy;
            bestIntentDot = intentDot;
            proposed = cand;
        }
    }
    return proposed;
}

// ── Speed matching (keep gentle overrides close to the player's own speed) ──
bool IsVelocitySafe(const Ctx& c, Vec2 vel)
{
    for (float t = 0.f; t <= c.horizon; t += kSampleMs) {
        const Vec2 p = Add(c.in->player, Mul(vel, c.lead + t));
        if (!CanOccupy(c, p.x, p.y)) return false;
    }
    for (int i = 0; i < c.sn->aoeCount; ++i) {
        const AoeThreat& a = c.sn->aoes[i];
        if (a.activeNow) {
            // Live zone: the whole dwell inside [0, min(horizon, remainMs)]
            // must stay clear of the disc.
            const float endT = std::min(c.horizon, a.remainMs);
            const Vec2 p0 = Add(c.in->player, Mul(vel, c.lead));
            const Vec2 p1 = Add(c.in->player, Mul(vel, c.lead + endT));
            if (DistPointSeg(a.pos, p0, p1) - a.radius < kIntentSafeClearance) return false;
            continue;
        }
        if (a.landingMs <= 0.f || a.landingMs > c.horizon) continue;
        const Vec2 p = Add(c.in->player, Mul(vel, c.lead + a.landingMs));
        if (Len(Sub(a.pos, p)) - a.radius < kIntentSafeClearance) return false;
    }
    for (int r = 0; r < c.relevantCount; ++r) {
        const ProjectileThreat& p = c.sn->projectiles[c.relevant[r]];
        const float half = HalfOf(c, p);
        for (int j = 0; j < p.sampleCount; ++j) {
            float tB = p.sampleTimesMs[j];
            Vec2 sB = p.samples[j];
            float clearance;
            if (j == 0) {
                if (tB > c.horizon) break;
                const Vec2 pB = Add(c.in->player, Mul(vel, c.lead + tB));
                clearance = Cheb(sB.x - pB.x, sB.y - pB.y) - half;
            } else {
                const float tA = p.sampleTimesMs[j - 1];
                if (tA > c.horizon) break;
                if (tB < tA) continue;
                if (tB > c.horizon) {       // clip the final segment to the horizon
                    sB = ThreatLerp(p, j - 1, c.horizon);
                    tB = c.horizon;
                }
                const Vec2 sA = p.samples[j - 1];
                const Vec2 pA = Add(c.in->player, Mul(vel, c.lead + tA));
                const Vec2 pB = Add(c.in->player, Mul(vel, c.lead + tB));
                clearance = MinChebOnSegment(sA.x - pA.x, sA.y - pA.y,
                                             sB.x - pB.x, sB.y - pB.y) - half;
            }
            if (clearance < kIntentSafeClearance) return false;
        }
    }
    return true;
}

float SelectAlignedSpeed(const Ctx& c, int cand, Vec2 intentVel)
{
    float bestScale = 1.f;
    const Vec2 full = Mul(c.dirs[cand], c.speed);
    float bestDiff = LenSq(Sub(full, intentVel));
    for (int step = 1; step <= 4; ++step) {
        const float scale = static_cast<float>(step) * 0.2f;
        const Vec2 v = Mul(full, scale);
        const float diff = LenSq(Sub(v, intentVel));
        if (diff >= bestDiff || !IsVelocitySafe(c, v)) continue;
        bestDiff = diff;
        bestScale = scale;
    }
    return bestScale;
}

void Finish(const Ctx& c, CoreOutput& out, Vec2 velocity, bool overrideActive,
            int candidate, float speedScale, int threatCount, float earliestImpactMs,
            Decision decision)
{
    out.overrideActive = overrideActive;
    out.velocity = velocity;
    out.candidate = candidate;
    out.speedScale = speedScale;
    out.threatCount = threatCount;
    out.earliestImpactMs = earliestImpactMs;
    out.decision = decision;
    for (int i = 0; i < kCandidateCount; ++i) {
        out.candidates[i].dir = c.dirs[i];
        out.candidates[i].score = c.score[i];
        out.candidates[i].impactMs = c.impactMs[i];
        out.candidates[i].blockMs = c.blockMs[i];
        out.candidates[i].valid = c.valid[i];
    }
}

} // namespace

// ── Field-search goal probe ─────────────────────────────────────────────────
// Port of RePP's endpoint test against the unified snapshot. Enemy bodies are
// deliberately NOT checked — they are score-only in this engine, including
// here (no contact-damage veto).
bool PointDwellClear(const CoreInput& in, Vec2 pos, float arrivalMs, float holdMs)
{
    if (!in.sensors) return false;
    if (in.env.canOccupy && !in.env.canOccupy(pos.x, pos.y, in.settings.safeWalk))
        return false;   // wall, or hazard endpoint when safeWalk is on
    const float lo = std::max(0.f, arrivalMs - kTimingPadMs);
    const float hi = arrivalMs + std::max(holdMs, 0.f) + kTimingPadMs;
    const float hitScale = std::clamp(in.settings.hitScale, 0.25f, 2.5f);
    for (int i = 0; i < in.sensors->projectileCount; ++i) {
        const ProjectileThreat& p = in.sensors->projectiles[i];
        const float half = std::clamp(p.hitHalf, 0.05f, 2.5f) * hitScale;
        for (int j = 0; j < p.sampleCount; ++j) {
            const float tB = p.sampleTimesMs[j];
            if (j == 0) {
                if (tB >= lo && tB <= hi &&
                    Cheb(p.samples[0].x - pos.x, p.samples[0].y - pos.y) <= half) return false;
                continue;
            }
            const float tA = p.sampleTimesMs[j - 1];
            if (tA > hi) break;
            if (tB < lo || tB < tA) continue;
            // Clip the segment to [lo, hi], then point-vs-segment Chebyshev.
            const float denom = std::max(tB - tA, 1e-4f);
            const float fA = std::clamp((std::max(tA, lo) - tA) / denom, 0.f, 1.f);
            const float fB = std::clamp((std::min(tB, hi) - tA) / denom, 0.f, 1.f);
            const Vec2 a = Add(p.samples[j-1], Mul(Sub(p.samples[j], p.samples[j-1]), fA));
            const Vec2 b = Add(p.samples[j-1], Mul(Sub(p.samples[j], p.samples[j-1]), fB));
            if (MinChebOnSegment(a.x - pos.x, a.y - pos.y, b.x - pos.x, b.y - pos.y) <= half)
                return false;
        }
    }
    for (int i = 0; i < in.sensors->aoeCount; ++i) {
        const AoeThreat& a = in.sensors->aoes[i];
        const bool inWindow = a.activeNow ? (lo <= a.remainMs)
                                          : (a.landingMs >= lo && a.landingMs <= hi);
        if (inWindow && Len(Sub(a.pos, pos)) <= a.radius) return false;
    }
    return true;
}

void Evaluate(const CoreInput& in, CoreState& state, CoreOutput& out)
{
    out = CoreOutput{};
    // Every Finish exit must leave the field readout consistent — initialize
    // it up front (Finish itself never writes these).
    out.fieldActive = false;
    out.fieldTarget = {};
    if (!in.sensors) return;

    Ctx c{};
    c.in = &in;
    c.sn = in.sensors;
    c.speed = std::max(0.f, in.moveSpeed);
    c.lead = std::clamp(in.settings.leadMs, 0.f, 250.f);
    c.horizon = std::clamp(in.settings.horizonMs, 200.f, 2000.f);
    c.hitScale = std::clamp(in.settings.hitScale, 0.25f, 2.5f);

    for (int i = 0; i < kDirectionCount; ++i) {
        const float ang = kTwoPi * static_cast<float>(i) / static_cast<float>(kDirectionCount);
        c.dirs[i + 1] = { std::cos(ang), std::sin(ang) };
    }
    c.dirs[kStandCandidate] = {};
    c.dirs[kIntentCandidate] = Normalize(in.intentDir);
    const Vec2 intentDir = c.dirs[kIntentCandidate];
    const bool hasIntent = LenSq(intentDir) > 1e-6f;
    const Vec2 intentVel = Mul(intentDir, c.speed);

    for (int i = 0; i < kCandidateCount; ++i) {
        c.score[i] = kMaxTimeMs;
        c.impactMs[i] = kMaxTimeMs;
        c.blockMs[i] = kMaxTimeMs;
        c.enemyClear[i] = kMaxTimeMs;
        c.hazardExitMs[i] = kMaxTimeMs;
        c.valid[i] = true;
    }
    c.valid[kFieldCandidate] = false;   // only real when the field produces a step
    c.dirs[kFieldCandidate] = {};
    c.hazardEscape = in.playerOnHazard && in.settings.safeWalk;

    // ── Relevance pass ───────────────────────────────────────────────────────
    int directProjectileThreats = 0;
    c.relevantCount = 0;
    for (int i = 0; i < c.sn->projectileCount; ++i) {
        const ProjectileThreat& p = c.sn->projectiles[i];
        if (p.sampleCount <= 0) continue;
        bool envelope = false, direct = false;
        ClassifyProjectile(c, p, intentDir, envelope, direct);
        if (envelope && c.relevantCount < kMaxProjectiles) c.relevant[c.relevantCount++] = i;
        if (direct) ++directProjectileThreats;
    }

    bool directAoeThreat = false;
    for (int i = 0; i < c.sn->aoeCount; ++i) {
        const AoeThreat& a = c.sn->aoes[i];
        if (a.activeNow) {
            // A live zone is a direct threat when its disc already crowds the
            // player (no landing-window gate — it is dangerous right now).
            if (Len(Sub(a.pos, in.player)) - a.radius <= kRelevanceClearance) {
                directAoeThreat = true;
                break;
            }
            continue;
        }
        if (a.landingMs <= 0.f || a.landingMs > c.horizon) continue;
        const float centerDist = Len(Sub(a.pos, in.player));
        if (centerDist > a.radius + c.speed * (c.lead + a.landingMs) + kRelevanceClearance) continue;
        const Vec2 ip = PlayerAt(c, intentDir, a.landingMs);
        if (std::min(centerDist, Len(Sub(a.pos, ip))) - a.radius <= kRelevanceClearance) {
            directAoeThreat = true;
            break;
        }
    }

    if (directProjectileThreats == 0 && !directAoeThreat && !c.hazardEscape) {
        Finish(c, out, intentVel, false, state.selectedCandidate, 1.f, 0, kMaxTimeMs, Decision::NoThreat);
        return;
    }

    // ── Score every candidate ────────────────────────────────────────────────
    ValidateCandidatePaths(c);
    float earliestImpactMs = kMaxTimeMs;
    int threatCount = 0;
    for (int r = 0; r < c.relevantCount; ++r)
        ScoreProjectile(c, c.sn->projectiles[c.relevant[r]], earliestImpactMs, threatCount);
    ScoreAoes(c, earliestImpactMs, threatCount);

    // Intent candidate untouched by projectile scoring (nothing reached it, or
    // it was invalid and skipped): inherit standing's PROJECTILE scores so the
    // ladder has a baseline. Wall validity is NOT overwritten — a wall-blocked
    // intent must stay invalid so PreserveSafeIntent doesn't walk into a wall
    // (matters when lock follow auto-walks the intent direction).
    const bool intentWallBlocked = !c.valid[kIntentCandidate];
    if (c.score[kIntentCandidate] >= kMaxTimeMs) {
        c.score[kIntentCandidate] = c.score[kStandCandidate];
        c.impactMs[kIntentCandidate] = c.impactMs[kStandCandidate];
        c.blockMs[kIntentCandidate] = c.blockMs[kStandCandidate];
        if (!intentWallBlocked)
            c.valid[kIntentCandidate] = c.valid[kStandCandidate];
    }

    if ((threatCount == 0 && !c.hazardEscape) || c.speed <= 0.f || in.movementLocked) {
        if (in.nowMs >= state.selectedUntilMs) state.selectedCandidate = kStandCandidate;
        Finish(c, out, intentVel, false, state.selectedCandidate, 1.f, threatCount, earliestImpactMs,
               (threatCount == 0 && !c.hazardEscape) ? Decision::NoThreat : Decision::MovementLocked);
        return;
    }

    // ── Layer 2: escape search when nothing straight survives the horizon ───
    RefineWithEscapeSearch(c);

    // ── Field escape: Dijkstra pocket search when nothing straight survives ──
    out.fieldActive = false;
    if (in.settings.fieldEscape && c.speed > 0.f) {
        bool boxedIn = true;   // no non-stand/intent candidate survives the horizon
        for (int cand = 1; cand <= kDirectionCount; ++cand)
            if (c.valid[cand] && c.impactMs[cand] >= c.horizon - 0.5f) { boxedIn = false; break; }
        bool hazardStuck = c.hazardEscape;
        if (hazardStuck)
            for (int cand = 0; cand < kCandidateCount; ++cand)
                if (c.valid[cand] && c.hazardExitMs[cand] < kMaxTimeMs) { hazardStuck = false; break; }
        if (boxedIn || hazardStuck) {
            const Field::EscapeResult esc = Field::FindEscape(in, c.speed);
            if (esc.found && LenSq(esc.firstDir) > 1e-6f) {
                const int fc = kFieldCandidate;
                c.dirs[fc] = esc.firstDir;
                c.valid[fc] = true;
                c.score[fc] = kMaxTimeMs; c.impactMs[fc] = kMaxTimeMs;
                c.blockMs[fc] = kMaxTimeMs; c.enemyClear[fc] = kMaxTimeMs;
                c.hazardExitMs[fc] = kMaxTimeMs;
                // Validate exactly like ValidateCandidatePaths does for one cand:
                for (float t = 0.f; t <= c.horizon; t += kSampleMs) {
                    const Vec2 p = PlayerAt(c, c.dirs[fc], t);
                    c.enemyClear[fc] = std::min(c.enemyClear[fc], EnemyClearanceAt(c, p));
                    if (c.hazardEscape && c.hazardExitMs[fc] >= kMaxTimeMs && !IsHazard(c, p.x, p.y))
                        c.hazardExitMs[fc] = t;
                    if (CanOccupy(c, p.x, p.y)) continue;
                    c.blockMs[fc] = t; c.impactMs[fc] = t;
                    if (t <= 0.f) c.valid[fc] = false;
                    break;
                }
                if (c.valid[fc]) {
                    const SegEval e = SweepSegment(c, in.player, 0.f, c.dirs[fc], c.lead);
                    c.impactMs[fc] = std::min(c.impactMs[fc], e.endMs);
                    c.score[fc] = std::min(c.score[fc], e.minClearance);
                    if (c.impactMs[fc] >= c.horizon - 0.5f)
                        c.score[fc] = std::max(c.score[fc], kIntentSafeClearance + 0.01f);
                    out.fieldActive = true;
                    out.fieldTarget = esc.target;
                }
            }
        }
    }

    // ── Hazard escape: get off damaging ground first, dodging on the way ────
    if (c.hazardEscape) {
        const int choice = SelectHazardEscape(c, intentDir);
        state.selectedCandidate = choice;
        state.selectedUntilMs = in.nowMs + kHysteresisMs;
        Finish(c, out, Mul(c.dirs[choice], c.speed), true, choice, 1.f,
               threatCount, earliestImpactMs, Decision::HazardEscape);
        return;
    }

    int proposed = threatCount > 0 ? SelectProposedCandidate(c) : kStandCandidate;

    // ── Intent-preservation ladder ───────────────────────────────────────────
    // Wall-blocked intent can't be preserved — fall through to the override
    // path so the core picks a heading that's both projectile- and wall-safe.
    if (c.valid[kIntentCandidate] && c.score[kIntentCandidate] >= kIntentSafeClearance) {
        Finish(c, out, intentVel, false, state.selectedCandidate, 1.f, threatCount, earliestImpactMs,
               Decision::PreserveSafeIntent);
        return;
    }

    int choice = proposed;
    Decision decision = earliestImpactMs >= kEmergencyOverrideMs
        ? Decision::GentleOverride : Decision::EmergencyOverride;

    if (earliestImpactMs >= kEmergencyOverrideMs) {
        // Not urgent: among all fully-safe candidates, pick the most intent-aligned.
        // (Iterates every candidate and skips !valid — the field candidate,
        // once real, competes here too.)
        float bestDot = -kMaxTimeMs;
        for (int cand = 0; cand < kCandidateCount; ++cand) {
            if (!c.valid[cand] || c.score[cand] < kIntentSafeClearance) continue;
            const float dot = Dot(c.dirs[cand], intentDir);
            if (dot > bestDot) { bestDot = dot; choice = cand; }
        }
        if (choice != proposed) decision = Decision::GentleManualBlend;
    } else {
        const float bestEmergencyScore = c.score[choice];
        if (hasIntent && bestEmergencyScore >= kIntentSafeClearance) {
            // Survival is achievable: allow a slightly-worse-but-still-safe
            // candidate that better matches the player's intent.
            const float acceptable = std::max(kIntentSafeClearance, bestEmergencyScore - kEmergencyIntentBand);
            float bestDot = -kMaxTimeMs;
            for (int cand = 0; cand < kCandidateCount; ++cand) {
                if (!c.valid[cand] || c.score[cand] < acceptable) continue;
                const float dot = Dot(c.dirs[cand], intentDir);
                if (dot > bestDot) { bestDot = dot; choice = cand; }
            }
            if (choice != proposed) decision = Decision::EmergencyManualBlend;
        } else if (hasIntent) {
            // A hit may be unavoidable: trade only within tight bands.
            const float acceptableImpact = std::max(0.f, c.impactMs[choice] - kUnavoidableImpactBandMs);
            const float acceptableClearance = c.score[choice] - kUnavoidableClearanceBand;
            float bestDot = -kMaxTimeMs;
            for (int cand = 0; cand < kCandidateCount; ++cand) {
                if (!c.valid[cand] || c.impactMs[cand] < acceptableImpact ||
                    c.score[cand] < acceptableClearance) continue;
                const float dot = Dot(c.dirs[cand], intentDir);
                if (dot > bestDot) { bestDot = dot; choice = cand; }
            }
            if (choice != proposed) decision = Decision::UnavoidableManualBlend;
        }
    }

    // ── Hysteresis: keep the previous heading unless the new one is clearly
    // better (prevents frame-to-frame zigzag). ────────────────────────────────
    const float choiceDot = Dot(c.dirs[choice], intentDir);
    const float heldDot = Dot(c.dirs[state.selectedCandidate], intentDir);
    if (in.nowMs < state.selectedUntilMs &&
        c.valid[state.selectedCandidate] &&
        c.score[state.selectedCandidate] >= kIntentSafeClearance &&
        (!hasIntent || heldDot >= choiceDot - 0.05f) &&
        c.score[choice] < c.score[state.selectedCandidate] + kHysteresisScoreGain) {
        choice = state.selectedCandidate;
    } else {
        state.selectedCandidate = choice;
        state.selectedUntilMs = in.nowMs + kHysteresisMs;
    }

    float speedScale = 1.f;
    if (in.settings.speedScale && choice != kStandCandidate && c.valid[choice] &&
        c.score[choice] >= kIntentSafeClearance)
        speedScale = SelectAlignedSpeed(c, choice, intentVel);

    // A pure survival win by the field candidate is a field escape; a blend
    // that happens to pick it keeps its blend decision.
    if (choice == kFieldCandidate &&
        (decision == Decision::GentleOverride || decision == Decision::EmergencyOverride))
        decision = Decision::FieldEscape;

    Finish(c, out, Mul(c.dirs[choice], c.speed * speedScale), true, choice, speedScale,
           threatCount, earliestImpactMs, decision);
}

} } // namespace UDodge::Core
