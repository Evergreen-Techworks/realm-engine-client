#include "pch-il2cpp.h"
#include "NoclipHook.h"
#include "Noclip.h"
#include "Il2CppResolver.h"
#include "minhook/MinHook.h"

#include <Windows.h>
#include <array>
#include <atomic>
#include <cstdint>
#include <utility>

// ─────────────────────────────────────────────────────────────────────────────
// NoclipHook — detours Map's (HJMBOMEHGDJ) walkability predicates so the game's
// own movement validation reports "walkable" while noclip is on.
//
// Which predicate actually gates player movement is not RE'd. All seven
// bool(float,float) predicates on Map are hooked; every one bumps a call
// counter, but only entries with `force >= 0` have their result overridden.
// Test → PLAYER NOCLIP shows the counters, so walking into a wall identifies
// the real gate empirically.
// ponytail: counters instead of a blind guess. Once the winner is known, drop
// the observe-only rows and keep the one that matters.
// ─────────────────────────────────────────────────────────────────────────────

namespace {

struct Target {
    const char* name;
    int         force;   // -1 = count only; 0/1 = value returned while noclip is on
};

constexpr Target kTargets[] = {
    { "PEGDEDNHEHD",  1 },
    { "LHGGJIAKLMJ",  1 },
    { "GIACHFPEJOC", -1 },
    { "OKFBFBNJEBH", -1 },
    { "HKELLOCLLCG", -1 },
    { "IGINLFBOICF", -1 },
    { "FNFKBDOLKDF", -1 },
};
constexpr int kCount = static_cast<int>(sizeof(kTargets) / sizeof(kTargets[0]));

using PredFn = bool(__fastcall*)(void*, float, float, void*);

static PredFn                s_orig[kCount]   = {};
static void*                 s_target[kCount] = {};
static bool                  s_hooked[kCount] = {};
static std::atomic<uint32_t> s_hits[kCount]   = {};

static bool     s_resolved   = false;
static bool     s_installed  = false;
static uint64_t s_nextTryMs  = 0;

static inline bool AddrOk(const void* p)
{
    const uintptr_t a = reinterpret_cast<uintptr_t>(p);
    return a > 0x10000u && a < 0x7FFFFFFFFFFFull;
}

static bool EnsureIl2CppThreadAttached()
{
    static thread_local bool attached = false;
    if (attached)
        return true;
    if (!il2cpp_domain_get || !il2cpp_thread_attach)
        return false;

    Il2CppDomain* domain = il2cpp_domain_get();
    if (!domain)
        return false;

    attached = il2cpp_thread_attach(domain) != nullptr;
    return attached;
}

template <int I>
static bool __fastcall Detour(void* self, float x, float y, void* method)
{
    s_hits[I].fetch_add(1, std::memory_order_relaxed);
    if (kTargets[I].force >= 0 && Noclip::ShouldBypassWalkable())
        return kTargets[I].force != 0;
    return s_orig[I](self, x, y, method);
}

template <int... I>
static std::array<void*, kCount> MakeDetours(std::integer_sequence<int, I...>)
{
    return { reinterpret_cast<void*>(&Detour<I>)... };
}
static const std::array<void*, kCount> s_detour =
    MakeDetours(std::make_integer_sequence<int, kCount>{});

// Resolving the class is a full IL2CPP metadata walk — throttle to 1 Hz so a
// miss (not in a world yet, renamed after a patch) can't stall the render thread.
static void ResolveTargets()
{
    if (s_resolved)
        return;

    const uint64_t now = GetTickCount64();
    if (now < s_nextTryMs)
        return;
    s_nextTryMs = now + 1000;

    if (!EnsureIl2CppThreadAttached())
        return;

    Il2CppClass* map = nullptr;
    Resolver::Protection::safe_call([&]() {
        map = Resolver::GetClass("", "HJMBOMEHGDJ");
    });
    if (!map)
        return;

    int found = 0;
    for (int i = 0; i < kCount; ++i) {
        const MethodInfo* mi = nullptr;
        Resolver::Protection::safe_call([&]() {
            mi = il2cpp_class_get_method_from_name(map, kTargets[i].name, 2);
        });
        if (mi && AddrOk(mi->methodPointer)) {
            s_target[i] = reinterpret_cast<void*>(mi->methodPointer);
            ++found;
        }
    }
    s_resolved = found > 0;
}

static bool EnsureMinHook()
{
    static bool mhInitialized = false;
    if (mhInitialized)
        return true;

    const MH_STATUS st = MH_Initialize();
    if (st != MH_OK && st != MH_ERROR_ALREADY_INITIALIZED)
        return false;

    mhInitialized = true;
    return true;
}

// Per-entry install: one predicate failing to hook must not sink the others.
static void TryInstall()
{
    if (s_installed)
        return;

    ResolveTargets();
    if (!s_resolved || !EnsureMinHook())
        return;

    for (int i = 0; i < kCount; ++i) {
        if (s_hooked[i] || !s_target[i])
            continue;
        s_orig[i] = reinterpret_cast<PredFn>(s_target[i]);
        if (MH_CreateHook(s_target[i], s_detour[i],
                reinterpret_cast<void**>(&s_orig[i])) != MH_OK) {
            s_orig[i] = nullptr;
            s_target[i] = nullptr;
            continue;
        }
        if (MH_EnableHook(s_target[i]) != MH_OK) {
            MH_RemoveHook(s_target[i]);
            s_orig[i] = nullptr;
            s_target[i] = nullptr;
            continue;
        }
        s_hooked[i] = true;
        s_installed = true;
    }
}

} // namespace

namespace NoclipHook {

void Tick()
{
    TryInstall();
}

void Uninstall()
{
    if (!s_installed)
        return;

    for (int i = kCount - 1; i >= 0; --i) {
        if (!s_hooked[i])
            continue;
        MH_DisableHook(s_target[i]);
        MH_RemoveHook(s_target[i]);
        s_hooked[i] = false;
        s_target[i] = nullptr;
        s_orig[i]   = nullptr;
    }
    s_installed = false;
}

bool IsInstalled() { return s_installed; }

bool IsResolved()
{
    ResolveTargets();
    return s_resolved;
}

int         Count()             { return kCount; }
const char* TargetName(int i)   { return (i >= 0 && i < kCount) ? kTargets[i].name : ""; }
bool        TargetHooked(int i) { return (i >= 0 && i < kCount) && s_hooked[i]; }
bool        TargetForced(int i) { return (i >= 0 && i < kCount) && kTargets[i].force >= 0; }
uint32_t    TargetHits(int i)
{
    return (i >= 0 && i < kCount) ? s_hits[i].load(std::memory_order_relaxed) : 0u;
}

} // namespace NoclipHook
