#include "pch-il2cpp.h"
#include "PlayerCollider.h"
#include "Il2CppResolver.h"
#include "RuntimeOffsets.h"

#include <cstring>

namespace PlayerCollider {
namespace {

// 6.13.0.1.0: ObjectProperties.collisionRadiusMultiplier sits at 0x798 (0x780 is
// now the hasTopAnimation bool). Only used until the by-name resolve below wins.
constexpr uint32_t kOffCollisionMultiplierFallback = 0x798;
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
uint32_t g_collisionMultiplierOffset = kOffCollisionMultiplierFallback;

struct EntityCandidate {
    void* ptr = nullptr;
};

bool IsPlausiblePointer(const void* ptr)
{
    const uintptr_t address = reinterpret_cast<uintptr_t>(ptr);
    return address > 0x10000ULL && address < 0x7FFFFFFFFFFFULL;
}

FieldInfo* FindFieldOnHierarchy(Il2CppClass* klass, const char* fieldName)
{
    for (Il2CppClass* current = klass; current; current = il2cpp_class_get_parent(current)) {
        FieldInfo* field = il2cpp_class_get_field_from_name(current, fieldName);
        if (field) return field;
    }
    return nullptr;
}

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

bool ResolveFieldOffset(Il2CppClass* klass, const char* fieldName, uint32_t fallback, uint32_t& outOffset, bool& outFromMetadata)
{
    outOffset = fallback;
    outFromMetadata = false;
    if (!klass || !fieldName) return false;

    FieldInfo* field = nullptr;
    if (!Resolver::Protection::safe_call([&]() {
        field = FindFieldOnHierarchy(klass, fieldName);
    }) || !field) {
        return false;
    }

    return Resolver::Protection::safe_call([&]() {
        outOffset = static_cast<uint32_t>(il2cpp_field_get_offset(field));
        outFromMetadata = true;
    });
}

void* ReadPointerRef(void* basePtr, uint32_t offset)
{
    if (!basePtr || offset == 0) return nullptr;
    void* ptr = nullptr;
    __try {
        ptr = *reinterpret_cast<void**>(reinterpret_cast<uint8_t*>(basePtr) + offset);
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        ptr = nullptr;
    }
    return IsPlausiblePointer(ptr) ? ptr : nullptr;
}

void* ReadObjectPropertiesRef(void* entityPtr, uint32_t offset)
{
    return ReadPointerRef(entityPtr, offset);
}

bool ResolveCollisionMultiplierOffset(void* properties)
{
    Il2CppClass* propertiesClass = nullptr;
    if (!TryGetObjectClass(properties, propertiesClass) || !ClassHierarchyHas(propertiesClass, "ObjectProperties"))
        return false;

    uint32_t offset = kOffCollisionMultiplierFallback;
    bool fromMetadata = false;
    ResolveFieldOffset(propertiesClass, "collisionRadiusMultiplier", kOffCollisionMultiplierFallback, offset, fromMetadata);
    (void)fromMetadata;
    g_collisionMultiplierOffset = offset;
    return true;
}

uint32_t ResolveObjectPropertiesOffset(Il2CppClass* entityClass, const ObjectPropertiesTarget& target)
{
    const char* fieldName = nullptr;
    if (std::strcmp(target.label, "base") == 0) fieldName = "OBAKMCCDBJA";
    else if (std::strcmp(target.label, "map-object") == 0) fieldName = "KKENJFFDMPO";
    else if (std::strcmp(target.label, "player-collision") == 0) fieldName = "GGBCADDBAPN";

    uint32_t offset = target.offset;
    bool fromMetadata = false;
    if (fieldName)
        ResolveFieldOffset(entityClass, fieldName, target.offset, offset, fromMetadata);
    return offset;
}

void* ResolveViewDestroyEntity(void* localPlayer)
{
    Il2CppClass* localClass = nullptr;
    uint32_t viewHandlerOffset = RuntimeOffsets::KJ_ViewHandler;
    bool fromMetadata = false;
    if (TryGetObjectClass(localPlayer, localClass))
        ResolveFieldOffset(localClass, "MPGOFIHIDML", RuntimeOffsets::KJ_ViewHandler, viewHandlerOffset, fromMetadata);

    void* viewHandler = ReadPointerRef(localPlayer, viewHandlerOffset);
    Il2CppClass* viewClass = nullptr;
    uint32_t destroyEntityOffset = RuntimeOffsets::VH_DestroyEntity;
    fromMetadata = false;
    if (TryGetObjectClass(viewHandler, viewClass))
        ResolveFieldOffset(viewClass, "destroyEntity", RuntimeOffsets::VH_DestroyEntity, destroyEntityOffset, fromMetadata);

    return ReadPointerRef(viewHandler, destroyEntityOffset);
}

bool ReadCollisionMultiplier(void* properties, float& out)
{
    if (!properties) return false;
    bool ok = false;
    __try {
        out = *reinterpret_cast<float*>(reinterpret_cast<uint8_t*>(properties) + g_collisionMultiplierOffset);
        ok = true;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) { ok = false; }
    return ok;
}

bool WriteCollisionMultiplier(void* properties, float value)
{
    if (!properties) return false;
    bool ok = false;
    __try {
        *reinterpret_cast<float*>(reinterpret_cast<uint8_t*>(properties) + g_collisionMultiplierOffset) = value;
        ok = true;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) { ok = false; }
    return ok;
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
        if (g_tracked[i].ptr && g_tracked[i].hasOriginal && IsPlausiblePointer(g_tracked[i].ptr))
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
        const uint32_t offset = ResolveObjectPropertiesOffset(entityClass, targets[i]);
        void* properties = ReadObjectPropertiesRef(entity, offset);
        if (!ResolveCollisionMultiplierOffset(properties)) continue;
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
        void* properties = ReadObjectPropertiesRef(entityPtr, targets[i].offset);
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
