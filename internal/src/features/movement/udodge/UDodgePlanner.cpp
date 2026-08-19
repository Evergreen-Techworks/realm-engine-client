#include "pch-il2cpp.h"
#include "UDodgePlanner.h"

#include <algorithm>

// ─────────────────────────────────────────────────────────────────────────────
// Threading note (Stage C1 verification — plan 58, Step 1):
//   The weapon range that feeds OrbitIntent comes from AutoAim::GetProjRangeTiles()
//   / IsProjRangeResolved(), which are thin inline reads of a cached, static
//   plain-data WeaponProfile (AutoAim.h:85-86 → WeaponCalibrator::GetProfile(),
//   WeaponProfile.cpp:130 returns `static WeaponProfile s_profile`). That profile
//   is populated on the game thread by WeaponCalibrator::Tick / OnProjectileSpawn;
//   the getters themselves touch no live IL2CPP object. They are therefore safe to
//   call on the game thread and their resolved value is captured (as a plain float)
//   into PlannerSnapshot::weaponRangeTiles before this pure Compute runs. No IL2CPP
//   handle, void*, or Env function pointer crosses the PlannerSnapshot/PlanResult
//   boundary — everything here is plain data + inline math.
// ─────────────────────────────────────────────────────────────────────────────

namespace UDodge { namespace Planner {
namespace {

// Orbit / keep-weapon-range steering toward a target at world (tx, ty).
// Pure math: the resolved weapon range (already selected on the game thread) is
// passed in as `rangeTiles` instead of calling AutoAim, so this is host-independent.
Vec2 OrbitIntent(Vec2 player, float tx, float ty, float rangeTiles)
{
    const Vec2 to = Sub(Vec2{ tx, ty }, player);
    const float dist = Len(to);
    if (dist < 1e-3f) return {};
    const Vec2 dir = Mul(to, 1.f / dist);
    const float range = std::clamp(rangeTiles, 2.f, 16.f);
    const float desired = range * 0.85f;
    if (dist > desired + 0.5f) return dir;             // too far → close in
    if (dist < desired - 0.5f) return Mul(dir, -1.f);  // too close → back off
    return Vec2{ -dir.y, dir.x };                       // in band → orbit (tangential)
}

} // namespace

void Compute(const PlannerSnapshot& in, PlanResult& out)
{
    out = PlanResult{};
    out.forSeq = in.seq;

    if (!in.hasLock) return;   // no goal → nothing to pursue this stage

    out.hasGoal = true;
    out.goalPos = in.lockPos;
    out.firstDir = OrbitIntent(in.player, in.lockPos.x, in.lockPos.y, in.weaponRangeTiles);
}

} } // namespace UDodge::Planner
