#pragma once

struct Il2CppClass;

// GameClasses — the ONE policy for resolving a game class by name.
//
// Why this exists: Resolver::FindClassLoose is a plain strcmp over the whole
// class table (core/runtime/Il2CppResolver.cpp) with no alias handling and no
// cache, so it does NOT survive a BeeByte rename. Before this header, four different
// call sites layered four different fallback chains on top of it and each kept
// its own `static Il2CppClass*`, so the same class resolved with different
// robustness depending on who asked — WorldTAB's projectile ESP used a bare
// FindClassLoose on the obfuscated literal alone while ProjectileTracking's
// dodge path had the alias pass, so a rename would have blanked the ESP and
// left dodging alive.
//
// Policy (in order):
//   1. Scan Beebyte::GetMap() for entries whose READABLE name == readableName;
//      for each candidate obfuscated name, try Resolver::GetClass("", obf) then
//      Resolver::FindClassLoose(obf). First hit wins.
//   2. Fall back to obfuscatedFallback (the last-known-good literal) via the
//      same GetClass -> FindClassLoose pair.
//   3. Cache the result (hit only) and return it for every later call.
//
// A FAILED lookup is NOT cached: classes load lazily, so a call before the
// player is in-realm must be retryable. This matches the behavior of every
// existing site's `if (!s_cached)` guard. Resolution is FAIL-CLOSED — an
// unresolved class comes back as nullptr and the caller skips.
//
// Thread-safety: guarded by an internal mutex. Resolution happens at init /
// first-use, never per-frame after the first hit; the post-hit path is a map
// lookup under that mutex, which is cheap but NOT free — hoist the pointer out
// of any per-frame loop exactly as the current static caches do.
namespace GameClasses {

    // `readableName` is the deobfuscated name as it appears in the VALUES of
    // Beebyte::GetMap() (e.g. "Projectile", "CameraManager"). `obfuscatedFallback`
    // is the last-known-good obfuscated literal for the current build, or the
    // readable name itself when the class is not obfuscated in this build
    // (e.g. "CameraManager" — pass it as BOTH arguments in that case).
    Il2CppClass* Resolve(const char* readableName, const char* obfuscatedFallback);

    // Named accessors for the classes resolved from more than one call site.
    // Each is a one-line Resolve() with the correct pair baked in, so a caller
    // cannot accidentally pass a weaker fallback than its neighbours.
    Il2CppClass* Projectile();      // "Projectile"     / "HBEAKBIHANL"
    Il2CppClass* WorldManager();    // "WorldManager"   / "HJMBOMEHGDJ"
    Il2CppClass* Square();          // "Square"         / "BGAIOPJMHLO"

} // namespace GameClasses
