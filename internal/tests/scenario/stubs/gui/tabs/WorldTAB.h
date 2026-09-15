#pragma once
namespace WorldTAB {
void  CopyBoxBlocked(float originX, float originY, int side, float cellTiles,
                     float playerHalfEdge, bool foldHazard, unsigned char* out);
bool  IsTileBlocked(int tx, int ty);
bool  IsTileFullOccupied(int tx, int ty);
bool  IsDamagingTile(int tx, int ty);
bool  IsTileDamagingLive(int tx, int ty);
float GetTileSpeed(int tx, int ty);
unsigned char GetTileFlags(int tx, int ty);
void  CopyTileSpeeds(int tx0, int ty0, int side, float* out);
}
