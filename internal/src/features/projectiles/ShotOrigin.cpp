#include "pch-il2cpp.h"

#include "features/projectiles/ShotOrigin.h"
#include "features/combat/autoaim/modes/AutoAim.h"
#include "features/combat/autoaim/ui/FeatMagnetAim.h"

#include <atomic>
#include <cmath>

#include "DbgFileLog.h"

namespace {

// Muzzle-offset constants — re-derived here unchanged from ProjectileTracking's
// original inlined branch. kMuzzleMinTiles is vanilla shot length; anything
// within kMuzzleVanillaEps of it counts as "slider disabled" so the hook skips
// the extra trig.
static constexpr float kMuzzleMinTiles   = 0.3f;
static constexpr float kMuzzleVanillaEps = 0.00051f; // treat as disabled vs 0.3

static std::atomic<uint8_t> s_lastSource{ static_cast<uint8_t>(ShotOrigin::Source::Vanilla) };

// Transition-only witness on which rule actually won for a LOCAL shot, and what
// offset it produced. Keyed on the source plus the offset rounded to 1/8 tile,
// so a steady state is one compare and a genuine change — including "stopped
// overriding" — logs once.
//
// KillAura is deliberately NOT one of the sources here any more: the local
// bullet's real position is written by a LATER entity setter, so this function
// could never move it (see features/projectiles/ShotOriginHook.h). Killaura's
// own witness lives there — grep [ShotOriginHook].
//
//   GREP THE TRACE LOG FOR:  [ShotOrigin]
static void Witness(ShotOrigin::Source src, const ShotOrigin::Request& req, float rx, float ry)
{
    const int key = (static_cast<int>(src) << 24)
                  ^ (static_cast<int>(rx * 8.f) << 12)
                  ^  static_cast<int>(ry * 8.f);
    static int s_last = 0x7FFFFFFF;
    if (key == s_last) return;
    s_last = key;
    const float dist = std::sqrt(rx * rx + ry * ry);
    DBG_FILE_LOG("[ShotOrigin] local shot -> "
        << (src == ShotOrigin::Source::Magnet ? "magnet"
          : src == ShotOrigin::Source::Muzzle ? "muzzle" : "vanilla")
        << " offset=(" << rx << "," << ry << ") dist=" << dist << " tiles"
        << " haveShooter=" << (req.haveShooter ? 1 : 0)
        << " angle=" << req.angle);
}

} // namespace

namespace ShotOrigin {

Source Resolve(const Request& req, float& outX, float& outY)
{
    // Rule 4 — Vanilla: pass the game's own relative offset straight through.
    // Every rule below overwrites this only when it fully succeeds, so a refused
    // override degrades to the unmodified shot rather than corrupting it.
    outX = req.startX;
    outY = req.startY;
    Source src = Source::Vanilla;

    // Rule 1 — KillAura USED TO LIVE HERE, and it never worked: rewriting the
    // shooter-relative startX/startY the spawn method takes is overwritten a
    // moment later by KJMONHENJEN::BDEBGEHBPCJ, the entity setter that writes
    // the projectile's actual position. Killaura now moves the local bullet from
    // that setter instead — features/projectiles/ShotOriginHook.h — and this
    // function is back to being purely about the game's own spawn offset.

    if (req.isLocalShot && CombatTAB::FeatMagnetAim::IsEnabled()) {
        // Rule 2 — Magnet: verbatim the MagnetAim branch that used to live in
        // SpawnProjectileDetour. The two sub-branches deliberately point at
        // different quantities (target direction vs fired angle); both are correct.
        const float magnetTiles = CombatTAB::FeatMagnetAim::GetVisualOffsetTiles();
        bool useTarget = false;
        if (AutoAim::HasTarget()) {
            float targetX = 0.f, targetY = 0.f;
            AutoAim::GetAimTarget(targetX, targetY);

            if (req.haveShooter) {
                const float dx = targetX - req.shooterX;
                const float dy = targetY - req.shooterY;
                const float lenSq = dx * dx + dy * dy;
                if (lenSq > 1e-6f) {
                    const float invLen = 1.f / sqrtf(lenSq);
                    outX = dx * invLen * magnetTiles;
                    outY = dy * invLen * magnetTiles;
                    useTarget = true;
                }
            }
        }
        if (!useTarget) {
            outX = cosf(req.angle) * magnetTiles;
            outY = sinf(req.angle) * magnetTiles;
        }
        src = Source::Magnet;
    } else {
        // Rule 3 — Muzzle: verbatim the manual-slider branch. MagnetAim
        // intentionally outranks it (surfaced in the Combat tab UI).
        const float muzzleTiles = req.muzzleTiles;
        if (muzzleTiles > kMuzzleMinTiles + kMuzzleVanillaEps && req.isLocalShot) {
            // startX/startY are shooter-relative; vanilla length ~0.3 tiles. Scale to keep direction.
            const float scale = muzzleTiles / kMuzzleMinTiles;
            if (fabsf(req.startX) > 1e-5f || fabsf(req.startY) > 1e-5f) {
                outX = req.startX * scale;
                outY = req.startY * scale;
            } else {
                outX = cosf(req.angle) * muzzleTiles;
                outY = sinf(req.angle) * muzzleTiles;
            }
            src = Source::Muzzle;
        }
    }

    s_lastSource.store(static_cast<uint8_t>(src), std::memory_order_relaxed);
    if (req.isLocalShot) Witness(src, req, outX, outY);
    return src;
}

Source LastSource()
{
    return static_cast<Source>(s_lastSource.load(std::memory_order_relaxed));
}

} // namespace ShotOrigin
