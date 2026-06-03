// Purpose: stores the client-provided tile map and no-walk tile type set used
// by movement and diagnostics through the public IpcBridge tile APIs.

// Helpful notes:
// - Unknown tiles are treated as walkable to avoid blocking movement on missing
//   client data.
// - clearTiles, noWalkInit, and tileUpdate messages mutate this state on the
//   pipe thread; reads are protected by the same mutex.
// - Tile keys pack 16-bit x/y coordinates into a single uint32_t.

#include "pch-il2cpp.h"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <unordered_map>
#include <unordered_set>
#include "IpcTileState.h"
#include "IpcBridge.h"

#ifdef _DEBUG
#define DbgLog(fmt, ...) do { \
    char _b[512]; snprintf(_b, sizeof(_b), fmt, ##__VA_ARGS__); \
    std::cout << "[IpcBridge] " << _b << std::endl; \
} while(0)
#else
#define DbgLog(fmt, ...) (void)0
#endif

static std::unordered_map<uint32_t, uint16_t> s_tileMap;
static std::unordered_set<uint16_t> s_noWalkTypes;
static std::mutex s_tileMutex;

bool IpcTileState::IsWalkable(float worldX, float worldY)
{
    int tx = (int)floorf(worldX);
    int ty = (int)floorf(worldY);
    if (tx < 0 || ty < 0 || tx > 0xFFFF || ty > 0xFFFF) return true;
    uint32_t key = (static_cast<uint32_t>(tx & 0xFFFF) << 16)
                 |  static_cast<uint32_t>(ty & 0xFFFF);
    std::lock_guard<std::mutex> lk(s_tileMutex);
    auto it = s_tileMap.find(key);
    if (it == s_tileMap.end()) return true;
    return s_noWalkTypes.find(it->second) == s_noWalkTypes.end();
}

void IpcTileState::GetStats(int* outTileCount, int* outNoWalkTypeCount)
{
    std::lock_guard<std::mutex> lk(s_tileMutex);
    if (outTileCount)        *outTileCount        = static_cast<int>(s_tileMap.size());
    if (outNoWalkTypeCount)  *outNoWalkTypeCount  = static_cast<int>(s_noWalkTypes.size());
}

int IpcTileState::CopyUniqueTypeEntries(IpcTileTypeEntry* buf, int maxCount)
{
    if (!buf || maxCount <= 0) return 0;
    std::lock_guard<std::mutex> lk(s_tileMutex);
    std::unordered_map<uint16_t, int> typeCounts;
    typeCounts.reserve(s_tileMap.size() / 4 + 1);
    for (const auto& kv : s_tileMap)
        typeCounts[kv.second]++;
    int n = 0;
    for (const auto& tc : typeCounts) {
        if (n >= maxCount) break;
        buf[n].typeId = tc.first;
        buf[n].count  = tc.second;
        buf[n].noWalk = (s_noWalkTypes.find(tc.first) != s_noWalkTypes.end());
        ++n;
    }
    std::sort(buf, buf + n, [](const IpcTileTypeEntry& a, const IpcTileTypeEntry& b) {
        return a.typeId < b.typeId;
    });
    return n;
}

void IpcTileState::ClearTiles()
{
    std::lock_guard<std::mutex> lk(s_tileMutex);
    s_tileMap.clear();
    DbgLog("Tile map cleared.");
}

void IpcTileState::InitNoWalkTypes(char* typesBuf)
{
    std::lock_guard<std::mutex> lk(s_tileMutex);
    s_noWalkTypes.clear();
    char* saveptr = typesBuf;
    char* tok = strtok_s(saveptr, " ", &saveptr);
    int count = 0;
    while (tok) {
        const int tileType = atoi(tok);
        if (tileType > 0 && tileType <= 0xFFFF) {
            s_noWalkTypes.insert(static_cast<uint16_t>(tileType));
            ++count;
        }
        tok = strtok_s(nullptr, " ", &saveptr);
    }
    DbgLog("noWalkInit: %d impassable tile types.", count);
}

void IpcTileState::ApplyTileUpdate(char* tilesBuf)
{
    std::lock_guard<std::mutex> lk(s_tileMutex);
    char* saveptr = tilesBuf;
    char* tok = strtok_s(saveptr, " ", &saveptr);
    while (tok) {
        int x = 0, y = 0, tileType = 0;
        if (sscanf_s(tok, "%d:%d:%d", &x, &y, &tileType) == 3
            && x >= 0 && x <= 0xFFFF && y >= 0 && y <= 0xFFFF)
        {
            const uint32_t key = (static_cast<uint32_t>(x & 0xFFFF) << 16)
                               |  static_cast<uint32_t>(y & 0xFFFF);
            s_tileMap[key] = static_cast<uint16_t>(tileType);
        }
        tok = strtok_s(nullptr, " ", &saveptr);
    }
}
