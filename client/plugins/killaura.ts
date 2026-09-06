import type { PluginContext, Packet } from './api.js';
import { sendDllFeature, getDllAim, getDllAimAgeMs, RuntimeScheduler } from './api.js';

/**
 * Killaura — outbound half.
 *
 * The DLL picks the target, SOLVES THE SHOT ORIGIN ONCE, and publishes both over
 * the named pipe (DllAimBus) stamped with a generation. This plugin rewrites the
 * OUTGOING `PLAYERSHOOT.projectilePosition` to that published origin. It is now
 * the ONLY consumer of that origin: the DLL-side hook that displaced the LOCAL
 * bullet was deleted after it was measured to buy no extra reach while making
 * the at-range hit claims less plausible (see the measured-result block at the
 * top of internal/src/features/combat/autoaim/modes/KillAura.cpp). Nothing here
 * pulls a trigger or blocks a packet.
 *
 * `spoofPlayerPosition` (default ON) additionally rewrites `playerPosition` to
 * the same origin, so the frame is INTERNALLY consistent ("I am at B and my shot
 * started at B") instead of self-contradictory ("I am at A, my shot started at
 * B"). Turning it OFF reproduces the old, measured-to-disconnect behaviour. See
 * the long comment on that setting for the cross-packet caveat.
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
// Vanilla muzzle offset: a real shot spawns this far from the player centre along
// the fire angle. Mirrors StateManager.ts:225 (which back-derives the player
// position from the packet using the same 0.3) and the DLL's kMuzzleMinTiles.
const kVanillaMuzzleTiles = 0.3;

export function register(ctx: PluginContext) {
  ctx.name = 'Killaura';
  ctx.category = 'combat';
  // Off by default — this rewrites outbound game traffic; opt in explicitly.
  ctx.enabled = false;

  const stats = {
    rewrites: 0,
    /**
     * Of `rewrites`, how many ALSO rewrote `playerPosition` (the consistent-frame
     * variant). `rewrites - rewritesBoth` is the count that went out in the old
     * projectilePosition-only shape, so a log line read after the fact says which
     * variant was actually armed when the server did or did not drop us.
     */
    rewritesBoth: 0,
    enemyHitsSent: 0,
    enemyHitsBlocked: 0,
    /** Shots forwarded unchanged because no non-stale authoritative origin was held. */
    staleSkips: 0,
    /** Generation of the origin the LAST outbound rewrite used. See the diag line. */
    lastGen: 0,
  };
  // The server validates ENEMYHIT against its MOVE-authoritative player
  // position. Displacing only the shot frame can produce a local collision that
  // the server rejects (the visible "ghost hit"). Keep production killaura
  // angle-only; retain the old setting solely for config compatibility.
  const serverValidOriginRewrite = false;

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
     * auto on every connect — which is exactly the bug this replaces (a flat 16
     * that REPLACED the weapon-derived radius and locked targets out of reach).
     *
     * A non-zero value can only SHRINK the weapon's range, never extend it. The
     * server validates hits against its OWN position for you, maintained from the
     * MOVE stream, so extra reach is not something the shot packet can claim —
     * see the measured-result block at the top of KillAura.cpp.
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
    label: 'Standoff (tiles)',
    type: 'number',
    value: 0.35,
    min: 0,
    max: 3,
    step: 0.05,
  }, (val: number) => {
    sendDllFeature('killauraStandoffTiles', val);
  });

  // `maxOffsetTiles` USED to be a user setting here (and a `killauraMaxOffsetTiles`
  // feature key). It is gone from both sides: the cap is now DERIVED in the DLL
  // from the selection radius it is meant to bound (KillAura.cpp,
  // kKaOriginCapMarginTiles) and published on the aim payload, so the two can no
  // longer disagree. As a user slider at 12 against a 16-tile selection radius it
  // refused every origin for a target 12-16 tiles out — measured staleSkips=291
  // against rewrites=81. The re-check below still uses the published value.

  // HISTORY, and why the default is still OFF.
  //
  // 2026-08-24 — measured 3 for 3 in %TEMP%\realm-engine-proxy.log: every time
  // this armed, the server sent FAILURE (errorId=0, empty errorMessage) and
  // dropped the connection ~1.4s later — log lines 2249->2250, 2272->2273,
  // 2368->2369. The packet itself was fine (the serialize round-trip guard below
  // verifies it is byte-identical); the server rejected the CONTENT, a frame
  // claiming "I am at A, my bullet started 12 tiles away at B".
  //
  // 2026-08-25 — that is FIXED. With `spoofPlayerPosition` ON (below), which
  // rewrites BOTH fields into a self-consistent frame, the same session measured
  // 81/81 rewrites ACCEPTED and zero FAILURE. The disconnect is not a reason to
  // leave this off any more.
  //
  // What it still does NOT buy is RANGE. Enemies die when the player is adjacent
  // and not at range, which says the server validates ENEMYHIT against its OWN
  // position for us — maintained from the MOVE stream — not against the position
  // the shot packet claims. Our claimed position is accepted-but-not-
  // authoritative, so this rewrite changes where the server thinks the bullet
  // started without changing what it will accept as a hit.
  //
  // Left DEFAULT OFF pending an explicit decision: it is measurably safe now, but
  // it is also not yet measurably useful, and it is the one thing here that
  // touches outbound traffic.
  ctx.registerSetting('rewriteOutbound', {
    label: 'Legacy shot-origin rewrite (disabled: causes ghost hits)',
    type: 'boolean',
    value: false,
  });

  // The A/B knob for the "consistent frame" hypothesis. Only has any effect
  // while `rewriteOutbound` is ON.
  //
  //   ON  (default) — PLAYERSHOOT goes out with BOTH `projectilePosition` and
  //                   `playerPosition` set to the DLL's solved origin: "I am
  //                   standing at B and my shot started at B." Nothing inside
  //                   the packet contradicts itself, so the server's own
  //                   simulation starts the bullet where we claim, from a
  //                   position we also claim to occupy.
  //   OFF           — only `projectilePosition` is rewritten. This is the exact
  //                   shape that was measured to DISCONNECT 4/4 times: the frame
  //                   says "I am at A, my bullet started 12 tiles away at B",
  //                   which is trivially self-contradictory. Leave it OFF only
  //                   to reproduce that baseline.
  //
  // CAVEAT, UNTESTED, READ BEFORE TRUSTING THE ON PATH: internal consistency is
  // not the only consistency the server can check. MOVE (id 62) is sent by the
  // game client every tick and carries LocationRecord{time,x,y} samples of the
  // player's REAL position; the server also runs its own authoritative position
  // for us and echoes it back in NEWTICK (and rubberbands us to it — see the
  // header comment on player-noclip.ts). Nothing on the killaura path touches
  // MOVE. So with this ON the stream reads: MOVE "I am at A" (5x/sec) … PLAYERSHOOT
  // "I am at B, up to maxOffsetTiles away" … MOVE "I am at A" again. That is a
  // per-shot teleport out and back, which is at least as detectable as the
  // self-contradiction it removes and is a well-known ban heuristic. It is
  // shipped as a toggle because a real in-game result beats this reasoning.
  ctx.registerSetting('spoofPlayerPosition', {
    label: 'Also spoof playerPosition (consistent frame) — OFF = old known-disconnect shape',
    type: 'boolean',
    value: true,
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
  //   sent == 0 -> the client never registered a collision at all, so the bullet
  //                is not reaching the enemy and nothing downstream can help.
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
    if (!serverValidOriginRewrite) return;
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
    // Consistent-frame variant: claim to be standing where the bullet started.
    // Read AFTER the cap check above, which needs the packet's REAL player
    // position — moving this line earlier would cap the origin against itself.
    //
    // StateManager's own PLAYERSHOOT handler is unaffected either way: it is
    // registered in StateManager.attach (index.ts:213, before any plugin loads)
    // and hooks fire in registration order (Proxy.firePacketHooks), so it has
    // already run on the ORIGINAL values by the time this executes — and it
    // reads projectilePosition + angle only, never playerPosition.
    // The packet's OWN fire angle -- the same field the server will use to
    // simulate this shot, so the muzzle offset below is derived from exactly the
    // direction the frame declares rather than from our (possibly staler) aim.
    const shotAngle = packet.data.angle;
    const spoofPlayer = ctx.getSetting<boolean>('spoofPlayerPosition') !== false
                     && typeof shotAngle === 'number' && Number.isFinite(shotAngle);
    if (spoofPlayer) {
      // NOT `{ x: ox, y: oy }`. Every vanilla PLAYERSHOOT satisfies
      //     projectilePosition = playerPosition + kVanillaMuzzleTiles * (cos a, sin a)
      // -- that is the muzzle offset, and it is exactly how our OWN StateManager
      // back-derives the player position from the packet (StateManager.ts:225).
      // Writing the origin into both fields would make |proj - player| == 0, which
      // no real client ever sends: we would have removed one trivially-detectable
      // inconsistency and introduced another. Claim instead to be standing where a
      // real player WOULD have to stand for that bullet to spawn where we say.
      packet.data.playerPosition = {
        x: ox - Math.cos(shotAngle) * kVanillaMuzzleTiles,
        y: oy - Math.sin(shotAngle) * kVanillaMuzzleTiles,
      };
      stats.rewritesBoth++;
    }
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
      /** Rewrites that ALSO spoofed playerPosition (consistent-frame variant). */
      rewritesBoth: stats.rewritesBoth,
      /** Which variant is armed right now, so a toggle is visible in the log. */
      spoofPlayerPosition: ctx.getSetting<boolean>('spoofPlayerPosition') !== false,
      enemyHitsSent: stats.enemyHitsSent,
      enemyHitsBlocked: stats.enemyHitsBlocked,
      refused: armState === 'refused',
      aimAgeMs: getDllAimAgeMs(),
      // The generation the LAST outbound rewrite used. It is now the ONLY
      // consumer of the published origin (the DLL-side local-bullet rewrite that
      // used to carry its own `gen=` in the trace log is deleted), so this is a
      // freshness readout rather than a divergence check: a `gen` that stops
      // moving while `rewrites` climbs would mean the publisher has stalled.
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
    // `spoofPlayerPosition` IS in the change key (unlike gen/staleSkips): it only
    // moves when the user flips the A/B toggle, and the whole point of the line
    // is to say which variant was armed when the connection did or did not drop.
    // `rewritesBoth` is printed but not keyed — it moves in lockstep with
    // `rewrites` whenever the toggle is ON, which is already keyed.
    const key = `${diag.armed}|${diag.refused}|${diag.targetId}|${diag.rewrites}`
              + `|${diag.enemyHitsSent}|${diag.enemyHitsBlocked}|${diag.spoofPlayerPosition}`;
    if (key !== lastDiagKey) {
      lastDiagKey = key;
      ctx.log(`diag armed=${diag.armed} refused=${diag.refused}`
        + ` target=${diag.targetId} rewrites=${diag.rewrites}`
        + ` rewritesBoth=${diag.rewritesBoth} spoofPlayerPos=${diag.spoofPlayerPosition}`
        + ` enemyHitsSent=${diag.enemyHitsSent} enemyHitsBlocked=${diag.enemyHitsBlocked}`
        + ` aimAgeMs=${diag.aimAgeMs} gen=${diag.gen} staleSkips=${diag.staleSkips}`
        + (diag.rewrites > 0 && diag.enemyHitsSent === 0
            ? '  <-- shots rewritten but the client NEVER claimed a hit'
            : ''));
    }
  });

  ctx.registerCleanup(() => {
    scheduler.stop();
    sendDllFeature('killauraEnabled', false);
  });
}
