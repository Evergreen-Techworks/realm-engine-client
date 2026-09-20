#pragma once
#include <cstdint>
namespace RuntimeOffsets {
constexpr uint32_t WM_TileList = 0x10;
constexpr uint32_t TileX = 0x38, TileY = 0x3c, TileType = 0x40, Sq_Cover = 0x48, TileProps = 0x50;
constexpr uint32_t TP_Speed = 0x50, TP_Sink = 0x58, TP_NoWalk = 0x78;
constexpr uint32_t TP_MaxDmg = 0xb8, TP_Push = 0xc8, TP_Sinking = 0xd8;
constexpr uint32_t ObjProps = 0x18, KJ_DictObjectId = 0x20;
constexpr uint32_t OP_IsStatic = 0x20, OP_OccupySq = 0x21, OP_FullOcc = 0x22, OP_EnemyOcc = 0x23;
}
