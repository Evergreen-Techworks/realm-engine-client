#include "pch-il2cpp.h"

#include "features/projectiles/ShotOrigin.h"
#include "features/combat/autoaim/modes/KillAura.h"
#include "features/combat/autoaim/modes/AutoAim.h"
#include "features/combat/autoaim/ui/FeatMagnetAim.h"

#include <atomic>
#include <cmath>

namespace {

// Muzzle-offset constants — re-derived here unchanged from ProjectileTracking's
// original inlined branch. kMuzzleMinTiles is vanilla shot length; anything
// within kMuzzleVanillaEps of it counts as "slider disabled" so the hook skips
// the extra trig.
static constexpr float kMuzzleMinTiles   = 0.3f;
static constexpr float kMuzzleVanillaEps = 0.00051f; // treat as disabled vs 0.3

static std::atomic<uint8_t> s_lastSource{ static_cast<uint8_t>(ShotOrigin::Source::Vanilla) };

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

    // Rule 1 — KillAura: the only rule that changes where the shot LANDS, so it
    // outranks MagnetAim (an explicitly visual-only path). KillAura returns an
    // ABSOLUTE world point and already enforces its own standoff / max-offset /
    // finiteness policy; all we do is rebase it into the shooter-relative space
    // the spawn method takes. Without a shooter position we cannot rebase, so we
    // fall through to rules 2/3/4 rather than guess — fail-closed.
    if (req.isLocalShot) {
        float ox = 0.f, oy = 0.f;
        if (KillAura::ComputeShotOrigin(req.angle, ox, oy) && req.haveShooter) {
            const float rx = ox - req.shooterX;
            const float ry = oy - req.shooterY;
            if (std::isfinite(rx) && std::isfinite(ry)) {
                outX = rx;
                outY = ry;
                s_lastSource.store(static_cast<uint8_t>(Source::KillAura), std::memory_order_relaxed);
                return Source::KillAura;
            }
        }
    }

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
    return src;
}

Source LastSource()
{
    return static_cast<Source>(s_lastSource.load(std::memory_order_relaxed));
}

} // namespace ShotOrigin
