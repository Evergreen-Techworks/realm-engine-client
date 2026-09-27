import type { PluginContext } from './api.js';
import { sendDllFeature, RuntimeScheduler } from './api.js';

/**
 * Killaura — settings and diagnostics for the native shot edit.
 *
 * The DLL does the work inside the game's own attack call
 * (internal/src/features/combat/autoaim/shoot/ShotTransaction.h): for each of
 * the local player's shots it moves the projectile's origin up to 2 tiles toward
 * the killaura target (or the mouse point when no target is in reach), points
 * the projectile at it, and has the outgoing PlayerShoot carry the same origin
 * and angle. The projectile keeps the edit only when that PlayerShoot was
 * actually serialized with those values in the same session.
 *
 * This plugin does not touch any packet. It sends the settings, counts what
 * the proxy sees, and logs it:
 *   - PLAYERSHOOT: how many shots left with their origin moved off the player
 *     (independent evidence the native edit reaches the wire), and the largest
 *     move seen (must never exceed ~2 tiles).
 *   - ENEMYHIT: whether the client is claiming hits at all.
 * The native counters (kept / undone / left natural, and why) are in the
 * Combat tab and the trace log's `[KillAura] alive` line.
 */

// A natural shot starts about 0.3 tiles from the player centre (plus a small
// per-weapon sideways offset). Anything past this was moved by the native edit.
const MOVED_ORIGIN_TILES = 0.75;
// The native edit caps the origin at 2 tiles from the player; allow float slack.
const MAX_ORIGIN_TILES = 2.05;

export function register(ctx: PluginContext) {
  ctx.name = 'Killaura';
  ctx.category = 'combat';
  // Off by default — it changes where your shots start; opt in explicitly.
  ctx.enabled = false;

  const stats = {
    shotsSeen: 0,
    /** PLAYERSHOOTs whose projectilePosition sits more than MOVED_ORIGIN_TILES from playerPosition. */
    shotsMoved: 0,
    /** Largest projectilePosition-to-playerPosition distance seen, in tiles. */
    maxMoveTiles: 0,
    /** Shots moved further than MAX_ORIGIN_TILES — should stay 0. */
    overCap: 0,
    enemyHitsSent: 0,
    enemyHitsBlocked: 0,
  };

  // ── Settings ────────────────────────────────────────────────────────────

  function modeIdx(): number {
    return ctx.getSetting<string>('aimMode') === 'mouse' ? 1 : 0;
  }

  function syncControlState() {
    sendDllFeature('killauraMode', modeIdx());
    sendDllFeature('killauraRangeTiles', ctx.getSetting<number>('rangeTiles'));
    sendDllFeature('killauraStandoffTiles', ctx.getSetting<number>('standoffTiles'));
    sendDllFeature('killauraEnabled', ctx.enabled);
  }

  ctx.registerSetting('aimMode', {
    label: 'Aim mode',
    type: 'select',
    value: 'target',
    options: [
      { label: 'At target', value: 'target' },
      { label: 'At mouse', value: 'mouse' },
    ],
  }, () => {
    sendDllFeature('killauraMode', modeIdx());
  });

  ctx.registerSetting('rangeTiles', {
    label: 'Target range CAP (tiles) — 0 = auto = your weapon\'s real range',
    /**
     * 0 = AUTO, matching the DLL default (KillAura.cpp `s_rangeTiles`). These MUST
     * agree: syncControlState() sends killauraRangeTiles on every enable/settings
     * change, so a stale non-zero default here would silently override the DLL's
     * auto on every connect.
     *
     * A non-zero value can only SHRINK the selection radius. Each shot is still
     * checked natively: it is edited only when the target is within that
     * projectile's own range of the moved origin.
     */
    type: 'number',
    value: 0,
    min: 0,
    max: 30,
    step: 0.5,
  }, (val: number) => {
    sendDllFeature('killauraRangeTiles', val);
  });

  ctx.registerSetting('standoffTiles', {
    label: 'Standoff (tiles) — how far short of the aim point the moved origin stops',
    type: 'number',
    value: 0.35,
    min: 0,
    max: 3,
    step: 0.05,
  }, (val: number) => {
    sendDllFeature('killauraStandoffTiles', val);
  });

  ctx.onEnabledChange(() => {
    syncControlState();
  });

  // ── Observation only ────────────────────────────────────────────────────

  ctx.hookPacket('PLAYERSHOOT', (_client, packet) => {
    if (!packet.isDefined) return;
    const player = packet.data.playerPosition;
    const proj = packet.data.projectilePosition;
    if (!player || !proj) return;
    const dx = proj.x - player.x, dy = proj.y - player.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (!Number.isFinite(d)) return;
    stats.shotsSeen++;
    if (d > MOVED_ORIGIN_TILES) stats.shotsMoved++;
    if (d > MAX_ORIGIN_TILES) stats.overCap++;
    if (d > stats.maxMoveTiles) stats.maxMoveTiles = d;
  });

  // Is the client claiming hits at all? Damage in RotMG is client-claimed
  // (ENEMYHIT). `blocked` counts hits another plugin suppressed so a suppressed
  // hit is never mistaken for one that was never claimed.
  ctx.hookPacket('ENEMYHIT', (_client, packet) => {
    if (packet.send === false) stats.enemyHitsBlocked++;
    else stats.enemyHitsSent++;
  });

  // ── Lifecycle + diagnostics ─────────────────────────────────────────────

  ctx.on('clientConnected', () => {
    syncControlState();
  });

  let lastDiagKey = '';
  const scheduler = new RuntimeScheduler();
  scheduler.scheduleRepeating(1000, () => {
    const diag = {
      enabled: ctx.enabled,
      shotsSeen: stats.shotsSeen,
      shotsMoved: stats.shotsMoved,
      maxMoveTiles: Math.round(stats.maxMoveTiles * 100) / 100,
      overCap: stats.overCap,
      enemyHitsSent: stats.enemyHitsSent,
      enemyHitsBlocked: stats.enemyHitsBlocked,
    };
    ctx.setData('killaura', diag);
    ctx.broadcastData('killaura', diag);

    // Mirrored to the proxy log on CHANGE, so the counters can be read after
    // the fact. `shotsSeen` is printed but not keyed: it ticks on every shot.
    //
    //   GREP THE PROXY LOG FOR:  [Killaura] diag
    const key = `${diag.enabled}|${diag.shotsMoved}|${diag.overCap}`
              + `|${diag.enemyHitsSent}|${diag.enemyHitsBlocked}`;
    if (key !== lastDiagKey) {
      lastDiagKey = key;
      ctx.log(`diag enabled=${diag.enabled} shotsSeen=${diag.shotsSeen}`
        + ` shotsMoved=${diag.shotsMoved} maxMoveTiles=${diag.maxMoveTiles}`
        + ` overCap=${diag.overCap}`
        + ` enemyHitsSent=${diag.enemyHitsSent} enemyHitsBlocked=${diag.enemyHitsBlocked}`
        + (diag.overCap > 0 ? '  <-- a shot origin was moved past the 2-tile cap' : ''));
    }
  });

  ctx.registerCleanup(() => {
    scheduler.stop();
    sendDllFeature('killauraEnabled', false);
  });
}
