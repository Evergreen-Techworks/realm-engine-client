#include "pch-il2cpp.h"

#include "ProjectileTrajectory.h"
#include "gui/tabs/WorldTAB.h"
#include "Il2CppResolver.h"
#include "BeebyteName.h"

#include <cmath>

namespace {

// ── Runtime-resolved positionAt (GIBLKPDHLBG on HBEAKBIHANL) ─────────────────
// app::HBEAKBIHANL_GIBLKPDHLBG is null in the current build (stub never set by
// IL2CPP init). The vtable struct field is unsafe to use directly because the
// generated offsets may not match the runtime layout. Instead, find the method
// once via IL2CPP metadata — same pattern as ResolveProjClass() in
// ProjectileTracking.cpp — and cache the native pointer.
using PositionAtFn = app::Vector2(__fastcall*)(app::HBEAKBIHANL*, float, float*, float*, MethodInfo*);

struct PosAtMethod {
    PositionAtFn      fn    = nullptr;
    const MethodInfo* mi    = nullptr;
    bool              ok    = false;
    bool              tried = false;
};
static PosAtMethod s_posAt;

static const PosAtMethod& GetPosAtMethod()
{
    if (s_posAt.tried) return s_posAt;
    s_posAt.tried = true;

    if (app::HBEAKBIHANL_GIBLKPDHLBG) {
        s_posAt.fn = app::HBEAKBIHANL_GIBLKPDHLBG;
        s_posAt.ok = true;
        return s_posAt;
    }

    Il2CppClass* klass = nullptr;
    for (const auto& kv : Beebyte::GetMap()) {
        if (kv.second == "Projectile") {
            klass = Resolver::GetClass("", kv.first.c_str());
            if (!klass) klass = Resolver::FindClassLoose(kv.first.c_str());
            if (klass) break;
        }
    }
    if (!klass) klass = Resolver::GetClass("", "HBEAKBIHANL");
    if (!klass) klass = Resolver::FindClassLoose("HBEAKBIHANL");
    if (!klass) return s_posAt;

    void* iter = nullptr;
    while (const MethodInfo* mi = il2cpp_class_get_methods(klass, &iter)) {
        const char* name = il2cpp_method_get_name(mi);
        if (!name || strcmp(name, "GIBLKPDHLBG") != 0) continue;
        if (il2cpp_method_get_param_count(mi) != 3) continue;
        if (!mi->methodPointer) continue;
        s_posAt.fn = reinterpret_cast<PositionAtFn>(mi->methodPointer);
        s_posAt.mi = mi;
        s_posAt.ok = true;
        break;
    }
    return s_posAt;
}

static bool IsFiniteWorldPoint(float x, float y)
{
    return std::isfinite(x) && std::isfinite(y) && fabsf(x) < 10000.f && fabsf(y) < 10000.f;
}

static bool AddrOk(const void* p)
{
    const uintptr_t a = reinterpret_cast<uintptr_t>(p);
    return a > 0x10000 && a < 0x7FFFFFFFFFFFULL;
}

static bool ReadGamePositionAtTime(void* projectilePtr, float tMs, float& outX, float& outY)
{
    if (!AddrOk(projectilePtr)) return false;
    const PosAtMethod& m = GetPosAtMethod();
    if (!m.ok || !m.fn) return false;
    bool ok = false;
    __try {
        float dx = 0.f, dy = 0.f;
        auto* projectile = reinterpret_cast<app::HBEAKBIHANL*>(projectilePtr);
        const app::Vector2 pos = m.fn(projectile, tMs, &dx, &dy,
                                      const_cast<MethodInfo*>(m.mi));
        if (IsFiniteWorldPoint(pos.x, pos.y)) {
            outX = pos.x;
            outY = pos.y;
            ok = true;
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        ok = false;
    }
    return ok;
}

} // namespace

namespace ProjectileTrajectory {

float NormalizeLifetimeMs(float rawFromProps)
{
    if (!(rawFromProps > 0.f) || rawFromProps != rawFromProps)
        return 2000.f;
    if (rawFromProps < 250.f)
        return rawFromProps * 1000.f;
    return rawFromProps;
}

float NormalizeAccelDelayMs(float rawFromProps)
{
    if (!(rawFromProps > 0.f) || rawFromProps != rawFromProps)
        return 0.f;
    if (rawFromProps < 250.f)
        return rawFromProps * 1000.f;
    return rawFromProps;
}

bool GetPositionAtTime(const WorldProjectile& proj, float tMs, float& outX, float& outY)
{
    outX = 0.f;
    outY = 0.f;
    return ReadGamePositionAtTime(proj.ptr, tMs, outX, outY);
}

bool CachePath(WorldProjectile& proj)
{
    proj.hasCachedPath = false;
    proj.pathSampleCount = 0;
    const float lifetime = (proj.lifetime > 1.f && std::isfinite(proj.lifetime)) ? proj.lifetime : 2000.f;
    constexpr int sampleCap = kWorldProjectilePathSampleCap;
    for (int i = 0; i < sampleCap; ++i) {
        const float tMs = (lifetime * static_cast<float>(i)) / static_cast<float>(sampleCap - 1);
        float x = 0.f, y = 0.f;
        if (!GetPositionAtTime(proj, tMs, x, y)) break;
        proj.pathSampleTimesMs[proj.pathSampleCount] = tMs;
        proj.pathX[proj.pathSampleCount] = x;
        proj.pathY[proj.pathSampleCount] = y;
        ++proj.pathSampleCount;
    }
    proj.hasCachedPath = proj.pathSampleCount >= 2;
    return proj.hasCachedPath;
}

} // namespace ProjectileTrajectory
