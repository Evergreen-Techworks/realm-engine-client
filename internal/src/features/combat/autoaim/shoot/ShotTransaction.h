#pragma once
#include <cstdint>

// ShotTransaction — killaura's per-shot edit, done natively and kept consistent
// between the local projectile and the outgoing PlayerShoot message.
//
// Hook order for one local shot (all on the game thread, all inside one call to
// Player.LGJPEFJKHHP):
//
//   Player.LGJPEFJKHHP (FKALGHJIADI)        opens a thread-local shot scope
//     -> HBEAKBIHANL.KOBMINBDOBD             creation: records the exact projectile
//                                            (ProjectileTracking's existing detour
//                                            calls OnProjectileCreated)
//     -> MapViewService.AODEIADKBCC(BasicMapObject)
//                                            edit point: natural x/y/angle are read,
//                                            the proposal is written, then the
//                                            original add runs
//     -> SocketManager.SendMessage(PlayerShoot)
//                                            the matching message borrows the same
//                                            origin/angle for the duration of the send
//        -> HJNFJAHAOOE.IAEHBNKGNMH          the PlayerShoot writer: proof that the
//                                            edited fields went into the wire bytes
//     <- SendMessage returns                 transport completion: packet fields are
//                                            restored; the projectile edit is kept only
//                                            if the send serialized our values in the
//                                            same session, otherwise the projectile's
//                                            natural x/y/angle are put back
//
// SendMessage serializes synchronously: SocketManager.SendMessage calls the
// connection's send (JOEMEFDPIIP.BLBEFOJBAPO), which calls the message's virtual
// writer (vtable +0x308, the IAEHBNKGNMH override), encrypts the bytes and queues
// BYTES, not the message object. Restoring the borrowed fields after the call
// returns therefore cannot change what is on the wire. When the connection is not
// up, BLBEFOJBAPO returns without calling the writer; the writer hook is how the
// transaction tells those two cases apart.
//
// Per-shot state is thread-local and lives on the stack of the LGJPEFJKHHP detour.
// Every hook's first test is that thread-local pointer, so projectiles, map adds
// and messages that are not part of a local shot pay one TLS read.
namespace ShotTransaction {

// Render thread (from KillAura::Tick). Idempotent; retries until every hook target
// and field resolves. Requires ProjectileTracking's spawn hook to be installed.
bool Install();
void Uninstall();
bool IsInstalled();

// Game thread, from ProjectileTracking's spawn detour, AFTER the original
// KOBMINBDOBD returned `proj`. `lifetimeMul` / `speedMul` are the two trailing
// floats the game passed to KOBMINBDOBD (disassembly: the player's lifetime and
// speed multipliers; the detour's parameters are misnamed startX/startY).
void OnProjectileCreated(void* proj, int32_t ownerId, int32_t bulletId, float angle,
                         void* objProps, void* projProps, float lifetimeMul, float speedMul);

// True while a local shot scope is open on the calling thread.
bool ScopeOpen();

// Cumulative counters, any thread. Read by the Combat tab and the trace summary.
struct Stats {
    uint64_t scopes          = 0;  // local primary/ability shots seen with killaura on
    uint64_t staged          = 0;  // local projectiles recorded at creation
    uint64_t edited          = 0;  // projectiles whose x/y/angle were written at map add
    uint64_t committed       = 0;  // edits kept: the send serialized our values
    uint64_t restored        = 0;  // edits undone: natural x/y/angle written back
    uint64_t skipped         = 0;  // staged projectiles left natural (see lastSkip)
    uint64_t packetMismatch  = 0;  // an edited projectile's PlayerShoot did not match
    uint64_t notSerialized   = 0;  // send returned without the writer seeing our values
    uint64_t sessionChanged  = 0;  // session moved between staging and completion
    uint64_t targetShots     = 0;  // committed shots aimed at the killaura target
    uint64_t mouseShots      = 0;  // committed shots aimed at the mouse point
    uint64_t containerDisagree = 0;// attack-entry container type != projectile's ObjectProperties type
};
Stats GetStats();
const char* LastSkipReason();     // static string, never null
const char* LastRestoreReason();  // static string, never null
const char* InstallStatus();      // static string, never null

} // namespace ShotTransaction
