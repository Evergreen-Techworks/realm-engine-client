#include "pch-il2cpp.h"
#include "PlayerCollider.h"
#include "Il2CppResolver.h"
#include "RuntimeOffsets.h"
#include "MemRead.h"

#include <cstring>

namespace PlayerCollider {
namespace {

constexpr size_t kMaxObjectPropertiesTargets = 3;
constexpr size_t kMaxEntityCandidates = 2;

// One tracked ObjectProperties object: the captured pre-hack game value so the
// collider can be restored exactly when the feature is turned off.
struct TrackedProperty {
    void* ptr = nullptr;
    float originalMultiplier = 0.0f;
    bool  hasOriginal = false;
};

bool g_enabled = false;

float g_multiplier = 1.0f;
void* g_lastPlayer = nullptr;
TrackedProperty g_tracked[kMaxObjectPropertiesTargets]{};
size_t g_trackedCount = 0;

struct EntityCandidate {
    void* ptr = nullptr;
};

bool TryGetObjectClass(void* object, Il2CppClass*& outClass)
{
    outClass = nullptr;
    if (!Resolver::Protection::IsValidIl2CppObject(object)) return false;
    return Resolver::Protection::safe_call([&]() {
        outClass = il2cpp_object_get_class(reinterpret_cast<Il2CppObject*>(object));
    }) && outClass != nullptr;
}

bool ClassHierarchyHas(Il2CppClass* klass, const char* expectedName)
{
    if (!klass || !expectedName) return false;
    bool matched = false;
    Resolver::Protection::safe_call([&]() {
        for (Il2CppClass* current = klass; current; current = il2cpp_class_get_parent(current)) {
            const char* name = il2cpp_class_get_name(current);
            if (name && std::strcmp(name, expectedName) == 0) {
                matched = true;
                break;
            }
        }
    });
    return matched;
}

bool IsObjectPropertiesInstance(void* properties)
{
    Il2CppClass* propertiesClass = nullptr;
    return TryGetObjectClass(properties, propertiesClass) &&
           ClassHierarchyHas(propertiesClass, "ObjectProperties");
}

void* ResolveViewDestroyEntity(void* localPlayer)
{
    void* viewHandler = Mem::ReadPtr(localPlayer, RuntimeOffsets::KJ_ViewHandler);
    return Mem::ReadPtr(viewHandler, RuntimeOffsets::VH_DestroyEntity);
}

bool ReadCollisionMultiplier(void* properties, float& out)
{
    return Mem::TryRead(properties, RuntimeOffsets::OP_CollRadiusMult, out);
}

bool WriteCollisionMultiplier(void* properties, float value)
{
    return Mem::TryWrite(properties, RuntimeOffsets::OP_CollRadiusMult, value);
}

// Carry over a previously-captured original for an object we still track, so
// the per-frame zeroing never clobbers the genuine game value with our own 0.
bool FindTrackedOriginal(void* properties, float& outOriginal)
{
    for (size_t i = 0; i < g_trackedCount; ++i) {
        if (g_tracked[i].ptr == properties && g_tracked[i].hasOriginal) {
            outOriginal = g_tracked[i].originalMultiplier;
            return true;
        }
    }
    return false;
}

// Write each captured game value back to the collider we zeroed, then drop the
// tracking set. Used when the feature is turned off while the scene is live.
void RestoreTrackedColliders()
{
    for (size_t i = 0; i < g_trackedCount; ++i) {
        if (g_tracked[i].ptr && g_tracked[i].hasOriginal && Mem::AddrOk(g_tracked[i].ptr))
            WriteCollisionMultiplier(g_tracked[i].ptr, g_tracked[i].originalMultiplier);
    }
    for (TrackedProperty& tracked : g_tracked) tracked = TrackedProperty{};
    g_trackedCount = 0;
}

// Drop the tracking set without restoring — the underlying objects are gone
// (player/scene change), so there is no live collider left to restore.
void ForgetTrackedColliders()
{
    for (TrackedProperty& tracked : g_tracked) tracked = TrackedProperty{};
    g_trackedCount = 0;
}

bool AddObjectPropertiesTarget(void** properties, size_t& propertyCount, void* candidate)
{
    if (!candidate || propertyCount >= kMaxObjectPropertiesTargets) return false;
    for (size_t i = 0; i < propertyCount; ++i) {
        if (properties[i] == candidate) return false;
    }
    properties[propertyCount++] = candidate;
    return true;
}

size_t CollectPlayerObjectProperties(void* entity, const ObjectPropertiesTarget* targets, size_t targetCount, void** outProperties, size_t outCapacity)
{
    if (!entity || !targets || outCapacity == 0) return 0;

    Il2CppClass* entityClass = nullptr;
    if (!TryGetObjectClass(entity, entityClass) || !ClassHierarchyHas(entityClass, "FKALGHJIADI"))
        return 0;

    size_t propertyCount = 0;
    const size_t count = targetCount < outCapacity ? targetCount : outCapacity;
    for (size_t i = 0; i < count; ++i) {
        const uint32_t offset = targets[i].offset;
        void* properties = Mem::ReadPtr(entity, offset);
        if (!IsObjectPropertiesInstance(properties)) continue;
        AddObjectPropertiesTarget(outProperties, propertyCount, properties);
    }
    return propertyCount;
}

} // namespace

bool ApplyEntityMultiplier(void* entityPtr,
    uint32_t primaryObjectPropertiesOffset,
    uint32_t secondaryObjectPropertiesOffset,
    uint32_t collisionMultiplierOffset,
    const char* reason,
    UpdateLogFn logFn)
{
    const ObjectPropertiesTarget targets[] = {
        { "primary", primaryObjectPropertiesOffset },
        { "secondary", secondaryObjectPropertiesOffset },
    };
    return ApplyEntityMultiplierTargets(entityPtr, targets, 2, collisionMultiplierOffset, reason, logFn);
}

bool ApplyEntityMultiplierTargets(void* entityPtr,
    const ObjectPropertiesTarget* targets,
    size_t targetCount,
    uint32_t collisionMultiplierOffset,
    const char* reason,
    UpdateLogFn logFn)
{
    if (!entityPtr || !targets || targetCount == 0) return false;

    bool updated = false;
    void* visited[kMaxObjectPropertiesTargets]{};
    size_t visitedCount = 0;
    const size_t count = targetCount < kMaxObjectPropertiesTargets ? targetCount : kMaxObjectPropertiesTargets;
    for (size_t i = 0; i < count; ++i) {
        void* properties = Mem::ReadPtr(entityPtr, targets[i].offset);
        if (!properties) continue;

        bool duplicate = false;
        for (size_t seen = 0; seen < visitedCount; ++seen) {
            if (visited[seen] == properties) {
                duplicate = true;
                break;
            }
        }
        if (duplicate) continue;
        visited[visitedCount++] = properties;

        __try {
            float& multiplier = *reinterpret_cast<float*>(reinterpret_cast<uint8_t*>(properties) + collisionMultiplierOffset);
            updated = ApplyMultiplier(multiplier, properties, reason, logFn) || updated;
        }
        __except (EXCEPTION_EXECUTE_HANDLER) {}
    }

    return updated;
}

void Tick(void* player)
{
    // Feature off: undo anything we applied (once), then stay out of the game's
    // way. This is what makes the collider behave when autododge is disabled.
    if (!g_enabled) {
        if (g_trackedCount) RestoreTrackedColliders();
        g_lastPlayer = player;
        return;
    }

    if (!player) {
        if (g_lastPlayer) ResetScene();
        return;
    }

    const ObjectPropertiesTarget targets[] = {
        { "base", RuntimeOffsets::ObjProps },
        { "map-object", RuntimeOffsets::MoObjectProps },
        { "player-collision", RuntimeOffsets::PlayerCollisionProps },
    };

    EntityCandidate entities[kMaxEntityCandidates] = {
        { player },
        { ResolveViewDestroyEntity(player) },
    };
    if (entities[1].ptr == entities[0].ptr) entities[1].ptr = nullptr;

    void* properties[kMaxObjectPropertiesTargets]{};
    size_t propertyCount = 0;
    for (const EntityCandidate& entity : entities) {
        void* entityProperties[kMaxObjectPropertiesTargets]{};
        const size_t entityPropertyCount = CollectPlayerObjectProperties(entity.ptr, targets, 3, entityProperties, kMaxObjectPropertiesTargets);
        for (size_t i = 0; i < entityPropertyCount; ++i)
            AddObjectPropertiesTarget(properties, propertyCount, entityProperties[i]);
    }

    if (propertyCount == 0)
        return;

    // Rebuild the tracking set: keep the captured original for objects we already
    // track, capture a fresh one for newcomers, then force each collider to the
    // target multiplier (g_multiplier).
    TrackedProperty next[kMaxObjectPropertiesTargets]{};
    size_t nextCount = 0;
    for (size_t i = 0; i < propertyCount; ++i) {
        void* propertiesPtr = properties[i];
        TrackedProperty entry;
        entry.ptr = propertiesPtr;

        float carried = 0.0f;
        if (FindTrackedOriginal(propertiesPtr, carried)) {
            entry.originalMultiplier = carried;
            entry.hasOriginal = true;
        } else {
            // Only a finite, non-zero read is the genuine game value. A zero is
            // almost certainly our own prior write, and capturing it would make
            // the eventual restore a silent no-op.
            float current = 0.0f;
            if (ReadCollisionMultiplier(propertiesPtr, current) && std::isfinite(current) && current != 0.0f) {
                entry.originalMultiplier = current;
                entry.hasOriginal = true;
            }
        }

        WriteCollisionMultiplier(propertiesPtr, g_multiplier);
        next[nextCount++] = entry;
    }

    for (size_t i = 0; i < kMaxObjectPropertiesTargets; ++i)
        g_tracked[i] = (i < nextCount) ? next[i] : TrackedProperty{};
    g_trackedCount = nextCount;

    g_lastPlayer = player;
}

void SetEnabled(bool enabled)
{
    g_enabled = enabled;
}

bool IsEnabled()
{
    return g_enabled;
}

void SetMultiplier(float multiplier)
{
    if (!std::isfinite(multiplier)) return;
    if (multiplier < 0.0f) multiplier = 0.0f;
    if (multiplier > 1.0f) multiplier = 1.0f;
    g_multiplier = multiplier;
}

float GetMultiplier()
{
    return g_multiplier;
}

void ResetScene()
{
    g_lastPlayer = nullptr;
    ForgetTrackedColliders();
}

void ResetStateForTest()
{
    g_enabled = false;
    g_multiplier = 1.0f;
    g_lastPlayer = nullptr;
    ForgetTrackedColliders();
}

} // namespace PlayerCollider
