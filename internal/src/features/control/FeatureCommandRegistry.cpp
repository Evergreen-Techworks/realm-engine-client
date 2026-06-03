// Purpose: maps validated IPC feature commands to the concrete feature, GUI, and
// runtime setters that actually update client behavior.

// Helpful notes:
// - IpcBridge parses and authenticates setFeature messages before reaching here.
// - FeatureCommand converts fixed string buffers into bool/int/float/text values.
// - Some commands update FeatureState for deferred runtime application, while
//   others call feature modules immediately when that is the established API.
// - Unknown keys are intentionally treated as applied after all groups are tried;
//   this keeps the IPC command stream tolerant of client/server version skew.

#include "pch-il2cpp.h"
#include "IpcBridge.h"
#include "main.h"
#include "DbgFileLog.h"
#include "AutoAim.h"
#include "ProjNoclip.h"
#include "PlayerCollider.h"
#include "FpsSetter.h"
#include "GhostHit.h"
#include "gui/tabs/TestTAB.h"
#include "DangerPlanner.h"
#include "XDodge.h"
#include "RolloutDodge.h"
#include "ZaclinDodge.h"
#include "SpeedHack.h"
#include <string>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include "FeatureState.h"
#include "FloatingTextService.h"
#include "FeatureCommandRegistry.h"

bool FeatureCommand::Is(const char* name) const { return strcmp(key, name) == 0; }
bool FeatureCommand::Bool() const { return strcmp(value, "true") == 0 || strcmp(value, "1") == 0; }
int FeatureCommand::Int() const { return atoi(value); }
float FeatureCommand::Float() const { return static_cast<float>(atof(value)); }

namespace {

    int ResolveHotkeyVkInternal(const char* raw)
    {
        if (!raw) return 0;
        std::string key;
        for (const char* p = raw; *p; ++p) {
            const unsigned char ch = static_cast<unsigned char>(*p);
            if (!std::isspace(ch)) key.push_back(static_cast<char>(std::toupper(ch)));
        }
        if (key.empty() || key == "NONE" || key == "OFF") return 0;
        if (key.rfind("VK_", 0) == 0) key.erase(0, 3);
        if (key.size() == 1) {
            const char ch = key[0];
            if ((ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')) return static_cast<int>(ch);
        }
        if (key.size() >= 2 && key[0] == 'F') {
            const int fn = atoi(key.c_str() + 1);
            if (fn >= 1 && fn <= 24) return VK_F1 + (fn - 1);
        }
        if (key.rfind("NUMPAD", 0) == 0) {
            const int n = atoi(key.c_str() + 6);
            if (n >= 0 && n <= 9) return VK_NUMPAD0 + n;
        }
        static const std::pair<const char*, int> named[] = {{"SPACE", VK_SPACE}, {"TAB", VK_TAB}, {"ESC", VK_ESCAPE}, {"ESCAPE", VK_ESCAPE}, {"SHIFT", VK_SHIFT}, {"CTRL", VK_CONTROL}, {"CONTROL", VK_CONTROL}, {"ALT", VK_MENU}, {"MENU", VK_MENU}, {"INSERT", VK_INSERT}, {"INS", VK_INSERT}, {"DELETE", VK_DELETE}, {"DEL", VK_DELETE}, {"HOME", VK_HOME}, {"END", VK_END}, {"PAGEUP", VK_PRIOR}, {"PGUP", VK_PRIOR}, {"PAGEDOWN", VK_NEXT}, {"PGDN", VK_NEXT}, {"UP", VK_UP}, {"DOWN", VK_DOWN}, {"LEFT", VK_LEFT}, {"RIGHT", VK_RIGHT}};
        for (const auto& kv : named) if (key == kv.first) return kv.second;
        return 0;
    }

    struct FeatureHandler { const char* key; bool (*apply)(const FeatureCommand&); };

    bool ApplyFeatureTable(const FeatureCommand& f, const FeatureHandler* handlers, size_t count)
    {
        for (size_t i = 0; i < count; ++i)
            if (f.Is(handlers[i].key)) return handlers[i].apply(f);
        return false;
    }

#define FH(key, body) { key, [](const FeatureCommand& f)->bool { body; return true; } }
#define FH_BOOL(key, fn) FH(key, fn(f.Bool()))
#define FH_INT(key, fn) FH(key, fn(f.Int()))
#define FH_INT_BOOL(key, fn) FH(key, fn(f.Int() != 0))
#define FH_FLOAT(key, fn) FH(key, fn(f.Float()))
#define FH_TEXT(key, fn) FH(key, fn(f.value))

    bool ApplyCoreFeature(const FeatureCommand& f)
    {
        static const FeatureHandler h[] = {
            FH_BOOL("overlayEnabled", IpcBridge_SetOverlayEnabled),
            FH("internalUnloadDll", {
                if (f.Bool()) {
                    DBG_FILE_LOG("[IpcBridge] internalUnloadDll requested.");
                    IpcBridge_RequestShutdown();
                    if (hUnloadEvent) SetEvent(hUnloadEvent);
                }
            }),
            FH_BOOL("autoAimEnabled", IpcBridge_SetAutoAimEnabled),
            FH_INT("autoAimMode", IpcBridge_SetAutoAimMode),
            FH_BOOL("autoAimPrioritizeBosses", AutoAim::SetPrioritizeBosses),
            FH_BOOL("autoAimIgnoreWalls", AutoAim::SetIgnoreWalls),
            FH("projectileNoclipEnabled", {
                const bool on = f.Bool();
                FeatureState::SetProjectileNoclipEnabled(on);
                if (!on) ProjNoclip::SetEnabled(false);
            }),
            FH("playerColliderSceneReset", PlayerCollider::ResetScene()),
            FH("clientDefense", FeatureState::SetClientDefense(static_cast<int32_t>(f.Int()))),
            FH("clientClassType", FeatureState::SetClientClassType(static_cast<int32_t>(f.Int()))),
            FH_INT("autoDodgeMode", IpcBridge_SetAutoDodgeMode),
            FH_FLOAT("autoDodgeHorizonMs", IpcBridge_SetAutoDodgeHorizonMs),
            FH_FLOAT("autoDodgeHitboxPadding", IpcBridge_SetAutoDodgeHitboxPadding),
            FH_BOOL("autoDodgeWallAvoid", IpcBridge_SetAutoDodgeWallAvoid),
            FH_FLOAT("speedHackMult", SpeedHack::SetMultiplier),
            FH_BOOL("autoAbilityEnabled", IpcBridge_SetAutoAbilityEnabled),
            FH_FLOAT("autoAbilityMpPct", IpcBridge_SetAutoAbilityMpPct),
            FH_INT("autoAbilityWizardMode", IpcBridge_SetAutoAbilityWizardMode),
            FH_INT("targetFrameRate", FpsSetter::SetTargetFps),
            FH_TEXT("showPluginFloatingText", FloatingTextService::QueuePluginText)
        };
        return ApplyFeatureTable(f, h, sizeof(h) / sizeof(h[0]));
    }

    bool ApplyXDodgeFeature(const FeatureCommand& f)
    {
        static const FeatureHandler h[] = {
            FH_FLOAT("xdodgeHitScale", XDodge::SetHitScale),
            FH_INT("xdodgeRebuildN", XDodge::SetRebuildN),
            FH_FLOAT("xdodgePlanStepMs", XDodge::SetPlanStepMs),
            FH_FLOAT("xdodgeSearchRadius", XDodge::SetSearchRadius),
            FH_INT_BOOL("xdodgeAstar", XDodge::SetAstarEnabled),
            FH_INT_BOOL("xdodgeWeighting", XDodge::SetWeightingEnabled),
            FH_INT_BOOL("xdodgeSmartGoal", XDodge::SetSmartGoalEnabled),
            FH_INT_BOOL("xdodgePerpBias", XDodge::SetPerpEnabled),
            FH_INT_BOOL("xdodgeSpeedMatch", XDodge::SetSpeedMatchEnabled),
            FH_INT_BOOL("xdodgeLockFollow", DangerPlanner::SetLockFollowEnabled),
            FH_INT("xdodgeAutoLock", DangerPlanner::SetAutoLockMode),
            FH_INT_BOOL("xdodgeWalkCache", XDodge::SetWalkCacheEnabled),
            FH_INT_BOOL("xdodgeWallAvoid", XDodge::SetWallAvoidEnabled),
            FH_INT_BOOL("xdodgeArbiter", XDodge::SetArbiterEnabled),
            FH_INT_BOOL("xdodgeBfsBias", XDodge::SetBfsBiasEnabled),
            FH_INT_BOOL("xdodgeCcd", XDodge::SetCcdEnabled),
            FH_FLOAT("xdodgeCcdPad", XDodge::SetCcdPad),
            FH_INT_BOOL("xdodgeCatalog", XDodge::SetCatalogEnabled),
            FH("xdodgeNotifyHit", XDodge::OnPlayerHit()),
            FH_INT_BOOL("xdodgeDrawPath", XDodge::SetDrawPathEnabled),
            FH_INT_BOOL("xdodgeDrawProjPred", XDodge::SetDrawProjPredEnabled),
            FH_FLOAT("xdodgeDebugPredLongMs", XDodge::SetDebugPredLongMs),
            FH_INT_BOOL("xdodgeAvoidEnemies", XDodge::SetAvoidEnemiesEnabled),
            FH_INT_BOOL("xdodgeGhostHit", GhostHit::SetEnabled),
            FH_INT_BOOL("xdodgeLosGoal", XDodge::SetLosGoalEnabled),
            FH_INT_BOOL("xdodgeWasdYield", XDodge::SetWasdYieldEnabled),
            FH_INT_BOOL("xdodgeLateralPref", XDodge::SetLateralPrefEnabled),
            FH_INT_BOOL("xdodgeGoalSticky", XDodge::SetGoalStickyEnabled),
            FH_FLOAT("xdodgeDangerPenalty", XDodge::SetDangerWeight)
        };
        if (ApplyFeatureTable(f, h, sizeof(h) / sizeof(h[0]))) return true;
        if (f.Is("xdodgeStayPenalty") || f.Is("xdodgeFutureSample") || f.Is("xdodgeFutureHorizon") || f.Is("xdodgeFutureStride")) return true;
        return false;
    }

    bool ApplyRolloutFeature(const FeatureCommand& f)
    {
        static const FeatureHandler h[] = {
            FH_FLOAT("rolloutHorizonTicks", RolloutDodge::SetHorizonTicks),
            FH_FLOAT("rolloutSampleStepMs", RolloutDodge::SetSampleStepMs),
            FH_INT("rolloutHeadings", RolloutDodge::SetHeadingCount),
            FH_FLOAT("rolloutHitScale", RolloutDodge::SetHitScale),
            FH_FLOAT("rolloutIntentWeight", RolloutDodge::SetIntentWeight),
            FH_INT("rolloutRebuildN", RolloutDodge::SetRebuildN),
            FH_INT_BOOL("rolloutForceBrute", RolloutDodge::SetForceBruteForce),
            FH_INT_BOOL("rolloutAvoidEnemies", RolloutDodge::SetAvoidEnemiesEnabled),
            FH_INT_BOOL("rolloutWasdYield", RolloutDodge::SetWasdYieldEnabled),
            FH_INT_BOOL("rolloutCommitDwell", RolloutDodge::SetCommitDwellEnabled),
            FH_INT_BOOL("rolloutDrawPath", RolloutDodge::SetDrawPathEnabled)
        };
        return ApplyFeatureTable(f, h, sizeof(h) / sizeof(h[0]));
    }

    bool ApplyZDodgeFeature(const FeatureCommand& f)
    {
        static const FeatureHandler h[] = {
            FH_FLOAT("zdodgeReactWindowMs", ZaclinDodge::SetReactWindowMs),
            FH_FLOAT("zdodgeMaxMoveTiles", ZaclinDodge::SetMaxMoveTiles),
            FH_FLOAT("zdodgePlayerRadius", ZaclinDodge::SetPlayerRadius),
            FH_FLOAT("zdodgeProjectileHitScale", ZaclinDodge::SetProjectileHitScale),
            FH_FLOAT("zdodgeProjectileRadiusFallback", ZaclinDodge::SetProjectileRadiusFallback),
            FH_FLOAT("zdodgeClearanceTiles", ZaclinDodge::SetClearanceTiles),
            FH_FLOAT("zdodgeSampleStepMs", ZaclinDodge::SetSampleStepMs),
            FH_FLOAT("zdodgePerpWeight", ZaclinDodge::SetPerpWeight),
            FH_FLOAT("zdodgeIntentWeight", ZaclinDodge::SetIntentWeight),
            FH_FLOAT("zdodgeClearanceWeight", ZaclinDodge::SetClearanceWeight),
            FH_FLOAT("zdodgeBackpedalPenalty", ZaclinDodge::SetBackpedalPenalty),
            FH_FLOAT("zdodgeEnemyAvoidanceRadius", ZaclinDodge::SetEnemyAvoidanceRadius),
            FH_FLOAT("zdodgeDamageThresholdPct", ZaclinDodge::SetDamageThresholdPct),
            FH_INT_BOOL("zdodgeDebugOverlay", ZaclinDodge::SetDebugOverlay),
            FH_INT_BOOL("zdodgeCandidateOverlay", ZaclinDodge::SetCandidateOverlay)
        };
        return ApplyFeatureTable(f, h, sizeof(h) / sizeof(h[0]));
    }

    bool ApplyInputCameraSkinFeature(const FeatureCommand& f)
    {
        static const FeatureHandler h[] = {
            FH("playerNoclipActive",      FeatureState::SetPlayerNoclipActive(f.Bool())),
            FH("playerNoclipEnabled",     FeatureState::SetPlayerNoclipEnabled(f.Bool())),
            FH("playerNoclipHotkey",      FeatureState::SetPlayerNoclipHotkeyVk(ResolveHotkeyVkInternal(f.value))),
            FH("socketHotkeyActive",      FeatureState::SetSocketHotkeyActive(f.Bool())),
            FH("socketHotkey",            FeatureState::SetSocketHotkeyVk(ResolveHotkeyVkInternal(f.value))),
            FH("walkTargetX",             FeatureState::SetWalkTarget(f.Float(), FeatureState::GetWalkTargetY(), FeatureState::GetWalkTargetActive())),
            FH("walkTargetY",             FeatureState::SetWalkTarget(FeatureState::GetWalkTargetX(), f.Float(), FeatureState::GetWalkTargetActive())),
            FH("walkTargetActive",        FeatureState::SetWalkTarget(FeatureState::GetWalkTargetX(), FeatureState::GetWalkTargetY(), f.Bool())),
            FH("cameraZoomActive",        FeatureState::SetCameraZoom(f.Bool(), FeatureState::GetCameraZoomValue())),
            FH("cameraZoomValue",         FeatureState::SetCameraZoom(FeatureState::GetCameraZoomActive(), f.Float())),
            FH("cameraAngleActive",       FeatureState::SetCameraAngle(f.Bool(), FeatureState::GetCameraAngleValue())),
            FH("cameraAngleValue",        FeatureState::SetCameraAngle(FeatureState::GetCameraAngleActive(), f.Int())),
            FH("cameraCenteringActive",   FeatureState::SetCameraCentering(f.Bool(), FeatureState::GetCameraCentered())),
            FH("cameraCentered",          FeatureState::SetCameraCentering(FeatureState::GetCameraCenteringActive(), f.Bool())),
            FH("skinOverrideEnabled",     FeatureState::SetSkinOverride(f.Bool(), FeatureState::GetSkinOverrideId())),
            FH("skinOverrideId",          FeatureState::SetSkinOverride(FeatureState::GetSkinOverrideEnabled(), f.Int()))
        };
        return ApplyFeatureTable(f, h, sizeof(h) / sizeof(h[0]));
    }

    bool ApplyDangerPlannerFeature(const FeatureCommand& f)
    {
        static const FeatureHandler h[] = {
            FH_FLOAT("dodgeWasdLookahead", DangerPlanner::SetWasdLookahead),
            FH_FLOAT("dodgeTightLeash", DangerPlanner::SetTightLeashRadius),
            FH_FLOAT("dodgeIdleMinGain", DangerPlanner::SetIdleMinGain),
            FH_FLOAT("dodgeStickiness", DangerPlanner::SetStickiness),
            FH_BOOL("dodgeReplanOnSpawn", DangerPlanner::SetReplanOnHazardSpawn),
            FH_BOOL("dodgeStrategicBias", DangerPlanner::SetStrategicBiasEnabled),
            FH_BOOL("dodgeStrategicNearWaypoint", DangerPlanner::SetStrategicUseNearWaypoint),
            FH_FLOAT("dodgeHitAversion", DangerPlanner::SetHitAversion),
            FH_FLOAT("dodgeHitScale", DangerPlanner::SetDodgeHitScale)
        };
        return ApplyFeatureTable(f, h, sizeof(h) / sizeof(h[0]));
    }

#undef FH_TEXT
#undef FH_FLOAT
#undef FH_INT_BOOL
#undef FH_INT
#undef FH_BOOL
#undef FH

} // namespace

namespace FeatureCommandRegistry {

    int ResolveHotkeyVk(const char* raw) { return ResolveHotkeyVkInternal(raw); }

    bool Apply(const FeatureCommand& feature)
    {
        if (ApplyCoreFeature(feature)) return true;
        if (ApplyXDodgeFeature(feature)) return true;
        if (ApplyZDodgeFeature(feature)) return true;
        if (ApplyRolloutFeature(feature)) return true;
        if (ApplyInputCameraSkinFeature(feature)) return true;
        ApplyDangerPlannerFeature(feature);
        return true;
    }

} // namespace FeatureCommandRegistry
