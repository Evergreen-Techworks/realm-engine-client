#pragma once
#include <cstdint>
#include <vector>

// ─────────────────────────────────────────────────────────────────────────────
// WorldEntity — snapshot of one entity from the entity dictionary.
// Exposed here so DebugTAB can iterate the last-refreshed entity list for
// world-space label rendering without duplicating the data.
// ─────────────────────────────────────────────────────────────────────────────
struct WorldEntity
{
    int32_t  objectId      = 0;
    int32_t  objType       = 0;    // HFDNHJFNEKA @ 0x30 (no ACTK shift)
    float    x             = 0.f;
    float    y             = 0.f;
    int32_t  hp            = 0;
    int32_t  maxHp         = 0;
    bool     isLocal       = false;
    void*    ptr           = nullptr;
    void*    klass         = nullptr;
    char     typeName[32]  = {};
    char     playerName[32]= {};   // DPGEBOCBKEF @ 0x178 (no ACTK shift — confirmed)
    char     objName[64]   = {};   // ObjectProperties.id via KJMONHENJEN.OBAKMCCDBJA[0x18]+0x38
    uint16_t objConds      = 0;    // bitmask of OCOND_* flags
    uint32_t condLo        = 0;    // MapObject.conditions[0] (status bitmask low)
    uint32_t condHi        = 0;    // MapObject.conditions[1] (status bitmask high)
};

// Visual-only radius used to draw OccupySquare debug circles in the overlay.
// Flash isWalkable() has NO sub-tile circle model for OccupySquare — the entire
// tile cell is blocked for entry.  Do not use this for collision logic.
static constexpr float kOccupyRadius = 0.375f;  // debug visual only

// Object condition bitmask flags (ObjectProperties boolean fields)
static constexpr uint16_t OCOND_OCCUPY_SQ   = 0x0001;
static constexpr uint16_t OCOND_FULL_OCC    = 0x0002;
static constexpr uint16_t OCOND_ENEMY_OCC   = 0x0004;
static constexpr uint16_t OCOND_STATIC      = 0x0008;
static constexpr uint16_t OCOND_BLOCK_PROJ  = 0x0010;
static constexpr uint16_t OCOND_FLYING      = 0x0020;
static constexpr uint16_t OCOND_PROT_GND    = 0x0040;
static constexpr uint16_t OCOND_PROT_SINK   = 0x0080;
static constexpr uint16_t OCOND_NO_COVER    = 0x0100;
static constexpr uint16_t OCOND_NO_WALL_RPT = 0x0200;
static constexpr uint16_t OCOND_CONNECTS    = 0x0400;
static constexpr uint16_t OCOND_IS_ENEMY    = 0x0800;  // ObjectProperties.isEnemy (XML Enemy element / type)

// ─────────────────────────────────────────────────────────────────────────────
// WorldTile — snapshot of one ground tile from the spatial grid.
// ─────────────────────────────────────────────────────────────────────────────
struct WorldTile
{
    uint16_t tileType = 0;    // JOFEAFJPJEM @ 0x40
    int32_t  tileX    = 0;    // grid X
    int32_t  tileY    = 0;    // grid Y
    int32_t  minDmg   = 0;
    int32_t  maxDmg   = 0;
    float    speed    = 0.f;
    uint8_t  conds    = 0;    // bitmask of TCOND_* flags below
    void*    ptr      = nullptr;
    char     tileName[64] = {};
};

// Tile condition bitmask flags
static constexpr uint8_t TCOND_SINK    = 0x01;
static constexpr uint8_t TCOND_PUSH    = 0x02;
static constexpr uint8_t TCOND_ALPHA   = 0x04;
static constexpr uint8_t TCOND_SINKING = 0x08;
static constexpr uint8_t TCOND_NOWALK  = 0x10;

// ─────────────────────────────────────────────────────────────────────────────
// WorldProjectile — SpawnProjectile hook + WorldManager KJMONHENJEN containers (DIA4A offsets).
// Filled from ProjectileTracking::SnapshotToWorld and WM dict/list merge on each refresh.
// ─────────────────────────────────────────────────────────────────────────────
struct WorldProjectile
{
    void*    ptr            = nullptr;
    float    x              = 0.f;  // last snapshotted world X (live read in table optional)
    float    y              = 0.f;
    float    startX         = 0.f;
    float    startY         = 0.f;
    float    angle          = 0.f;
    float    speed          = 0.f;   // raw int as float; divide by 10000 for tiles/ms
    float    lifetime       = 0.f;   // ms (ProjectileProperties: seconds normalized via NormalizeProjectileLifetimeMs)
    int32_t  minDamage      = 0;
    int32_t  damage         = 0;   // max damage (ProjectileMaxDamage @ 0x1A8)
    bool     armorPiercing  = false;
    int32_t  bulletId       = 0;
    /// Runtime Chebyshev half-edge T from live HBEAKBIHANL+0x1D4 (Exalt IsHit). 0 = unread / use projHalfSize.
    float    runtimeChebyshevHalf = 0.f;
    /// Heuristic half-extent when runtime T unavailable (spawn-time skin/scale/magnitude).
    float    projHalfSize   = 0.f;
    float    amplitude      = 0.f;
    float    frequency      = 0.f;
    /// Flash ProjectileProperties.magnitude_ — parametric path radius (tiles), not sine amplitude.
    float    magnitude      = 0.f;
    /// Native KDAJOMOFMJB × optional UI scale; applied to speed/10000 distance term (ProjPosAt).
    float    speedMul       = 1.f;
    bool     wavy              = false;
    bool     hasCustomAmplitude = false;  // PP+0x1A0: wavy uses Amplitude/Frequency fields instead of hardcoded π/64
    bool     parametric     = false;
    bool     boomerang      = false;
    bool     isAccelerating = false;
    /// ProjectileProperties.UseAcceleration (+0x185) — the per-shot enable flag.
    /// Game applies acceleration only when (isAccelerating && useAccel) — these
    /// were collapsed into one field previously, so non-accelerating shots
    /// where IsAccel=1/UseAccel=0 (or vice-versa) were predicted wrong.
    bool     useAccel       = false;
    float    acceleration   = 0.f;
    /// Cached 1/Acceleration when game stores inverse (ProjectileProperties.AccelerationInv).
    float    accelerationInv = 0.f;
    /// Alternate linear accel term (ProjectileProperties.VelocityChangeRate).
    float    velocityChangeRate = 0.f;
    /// 1 / VelocityChangeRate when the game stores inverse (ProjectileProperties.VelocityChangeRateInv).
    float    velocityChangeRateInv = 0.f;
    float    accelDelay     = 0.f;
    float    speedClamp     = 0.f;
    /// Spawn-time ProjectileProperties* for late refresh of *Value fields.
    void*    projPropsPtr   = nullptr;
    uint64_t spawnTick      = 0;
    bool     valid          = false;
    int32_t  attackerObjId  = 0;
    uint32_t ownerObjId     = 0;
    bool     hasCustomHitbox = false;
    float    customOffsetX   = 0.f;
    float    customOffsetY   = 0.f;
    /// ProjectileProperties.LaserDistance (+0x170); >0 => laser-style capped ray (Flash parity).
    bool     laser           = false;
    float    laserDistance   = 0.f;
    /// ProjectileProperties.IsTurning (+0x1B0) — shot traces a circular arc.
    bool     isTurning          = false;
    /// PP[0x1B1] — "circle-turn delayed" subtype: arc uses circleTurnAngle/turnStopTime as omega
    /// and circleTurnDelay as the straight-travel phase. Distinct from isTurningDelayed.
    bool     isCircleTurnDelayed = false;
    /// ProjectileProperties.IsTurningDelayed (+0x1B2) — TurnRate-based delayed arc; straight phase = turnRateDelay ms.
    bool     isTurningDelayed   = false;
    /// PP[0x1B5] — when true the arc caps at turnStopTime and the shot continues straight.
    /// When false (common) the arc keeps curving for the full projectile lifetime.
    bool     turnSnapsToStraight = false;
    /// PP[0x1B3] — boomerang / accelerated-turn flag; enables quadratic turn-angle modification.
    bool     isTurningAccelerated = false;
    /// ProjectileProperties.ProjectileTurnRate (+0xD4). XML TurnAngle is in radians PER 50 ms tick;
    /// ProjPosAt converts to rad/ms via omega = turnRate / 50. (Old code used turnRate/turnStopTime,
    /// which was 20× too slow for typical 1000 ms turn windows.)
    float    turnRate           = 0.f;
    /// ProjectileProperties.ProjectileTurnStopTime (+0xE8) ms.
    float    turnStopTime       = 0.f;
    /// ProjectileProperties.ProjectileTurnRateDelay (+0xD8) ms (normalized from seconds); delay for isTurningDelayed.
    float    turnRateDelay      = 0.f;
    /// ProjectileProperties.ProjectileCircleTurnAngle (+0xEC) — total arc angle for isCircleTurnDelayed path.
    float    circleTurnAngle    = 0.f;
    /// ProjectileProperties.ProjectileCircleTurnDelay (+0xF0) ms — straight-line phase before isCircleTurnDelayed arc.
    float    circleTurnDelay    = 0.f;
    /// PP[0xDC] — turn acceleration rate for boomerang shots.
    float    turnAcceleration    = 0.f;
    /// PP[0xE0] — time threshold (seconds) before boomerang accel kicks in.
    float    turnAccelDelay      = 0.f;
    /// PP[0xE4] — target / clamped turn rate for boomerang accel.
    float    turnClamp           = 0.f;
    /// PP[0x1AC] — inverse-accel threshold scale for boomerang two-segment blend.
    float    turnAccelInv        = 0.f;
};

// WorldAoe source — which hook path recorded this entry.
static constexpr uint8_t kAoeSrcGjj  = 0;  // GJJCEFJMNMK::KOBMINBDOBD  (throwable entity init)
static constexpr uint8_t kAoeSrcFhoh = 1;  // FHOHCELBPDO::KOBMINBDOBD  (visual fallback)
static constexpr uint8_t kAoeSrcExpl = 2;  // FGOFPGIIEPC::KOBMINBDOBD  (explosion controller)
static constexpr uint8_t kAoeSrcSfx  = 3;  // HJMBOMEHGDJ::CGBILOJJPEI  (ShowEffect packet)

// ─────────────────────────────────────────────────────────────────────────────
// WorldAoe — ground-target AOE zone captured from four hook paths:
//   GJJ  (kAoeSrcGjj):  GJJCEFJMNMK throwable entity. ownerObjId = throwable's objectId.
//   FHOH (kAoeSrcFhoh): FHOHCELBPDO visual fallback.  ownerObjId = visual object's objectId.
//   EXPL (kAoeSrcExpl): FGOFPGIIEPC explosion ring.   ownerObjId = anchor (thrower) entity objectId.
//   SFX  (kAoeSrcSfx):  ShowEffect packet handler.    ownerObjId = packet targetObjectId (source entity).
//
// ownerObjId meaning by source:
//   GJJ/FHOH → objectId of the throwable/visual entity (NOT the thrower — isEnemy deferred via pos-match)
//   EXPL/SFX → objectId of the actual thrower / source entity (direct isEnemy lookup)
// ─────────────────────────────────────────────────────────────────────────────
struct WorldAoe
{
    float    x           = 0.f;    // throw origin world X  (GJJCEFJMNMK+0x368 / SFX pos1.x)
    float    y           = 0.f;    // throw origin world Y  (GJJCEFJMNMK+0x36C / SFX pos1.y)
    float    destX       = 0.f;    // landing spot X        (GJJCEFJMNMK+0x370 / SFX pos2.x for THROW)
    float    destY       = 0.f;    // landing spot Y        (GJJCEFJMNMK+0x374 / SFX pos2.y for THROW)
    float    radius      = 0.f;    // GJJ/FHOH/SFX: kDefaultAoeRadiusTiles (2.0); EXPL: CustomExplosionEntrance+0x38
    float    innerR      = 0.f;    // inner radius if annular, 0 = filled disk
    float    lifetime    = 3000.f; // total duration ms
    float    arcMs       = 0.f;    // arc flight duration (distance/speed × 1000) when known from
                                   // CustomExplosionEntrance; 0 = use heuristic. Planner uses this
                                   // as the arming window so severity ramps during arc, peaks at blast.
    uint64_t spawnTick   = 0;      // GetTickCount64() at capture time
    bool     valid       = false;
    bool     isDamaging      = false;  // true = throwable / explosion AOE
    bool     isEnemy         = false;  // true = thrown by enemy; false = player/friendly
    bool     isEnemyChecked  = false;  // true = isEnemy resolved from ObjectProperties
    uint8_t  source          = kAoeSrcGjj;  // which hook path captured this entry
    int32_t  sfxEffectType   = 0;          // SFX only: ShowEffect effectType (4=THROW 5=NOVA 23=CIRC 39=AOE)
    void*    ptr             = nullptr; // GJJ/FHOH: live entity*; EXPL/SFX: nullptr
    int32_t  ownerObjId      = 0;      // see source-specific meaning above
};

namespace WorldTAB {
    void Render();
    void ForceRefresh();    // trigger a DoRefresh() from external callers (e.g. TestTAB)

    // Last-known local player data (updated on each successful DoRefresh).
    // May be stale/null if WorldTAB has not been refreshed since injecting.
    void*     GetLocalPtr();    // FKALGHJIADI* from WorldManager.OCLNLBHDEFK
    float     GetLocalX();
    float     GetLocalY();
    // Live read +0x3C/+0x40 from local player object (same as movement / W2S anchor); falls back to last refresh.
    void      ReadLocalWorldXYLive(float& outX, float& outY);
    uintptr_t GetAppMgrPtr();   // ApplicationManager* (for WritePointerDataDict chain)

    // Live-read the world position of an entity by objectId from the cached entity list.
    // Returns true and fills outX/outY if the entity is found and its ptr is still readable.
    bool GetEntityLivePos(int32_t objectId, float& outX, float& outY);

    // Find the objectId of the player whose IGN best matches query (partial, case-insensitive).
    // Priority: exact > starts-with > contains. Fills outMatchedName with the actual IGN.
    bool FindPlayerByName(const char* query, int32_t& outObjectId, char* outMatchedName, int nameLen);

    // Read-only snapshots of the last-refreshed entity and tile lists.
    const std::vector<WorldEntity>& GetEntities();
    const std::vector<WorldTile>&   GetTiles();
    const std::vector<WorldProjectile>& GetProjectiles();

    // Returns true if tile (tx, ty) blocks movement.
    // Flash isWalkable() parity: NoWalk ground OR entity with OccupySquare OR FullOccupy.
    // Damaging tiles are NOT in this set; they are physically walkable.
    bool IsTileBlocked(int tx, int ty);

    // Returns true if tile (tx, ty) has a FullOccupy entity.
    // Used for the Flash isValidPosition sub-tile neighbour check (section B):
    // neighbouring FullOccupy tiles constrain which fractional sub-position within
    // a walkable tile the player can occupy.  Distinct from IsTileBlocked.
    bool IsTileFullOccupied(int tx, int ty);

    // Returns true if the tile at (tx, ty) deals damage.
    // Damage triggers when the player centre (floor of world XY) is on the tile —
    // NOT when the hitbox overlaps it.  Use floor(worldX/Y) for the lookup.
    bool IsDamagingTile(int tx, int ty);

    // Returns the XML speed multiplier of the tile at (tx, ty).
    // 0.0 = no modifier, > 1.0 = speedy ground, < 1.0 = slow ground.
    float GetTileSpeed(int tx, int ty);

    // Reads the current world/map name via ABKHBJOKLJH (WorldManager property, RVA 0x4045E0).
    // Writes a null-terminated ASCII string into buf. Returns false if unavailable.
    bool ReadMapName(char* buf, int bufLen);
}
