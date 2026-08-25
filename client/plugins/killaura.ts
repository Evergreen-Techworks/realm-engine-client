import type { PluginContext, Packet } from './api.js';
import { sendDllFeature, getDllAim, getDllAimAgeMs, RuntimeScheduler } from './api.js';

/**
 * Killaura — outbound half.
 *
 * The DLL picks the target, SOLVES THE SHOT ORIGIN ONCE, and publishes both over
 * the named pipe (DllAimBus) stamped with a generation. This plugin rewrites the
 * OUTGOING `PLAYERSHOOT.projectilePosition` to that published origin so the
 * *server's* simulation of the shot starts where the DLL already put the local
 * bullet. The local bullet origin is the DLL's job (plan 87) — nothing here pulls
 * a trigger, blocks a packet, or lies about `playerPosition`.
 *
 * IT DOES NOT COMPUTE AN ORIGIN. It used to: it re-derived one from
 * `tx - cos(angle) * standoff` off an aim sample up to 250 ms stale, while the
 * DLL armed the local bullet from a LIVE solve at spawn time. Nothing forced the
 * two to match, so the client claimed a hit the server's simulation never
 * produced. One value, one generation, or no rewrite at all.
 *
 * Everything fails closed: a stale/absent aim, a non-finite number, an origin
 * beyond the DLL's hard cap, or a packet whose serialize round-trip is not
 * byte-identical all forward the shot completely unchanged.
 */
export function register(ctx: PluginContext) {
  ctx.name = 'Killaura';
  ctx.category = 'combat';
  // Off by default — this rewrites outbound game traffic; opt in explicitly.
  ctx.enabled = false;

  const stats = {
    rewrites: 0,
    enemyHitsSent: 0,
    enemyHitsBlocked: 0,
    /** Shots forwarded unchanged because no non-stale authoritative origin was held. */
    staleSkips: 0,
    /** Generation of the origin the LAST outbound rewrite used. See the diag line. */
    lastGen: 0,
  };

  /**
   * Freshness bound for the aim sample, in ms of LOCAL RECEIVE time.
   *
   * Was 250 ms, which is ~30 DLL refreshes (KillAura::Tick self-throttles to
   * 8 ms) — an origin that old describes where the target WAS, not where the DLL
   * just put the bullet. A shot is a discrete event; the sample has to be
   * near-current or it is not evidence about this shot.
   *
   * 80 ms is the floor that still clears the transport: the DLL's pipe writer
   * drains pending aim payloads on a 25 ms loop (IpcBridge.cpp), so a live
   * publisher lands a sample roughly every 25-40 ms and 80 ms leaves ~2 write
   * cycles of slack for node event-loop jitter without ever admitting a sample
   * from a stalled publisher.
   */
  const AIM_MAX_AGE_MS = 80;

  /**
   * Serialize-identity self-check. `ClientConnection` forwards a modified packet
   * by calling `packetFactory.serialize()`, which RECONSTRUCTS the packet from
   * the parsed fields (see the warning at ClientConnection.ts:143-149). If the
   * PLAYERSHOOT definition ever drifts from the live game, that reconstruction
   * would corrupt every shot. So before the first rewrite on a connection we
   * serialize the UNMODIFIED packet and demand byte-for-byte equality with
   * rawBytes; a mismatch permanently disarms this connection.
   */
  let armState: 'unknown' | 'armed' | 'refused' = 'unknown';

  function armIfSerializeIsIdentity(packet: Packet): boolean {
    if (armState === 'armed') return true;
    if (armState === 'refused') return false;
    let rebuilt: Buffer | null = null;
    try {
      rebuilt = ctx.serializePacket(packet);
    } catch {
      rebuilt = null;
    }
    // `rebuilt !== packet.rawBytes` is load-bearing, not redundant with .equals():
    // PacketFactory.serialize returns the SAME Buffer object (`return packet.rawBytes`)
    // when writeFields throws, so .equals() alone is trivially true on the failure
    // path and would latch ARMED for a packet definition we cannot actually rebuild.
    // Identity of the object means "serialize gave up", so treat it as REFUSED.
    const ok = Buffer.isBuffer(rebuilt)
      && rebuilt !== packet.rawBytes
      && rebuilt.equals(packet.rawBytes);
    armState = ok ? 'armed' : 'refused';
    ctx.log(ok
      ? 'PLAYERSHOOT serialize round-trip is byte-identical — origin rewrite ARMED'
      : 'PLAYERSHOOT serialize round-trip MISMATCH — origin rewrite REFUSED (stale packet definition)');
    return ok;
  }

  // ── Settings ────────────────────────────────────────────────────────────

  function modeIdx(): number {
    return ctx.getSetting<string>('aimMode') === 'mouse' ? 1 : 0;
  }

  function syncControlState() {
    sendDllFeature('killauraMode', modeIdx());
    sendDllFeature('killauraRangeTiles', ctx.getSetting<number>('rangeTiles'));
    sendDllFeature('killauraStandoffTiles', ctx.getSetting<number>('standoffTiles'));
    sendDllFeature('killauraMaxOffsetTiles', ctx.getSetting<number>('maxOffsetTiles'));
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
    label: 'Target range (tiles)',
    // 16 to match the DLL default (KillAura.cpp s_rangeTiles). These MUST agree:
    // syncControlState() sends killauraRangeTiles on every enable/settings change,
    // so a stale 8 here would silently override the DLL's 16 on every connect and
    // re-create the short-range target flapping this default was raised to fix.
    type: 'number',
    value: 16,
    min: 1,
    max: 30,
    step: 0.5,
  }, (val: number) => {
    sendDllFeature('killauraRangeTiles', val);
  });

  ctx.registerSetting('standoffTiles', {
    label: 'Standoff (tiles)',
    type: 'number',
    value: 0.35,
    min: 0,
    max: 3,
    step: 0.05,
  }, (val: number) => {
    sendDllFeature('killauraStandoffTiles', val);
  });

  ctx.registerSetting('maxOffsetTiles', {
    label: 'Max origin offset (tiles)',
    type: 'number',
    value: 12,
    min: 0,
    max: 30,
    step: 0.5,
  }, (val: number) => {
    sendDllFeature('killauraMaxOffsetTiles', val);
  });

  // DEFAULT OFF as of 2026-08-24 — this rewrite gets you DISCONNECTED.
  //
  // Measured, 3 for 3 in %TEMP%\realm-engine-proxy.log: every time this armed,
  // the server sent FAILURE (errorId=0, empty errorMessage) and dropped the
  // connection ~1.4s later — log lines 2249->2250, 2272->2273, 2368->2369. The
  // packet itself is fine (the serialize round-trip guard below verifies it is
  // byte-identical); the server rejects the CONTENT. It validates the shot
  // origin against the player's real position, and this moves it up to
  // maxOffsetTiles (default 12) away, versus vanilla's ~0.3.
  //
  // The plan that introduced this (docs/plans/84-overview.md) argued killaura
  // needed BOTH an outbound rewrite and a local-bullet rewrite. Re-reading it:
  // the "(A) alone is not enough" half was evidence-backed (o3-helper.ts blocks
  // ENEMYHIT to stop damage, proving the client is what deals damage), but the
  // "(C) alone is not enough" half was a hedge — "the hit CAN be rejected" —
  // never verified. ENEMYHIT is client->server, so the local-bullet rewrite
  // (ShotOrigin, DLL side) may well be sufficient on its own: the bullet
  // actually reaches the enemy, the client claims the hit, and the server sees
  // an entirely ordinary PLAYERSHOOT originating at the player.
  //
  // So: local-only is the default. Turning this ON re-enables the outbound
  // rewrite for experimentation ONLY — expect to be disconnected.
  ctx.registerSetting('rewriteOutbound', {
    label: 'Rewrite outbound shot origin (DISCONNECTS — experimental)',
    type: 'boolean',
    value: false,
  });

  ctx.onEnabledChange(() => {
    syncControlState();
  });

  // DIAGNOSTIC — is the client claiming hits at all?
  //
  // Symptom being chased: bullets visibly reach the enemy but nothing takes
  // damage. Damage in RotMG is client-claimed (ENEMYHIT, client->server), so
  // there are exactly two worlds and this counter separates them:
  //   sent > 0  -> the client IS claiming hits; the SERVER is rejecting them
  //   sent == 0 -> the client never registered a collision, so moving the
  //                bullet's rendered position did not move the game's own hit
  //                test (it likely derives position from the projectile's
  //                internal start+angle+elapsed rather than the rendered one).
  // `blocked` counts hits some other plugin suppressed (o3-helper does this
  // inside the O3 Sanctuary) so a suppressed hit can never be mistaken for a
  // hit that was never claimed.
  ctx.hookPacket('ENEMYHIT', (_client, packet) => {
    if (packet.send === false) stats.enemyHitsBlocked++;
    else stats.enemyHitsSent++;
  });

  // ── PLAYERSHOOT origin rewrite ──────────────────────────────────────────

  // Registered WITHOUT `prepend` on purpose. Proxy.firePacketHooks runs handlers
  // in registration order and StateManager.attach registers its own PLAYERSHOOT
  // handler at startup, before any plugin. That handler infers playerData.pos
  // from projectilePosition (StateManager.ts:219-228), so it must see the
  // ORIGINAL value — running after it is what keeps that inference honest.
  ctx.hookPacket('PLAYERSHOOT', (_client, packet) => {
    if (!ctx.enabled) return;
    if (!ctx.getSetting<boolean>('rewriteOutbound')) return;
    if (!packet.isDefined) return;                       // unknown shape -> never touch

    // Fail closed on staleness. `originValid === false` means that DLL refresh
    // solved no origin at all (the standoff/maxOffset caps refused it), so there
    // is nothing authoritative to forward — the shot goes out untouched, exactly
    // as the DLL left the local bullet untouched.
    const aim = getDllAim(AIM_MAX_AGE_MS);
    if (!aim || !aim.armed || aim.targetId === 0 || !aim.originValid) {
      stats.staleSkips++;
      return;
    }

    const player = packet.data.playerPosition;
    const proj = packet.data.projectilePosition;
    if (!player || !proj) return;
    if (!Number.isFinite(player.x) || !Number.isFinite(player.y)) return;

    // The DLL's ONE origin, forwarded verbatim. No arithmetic here on purpose:
    // any expression in this file is a second implementation of the formula in
    // KillAura::SolveShotOrigin and can drift from it.
    const ox = aim.ox;
    const oy = aim.oy;
    if (!Number.isFinite(ox) || !Number.isFinite(oy)) return;

    // HARD CAP, re-checked against the PACKET'S OWN player position. The DLL
    // already capped against the position it held at solve time; this is an
    // independent net against the player having moved since.
    const dx = ox - player.x, dy = oy - player.y;
    if (dx * dx + dy * dy > aim.maxOffsetTiles * aim.maxOffsetTiles) return;

    if (!armIfSerializeIsIdentity(packet)) return;

    packet.data.projectilePosition = { x: ox, y: oy };
    packet.modified = true;
    stats.rewrites++;
    stats.lastGen = aim.generation;
  });

  // ── Lifecycle + diagnostics ─────────────────────────────────────────────

  ctx.on('clientConnected', () => {
    // Re-run the self-check once per connection.
    armState = 'unknown';
    syncControlState();
  });

  let lastDiagKey = '';
  const scheduler = new RuntimeScheduler();
  scheduler.scheduleRepeating(1000, () => {
    const aim = getDllAim();
    const diag = {
      armed: armState === 'armed',
      targetId: aim?.targetId ?? 0,
      rewrites: stats.rewrites,
      enemyHitsSent: stats.enemyHitsSent,
      enemyHitsBlocked: stats.enemyHitsBlocked,
      refused: armState === 'refused',
      aimAgeMs: getDllAimAgeMs(),
      // The generation the LAST outbound rewrite used. Its counterpart is `gen=`
      // on the DLL trace log's [ShotOriginHook] "REWRITTEN" line, which is the
      // generation the LOCAL bullet rewrite used. The two consumers sample the
      // same published value at different latencies, so they will not always be
      // equal — but a LARGE, GROWING gap means the server is being told an origin
      // from a refresh the local bullet never used, which is the divergence that
      // makes the server refuse the hit claim.
      gen: stats.lastGen,
      staleSkips: stats.staleSkips,
    };
    ctx.setData('killaura', diag);
    ctx.broadcastData('killaura', diag);

    // Also mirror to the proxy log on CHANGE. broadcastData only reaches the
    // dashboard UI, which means these counters could not be read after the fact
    // or from outside the running app — and the whole point of them is to settle
    // "is the client claiming hits, or is the server refusing them?" from
    // evidence rather than argument. Change-keyed, so a steady state costs one
    // string compare per second and an idle session logs nothing.
    //
    //   GREP THE PROXY LOG FOR:  [Killaura] diag
    //   (%TEMP%\\realm-engine-proxy.log)
    // `gen` and `staleSkips` are PRINTED but deliberately NOT in the change key.
    // gen moves in lockstep with rewrites (already keyed), and staleSkips ticks
    // on every shot fired while unarmed — keying on it would turn a steady
    // "enabled but no target" session into one log line every second.
    const key = `${diag.armed}|${diag.refused}|${diag.targetId}|${diag.rewrites}`
              + `|${diag.enemyHitsSent}|${diag.enemyHitsBlocked}`;
    if (key !== lastDiagKey) {
      lastDiagKey = key;
      ctx.log(`diag armed=${diag.armed} refused=${diag.refused}`
        + ` target=${diag.targetId} rewrites=${diag.rewrites}`
        + ` enemyHitsSent=${diag.enemyHitsSent} enemyHitsBlocked=${diag.enemyHitsBlocked}`
        + ` aimAgeMs=${diag.aimAgeMs} gen=${diag.gen} staleSkips=${diag.staleSkips}`
        + (diag.rewrites > 0 && diag.enemyHitsSent === 0
            ? '  <-- bullets moved but the client NEVER claimed a hit'
            : ''));
    }
  });

  ctx.registerCleanup(() => {
    scheduler.stop();
    sendDllFeature('killauraEnabled', false);
  });
}
