#pragma once
namespace SteerInput {
struct SteerState { bool active; float dirX; float dirY; };
inline void Tick() {}
inline SteerState Get() { return SteerState{ false, 0.f, 0.f }; }
}
