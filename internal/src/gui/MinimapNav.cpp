#include "pch-il2cpp.h"

#include "gui/MinimapNav.h"
#include "Il2CppResolver.h"
#include "Il2CppHook.h"
#include "core/runtime/MemRead.h"
#include "DbgFileLog.h"

#include <cmath>
#include <cstdint>

// ─────────────────────────────────────────────────────────────────────────────
// TUNABLE CONSTANTS — the whole point of this calibration build. Every value the
// minimap transform cannot verify from the dumps (which are field-only, no method
// bodies) is a clearly-named constant here. Read the `[MinimapCal]` log lines,
// compare the COMPUTED world target against where the player actually ends up,
// and dial these in. Signs are separated out so a single flip fixes a mirror.
// ─────────────────────────────────────────────────────────────────────────────

// Scale. If kMinimapTilesPerPixelOverride > 0 it is used verbatim (world tiles
// per minimap client-pixel). Otherwise the scale is computed live from the
// minimap camera's orthographicSize:
//     worldHeightTiles = 2 * orthoSize * zoomMultUsed      (ortho = half height)
//     tilesPerPixel    = worldHeightTiles / rectHeightPx
// If the ortho getter can't be resolved, kMinimapTilesPerPixelFallback is used.
static constexpr float kMinimapTilesPerPixelOverride = 0.0f;   // 0 = compute from ortho
static constexpr float kMinimapTilesPerPixelFallback = 0.5f;   // guess: tune from log

// Zoom multiplier folded into the computed scale. The static fields
// MiniMapManager.BaseZoomMult / ZoomInMult are LOGGED every click; start at 1.0
// (i.e. trust the live orthographicSize alone) and fold a mult in here once the
// log shows which one the game applies.
static constexpr float kMinimapZoomMultUsed = 1.0f;

// Orientation. When rotationActive is true the click offset is un-rotated by the
// camera angle. kMinimapRotationEnable can force-disable that path for A/B
// testing; kMinimapAngleSign flips the rotation direction (try both — the log
// prints which sign produced the target).
static constexpr bool  kMinimapRotationEnable = true;
static constexpr float kMinimapAngleSign      = 1.0f;   // try -1.0f if mirrored

// Axis signs. Minimap is treated as: +x screen-right = +east, +y screen-up =
// +north. In ROTMG world +X is east and +Y is SOUTH, so north maps to -Y →
// kMinimapSignNorth defaults to -1. Flip either if the log shows a mirror.
static constexpr float kMinimapSignEast  =  1.0f;
static constexpr float kMinimapSignNorth = -1.0f;

// Fallback on-screen rect (CLIENT top-down px) used only when the RectTransform
// corners can't be resolved. Modeled as a square anchored to the top-right
// corner of the client area (RotMG's default minimap position). Tune from log.
static constexpr float kFallbackMarginPx = 12.0f;   // gap from screen edges
static constexpr float kFallbackSizePx   = 200.0f;  // minimap square edge (px)

static constexpr float kPI = 3.14159265358979323846f;

// ─────────────────────────────────────────────────────────────────────────────
// Resolve state
// ─────────────────────────────────────────────────────────────────────────────
static Il2CppClass*  s_mmClass       = nullptr;
static Il2CppObject* s_mmInstance    = nullptr;

static const MethodInfo* s_getTransform     = nullptr;  // Component.get_transform()
static const MethodInfo* s_getWorldCorners  = nullptr;  // RectTransform.GetWorldCorners(Vector3[])
static Il2CppClass*      s_vec3Class        = nullptr;  // UnityEngine.Vector3

namespace {

// Validate the cached instance's klass pointer still matches (cheap liveness
// check, same idea as CameraTAB's ValidateCamMgr).
bool InstanceValid()
{
    if (!Mem::AddrOk(s_mmInstance)) return false;
    void* k = nullptr;
    if (!Resolver::Protection::safe_call([&]() {
        k = *reinterpret_cast<void**>(s_mmInstance);
    })) return false;
    return k == s_mmClass;
}

// Read the fields we care about from the live MiniMapManager instance. All reads
// are wrapped in one SEH guard so a stale layout aborts the whole read cleanly.
struct MMFields {
    Il2CppObject* camera        = nullptr;  // app::Camera*
    Il2CppObject* rawImage      = nullptr;  // app::RawImage*
    Il2CppObject* contentRT     = nullptr;  // app::RectTransform*
    bool          rotationActive = false;
    app::Rect     mhRect        = {};       // MHDLIMLMABN
    bool          ok            = false;
};

MMFields ReadFields()
{
    MMFields f{};
    if (!Mem::AddrOk(s_mmInstance)) return f;
    f.ok = Resolver::Protection::safe_call([&]() {
        auto* mm = reinterpret_cast<app::MiniMapManager*>(s_mmInstance);
        f.camera         = reinterpret_cast<Il2CppObject*>(mm->fields.miniMapCamera);
        f.rawImage       = reinterpret_cast<Il2CppObject*>(mm->fields.miniMapRawImage);
        f.contentRT      = reinterpret_cast<Il2CppObject*>(mm->fields.miniMapContentRenderer);
        f.rotationActive = mm->fields.rotationActive;
        f.mhRect         = mm->fields.MHDLIMLMABN;
    });
    return f;
}

// Static zoom multipliers (MiniMapManager static fields). Logged for calibration.
bool ReadZoomMults(float& outBase, float& outZoomIn)
{
    bool ok = false;
    Resolver::Protection::safe_call([&]() {
        app::MiniMapManager__StaticFields* sf = nullptr;
        if (s_mmClass && s_mmClass->static_fields)
            sf = reinterpret_cast<app::MiniMapManager__StaticFields*>(s_mmClass->static_fields);
        else if (app::MiniMapManager__TypeInfo && *app::MiniMapManager__TypeInfo)
            sf = (*app::MiniMapManager__TypeInfo)->static_fields;
        if (sf) {
            outBase   = sf->BaseZoomMult;
            outZoomIn = sf->ZoomInMult;
            ok = true;
        }
    });
    return ok;
}

// Live orthographicSize off the minimap camera. Returns false if unresolved.
bool ReadOrthoSize(Il2CppObject* cam, float& out)
{
    if (!Mem::AddrOk(cam)) return false;
    const float v = Resolver::GetProperty<float>(cam, "orthographicSize");
    if (!(v > 0.0001f) || !std::isfinite(v)) return false;
    out = v;
    return true;
}

// Fill outCorners[4] with the RectTransform's world-space corners (screen px for
// an Overlay canvas: Unity Y-up, order BL, TL, TR, BR). Returns false on any
// failure. `rtObj` must be an object on which RectTransform.GetWorldCorners is
// callable (a RectTransform or a UI Transform).
bool GetWorldCorners(Il2CppObject* rtObj, app::Vector3 outCorners[4])
{
    if (!Mem::AddrOk(rtObj) || !s_getWorldCorners || !s_vec3Class) return false;

    il2cpp_array_size_t len; len.value = 4;
    Il2CppArray* arr = il2cpp_array_new(s_vec3Class, len);
    if (!arr) return false;

    void* params[1] = { arr };
    Resolver::Protection::SafeRuntimeInvoke(s_getWorldCorners, rtObj, params);

    // Value-type array data begins at +0x20 (Il2CppArray header on x64); each
    // Vector3 is 12 bytes. Copy under SEH in case the invoke left it degenerate.
    bool ok = Resolver::Protection::safe_call([&]() {
        const auto* base = reinterpret_cast<const uint8_t*>(arr) + 0x20;
        for (int i = 0; i < 4; ++i)
            outCorners[i] = *reinterpret_cast<const app::Vector3*>(base + i * 12);
    });
    if (!ok) return false;

    for (int i = 0; i < 4; ++i)
        if (!std::isfinite(outCorners[i].x) || !std::isfinite(outCorners[i].y))
            return false;
    return true;
}

// Resolve the RawImage's RectTransform (via Component.get_transform) and read its
// screen rect in CLIENT top-down px. Falls back to the content-renderer
// RectTransform. Returns false if neither resolves.
bool ResolveRectFromCorners(const MMFields& f, float screenH,
                            float& outX, float& outY, float& outW, float& outH)
{
    app::Vector3 corners[4] = {};
    bool got = false;

    // Primary: the RawImage's own transform (the on-screen viewport).
    if (Mem::AddrOk(f.rawImage) && s_getTransform) {
        Il2CppObject* rt =
            Resolver::Protection::SafeRuntimeInvoke(s_getTransform, f.rawImage, nullptr);
        if (Mem::AddrOk(rt))
            got = GetWorldCorners(rt, corners);
    }
    // Fallback: the content-renderer RectTransform is already a RectTransform.
    if (!got && Mem::AddrOk(f.contentRT))
        got = GetWorldCorners(f.contentRT, corners);

    if (!got) return false;

    const float unityXMin    = corners[0].x;
    const float unityXMax    = corners[2].x;
    const float unityYBottom = corners[0].y;
    const float unityYTop    = corners[1].y;

    const float w = unityXMax - unityXMin;
    const float h = unityYTop - unityYBottom;
    if (!(w > 1.0f) || !(h > 1.0f)) return false;

    outX = unityXMin;
    outY = screenH - unityYTop;   // Unity bottom-up → client top-down
    outW = w;
    outH = h;
    return true;
}

void FallbackRect(float screenW, float screenH,
                  float& outX, float& outY, float& outW, float& outH)
{
    outW = kFallbackSizePx;
    outH = kFallbackSizePx;
    outX = (screenW > 0.f) ? (screenW - kFallbackSizePx - kFallbackMarginPx)
                           : kFallbackMarginPx;
    outY = kFallbackMarginPx;
}

} // namespace

// ─────────────────────────────────────────────────────────────────────────────
void MinimapNav::EnsureResolved()
{
    // (Re)resolve the instance if the cache is stale.
    if (!InstanceValid()) {
        if (!s_mmClass)
            s_mmClass = Resolver::FindClassLoose("MiniMapManager");
        s_mmInstance = nullptr;
        if (s_mmClass) {
            auto insts = Resolver::FindObjectsByType(s_mmClass);
            if (!insts.empty())
                s_mmInstance = insts[0];
        }

        // Method resolution (cached by Il2CppHook; cheap to retry).
        if (!s_getTransform)
            s_getTransform = Il2CppHook::ResolveMethodCached(
                "Component", "get_transform", 0, false, "UnityEngine");
        if (!s_getWorldCorners)
            s_getWorldCorners = Il2CppHook::ResolveMethodCached(
                "RectTransform", "GetWorldCorners", 1, false, "UnityEngine");
        if (!s_vec3Class)
            s_vec3Class = Resolver::FindClass("UnityEngine", "Vector3");

        if (Mem::AddrOk(s_mmInstance)) {
            const MMFields f = ReadFields();
            float zBase = 0.f, zIn = 0.f;
            const bool zoomOk = ReadZoomMults(zBase, zIn);
            float ortho = 0.f;
            const bool orthoOk = f.ok && ReadOrthoSize(f.camera, ortho);
            DBG_FILE_LOG("[MinimapCal] resolve:"
                << " class=" << (s_mmClass ? "ok" : "fail")
                << " instance=ok"
                << " fieldsRead=" << (f.ok ? "ok" : "fail")
                << " camera=" << (Mem::AddrOk(f.camera) ? "ok" : "fail")
                << " orthoGetter=" << (orthoOk ? "ok" : "fail")
                << " ortho=" << ortho
                << " rawImage=" << (Mem::AddrOk(f.rawImage) ? "ok" : "fail")
                << " contentRT=" << (Mem::AddrOk(f.contentRT) ? "ok" : "fail")
                << " getTransform=" << (s_getTransform ? "ok" : "fail")
                << " getWorldCorners=" << (s_getWorldCorners ? "ok" : "fail")
                << " vec3Class=" << (s_vec3Class ? "ok" : "fail")
                << " rotationActive=" << (f.rotationActive ? 1 : 0)
                << " zoomMults=" << (zoomOk ? "ok" : "fail")
                << " BaseZoomMult=" << zBase
                << " ZoomInMult=" << zIn
                << " MHDLIMLMABN=(x=" << f.mhRect.m_XMin << " y=" << f.mhRect.m_YMin
                << " w=" << f.mhRect.m_Width << " h=" << f.mhRect.m_Height << ")");
        } else {
            DBG_FILE_LOG("[MinimapCal] resolve: class="
                << (s_mmClass ? "ok" : "fail")
                << " instance=fail (not in-game / minimap not up?)");
        }
    }
}

bool MinimapNav::GetScreenRect(float screenW, float screenH,
                               float& outX, float& outY, float& outW, float& outH,
                               bool& outFallback)
{
    if (!(screenH > 1.f)) return false;
    EnsureResolved();
    outFallback = false;

    if (Mem::AddrOk(s_mmInstance)) {
        const MMFields f = ReadFields();
        if (f.ok && ResolveRectFromCorners(f, screenH, outX, outY, outW, outH))
            return true;
    }

    // Fallback anchor rect: top-right square (RotMG default minimap position).
    outFallback = true;
    FallbackRect(screenW, screenH, outX, outY, outW, outH);
    return true;
}

bool MinimapNav::HitTest(float clientX, float clientY, float screenW, float screenH)
{
    float rx, ry, rw, rh;
    bool fb;
    if (!GetScreenRect(screenW, screenH, rx, ry, rw, rh, fb)) return false;
    return clientX >= rx && clientX <= rx + rw
        && clientY >= ry && clientY <= ry + rh;
}

bool MinimapNav::ClickToWorld(float clientMouseX, float clientMouseY,
                              float screenW, float screenH,
                              float playerWorldX, float playerWorldY, float camAngleDeg,
                              float& outWorldX, float& outWorldY)
{
    EnsureResolved();

    // Resolve the on-screen rect (client top-down px).
    float rx = 0, ry = 0, rw = 0, rh = 0;
    bool  fallback = true;
    bool  rectOk   = false;
    MMFields f{};
    if (Mem::AddrOk(s_mmInstance)) {
        f = ReadFields();
        if (f.ok && ResolveRectFromCorners(f, screenH, rx, ry, rw, rh)) {
            rectOk   = true;
            fallback = false;
        }
    }
    if (!rectOk)
        FallbackRect(screenW, screenH, rx, ry, rw, rh);

    const float centerX = rx + rw * 0.5f;
    const float centerY = ry + rh * 0.5f;

    // Scale (world tiles per minimap client-pixel).
    float ortho    = 0.f;
    bool  orthoOk  = f.ok && ReadOrthoSize(f.camera, ortho);
    float zBase = 0.f, zIn = 0.f;
    const bool zoomOk = ReadZoomMults(zBase, zIn);

    float tpp;
    if (kMinimapTilesPerPixelOverride > 0.f) {
        tpp = kMinimapTilesPerPixelOverride;
    } else if (orthoOk && rh > 1.f) {
        tpp = (2.0f * ortho * kMinimapZoomMultUsed) / rh;
    } else {
        tpp = kMinimapTilesPerPixelFallback;
    }

    // Offset from rect center (client top-down px) → up-positive math frame.
    const float offX = clientMouseX - centerX;   // right +
    const float offY = clientMouseY - centerY;   // down + (top-down)
    const float px   = offX;
    const float py   = -offY;                     // up +

    // Orientation.
    const bool  doRot = kMinimapRotationEnable && f.ok && f.rotationActive;
    float rxr = px, ryr = py;
    if (doRot) {
        const float a = kMinimapAngleSign * camAngleDeg * (kPI / 180.0f);
        const float c = std::cos(a), s = std::sin(a);
        rxr = px * c - py * s;
        ryr = px * s + py * c;
    }

    const float worldDX = rxr * tpp * kMinimapSignEast;
    const float worldDY = ryr * tpp * kMinimapSignNorth;
    outWorldX = playerWorldX + worldDX;
    outWorldY = playerWorldY + worldDY;

    const bool okFinite = std::isfinite(outWorldX) && std::isfinite(outWorldY);

    DBG_FILE_LOG("[MinimapCal] click:"
        << " mousePx=(" << clientMouseX << "," << clientMouseY << ")"
        << " rect=(x=" << rx << " y=" << ry << " w=" << rw << " h=" << rh << ")"
        << " center=(" << centerX << "," << centerY << ")"
        << " rectSrc=" << (fallback ? "FALLBACK" : "resolved")
        << " orthoOk=" << (orthoOk ? 1 : 0) << " ortho=" << ortho
        << " zoomMults=" << (zoomOk ? 1 : 0)
        << " BaseZoomMult=" << zBase << " ZoomInMult=" << zIn
        << " zoomMultUsed=" << kMinimapZoomMultUsed
        << " tpp=" << tpp
        << " rotationActive=" << (f.rotationActive ? 1 : 0)
        << " doRot=" << (doRot ? 1 : 0)
        << " angleDeg=" << camAngleDeg << " angleSign=" << kMinimapAngleSign
        << " offPx=(" << offX << "," << offY << ")"
        << " rotPx=(" << rxr << "," << ryr << ")"
        << " signEast=" << kMinimapSignEast << " signNorth=" << kMinimapSignNorth
        << " player=(" << playerWorldX << "," << playerWorldY << ")"
        << " target=(" << outWorldX << "," << outWorldY << ")"
        << " finite=" << (okFinite ? 1 : 0));

    return okFinite;
}
