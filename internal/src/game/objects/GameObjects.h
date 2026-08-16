#pragma once
#include "core/runtime/MemRead.h"
#include "core/runtime/RuntimeOffsets.h"

// ─────────────────────────────────────────────────────────────────────────────
// Typed, zero-cost game-object views. Flat wrappers (composition, no inheritance,
// no virtuals) over a non-owning void* + RuntimeOffsets:: field keys. Each
// accessor is a single Mem::ReadOr / Mem::ReadPtr and inlines to the exact raw
// read the feature code used to write by hand. Wrappers own NOTHING and cache
// NOTHING — they are frame-local views; caching/invalidation stays in
// RuntimeOffsets::EnsureAll(), GameState, LocalPlayer and EnemyTracker.
// Thread-safety is exactly that of the raw pointer wrapped (same rules as today).
// ─────────────────────────────────────────────────────────────────────────────
namespace Game {

namespace detail { struct Vec2Raw { float x, y; }; }

// Non-owning view of a KJMONHENJEN-derived world entity. Valid for the current
// frame only — do NOT store across frames (the pointer can die on world change);
// re-obtain from EnemyTracker / WalkDict each frame.
class Entity {
public:
    explicit Entity(void* p) : p_(p) {}
    bool     Ok()      const { return Mem::AddrOk(p_); }
    void*    Ptr()     const { return p_; }
    float    X()       const { return Mem::ReadOr<float>(p_, RuntimeOffsets::PosX, 0.f); }
    float    Y()       const { return Mem::ReadOr<float>(p_, RuntimeOffsets::PosY, 0.f); }
    int32_t  ObjType() const { return Mem::ReadOr<int32_t>(p_, RuntimeOffsets::ObjType, 0); }
    int32_t  ObjId()   const { return Mem::ReadOr<int32_t>(p_, RuntimeOffsets::ObjId, 0); }
    void*    Props()   const { return Mem::ReadPtr(p_, RuntimeOffsets::ObjProps); }
    // Props-derived (each re-reads Props(); callers in loops should hoist Props()).
    bool     IsEnemy() const {
        void* pr = Props();
        return pr && Mem::ReadOr<bool>(pr, RuntimeOffsets::OP_IsEnemy, false);
    }
    bool     IsInvincibleType() const {
        void* pr = Props();
        return pr && Mem::ReadPtr(pr, RuntimeOffsets::OP_InvincibleElem) != nullptr;
    }
    bool     HasHealthBar() const {
        void* pr = Props();
        return pr && Mem::ReadOr<uint8_t>(pr, RuntimeOffsets::OP_NoHealthBar, 1) == 0;
    }
private:
    void* p_;
};

// Character view (LKHPPBEGNOM fields; ACTK-shifted offsets already baked into
// RuntimeOffsets values). Compose, don't inherit: holds an Entity by value.
class Character {
public:
    explicit Character(void* p) : e_(p) {}
    const Entity& AsEntity() const { return e_; }
    int32_t Hp()      const { return Mem::ReadOr<int32_t>(e_.Ptr(), RuntimeOffsets::HP, 0); }
    int32_t MaxHp()   const { return Mem::ReadOr<int32_t>(e_.Ptr(), RuntimeOffsets::MaxHP, 0); }
    int32_t Defense() const { return Mem::ReadOr<int32_t>(e_.Ptr(), RuntimeOffsets::Defense, 0); }
    // MoVelocity Vector2. Reads both floats under one guard (a fault on either
    // aborts the whole read, matching the hand-rolled __try). false if the
    // offset is unresolved (0) or the read faults.
    bool Velocity(float& vx, float& vy) const {
        if (RuntimeOffsets::MoVelocity == 0) return false;
        detail::Vec2Raw v;
        if (!Mem::TryRead(e_.Ptr(), RuntimeOffsets::MoVelocity, v)) return false;
        vx = v.x; vy = v.y;
        return true;
    }
    // Combined 64-bit status mask via the SEH-safe RuntimeOffsets reader.
    bool Conditions(uint64_t& out) const {
        uint32_t w0 = 0, w1 = 0;
        if (!RuntimeOffsets::TryReadMapObjectConditions(e_.Ptr(), &w0, &w1)) return false;
        out = static_cast<uint64_t>(w0) | (static_cast<uint64_t>(w1) << 32);
        return true;
    }
private:
    Entity e_;
};

// Projectile instance view (HBEAKBIHANL).
class Projectile {
public:
    explicit Projectile(void* p) : p_(p) {}
    bool    Ok()         const { return Mem::AddrOk(p_); }
    float   Angle()      const { return Mem::ReadOr<float>(p_, RuntimeOffsets::Hbeak_Angle, 0.f); }
    int32_t Damage()     const { return Mem::ReadOr<int32_t>(p_, RuntimeOffsets::Hbeak_InstanceDamage, 0); }
    int32_t SpawnAgeMs() const { return Mem::ReadOr<int32_t>(p_, RuntimeOffsets::Hbeak_SpawnAgeMs, 0); }
    void*   Props()      const { return Mem::ReadPtr(p_, RuntimeOffsets::Hbeak_ProjPropsPtr); }
private:
    void* p_;
};

// ProjectileProperties view (type-level XML properties).
class ProjProps {
public:
    explicit ProjProps(void* p) : p_(p) {}
    bool    Ok()        const { return Mem::AddrOk(p_); }
    float   Lifetime()  const { return Mem::ReadOr<float>(p_, RuntimeOffsets::PP_Lifetime, 0.f); }
    int32_t Speed()     const { return Mem::ReadOr<int32_t>(p_, RuntimeOffsets::PP_Speed, 0); }
    bool    IsWavy()    const { return Mem::ReadOr<bool>(p_, RuntimeOffsets::PP_IsWavy, false); }
    float   Magnitude() const { return Mem::ReadOr<float>(p_, RuntimeOffsets::PP_Magnitude, 0.f); }
private:
    void* p_;
};

} // namespace Game
