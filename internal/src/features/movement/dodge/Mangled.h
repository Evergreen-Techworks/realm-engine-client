#pragma once

// Mangled.h — single source of truth for IL2CPP/Beebyte-mangled class and
// method name strings used by the dodge subsystem. After every game patch
// the publisher rotates these mangled names; touching ONE file beats
// chasing string literals scattered across DangerPlanner.cpp / DangerMap.cpp /
// AoeTracking.cpp / ProjectileTracking.cpp / AStarDodge.cpp / SteerInput.cpp.
//
// Real names come from internal/ClaudeAgents/ReverseEngineer/BeeByte_Deobfuscated.md
// and the autododge-tuner agent's mappings. When a game update lands and a
// `Resolver::FindClassLoose` call starts returning nullptr, find the new
// mangled name in the regenerated dump and update it here.
//
// Usage convention: pass MANGLED literals to Resolver::FindClassLoose /
// FindMethodLoose. Comments on each define show the deobfuscated name so
// readers don't have to cross-reference BeeByte_Deobfuscated.md.

// ── Classes ────────────────────────────────────────────────────────────────
#define MANGLED_LOCALPLAYER_CLS    "FKALGHJIADI"  // LocalPlayer (sealed). +0x708 enchantCtx, +0x748 projList (+0x50 ACTK)
#define MANGLED_PROJECTILE_CLS     "HBEAKBIHANL"  // Projectile. +0x1D4 = T (Chebyshev half-extent)
#define MANGLED_LASERPROJ_CLS      "BJLDGDKMPFL"  // LaserProjectile (vtable[578h] = perpendicular-distance hit)
#define MANGLED_CHARACTER_CLS      "LKHPPBEGNOM"  // Character (NPC base). +0x208 hp, +0x20C maxHp, +0x210 def
#define MANGLED_MAPOBJECT_CLS      "KJMONHENJEN"  // MapObject (entity base). +0x3C/+0x40 = world X/Y (no ACTK shift)
#define MANGLED_ENCHANTCTX_CLS     "APEMKOIBOKC"  // EnchantContext (owned by LocalPlayer)
#define MANGLED_LANDINGCIRCLE_CLS  "FHOHCELBPDO"  // ThrowableLandingCircle (visual only). +0x044 = sineScale, NOT radius
#define MANGLED_EXPLOSIONRING_CLS  "FGOFPGIIEPC"  // ExplosionRingEffect (real blast). +0x150 = currentRadius

// ── Methods ────────────────────────────────────────────────────────────────
#define MANGLED_MOVE_TO            "DGLCONCOIBO"  // FKALGHJIADI::moveTo(float x, float y) — NOT speed-clamped (the caller sizes the step)
#define MANGLED_CALC_MOVE_SPEED    "GCFKGLKAPND"  // FKALGHJIADI::CalcMoveSpeed -> float
#define MANGLED_PROJ_SPAWN         "KOBMINBDOBD"  // HBEAKBIHANL::SpawnProjectile (also used as the AoE spawn detour target)
#define MANGLED_PROJ_PERFRAME      "GJFKGLJEGKO"  // HBEAKBIHANL::PerFrameUpdate (RVA 0x0198A100)
#define MANGLED_PROJ_ISHIT         "HFJONMENEGF"  // HBEAKBIHANL::IsHit (Chebyshev test, RVA 0x0198B180)
