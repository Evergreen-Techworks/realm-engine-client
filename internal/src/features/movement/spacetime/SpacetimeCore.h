#pragma once
#include "../udodge/UDodgeTypes.h"
#include "ProjectileContact.h"
#include <array>

// Experimental bounded spacetime search. Algorithms propose trajectories;
// the host alone executes them. No dependencies on game pointers or UI.
namespace SpacetimeDodge {
using UDodge::Vec2;
constexpr int kMaxPlanPoints = 256;
constexpr float kMaxZoneHorizonMs = 4000.f;
constexpr int kMaxTimedZones = UDodge::kMaxAoes;

enum class Status { Clear, Waiting, Moving, Recovery, NoPlan, Incomplete, Locked };
enum class Reason { None, MissingMap, CaptureUnavailable, Truncated, InvalidInput,
    SpeedChanged, IntentChanged, PositionDrift, RouteBlocked, LeadBlocked,
    SearchBudget, NoRoute, CommandBlocked };
struct Diagnostics {
    int edges = 0, projectileRejects = 0, terrainRejects = 0, enemyRejects = 0,
        zoneRejects = 0, speedRejects = 0;
    int unknownTailChecks = 0;
    int cornerRejects = 0; // square-threshold contacts outside its inscribed circle
    bool seedAvailable = false;
    int recoveryCandidates = 0;
    int threatLane = -1;
    float baselineHitMs = -1.f;
};
struct TimedZone {
    Vec2 center{};
    float radius = 0.f;
    float startsMs = 0.f;
    float endsMs = 0.f;
};
struct Settings {
    bool avoidHarmlessBlocks = false; // manual steering preference only
    float lookRange = 16.f;         // projectile paths entering this local radius
    float horizonMs = 800.f;
    float stepMs = 40.f;
    float leadMs = 40.f;
    float dwellMs = 160.f;
    float maxDistance = 3.f;
    int maxExpansions = 4000;
    float maxSearchMs = 0.f;         // host deadline; zero for deterministic tests
    float recoveryBudgetMs = 0.f;
};
struct Input {
    UDodge::MapInput world{};
    Vec2 nominal{};                  // tiles/ms; zero means genuine idle
    double nowMs = 0.;
    float frameMs = 16.7f;
    // Duration within each control period for which an override can execute.
    // A throttled native actuator cannot promise continuous full-speed motion.
    // Zero uses the entire search step (continuous-controller tests).
    float actuationMs = 0.f;
    float maxCorrectionSpeed = 0.f; // tiles/ms; zero uses world.speed
    bool collectDiagnostics = false;
    bool expandedForZones = false;
    // Spatial guidance only. The temporal planner alone selects movement.
    struct Guidance {
        bool active=false, manual=false;
        uint64_t identity=0;
        int count=0;
        std::array<Vec2,128> points{};
    } guidance;
    Settings settings{};
    int zoneCount = 0;
    std::array<TimedZone, kMaxTimedZones> zones{};
};
struct Point { Vec2 pos{}; float timeMs = 0.f; };
struct Plan {
    std::array<Point, kMaxPlanPoints> points{};
    int count = 0;
    double epochMs = 0.;
    float speed = 0.f;
    Vec2 nominal{};
    float intervention = 0.f;
    float departureMs = 0.f;
};
struct State {
    Plan plan{};
    bool valid = false;
    uint64_t goalIdentity=0;
    Vec2 goal{};
    void Reset() { *this = State{}; }
};
struct Output {
    Status status = Status::Incomplete;
    Plan plan{};
    Vec2 velocity{};
    float waitMs = 0.f;
    int expansions = 0;
    bool budgetHit = false;
    bool reused = false;
    Reason reason = Reason::None;
    Reason replanReason = Reason::None;
    Diagnostics diagnostics{};
    float estimatedDamage = 0.f;
    int expectedHits = 0;
    bool unknownDamage = false;
};

Vec2 PositionAt(const Plan& plan, float timeMs);
// Verifies the complete remaining trajectory against current speed, terrain,
// moving projectiles, beams and timed zones. Never slides or shortens a plan.
bool Validate(const Input& in, const Plan& plan);
// Validate a proposed finite intention and the actual straight command slice.
// This does not mutate the single retained movement plan.
bool EvaluateTrajectory(const Input& in, const Plan& plan, Output& out);
// Last-resort command protection when no complete trajectory was found. A
// safe or least-damage finite prefix is Recovery, never a certified full route.
bool ProtectImmediateStep(const Input& in,Output& out,bool retainControl=false);
// Manual takeover tests damage/threats, not harmless scenery or slow terrain.
// This is not permission for an automatic route to cross a solid obstacle.
bool KeyboardIntentSafe(const Input& in);
void Evaluate(const Input& in, State& state, Output& out);
// Extend only the search budget for known timed blasts that cannot be escaped
// within the ordinary micro-dodge limits. Collision radii remain unchanged.
void ApplyZonePlanningLimits(Input& in);
const char* StatusName(Status status);
const char* ReasonName(Reason reason);
// Projectile half-width for ordinary shots; beam radius for beam capsules.
float ProjectileRadius(const UDodge::LaneThreat& lane,const UDodge::Settings& settings);
enum class SampleStatus { Known, Expired, Unknown };
SampleStatus SampleProjectile(const UDodge::LaneThreat& lane,float timeMs,Vec2& position);
// Includes the exact expiry endpoint for continuous segment clipping. Only
// runtime-verified constant motion can extend beyond captured samples.
bool ProjectLinearTail(const UDodge::LaneThreat& lane,float timeMs,Vec2& position);
bool LaneInLookRange(const Input& in,const UDodge::LaneThreat& lane);
bool EnemyPathClear(const UDodge::MapInput& in,Vec2 from,Vec2 to,bool ignoreScenery=false);
}
