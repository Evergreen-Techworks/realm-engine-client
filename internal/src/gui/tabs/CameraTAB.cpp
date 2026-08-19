#include "pch-il2cpp.h"

#define IMGUI_DEFINE_MATH_OPERATORS

#include "gui/tabs/CameraTAB.h"
#include "gui/tabs/TestTAB.h"
#include "gui/tabs/WorldTAB.h"
#include "gui/CamState.h"
#include "W2S.h"
#include "Il2CppResolver.h"
#include "RuntimeOffsets.h"
#include "core/runtime/MemRead.h"
#include "DirectX.h"
#include "FeatureState.h"
#include "DbgFileLog.h"
#include <imgui/imgui.h>
#include <imgui/imgui_internal.h>
#include <windows.h>
#include <cstdio>
#include <cstring>
#include <iomanip>
#include <cmath>

// ─────────────────────────────────────────────────────────────────────────────
// Offsets (runtime-confirmed via DIA4A and types_deobf.cs)
// ─────────────────────────────────────────────────────────────────────────────
//
// CameraManager (DecaGames.RotMG.Managers.CameraManager) field layout:
//   +0x28  mainCameraContainer  Transform*    (world-space camera container)
//   +0x50  [UnityEngine.Camera* KNAIAEFDCLM]  (main gameplay camera, not minimap)
//
// UnityEngine.Camera native object — orthographicSize candidates:
//   Try 0x4C first, then 0x44, 0x48, 0x40, 0x50, 0x54 (Unity version varies)
//
// Unity Transform.localPosition:
//   +0x38  float x,  +0x3C  float y,  +0x40  float z
//
// Camera angle is read via the NHPPJHAMCBL getter property (float) on
// CameraManager — NOT SetCameraAngle(int) which is write-only.
// NHPPJHAMCBL getter RVA: 0x01999970  (same as DIA4A "nhppZoomGetter" probe).
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
static std::string  g_status        = "Press Refresh.";
static bool         g_statusOk      = true;

static uintptr_t    g_camMgrPtr     = 0;
static uintptr_t    g_unityCamPtr   = 0;

// Cached class/instance to avoid FindObjectsByType (expensive Unity scan) every refresh.
static Il2CppClass*  s_camMgrClass  = nullptr;
static Il2CppObject* s_cachedCamMgr = nullptr;

static float        g_angle         = 0.f;
static float        g_zoom          = 0.f;
static float        g_posX          = 0.f;
static float        g_posY          = 0.f;
static bool         g_offsetMode    = false;  // IOABMGFJLLP — true = camera NOT centred on player

// Camera.pixelRect: the actual Unity viewport rect in pixels (bottom-left origin).
// x/y = bottom-left corner, w/h = viewport size.
// W2S uses: cx = x + w/2, cy = screenH - (y + h/2)
static float        g_pixelRectX    = 0.f;
static float        g_pixelRectY    = 0.f;
static float        g_pixelRectW    = 0.f;
static float        g_pixelRectH    = 0.f;

// Input fields
static float        g_setZoom       = 8.0f;
static int          g_setAngle      = 0;

// Auto-refresh
static bool         g_autoRefresh   = false;
static float        g_autoTimer     = 0.f;
static float        g_autoInterval  = 1.0f;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────


static bool IsPlausibleOrtho(float f) { return (f == f) && f > 0.05f && f < 500.f; }

struct Vec3 { float x, y, z; };

static const MethodInfo* s_worldToScreenPointMethod = nullptr;

static const MethodInfo* s_screenWidthMethod  = nullptr;
static const MethodInfo* s_screenHeightMethod  = nullptr;

// ── Cached method lookups (resolved once by EnsureCameraMethods) ─────────
static const MethodInfo* s_getEulerAngles   = nullptr;
static const MethodInfo* s_getPixelRect     = nullptr;
static const MethodInfo* s_getPosition      = nullptr;
static const MethodInfo* s_setCameraAngle   = nullptr;
static const MethodInfo* s_getOffsetMode    = nullptr;  // ANBDPNHJBHG / get_IOABMGFJLLP
static const MethodInfo* s_changeOffsetMode = nullptr;
static bool              s_methodsSearched  = false;

// Resolve all CameraManager / Transform / Camera methods once.
// Called from DoRefresh() after the CameraManager instance is validated.
// Retries on subsequent frames if any method is still null (e.g. the Camera
// pointer was null because we weren't in-game yet on the first attempt).
static void EnsureCameraMethods(Il2CppObject* camMgrObj)
{
    if (s_methodsSearched) return;
    if (!camMgrObj) return;

    Il2CppClass* cmKlass = il2cpp_object_get_class(camMgrObj);

    // CameraManager methods
    if (cmKlass && !s_setCameraAngle)
        s_setCameraAngle = il2cpp_class_get_method_from_name(cmKlass, "SetCameraAngle", 1);
    if (cmKlass && !s_changeOffsetMode)
        s_changeOffsetMode = il2cpp_class_get_method_from_name(cmKlass, "ChangeOffsetMode", 0);
    if (cmKlass && !s_getOffsetMode) {
        s_getOffsetMode = il2cpp_class_get_method_from_name(cmKlass, "ANBDPNHJBHG",    0);
        if (!s_getOffsetMode)
            s_getOffsetMode = il2cpp_class_get_method_from_name(cmKlass, "get_IOABMGFJLLP", 0);
        if (!s_getOffsetMode)
            s_getOffsetMode = il2cpp_class_get_method_from_name(cmKlass, "IOABMGFJLLP",    0);
    }

    // Transform methods (from mainCameraContainer)
    if (!s_getEulerAngles || !s_getPosition) {
        void* xfrm = nullptr;
        Mem::TryRead(camMgrObj, RuntimeOffsets::CM_Transform, xfrm);
        if (Mem::AddrOk(xfrm)) {
            Il2CppClass* xk = il2cpp_object_get_class(reinterpret_cast<Il2CppObject*>(xfrm));
            if (xk) {
                if (!s_getEulerAngles)
                    s_getEulerAngles = il2cpp_class_get_method_from_name(xk, "get_eulerAngles", 0);
                if (!s_getPosition)
                    s_getPosition = il2cpp_class_get_method_from_name(xk, "get_position", 0);
            }
        }
    }

    // Camera methods (from the Unity Camera object)
    if (!s_getPixelRect) {
        void* unityCam = nullptr;
        Mem::TryRead(camMgrObj, RuntimeOffsets::CM_UnityCam, unityCam);
        if (Mem::AddrOk(unityCam)) {
            Il2CppClass* ck = il2cpp_object_get_class(reinterpret_cast<Il2CppObject*>(unityCam));
            if (ck)
                s_getPixelRect = il2cpp_class_get_method_from_name(ck, "get_pixelRect", 0);
        }
    }

    // Fast-path: once all methods are resolved, skip future attempts.
    s_methodsSearched = s_setCameraAngle && s_changeOffsetMode
                     && s_getOffsetMode && s_getEulerAngles
                     && s_getPosition   && s_getPixelRect;
}

static bool InvokeStaticIntGetter(const MethodInfo* method, float& out)
{
    if (!method) return false;
    Il2CppObject* boxed = Resolver::Protection::SafeRuntimeInvoke(method, nullptr, nullptr);
    if (!boxed) return false;
    void* unboxed = il2cpp_object_unbox(boxed);
    if (!unboxed) return false;
    // No isfinite check: the source is an int32, so the conversion is always
    // finite. A zero/negative size is the only bad answer possible here.
    out = static_cast<float>(*reinterpret_cast<const int32_t*>(unboxed));
    return out > 0.f;
}

static bool GetUnityScreenSize(float& outWidth, float& outHeight)
{
    if (!s_screenWidthMethod || !s_screenHeightMethod) {
        Il2CppClass* screen = Resolver::FindClass("UnityEngine", "Screen");
        if (!screen) return false;
        s_screenWidthMethod = il2cpp_class_get_method_from_name(screen, "get_width", 0);
        s_screenHeightMethod = il2cpp_class_get_method_from_name(screen, "get_height", 0);
        if (!s_screenWidthMethod || !s_screenHeightMethod) return false;
    }
    return InvokeStaticIntGetter(s_screenWidthMethod,  outWidth)
        && InvokeStaticIntGetter(s_screenHeightMethod, outHeight);
}

static bool InvokeWorldToScreen(Il2CppObject* camObj, const Vec3& world,
                                float& outUnityX, float& outUnityY)
{
    if (!camObj || !s_worldToScreenPointMethod) return false;
    Vec3  worldArg  = world;
    void* params[1] = { &worldArg };
    Il2CppObject* boxed =
        Resolver::Protection::SafeRuntimeInvoke(s_worldToScreenPointMethod, camObj, params);
    if (!boxed) return false;
    void* unboxed = il2cpp_object_unbox(boxed);
    if (!unboxed) return false;
    const float* vec3Components = reinterpret_cast<const float*>(unboxed);
    outUnityX = vec3Components[0];
    outUnityY = vec3Components[1];
    // Trust boundary: Unity really does return NaN/Inf here for a degenerate
    // camera (zero-scale transform, projection matrix not yet built). Checking
    // once at the source is why the arithmetic downstream needs no checks.
    return std::isfinite(outUnityX) && std::isfinite(outUnityY);
}

// ─────────────────────────────────────────────────────────────────────────────
// Refresh — resolves CameraManager and reads all values
// ─────────────────────────────────────────────────────────────────────────────
static void DoRefresh()
{
    g_camMgrPtr   = 0;
    g_unityCamPtr = 0;
    g_angle = g_zoom = g_posX = g_posY = 0.f;
    g_pixelRectX = g_pixelRectY = g_pixelRectW = g_pixelRectH = 0.f;

    // ── Cached CameraManager lookup — avoids FindObjectsByType every refresh ──
    auto ValidateCamMgr = [&]() -> bool {
        if (!Mem::AddrOk(s_cachedCamMgr)) return false;
        void* k = nullptr;
        if (!Resolver::Protection::safe_call([&](){
            k = *reinterpret_cast<void**>(s_cachedCamMgr);
        })) return false;
        return k == s_camMgrClass;
    };

    if (!ValidateCamMgr()) {
        if (!s_camMgrClass)
            s_camMgrClass = Resolver::FindClassLoose("CameraManager");
        if (!s_camMgrClass) {
            g_status  = "ERROR: CameraManager class not found.";
            g_statusOk = false;
            return;
        }
        auto cams = Resolver::FindObjectsByType(s_camMgrClass);
        if (cams.empty()) {
            s_cachedCamMgr = nullptr;
            g_status  = "CameraManager not found — not in-game?";
            g_statusOk = false;
            return;
        }
        s_cachedCamMgr = cams[0];
    }

    Il2CppObject* camMgrObj = s_cachedCamMgr;
    if (!Mem::AddrOk(camMgrObj)) {
        g_status  = "ERROR: CameraManager pointer invalid.";
        g_statusOk = false;
        return;
    }
    g_camMgrPtr = reinterpret_cast<uintptr_t>(camMgrObj);

    EnsureCameraMethods(camMgrObj);

    // ── Camera angle via mainCameraContainer Transform.eulerAngles.z ─────────
    // SetCameraAngle(int) rotates the mainCameraContainer Transform around Z.
    // Reading eulerAngles.z gives the actual current rotation in degrees.
    // (NHPPJHAMCBL getter returns 0 even after angle change — not the angle field)
    {
        void* xfrmForAngle = nullptr;
        Mem::TryRead(camMgrObj, RuntimeOffsets::CM_Transform, xfrmForAngle);
        if (Mem::AddrOk(xfrmForAngle) && s_getEulerAngles) {
            Il2CppObject* eulerObj = Resolver::Protection::SafeRuntimeInvoke(
                s_getEulerAngles, reinterpret_cast<Il2CppObject*>(xfrmForAngle), nullptr);
            if (eulerObj) {
                void* unboxed = il2cpp_object_unbox(eulerObj);
                if (unboxed) {
                    const float* v = reinterpret_cast<const float*>(unboxed);
                    g_angle = v[2];  // z = rotation around world Z axis (yaw)
                }
            }
        }
    }
    if (g_setAngle == 0 && g_angle != 0.f)
        g_setAngle = static_cast<int>(g_angle);

    // ── Zoom via orthographicSize property getter on the Unity Camera object ──
    // UnityEngine.Camera stores its data in native Unity memory — raw offset reads
    // don't work reliably. Must call the IL2CPP getter: Camera.get_orthographicSize().
    //
    // Resolve the CameraManager field whose type is UnityEngine.Camera at runtime.
    // The obfuscator reused the name "inputModule" for both the Camera field (0x50
    // in the Apr 6 dump) and a separate CustomInputModule field (0x58), so we can't
    // trust get_field_from_name alone — we iterate and disambiguate by type.
    uint32_t camFieldOff = RuntimeOffsets::CM_UnityCam; // hardcoded fallback
    bool     camFieldResolved = false;
    {
        Il2CppClass* cmKlass = il2cpp_object_get_class(camMgrObj);
        if (cmKlass) {
            void* iter = nullptr;
            while (true) {
                FieldInfo* f = il2cpp_class_get_fields(cmKlass, &iter);
                if (!f) break;
                const Il2CppType* ft = il2cpp_field_get_type(f);
                if (!ft) continue;
                Il2CppClass* fc = il2cpp_type_get_class_or_element_class(ft);
                if (!fc) continue;
                const char* tn = il2cpp_class_get_name(fc);
                if (tn && strcmp(tn, "Camera") == 0) {
                    camFieldOff      = static_cast<uint32_t>(il2cpp_field_get_offset(f));
                    camFieldResolved = true;
                    DBG_FILE_LOG("[CameraTAB] UnityCam field resolved dynamically: name=\""
                        << (il2cpp_field_get_name(f) ? il2cpp_field_get_name(f) : "?")
                        << "\" offset=0x" << std::hex << camFieldOff << std::dec);
                    break;
                }
            }
        }
        if (!camFieldResolved) {
            DBG_FILE_LOG("[CameraTAB] UnityCam field NOT found dynamically — using fallback 0x"
                << std::hex << RuntimeOffsets::CM_UnityCam << std::dec);
        }
    }
    void* unityCam = nullptr;
    Mem::TryRead(camMgrObj, camFieldOff, unityCam);
    if (Mem::AddrOk(unityCam)) {
        g_unityCamPtr = reinterpret_cast<uintptr_t>(unityCam);
        g_zoom = Resolver::GetProperty<float>(reinterpret_cast<Il2CppObject*>(unityCam), "orthographicSize");
        if (g_setZoom == 8.0f && IsPlausibleOrtho(g_zoom))
            g_setZoom = g_zoom;

        // ── Camera.pixelRect — the actual game viewport in pixels ────────────
        // Unity returns a Rect value type boxed as Il2CppObject*.
        // Unboxing yields [x, y, width, height] as 4 contiguous floats.
        // x/y = bottom-left corner (Unity Y-up), w/h = extent.
        if (s_getPixelRect) {
            Il2CppObject* camObj = reinterpret_cast<Il2CppObject*>(unityCam);
            Il2CppObject* res = Resolver::Protection::SafeRuntimeInvoke(s_getPixelRect, camObj, nullptr);
            if (res) {
                float* pr = reinterpret_cast<float*>(il2cpp_object_unbox(res));
                if (pr) {
                    g_pixelRectX = pr[0];
                    g_pixelRectY = pr[1];
                    g_pixelRectW = pr[2];
                    g_pixelRectH = pr[3];
                }
            }
        }
    }

    // ── Camera position via Transform.get_position() IL2CPP invoke ─────────────
    // Unity Transform stores position in native memory — raw reads at fixed offsets
    // return localPosition in local space (always 0,0 for anchored containers).
    // Call get_position() to get world-space coordinates.
    void* xfrm = nullptr;
    Mem::TryRead(camMgrObj, RuntimeOffsets::CM_Transform, xfrm);
    if (Mem::AddrOk(xfrm) && s_getPosition) {
        Il2CppObject* posObj = Resolver::Protection::SafeRuntimeInvoke(
            s_getPosition, reinterpret_cast<Il2CppObject*>(xfrm), nullptr);
        if (posObj) {
            void* unboxed = il2cpp_object_unbox(posObj);
            if (unboxed) {
                const float* v = reinterpret_cast<const float*>(unboxed);
                g_posX = v[0];  // Vector3.x
                g_posY = v[1];  // Vector3.y
            }
        }
    }

    // ── Offset mode (IOABMGFJLLP — "Toggle Centering of Player") ─────────────
    // IOABMGFJLLP is a bool property on CameraManager; getter = "get_IOABMGFJLLP".
    // true  → camera is NOT centred on the player (player can wander off-screen).
    // false → camera follows the player (default).
    if (s_getOffsetMode) {
        Il2CppObject* res = Resolver::Protection::SafeRuntimeInvoke(s_getOffsetMode, camMgrObj, nullptr);
        if (res) {
            void* ub = il2cpp_object_unbox(res);
            if (ub) g_offsetMode = *reinterpret_cast<bool*>(ub);
        }
    }

    char buf[80];
    snprintf(buf, sizeof(buf), "Refreshed.  Angle=%.1f  Zoom=%.2f  Pos=(%.1f,%.1f)",
        g_angle, g_zoom, g_posX, g_posY);
    g_status   = buf;
    g_statusOk = true;
}

// Apply a new zoom value by calling Camera.set_orthographicSize() via IL2CPP
static void ApplyZoom(float newZoom)
{
    Il2CppObject* unityCam = reinterpret_cast<Il2CppObject*>(g_unityCamPtr);
    if (!Mem::AddrOk(unityCam)) {
        // Lazy-resolve on first apply so the dashboard doesn't need the user to
        // open the DLL menu and click Refresh before camera controls work.
        DoRefresh();
        unityCam = reinterpret_cast<Il2CppObject*>(g_unityCamPtr);
        DBG_FILE_LOG("[ApplyZoom] DoRefresh after null ptr — unityCam=" << (void*)unityCam);
        if (!Mem::AddrOk(unityCam)) {
            g_status  = "ERROR: Unity Camera not resolved (lazy refresh failed).";
            g_statusOk = false;
            return;
        }
    }
    DBG_FILE_LOG("[ApplyZoom] writing orthographicSize=" << newZoom << " to unityCam=" << (void*)unityCam);
    Resolver::SetProperty<float>(unityCam, "orthographicSize", newZoom);
    g_zoom  = newZoom;
    char buf[64]; snprintf(buf, sizeof(buf), "Zoom set to %.2f", newZoom);
    g_status = buf; g_statusOk = true;
}

// Apply a new camera angle by calling SetCameraAngle(int) on the CameraManager
static void ApplyAngle(int newAngle)
{
    Il2CppObject* camMgrObj = reinterpret_cast<Il2CppObject*>(g_camMgrPtr);
    if (!Mem::AddrOk(camMgrObj)) {
        g_status  = "ERROR: CameraManager not resolved — press Refresh first.";
        g_statusOk = false;
        return;
    }
    if (!s_setCameraAngle) {
        g_status  = "ERROR: SetCameraAngle(int) method not resolved.";
        g_statusOk = false;
        return;
    }
    void* params[] = { &newAngle };
    Resolver::Protection::SafeRuntimeInvoke(s_setCameraAngle, camMgrObj, params);

    char buf[64]; snprintf(buf, sizeof(buf), "Angle set to %d", newAngle);
    g_status = buf; g_statusOk = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────────────────────
void CameraTAB::Render()
{
    // Auto-refresh tick
    const float dt = ImGui::GetIO().DeltaTime;
    if (g_autoRefresh) {
        g_autoTimer -= dt;
        if (g_autoTimer <= 0.f) {
            DoRefresh();
            g_autoTimer = g_autoInterval;
        }
    }

    ImGui::Spacing();
    ImGui::TextColored(ImVec4(0.4f, 0.85f, 1.0f, 1.0f), "CAMERA");
    ImGui::SameLine(0.f, 16.f);
    if (ImGui::Button("Refresh")) { DoRefresh(); g_autoTimer = g_autoInterval; }
    ImGui::SameLine();
    ImGui::Checkbox("Auto", &g_autoRefresh);
    if (g_autoRefresh) {
        ImGui::SameLine();
        ImGui::SetNextItemWidth(50.f);
        ImGui::DragFloat("##cival", &g_autoInterval, 0.1f, 0.2f, 10.f, "%.1fs");
    }
    ImGui::Separator();

    // Status
    {
        ImVec4 sc = g_statusOk ? ImVec4(0.5f,0.5f,0.5f,1.f) : ImVec4(1.f,0.3f,0.3f,1.f);
        ImGui::TextColored(sc, "%s", g_status.c_str());
    }

    if (g_camMgrPtr) {
        ImGui::Spacing();
        ImGui::TextDisabled("CameraManager  0x%llX", (unsigned long long)g_camMgrPtr);
        if (g_unityCamPtr)
            ImGui::TextDisabled("Unity Camera   0x%llX", (unsigned long long)g_unityCamPtr);
    }

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    // ── Live IOABMGFJLLP read — re-read every frame so in-game hotkey changes are tracked ──
    // BeeByte names the getter ANBDPNHJBHG (same VA as the property accessor get_IOABMGFJLLP).
    if (Mem::AddrOk(s_cachedCamMgr) && s_getOffsetMode) {
        Il2CppObject* res = Resolver::Protection::SafeRuntimeInvoke(
            s_getOffsetMode, s_cachedCamMgr, nullptr);
        if (res) {
            void* ub = il2cpp_object_unbox(res);
            if (ub) g_offsetMode = *reinterpret_cast<bool*>(ub);
        }
    }

    // ── CENTERING (IOABMGFJLLP / Toggle Centering of Player) ──────────────────
    ImGui::TextColored(ImVec4(0.8f, 0.6f, 1.0f, 1.0f), "CENTERING  (IOABMGFJLLP)");
    ImGui::Indent(8.f);
    bool centeringActive = FeatureState::GetCameraCenteringActive();
    bool centeredOnPlayer = FeatureState::GetCameraCentered();
    if (ImGui::Checkbox("Force centering##cam_force_center", &centeringActive))
        FeatureState::SetCameraCentering(centeringActive, centeredOnPlayer);
    if (centeringActive) {
        ImGui::SameLine();
        if (ImGui::Checkbox("Centered on player##cam_centered", &centeredOnPlayer))
            FeatureState::SetCameraCentering(true, centeredOnPlayer);
    }
    {
        const char* modeLabel = g_offsetMode ? "OFF  (player NOT centred)" : "ON  (following player)";
        ImVec4      modeCol   = g_offsetMode ? ImVec4(1.f, 0.4f, 0.3f, 1.f) : ImVec4(0.3f, 1.f, 0.5f, 1.f);
        ImGui::TextColored(modeCol, "State: %s", modeLabel);
    }
    ImGui::Spacing();
    ImGui::PushStyleColor(ImGuiCol_Button,        ImVec4(0.25f, 0.15f, 0.40f, 1.f));
    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.40f, 0.25f, 0.60f, 1.f));
    ImGui::PushStyleColor(ImGuiCol_ButtonActive,  ImVec4(0.18f, 0.10f, 0.28f, 1.f));
    if (ImGui::Button("Toggle Centering"))
        FeatureState::SetCameraCentering(true, g_offsetMode != 0);
    ImGui::PopStyleColor(3);
    ImGui::SameLine();
    ImGui::TextDisabled("(calls ChangeOffsetMode() — same as H key)");
    ImGui::Unindent(8.f);

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    // ── POSITION ──────────────────────────────────────────────────────────────
    ImGui::TextColored(ImVec4(0.8f,0.8f,0.4f,1.f), "POSITION  (mainCameraContainer)");
    ImGui::Indent(8.f);
    ImGui::Text("X: %.4f", g_posX);
    ImGui::SameLine(0.f, 20.f);
    ImGui::Text("Y: %.4f", g_posY);
    ImGui::Unindent(8.f);

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    // ── ANGLE ─────────────────────────────────────────────────────────────────
    ImGui::TextColored(ImVec4(0.4f,1.f,0.7f,1.f), "ANGLE  (Transform.eulerAngles.z — degrees)");
    ImGui::Indent(8.f);
    bool angleActive = FeatureState::GetCameraAngleActive();
    int angleValue = FeatureState::GetCameraAngleValue();
    if (ImGui::Checkbox("Lock angle##cam_lock_angle", &angleActive))
        FeatureState::SetCameraAngle(angleActive, angleValue);
    ImGui::Text("Current: %.4f", g_angle);
    ImGui::Spacing();
    ImGui::SetNextItemWidth(100.f);
    if (ImGui::InputInt("##angleInput", &angleValue, 1, 10)) {
        g_setAngle = angleValue;
        FeatureState::SetCameraAngle(angleActive, angleValue);
    }
    ImGui::SameLine();
    ImGui::PushStyleColor(ImGuiCol_Button,        ImVec4(0.15f,0.4f,0.15f,1.f));
    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.2f, 0.6f,0.2f, 1.f));
    ImGui::PushStyleColor(ImGuiCol_ButtonActive,  ImVec4(0.1f, 0.25f,0.1f,1.f));
    if (ImGui::Button("Set Angle")) FeatureState::SetCameraAngle(true, angleValue);
    ImGui::PopStyleColor(3);
    ImGui::SameLine();
    ImGui::TextDisabled("(calls SetCameraAngle(int))");
    ImGui::Unindent(8.f);

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    // ── ZOOM ──────────────────────────────────────────────────────────────────
    ImGui::TextColored(ImVec4(1.f,0.6f,0.3f,1.f), "ZOOM  (orthographicSize — smaller = closer)");
    ImGui::Indent(8.f);
    bool zoomActive = FeatureState::GetCameraZoomActive();
    float zoomValue = FeatureState::GetCameraZoomValue();
    if (ImGui::Checkbox("Lock zoom##cam_lock_zoom", &zoomActive))
        FeatureState::SetCameraZoom(zoomActive, zoomValue);
    ImGui::Text("Current: %.4f", g_zoom);
    ImGui::Spacing();
    ImGui::SetNextItemWidth(100.f);
    if (ImGui::DragFloat("##zoomInput", &zoomValue, 0.1f, 0.5f, 100.f, "%.2f")) {
        g_setZoom = zoomValue;
        FeatureState::SetCameraZoom(zoomActive, zoomValue);
    }
    ImGui::SameLine();
    ImGui::PushStyleColor(ImGuiCol_Button,        ImVec4(0.4f,0.2f,0.05f,1.f));
    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.6f,0.3f,0.1f, 1.f));
    ImGui::PushStyleColor(ImGuiCol_ButtonActive,  ImVec4(0.25f,0.12f,0.02f,1.f));
    if (ImGui::Button("Set Zoom")) FeatureState::SetCameraZoom(true, zoomValue);
    ImGui::PopStyleColor(3);
    ImGui::SameLine();
    ImGui::TextDisabled("(writes orthographicSize)");
    ImGui::Unindent(8.f);

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    // ── Preset angles ─────────────────────────────────────────────────────────
    ImGui::TextDisabled("Quick angle presets:");
    ImGui::Indent(8.f);
    const int presets[] = { 0, 45, 90, 135, 180, 225, 270, 315 };
    for (int i = 0; i < 8; ++i) {
        char lbl[12]; snprintf(lbl, sizeof(lbl), "%d##a%d", presets[i], i);
        if (i > 0) ImGui::SameLine();
        if (ImGui::Button(lbl)) {
            g_setAngle = presets[i];
            FeatureState::SetCameraAngle(true, presets[i]);
        }
    }
    ImGui::Unindent(8.f);

    // ── Preset zooms ──────────────────────────────────────────────────────────
    ImGui::Spacing();
    ImGui::TextDisabled("Quick zoom presets:");
    ImGui::Indent(8.f);
    const float zPresets[] = { 4.f, 6.f, 8.f, 10.f, 14.f, 20.f };
    const char* zLabels[]  = { "x4","x6","x8","x10","x14","x20" };
    for (int i = 0; i < 6; ++i) {
        char lbl[16]; snprintf(lbl, sizeof(lbl), "%s##z%d", zLabels[i], i);
        if (i > 0) ImGui::SameLine();
        if (ImGui::Button(lbl)) {
            g_setZoom = zPresets[i];
            FeatureState::SetCameraZoom(true, zPresets[i]);
        }
    }
    ImGui::Unindent(8.f);

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    // ── W2S / S2W DEBUG ───────────────────────────────────────────────────────
    ImGui::TextColored(ImVec4(0.6f, 0.8f, 1.f, 1.f), "W2S / S2W DEBUG");
    ImGui::Indent(8.f);

    {
        // Per-frame camera/W2S state — the shared CamState snapshot that also
        // feeds the Test-tab overlays (built once per frame by CamState::Tick).
        const CamState::Snapshot& cs = CamState::Get();
        float camX     = cs.camX;
        float camY     = cs.camY;
        float angleRad = cs.angleRad;
        float cx       = cs.cx;
        float cy       = cs.cy;
        float zoom     = cs.zoom;
        float screenW  = cs.screenW;
        float screenH  = cs.screenH;

        // OrthoSize / angle are shown straight from the camera state readouts.
        float angleDeg = g_angle;
        float ortho    = g_zoom;
        if (ortho == 0.f) ortho = 8.f;

        bool stateOk = (screenW > 0.f && (camX != 0.f || camY != 0.f));
        bool w2sOk   = TestTAB::IsW2SValid();

        ImGui::Text("State:  %s", stateOk ? "OK" : "waiting (refresh World + Camera)");
        if (stateOk) {
            ImGui::Text("  Player world:    (%.2f,  %.2f)", camX, camY);
            ImGui::Text("  Camera angle:    %.2f deg", angleDeg);
            ImGui::Text("  OrthoSize:       %.2f   |  zoom: %.2f px/tile", ortho, zoom);
            ImGui::Text("  Screen:          %.0f x %.0f", screenW, screenH);
            ImGui::Text("  Viewport centre: (%.0f, %.0f)  [cx, cy]", cx, cy);
            if (g_pixelRectW > 16.f)
                ImGui::Text("  PixelRect:       x=%.0f  w=%.0f  h=%.0f  (camera rect)",
                    g_pixelRectX, g_pixelRectW, g_pixelRectH);
            else
                ImGui::TextColored(ImVec4(1.f, 0.8f, 0.3f, 1.f),
                    "  PixelRect:       not yet read — refresh Camera tab first");
        }

        ImGui::Spacing();
        float msx = TestTAB::GetMouseScreenX();
        float msy = TestTAB::GetMouseScreenY();
        float mwx = TestTAB::GetMouseWorldX();
        float mwy = TestTAB::GetMouseWorldY();
        ImGui::Text("Mouse  screen:  (%.1f, %.1f)", msx, msy);
        ImGui::Text("Mouse  world:   (%.2f, %.2f)%s", mwx, mwy, w2sOk ? "" : "  [stale]");

        if (stateOk && w2sOk) {
            float rtSX, rtSY;
            W2S(mwx, mwy, rtSX, rtSY, camX, camY, angleRad, zoom, cx, cy);
            ImGui::Text("W2S roundtrip:  (%.1f, %.1f)  err=(%.2f, %.2f)",
                rtSX, rtSY, rtSX - msx, rtSY - msy);
            float dx = mwx - camX, dy = mwy - camY;
            ImGui::Text("World delta:    (%.2f, %.2f)   dist: %.2f tiles",
                dx, dy, sqrtf(dx*dx + dy*dy));
        }
    }
    ImGui::Unindent(8.f);
}

// ── Public API (for TestTAB / W2S) ───────────────────────────────────────────
namespace CameraTAB {
    void  ForceRefresh()
    {
        // Coalesce double-refreshes — TestTAB and DebugTAB both ForceRefresh
        // at ~100 ms with independent timers, so when they align we'd walk
        // the camera-state reads twice in one frame. 50 ms gate lets
        // scheduled ticks through but drops duplicates.
        static ULONGLONG s_lastRefreshMs = 0;
        const ULONGLONG nowMs = GetTickCount64();
        if (nowMs - s_lastRefreshMs < 50ULL) return;
        s_lastRefreshMs = nowMs;
        DoRefresh();
    }
    float GetAngle()         { return g_angle;    }
    float GetZoom()          { return g_zoom;     }
    void* GetCamMgrPtr()     { return reinterpret_cast<void*>(g_camMgrPtr); }
    float GetPixelRectX()    { return g_pixelRectX; }
    float GetPixelRectY()    { return g_pixelRectY; }
    float GetPixelRectW()    { return g_pixelRectW; }
    float GetPixelRectH()    { return g_pixelRectH; }
    bool  GetCenteringState(){ return g_offsetMode; }
    float GetCamWorldX()     { return g_posX; }
    float GetCamWorldY()     { return g_posY; }

    bool CalibrateScreenBasis(void* playerPtr, float clientW, float clientH,
                              ScreenBasis& out, bool refineScaleAndRotation)
    {
        if (!playerPtr || !(clientW > 0.f) || !(clientH > 0.f)) return false;

        auto* camObj = reinterpret_cast<Il2CppObject*>(g_unityCamPtr);
        if (!Mem::AddrOk(camObj)) 
            return false;

        if (!s_worldToScreenPointMethod) {
            Il2CppClass* klass = il2cpp_object_get_class(camObj);
            if (!klass) return false;
            s_worldToScreenPointMethod =
                il2cpp_class_get_method_from_name(klass, "WorldToScreenPoint", 1);
            if (!s_worldToScreenPointMethod) return false;
        }

        float renderW = 0.f, renderH = 0.f;
        if (!GetUnityScreenSize(renderW, renderH) || !(renderW > 0.f) || !(renderH > 0.f)) {
            renderW = clientW;
            renderH = clientH;
        }
        const float renderToClientX = clientW / renderW;
        const float renderToClientY = clientH / renderH;

        // Trust boundary: this is raw game memory at an offset that goes stale
        // on a game patch, so a bad read is plausible and would otherwise be
        // handed straight to Unity.
        Vec3 playerWorld{};
        if (!Mem::TryRead(playerPtr, RuntimeOffsets::KJ_Float3Pos, playerWorld)) return false;
        if (!std::isfinite(playerWorld.x) ||
                !std::isfinite(playerWorld.y) ||
                !std::isfinite(playerWorld.z))
            return false;

        float unityPlayerX,     unityPlayerY;
        float unityPlusWorldXx, unityPlusWorldXy;
        float unityPlusWorldYx, unityPlusWorldYy;
        if (!InvokeWorldToScreen(camObj, playerWorld, unityPlayerX, unityPlayerY)) return false;

        const float anchorScreenX = unityPlayerX * renderToClientX;
        const float anchorScreenY = (renderH - unityPlayerY) * renderToClientY;

        out.anchorTileX   = playerWorld.x;
        out.anchorTileY   = -playerWorld.y;
        out.anchorScreenX = anchorScreenX;
        out.anchorScreenY = anchorScreenY;
        out.hasAnchor     = true;
        out.hasScaleAndRotation = false;
        out.fitResidualPx       = -1.f;

        if (!refineScaleAndRotation) 
            return true;
        if (!InvokeWorldToScreen(camObj, Vec3{ playerWorld.x + 1.f, playerWorld.y, playerWorld.z },
                                 unityPlusWorldXx, unityPlusWorldXy)) 
            return true;
        if (!InvokeWorldToScreen(camObj, Vec3{ playerWorld.x, playerWorld.y + 1.f, playerWorld.z },
                                 unityPlusWorldYx, unityPlusWorldYy)) 
            return true;

        const float worldXAxisPxX = unityPlusWorldXx * renderToClientX - anchorScreenX;
        const float worldXAxisPxY = (renderH - unityPlusWorldXy) * renderToClientY - anchorScreenY;
        // NOTE: Unity +Y and ROTMG  +Y are inverted 
        const float worldYAxisPxX = -(unityPlusWorldYx * renderToClientX - anchorScreenX);
        const float worldYAxisPxY = -((renderH - unityPlusWorldYy) * renderToClientY - anchorScreenY);

        const float worldXAxisLenPx =
            std::sqrt(worldXAxisPxX * worldXAxisPxX + worldXAxisPxY * worldXAxisPxY);
        const float worldYAxisLenPx =
            std::sqrt(worldYAxisPxX * worldYAxisPxX + worldYAxisPxY * worldYAxisPxY);

        // Rejects a degenerate/zero-zoom projection. Written as `!(x > 1.f)` so
        // it also rejects NaN, which makes a separate isfinite check redundant.
        if (!(worldXAxisLenPx > 1.f) || !(worldYAxisLenPx > 1.f))
            return true;

        const float rotationRad   = std::atan2(worldXAxisPxY, worldXAxisPxX);
        const float pixelsPerTile = 0.5f * (worldXAxisLenPx + worldYAxisLenPx);

        const float expectedYAxisPxX = -std::sin(rotationRad) * pixelsPerTile;
        const float expectedYAxisPxY =  std::cos(rotationRad) * pixelsPerTile;
        const float residualX = worldYAxisPxX - expectedYAxisPxX;
        const float residualY = worldYAxisPxY - expectedYAxisPxY;
        out.fitResidualPx = std::sqrt(residualX * residualX + residualY * residualY);

        out.pixelsPerTile        = pixelsPerTile;
        out.rotationRad          = rotationRad;
        out.hasScaleAndRotation  = true;
        return true;
    }
    void  SetZoomValue(float zoom)
    {
        // Always apply — the cached g_zoom may be stale if DoRefresh() hasn't run.
        // ApplyZoom updates g_zoom after writing, so back-to-back identical calls are cheap.
        ApplyZoom(zoom);
    }
    void  SetAngleDegrees(int angleDeg)
    {
        // Always apply — g_angle may be stale (only updated by DoRefresh).
        ApplyAngle(angleDeg);
    }
    void  SetCenteredOnPlayer(bool centered)
    {
        if (!Mem::AddrOk(reinterpret_cast<void*>(g_camMgrPtr)))
            return;
        // Read live state instead of relying on cached g_offsetMode which may be stale.
        // The Render() function reads the live getter every frame, so piggyback on s_cachedCamMgr.
        bool liveOffsetMode = g_offsetMode;
        if (Mem::AddrOk(s_cachedCamMgr) && s_getOffsetMode) {
            Il2CppObject* res = Resolver::Protection::SafeRuntimeInvoke(
                s_getOffsetMode, s_cachedCamMgr, nullptr);
            if (res) {
                void* ub = il2cpp_object_unbox(res);
                if (ub) liveOffsetMode = *reinterpret_cast<bool*>(ub);
            }
        }
        const bool currentlyCentered = !liveOffsetMode;
        if (currentlyCentered == centered)
            return;
        if (!s_changeOffsetMode)
            return;
        Il2CppObject* camMgrObj = reinterpret_cast<Il2CppObject*>(g_camMgrPtr);
        Resolver::Protection::SafeRuntimeInvoke(s_changeOffsetMode, camMgrObj, nullptr);
        g_offsetMode = !centered;
    }
}
