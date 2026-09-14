#pragma once
namespace ImGui {
inline bool Checkbox(const char*, bool*) { return false; }
inline bool InputInt(const char*, int*) { return false; }
inline bool IsItemHovered() { return false; }
inline void SetTooltip(const char*, ...) {}
inline bool SliderFloat(const char*, float*, float, float, const char* = nullptr) { return false; }
}
