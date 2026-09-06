#include "pch-il2cpp.h"

#include "game/symbols/GameClasses.h"
#include "game/symbols/BeebyteName.h"
#include "core/runtime/Il2CppResolver.h"
#include "core/logging/DbgFileLog.h"

#include <mutex>
#include <string>
#include <unordered_map>

namespace GameClasses {
namespace {

std::mutex s_mu;
std::unordered_map<std::string, Il2CppClass*> s_cache;   // keyed by readableName

// One name, both lookups: the exact namespace-less lookup first (cheap), then
// the namespace-ignoring class-table scan. This is the pair every migrated
// site already used; it is not widened here.
Il2CppClass* TryName(const char* n)
{
    if (!n || !n[0]) return nullptr;
    Il2CppClass* k = Resolver::GetClass("", n);
    if (!k) k = Resolver::FindClassLoose(n);
    return k;
}

} // namespace

Il2CppClass* Resolve(const char* readableName, const char* obfuscatedFallback)
{
    if (!readableName || !readableName[0]) return nullptr;

    std::lock_guard<std::mutex> lk(s_mu);
    const std::string key(readableName);
    if (auto it = s_cache.find(key); it != s_cache.end()) return it->second;

    Il2CppClass* found = nullptr;
    const char* via = nullptr;
    for (const auto& kv : Beebyte::GetMap()) {
        if (kv.second != key) continue;
        if (Il2CppClass* k = TryName(kv.first.c_str())) { found = k; via = kv.first.c_str(); break; }
    }
    if (!found && obfuscatedFallback) {
        if (Il2CppClass* k = TryName(obfuscatedFallback)) { found = k; via = obfuscatedFallback; }
    }
    if (!found) return nullptr;                 // NOT cached — lazy class load, retry later

    s_cache.emplace(key, found);
    DBG_FILE_LOG("[GameClasses] '" << readableName << "' resolved via '"
                 << (via ? via : "?") << "' (fallback literal was '"
                 << (obfuscatedFallback ? obfuscatedFallback : "-") << "')");
    return found;
}

Il2CppClass* Projectile()   { return Resolve("Projectile",   "HBEAKBIHANL"); }
Il2CppClass* WorldManager() { return Resolve("WorldManager", "HJMBOMEHGDJ"); }
Il2CppClass* Square()       { return Resolve("Square",       "BGAIOPJMHLO"); }

} // namespace GameClasses
