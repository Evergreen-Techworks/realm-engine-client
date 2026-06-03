// Purpose: thread-safe tile walkability state populated from IPC tile messages.

// Helpful notes:
// - IsWalkable returns true for unknown/out-of-range tiles by design.
// - InitNoWalkTypes and ApplyTileUpdate mutate the shared state using compact
//   space-delimited payloads parsed in place.
// - CopyUniqueTypeEntries supports diagnostics without exposing internal maps.


#pragma once
#include <cstdint>

struct IpcTileTypeEntry;

namespace IpcTileState {

bool IsWalkable(float worldX, float worldY);
void GetStats(int* outTileCount, int* outNoWalkTypeCount);
int CopyUniqueTypeEntries(IpcTileTypeEntry* buf, int maxCount);
void ClearTiles();
void InitNoWalkTypes(char* typesBuf);
void ApplyTileUpdate(char* tilesBuf);

} // namespace IpcTileState
