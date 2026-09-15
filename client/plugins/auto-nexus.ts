import type { PluginContext, ClientConnection, Packet, GameDataLoader } from './api.js';
import { sendDllFeature, StatType, getDllThreats, getDllThreatsAgeMs } from './api.js';
import { remainingHitMs } from './auto-nexus/forecastTiming.js';
import { HealthEvidence } from './auto-nexus/healthEvidence.js';
import {
  type ShotRecord,
  appliedDamage,
  bulletKey,
  isInvulnerable,
  isPacketDamage,
  isSyntheticThreat,
  shotCount,
  shotTtlMs,
  withOnHitEffects,
} from './auto-nexus/hitLedger.js';

// Confirmed health protects the player. The two predictive layers are observations:
//  1. Confirmed health — server HP (NEWTICK/UPDATE) and server DAMAGE amounts.
//  2. Hit ledger — each outgoing PLAYERHIT charges the damage the server stated
//     for that bullet in ENEMYSHOOT, after defense, until the next server HP.
//  3. Short forecast (optional) — bullets already fired, with a packet damage,
//     that the native scanner predicts will hit within a short horizon.
// AoE visuals, ground estimates, unknown bullets, guessed regeneration and
// synthetic native threats never charge HP. Outgoing PLAYERHITs are observed only:
// never held, dropped or modified.
const SAFE_ZONE_MAPS = new Set([
  'Nexus', 'Vault',
  'Guild Hall', 'Guild Hall 2', 'Guild Hall 3', 'Guild Hall 4', 'Guild Hall 5',
  'Cloth Bazaar', 'Nexus Explanation', 'Vault Explanation', 'Guild Explanation',
  'Daily Quest Room', 'Daily Login Room',
  'Pet Yard', 'Pet Yard 2', 'Pet Yard 3', 'Pet Yard 4', 'Pet Yard 5',
].map(name => name.toLowerCase()));

// ── Burst guard ──────────────────────────────────────────────────────────────
// A fixed threshold only helps if some server health update lands between the
// threshold and zero. In the 2026-09-12 session all three deaths had their last
// confirmed HP just ABOVE the threshold (75/775 at 9%, 43/435 at 9%, 21/147 at
// 10%) and the next damage killed before another update arrived. The burst guard
// raises the escape point to the largest HP loss the server has CONFIRMED within
// one reaction window recently: if that much can land again before we can react,
// the current HP is not safe. It is fed by server HP only.
/** Damage that can land before an escape can take effect: one server tick plus a round trip. */
const BURST_WINDOW_MS = 400;
/** How long an observed burst keeps the escape point raised. */
const BURST_MEMORY_MS = 6000;
/** The next burst can be larger than the largest one seen. */
const BURST_MARGIN = 1.25;
/** Never raise the escape point above this share of max HP. */
const BURST_GUARD_MAX_PCT = 50;

// ── Hit ledger / forecast ────────────────────────────────────────────────────
/** Shots kept per connection; a busy boss room stays far below this between prunes. */
const MAX_SHOTS = 4096;
const SHOT_PRUNE_INTERVAL_MS = 1000;
/** Native threat scans older than this are discarded (see forecastTiming). */
const FORECAST_MAX_SCAN_AGE_MS = 100;
const FORECAST_POLL_MS = 20;
const DEFAULT_FORECAST_HORIZON_MS = 250;
/** Bullets listed per escape log line. */
const MAX_LOGGED_BULLETS = 8;

interface Charge {
  key: string;
  ownerType: number | null;
  raw: number;
  applied: number;
  armorPiercing: boolean | null;
}

interface BulletNote extends Omit<Charge, 'key'> {
  /** Forecast only: time until the predicted hit. */
  inMs?: number;
}

interface EscapePoint { hp: number; burst: number; guarded: boolean }

type EscapeLayer = 'confirmed-health' | 'hit-ledger' | 'forecast' | 'manual';

export type PredictionMode = 'off' | 'observe' | 'active';
export interface PredictionObservation {
  sampleAt: number;
  generation: number;
  mode: PredictionMode;
  layer: 'hit-ledger' | 'forecast';
  confirmedHp: number | null;
  healthAgeMs: number | null;
  predictedHp: number | null;
  effectiveThreshold: number;
  thresholdCrossed: boolean;
  lethal: boolean;
  nativeScanAgeMs: number | null;
  sourceCertainty: 'ambiguous';
  pendingDamage: number;
  certainty: 'identified' | 'ambiguous';
}

interface NexusState {
  generation: number;
  evidence: HealthEvidence;
  ownerIncarnations: Map<number, number>;
  shotSequence: number;
  hp: number | null;
  maxHp: number;
  healthAt: number | null;
  safe: boolean;
  escaped: boolean;
  retry: ReturnType<typeof setInterval> | null;
  /** Confirmed HP values from the last BURST_WINDOW_MS, oldest first. */
  samples: { at: number; hp: number; maxHp: number }[];
  /** Confirmed HP losses within one BURST_WINDOW_MS, from the last BURST_MEMORY_MS. */
  bursts: { at: number; loss: number }[];
  /** Bullets the server announced to this connection, by `owner:bulletId`. */
  shots: Map<string, ShotRecord>;
  lastShotPruneAt: number;
  /** Hits charged since the last explicit server HP. */
  charges: Charge[];
  /** Condition bits charged bullets applied since the last server HP. */
  ledgerEffects: [number, number];
}

export function register(ctx: PluginContext, testHooks?: { allowActivePredictionForTests?: boolean }) {
  ctx.name = 'Auto Nexus';
  ctx.category = 'combat';
  let thresholdPct = 25;
  let showNotification = true;
  let retryCount = 4;
  let retryMs = 400;
  let burstGuard = true;
  let forecastEnabled = true;
  let predictionMode: PredictionMode = 'observe';
  const observations = new WeakMap<ClientConnection, PredictionObservation>();
  let horizonMs = DEFAULT_FORECAST_HORIZON_MS;
  let states = new WeakMap<ClientConnection, NexusState>();
  let activeClient: ClientConnection | null = null;
  const timers = new Set<ReturnType<typeof setInterval>>();

  function activePredictionAllowed(): boolean {
    return predictionMode !== 'off' && testHooks?.allowActivePredictionForTests === true;
  }

  ctx.registerSetting('PredictionMode', {
    label: 'Prediction (observation only)', type: 'select', value: 'observe',
    options: [{ label: 'Off', value: 'off' }, { label: 'Observe', value: 'observe' }],
  }, (value: string) => {
    predictionMode = value === 'off' ? 'off' : 'observe';
    if (value !== predictionMode) ctx.updateSetting('PredictionMode', predictionMode);
    syncNativeForecast();
  });

  ctx.registerSetting('ForceAutoNexusHealth', {
    label: 'Nexus Health', type: 'range', value: thresholdPct, min: 0, max: 100, step: 1,
  }, (v: number) => {
    if (!Number.isFinite(v)) return;
    const next = Math.max(0, Math.min(100, v));
    // Logged because the startup line shows the code default before the saved
    // profile applies; without this the log cannot say which threshold was live.
    if (next !== thresholdPct) ctx.log(`Nexus threshold set to ${next}% HP (was ${thresholdPct}%)`);
    thresholdPct = next;
  });
  ctx.registerSetting('BurstGuard', {
    label: 'Burst guard (nexus earlier after big confirmed hits)', type: 'boolean', value: true,
  }, (v: boolean) => { burstGuard = v === true; });
  // New keys on purpose: the pre-2026-09-06 prediction settings (PredictedAutoNexusHealth,
  // PredictedAutoNexusTime, IncludeGroundTicks, HoldLethalPlayerHit, ...) stay
  // unregistered, so a saved profile carrying them cannot bring that behaviour back.
  ctx.registerSetting('PredictiveNexusForecast', {
    label: 'Predictive Nexus (forecast)', type: 'boolean', value: true,
  }, (v: boolean) => {
    const next = v === true;
    if (next !== forecastEnabled) ctx.log(`Predictive Nexus forecast ${next ? 'on' : 'off'}`);
    forecastEnabled = next;
    syncNativeForecast();
  });
  ctx.registerSetting('PredictiveNexusHorizonMs', {
    label: 'Forecast horizon (ms)', advanced: true, type: 'range', value: DEFAULT_FORECAST_HORIZON_MS,
    min: 100, max: 400, step: 10, visibleWhen: { key: 'PredictiveNexusForecast', value: true },
  }, (v: number) => {
    const n = Math.trunc(Number(v));
    horizonMs = Number.isFinite(n) ? Math.max(100, Math.min(400, n)) : DEFAULT_FORECAST_HORIZON_MS;
    syncNativeForecast();
  });
  ctx.registerSetting('ShowChatMessageOnNexus', {
    label: 'Show Chat Message on Nexus', advanced: true, type: 'boolean', value: true,
  }, (v: boolean) => { showNotification = v === true; });
  ctx.registerSetting('EscapeRetryCount', {
    label: 'Escape Retries', advanced: true, type: 'range', value: 4, min: 0, max: 10, step: 1,
  }, (v: number) => { retryCount = Math.max(0, Math.min(10, Math.trunc(Number(v) || 0))); });
  ctx.registerSetting('EscapeRetryIntervalMs', {
    label: 'Escape Retry Interval', advanced: true, type: 'range', value: 400, min: 100, max: 2000, step: 50,
  }, (v: number) => { retryMs = Math.max(100, Math.min(2000, Math.trunc(Number(v) || 400))); });

  // Native Auto Nexus only publishes projectile forecasts; it never sends ESCAPE
  // and its damage numbers are ignored here. Its ground predictor and overlay stay
  // off. Re-sent on connect and map change so restored native state cannot linger.
  function syncNativeForecast(): void {
    const on = ctx.enabled && forecastEnabled && predictionMode !== 'off';
    sendDllFeature('autoNexusTilePredict', false);
    sendDllFeature('autoNexusDebugDraw', false);
    // Scan past the horizon by the accepted scan age, so a hit at the horizon edge
    // is still listed when the scan it came from is up to that old.
    if (on) sendDllFeature('autoNexusPredictedTimeMs', horizonMs + FORECAST_MAX_SCAN_AGE_MS);
    sendDllFeature('autoNexusProjPredict', on);
    sendDllFeature('autoNexusEnabled', on);
  }
  syncNativeForecast();
  ctx.onEnabledChange(() => {
    syncNativeForecast();
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    states = new WeakMap(); // re-enable must not reuse health, shots or charges from before the pause
    activeClient = null;
  });
  ctx.on('clientConnected', syncNativeForecast);

  let lastForecastErrorAt = -Infinity;
  const forecastTimer = setInterval(() => {
    const client = activeClient;
    if (!client || !ctx.enabled || !forecastEnabled) return;
    try { checkForecast(client, stateFor(client)); }
    catch (error) {
      const now = Date.now();
      if (now - lastForecastErrorAt >= 10000) { lastForecastErrorAt = now; ctx.log(`Forecast check failed: ${String(error)}`); }
    }
  }, FORECAST_POLL_MS);
  ctx.registerCleanup(() => {
    clearInterval(forecastTimer);
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    sendDllFeature('autoNexusEnabled', false);
    sendDllFeature('autoNexusProjPredict', false);
    sendDllFeature('autoNexusTilePredict', false);
    sendDllFeature('autoNexusDebugDraw', false);
  });

  function stateFor(client: ClientConnection): NexusState {
    let state = states.get(client);
    if (!state) {
      const evidence = new HealthEvidence();
      const generation = client.admission?.generation ?? 0;
      evidence.reset(generation);
      state = { generation, evidence, ownerIncarnations: new Map(), shotSequence: 0,
        hp: null, maxHp: 0, healthAt: null, safe: SAFE_ZONE_MAPS.has(
        String(client.playerData?.mapName ?? '').trim().toLowerCase()), escaped: false, retry: null,
        samples: [], bursts: [], shots: new Map(), lastShotPruneAt: 0, charges: [], ledgerEffects: [0, 0] };
      states.set(client, state);
    }
    return state;
  }
  function stopRetry(state: NexusState): void {
    if (state.retry) { clearInterval(state.retry); timers.delete(state.retry); state.retry = null; }
  }
  function clearLedger(state: NexusState): void {
    state.charges = [];
    state.ledgerEffects = [0, 0];
    state.evidence.reset(state.generation);
    if (state.hp !== null) state.evidence.observeHp(state.hp, Date.now());
  }
  function reset(client: ClientConnection, safe: boolean): void {
    const state = stateFor(client); stopRetry(state);
    state.generation = client.admission?.generation ?? 0;
    state.hp = null; state.maxHp = 0; state.healthAt = null; state.safe = safe; state.escaped = false;
    state.samples = []; state.bursts = [];
    state.shots.clear(); clearLedger(state);
    state.ownerIncarnations.clear(); state.shotSequence = 0;
    observations.delete(client);
  }
  ctx.on('clientDisconnected', client => {
    stopRetry(stateFor(client)); states.delete(client);
    if (activeClient === client) activeClient = null;
  });
  ctx.hookPacket('MAPINFO', (client, packet) => {
    if (!packet.isDefined) return;
    reset(client, SAFE_ZONE_MAPS.has(String(packet.data.name ?? '').trim().toLowerCase()));
    syncNativeForecast();
  });
  ctx.hookPacket('CREATESUCCESS', client => { reset(client, stateFor(client).safe); });

  // ── Player numbers ─────────────────────────────────────────────────────────
  /**
   * Wire DEFENSE (stat 21) alone. `defense + defenseBonus` double-counts gear if
   * stat 21 is already the effective value, which is what the 2026-05 AutoNexus
   * investigation found (see StateManager's DefenseCheck). If stat 21 is instead
   * the base value, this understates defense and the ledger charges more: safe.
   */
  function defenseOf(client: ClientConnection): number {
    const def = Number(client.playerData?.defense);
    return Number.isFinite(def) ? def : 0;
  }
  function effectsOf(client: ClientConnection, state: NexusState): [number, number] {
    const wire = client.playerData?.effects;
    const e0 = Number(wire?.[0]) | 0, e1 = Number(wire?.[1]) | 0;
    return [e0 | state.ledgerEffects[0], e1 | state.ledgerEffects[1]];
  }
  function predictedHp(state: NexusState): number | null {
    return state.evidence.snapshot(Date.now()).predictedHp;
  }
  function ownerLabel(type: number | null): string {
    if (type === null) return 'unknown owner';
    const def = ctx.gameData?.getObject(type);
    const name = def?.displayId || def?.id;
    return `${name ? `${name} ` : ''}0x${type.toString(16)}`;
  }
  function describeBullets(bullets: BulletNote[]): string {
    if (bullets.length === 0) return 'none';
    const shown = bullets.slice(0, MAX_LOGGED_BULLETS).map(b =>
      `${ownerLabel(b.ownerType)} raw ${b.raw} -> ${b.applied}`
      + ` ${b.armorPiercing === true ? 'pierce' : b.armorPiercing === false ? 'def' : 'pierce(unknown)'}`
      + (b.inMs === undefined ? '' : ` in ${Math.round(b.inMs)}ms`));
    const more = bullets.length - shown.length;
    return `${bullets.length} [${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}]`;
  }

  // ── Escape ───────────────────────────────────────────────────────────────
  function escape(
    client: ClientConnection,
    state: NexusState,
    layer: EscapeLayer,
    reason: string,
    bullets: BulletNote[] = [],
    forecastHp: number | null = null,
  ): void {
    if ((layer === 'hit-ledger' || layer === 'forecast') && !activePredictionAllowed()) return;
    if ((layer === 'hit-ledger' || layer === 'forecast') && state.evidence.snapshot(Date.now()).certainty === 'ambiguous') return;
    if (state.escaped || !client.connected) return;
    state.escaped = true;
    const now = Date.now();
    const point = state.maxHp > 0 ? escapePoint(state, now) : null;
    const predicted = forecastHp ?? predictedHp(state);
    const round = (n: number | null) => (n === null ? 'unknown' : String(Math.round(n)));
    const detail = `layer=${layer}; predicted HP=${round(predicted)}/${state.maxHp}`
      + `; escape point=${point ? `${Math.round(point.hp)} HP (${point.guarded
        ? `burst guard, largest burst ${point.burst}` : `threshold ${thresholdPct}%`})` : 'unknown'}`
      + `; confirmed HP=${state.hp ?? 'unknown'}/${state.maxHp}`
      + ` age=${state.healthAt === null ? 'unknown' : `${now - state.healthAt}ms`}`
      + `; bullets=${describeBullets(bullets)}`;
    ctx.log(`AUTO NEXUS — ${detail}; ${reason}`);
    const send = () => {
      try {
        const packet = ctx.createPacket('ESCAPE'); packet.modified = true;
        client.sendToServer(packet);
      } catch (error) {
        ctx.log(`ESCAPE send failed; bounded retries remain available: ${String(error)}`);
      }
    };
    send();
    // Notification failures must never prevent the first ESCAPE or its retries.
    if (showNotification) {
      try {
        ctx.sendNotification(client, 'AutoNexus',
          `Escaped (${layer}) at predicted HP ${round(predicted)}/${state.maxHp}; confirmed ${state.hp ?? 'unknown'}\n${reason}`);
      } catch (error) { ctx.log(`Auto Nexus notification failed: ${String(error)}`); }
    }
    let remaining = retryCount;
    if (remaining <= 0) return;
    state.retry = setInterval(() => {
      if (!ctx.enabled || !client.connected || !state.escaped || remaining <= 0) { stopRetry(state); return; }
      send();
      if (--remaining <= 0) stopRetry(state);
    }, retryMs);
    timers.add(state.retry);
  }
  /** Record a newly confirmed HP value and any loss it completes within one reaction window. */
  function noteConfirmedHp(state: NexusState, now: number): void {
    if (state.hp === null || state.maxHp <= 0) return;
    // A max-HP change (gear, death, character) makes earlier values incomparable.
    state.samples = state.samples.filter(s => now - s.at <= BURST_WINDOW_MS && s.maxHp === state.maxHp);
    const peak = state.samples.reduce((best, s) => Math.max(best, s.hp), -Infinity);
    if (peak > state.hp) state.bursts.push({ at: now, loss: peak - state.hp });
    state.samples.push({ at: now, hp: state.hp, maxHp: state.maxHp });
    state.bursts = state.bursts.filter(b => now - b.at <= BURST_MEMORY_MS);
  }
  /** HP at or below which to escape now; `guarded` when the burst guard, not the threshold, set it. */
  function escapePoint(state: NexusState, now: number): EscapePoint {
    const threshold = state.maxHp * thresholdPct / 100;
    const burst = state.bursts.reduce((best, b) => now - b.at <= BURST_MEMORY_MS ? Math.max(best, b.loss) : best, 0);
    // A threshold of 0 is a deliberate "only at zero"; the guard does not override it.
    if (!burstGuard || thresholdPct <= 0) return { hp: threshold, burst, guarded: false };
    const guarded = Math.min(burst * BURST_MARGIN, state.maxHp * BURST_GUARD_MAX_PCT / 100);
    return guarded > threshold ? { hp: guarded, burst, guarded: true } : { hp: threshold, burst, guarded: false };
  }
  function armed(state: NexusState): boolean {
    return ctx.enabled && !state.safe && !state.escaped && state.hp !== null && state.maxHp > 0;
  }
  /** Layer 1: confirmed server HP. */
  function check(client: ClientConnection, state: NexusState, reason: string): void {
    if (!armed(state)) return;
    const point = escapePoint(state, Date.now());
    if (state.hp! > point.hp) return;
    escape(client, state, 'confirmed-health', point.guarded
      ? `${reason}; burst guard: ${point.burst} HP lost within ${BURST_WINDOW_MS}ms in the last ${BURST_MEMORY_MS / 1000}s, escaping at <=${Math.round(point.hp)} HP`
      : reason);
  }
  /** Layer 2: confirmed HP minus the hits charged since. */
  function checkLedger(client: ClientConnection, state: NexusState): void {
    if (!armed(state) || predictionMode === 'off' || state.charges.length === 0) return;
    const predicted = predictedHp(state)!;
    observePrediction(client, state, 'hit-ledger', predicted);
    if (predicted > escapePoint(state, Date.now()).hp) return;
    escape(client, state, 'hit-ledger',
      `${state.charges.length} outgoing PLAYERHIT(s) charged at packet damage since the last server HP`,
      state.charges.map(({ key: _key, ...note }) => note));
  }
  /** Layer 3: already-fired bullets with packet damage the native scan says hit within the horizon. */
  function checkForecast(client: ClientConnection, state: NexusState): void {
    if (!forecastEnabled || predictionMode === 'off' || !armed(state)) return;
    let effects = effectsOf(client, state);
    if (isInvulnerable(effects)) return;
    const threats = getDllThreats();
    if (threats.length === 0) return;
    const ageMs = getDllThreatsAgeMs();
    const now = Date.now();
    const seen = new Set<string>();
    const incoming: { shot: ShotRecord; inMs: number }[] = [];
    for (const threat of threats) {
      const attacker = Number(threat?.attackerObjId), bulletId = Number(threat?.bulletId);
      if (!Number.isInteger(attacker) || !Number.isInteger(bulletId)) continue;
      if (isSyntheticThreat(bulletId, threat.fallbackDamage)) continue;
      const inMs = remainingHitMs(threat.tHitMs, ageMs);
      if (inMs === null || inMs > horizonMs) continue;
      const key = bulletKey(attacker, bulletId);
      if (seen.has(key)) continue;
      seen.add(key);
      const shot = state.shots.get(key);
      // Only bullets the server announced with a damage count; already-charged ones never twice.
      if (!shot || shot.ambiguous || shot.charged || shot.expiresAt < now || !isPacketDamage(shot.rawDamage)) continue;
      incoming.push({ shot, inMs });
    }
    if (incoming.length === 0) return;
    incoming.sort((a, b) => a.inMs - b.inMs);
    const point = escapePoint(state, now);
    const defense = defenseOf(client);
    let hp = predictedHp(state)!;
    const counted: BulletNote[] = [];
    for (const { shot, inMs } of incoming) {
      const applied = appliedDamage(shot.rawDamage, shot.armorPiercing, defense, effects);
      effects = withOnHitEffects(effects, shot.onHitEffects);
      if (applied <= 0) continue;
      hp -= applied;
      counted.push({ ownerType: shot.ownerType, raw: shot.rawDamage, applied, armorPiercing: shot.armorPiercing, inMs });
      observePrediction(client, state, 'forecast', hp);
      if (hp <= point.hp) {
        escape(client, state, 'forecast',
          `${counted.length} fired bullet(s) predicted to hit within ${horizonMs}ms`
          + ` (native scan age ${ageMs ?? 'unknown'}ms)`, counted, hp);
        if (activePredictionAllowed()) return;
      }
    }
  }

  function observePrediction(client: ClientConnection, state: NexusState, layer: 'hit-ledger' | 'forecast', hp: number): void {
    const point = escapePoint(state, Date.now());
    observations.set(client, {
      sampleAt: performance.now(), generation: client.admission?.generation ?? 0,
      mode: activePredictionAllowed() ? 'active' : predictionMode, layer,
      confirmedHp: state.hp, healthAgeMs: state.healthAt === null ? null : Date.now() - state.healthAt,
      predictedHp: hp, effectiveThreshold: point.hp, thresholdCrossed: hp <= point.hp, lethal: hp <= 0,
      nativeScanAgeMs: layer === 'forecast' ? getDllThreatsAgeMs() : null, sourceCertainty: 'ambiguous',
      pendingDamage: state.evidence.snapshot(Date.now()).pendingDamage,
      certainty: state.evidence.snapshot(Date.now()).certainty,
    });
  }

  // ── Shots (ENEMYSHOOT / enemy-owned SERVERPLAYERSHOOT) ────────────────────
  function pruneShots(state: NexusState, now: number, force = false): void {
    if (!force && now - state.lastShotPruneAt < SHOT_PRUNE_INTERVAL_MS) return;
    state.lastShotPruneAt = now;
    for (const [key, shot] of state.shots) if (shot.expiresAt < now) state.shots.delete(key);
  }
  function recordShots(
    state: NexusState, ownerId: number, ownerType: number | null, firstBulletId: number,
    count: number, rawDamage: number, bulletType: number, projectileOwners: (number | null | undefined)[],
  ): void {
    let def: ReturnType<GameDataLoader['getProjectile']>;
    for (const type of projectileOwners) {
      if (typeof type !== 'number') continue;
      def = ctx.gameData?.getProjectile(type, bulletType);
      if (def) break;
    }
    const now = Date.now();
    const expiresAt = now + shotTtlMs(def?.lifetimeMs);
    const onHitEffects = (def?.conditionEffects ?? []).map(ce => ce.effect);
    for (let i = 0; i < count; i++) {
      const key = bulletKey(ownerId, firstBulletId + i);
      const previous = state.shots.get(key);
      const ambiguous = Boolean(previous && previous.expiresAt >= now);
      if (ambiguous) state.evidence.noteAmbiguity();
      const ownerIncarnation = state.ownerIncarnations.get(ownerId) ?? 0;
      const receiptSequence = ++state.shotSequence;
      state.shots.set(key, {
        identity: `${state.generation}:${ownerId}:${ownerIncarnation}:${(firstBulletId + i) & 0xffff}:${receiptSequence}`,
        ownerIncarnation, receiptSequence, receivedAt: now, ambiguous,
        ownerId, ownerType, bulletType, rawDamage,
        armorPiercing: def ? def.armorPiercing === true : null,
        onHitEffects, expiresAt, charged: false,
      });
    }
    if (state.shots.size > MAX_SHOTS) {
      pruneShots(state, now, true);
      for (const key of state.shots.keys()) {
        if (state.shots.size <= MAX_SHOTS) break;
        state.shots.delete(key);
      }
    }
  }
  ctx.hookPacket('ENEMYSHOOT', (client, packet) => {
    if (!packet.isDefined) return;
    const ownerId = Number(packet.data.ownerId), bulletId = Number(packet.data.bulletId);
    const damage = packet.data.damage;
    if (!Number.isInteger(ownerId) || !Number.isInteger(bulletId) || !isPacketDamage(damage)) return;
    const state = stateFor(client);
    const ownerType = ctx.getWorldState(client)?.getEntityType(ownerId) ?? null;
    const bulletType = Number(packet.data.bulletType) | 0;
    recordShots(state, ownerId, ownerType, bulletId, shotCount(packet.data.numShots), damage, bulletType, [ownerType]);
  });
  ctx.hookPacket('SERVERPLAYERSHOOT', (client, packet) => {
    if (!packet.isDefined) return;
    const ownerId = Number(packet.data.ownerId), bulletId = Number(packet.data.bulletId);
    const damage = packet.data.damage;
    if (!Number.isInteger(ownerId) || !Number.isInteger(bulletId) || ownerId === client.objectId || !isPacketDamage(damage)) return;
    const ownerType = ctx.getWorldState(client)?.getEntityType(ownerId);
    // Player shots never hit the local player; only an enemy owner makes this a threat.
    if (ownerType === undefined || ctx.gameData?.getObject(ownerType)?.isEnemy !== true) return;
    const rawType = Number(packet.data.bulletType);
    const bulletType = Number.isInteger(rawType) && rawType !== 255 ? rawType : 0;
    const container = Number(packet.data.containerType);
    recordShots(stateFor(client), ownerId, ownerType, bulletId, shotCount(packet.data.numShots), damage, bulletType,
      [ownerType, Number.isInteger(container) && container > 0 ? container : null]);
  });

  // Observe only. The packet is forwarded exactly as the game client sent it.
  ctx.hookPacket('PLAYERHIT', (client, packet) => {
    if (!packet.isDefined) return;
    const objectId = Number(packet.data.objectId), bulletId = Number(packet.data.bulletId);
    if (!Number.isInteger(objectId) || !Number.isInteger(bulletId)) return;
    const state = stateFor(client);
    activeClient = client;
    const shot = state.shots.get(bulletKey(objectId, bulletId));
    if (!shot || shot.ambiguous || shot.charged || shot.expiresAt < Date.now()) return;
    shot.charged = true;
    const applied = appliedDamage(shot.rawDamage, shot.armorPiercing, defenseOf(client), effectsOf(client, state));
    state.ledgerEffects = withOnHitEffects(state.ledgerEffects, shot.onHitEffects);
    if (applied <= 0) return;
    state.evidence.observeHit(shot.identity, applied, shot.expiresAt, Date.now());
    state.charges.push({ key: bulletKey(objectId, bulletId), ownerType: shot.ownerType, raw: shot.rawDamage,
      applied, armorPiercing: shot.armorPiercing });
    if (state.charges.length > MAX_SHOTS) { state.charges.shift(); state.evidence.noteAmbiguity(); }
    checkLedger(client, state);
  });

  // ── Server health ────────────────────────────────────────────────────────
  function syncMaxHp(client: ClientConnection, state: NexusState): void {
    const max = client.playerData.effectiveMaxHealth;
    if (Number.isFinite(max) && max > 0) state.maxHp = max;
  }
  function statusHealth(client: ClientConnection, packet: Packet, statuses: any[]): void {
    if (!packet.isDefined) return;
    const state = stateFor(client);
    activeClient = client;
    syncMaxHp(client, state);
    pruneShots(state, Date.now());
    const own = statuses.find(status => status?.objectId === client.objectId);
    const hpStat = own?.data?.find((stat: any) => stat.id === StatType.HP);
    if (hpStat && typeof hpStat.value === 'number' && Number.isFinite(hpStat.value)) {
      state.hp = Math.max(0, hpStat.value);
      state.healthAt = Date.now();
      state.evidence.observeHp(state.hp, state.healthAt);
      state.ledgerEffects = [0, 0];
      noteConfirmedHp(state, state.healthAt);
    } else if (state.hp === null && Number.isFinite(client.playerData.health) && client.playerData.health > 0) {
      // Hot reload can begin between full HP updates. Seed once from the last
      // server HP; delta ticks without HP must not undo confirmed DAMAGE.
      state.hp = client.playerData.health;
      state.evidence.observeHp(state.hp, Date.now());
    }
    check(client, state, 'server health update');
    checkLedger(client, state);
  }
  // These hooks run after StateManager so effective max HP includes gear/exalts.
  // Read HP from the packet itself; do not replace a confirmed zero with max HP.
  ctx.hookPacket('NEWTICK', (client, packet) => {
    statusHealth(client, packet, packet.data.statuses ?? []);
  });
  ctx.hookPacket('UPDATE', (client, packet) => {
    if (packet.isDefined) {
      const state = stateFor(client);
      for (const ownerId of packet.data.drops ?? []) {
        if (!Number.isInteger(ownerId)) continue;
        state.ownerIncarnations.set(ownerId, (state.ownerIncarnations.get(ownerId) ?? 0) + 1);
        for (const [key, shot] of state.shots) if (shot.ownerId === ownerId) {
          state.shots.delete(key);
          state.evidence.noteAmbiguity();
        }
      }
      if (state.ownerIncarnations.size > MAX_SHOTS) {
        state.ownerIncarnations.clear(); state.shots.clear(); state.evidence.noteAmbiguity();
      }
    }
    statusHealth(client, packet, (packet.data.newObjs ?? []).map((o: any) => o.status));
  });
  ctx.hookPacket('DAMAGE', (client, packet) => {
    if (!packet.isDefined || packet.data.targetId !== client.objectId) return;
    const state = stateFor(client); syncMaxHp(client, state);
    if (state.hp === null && Number.isFinite(client.playerData.health) && client.playerData.health > 0) {
      state.hp = client.playerData.health;
      state.evidence.observeHp(state.hp, Date.now());
    }
    if (packet.data.kill === true) {
      state.hp = 0;
      clearLedger(state);
    } else {
      const damage = packet.data.damageAmount;
      if (typeof damage !== 'number' || !Number.isFinite(damage) || damage <= 0 || state.hp === null) return;
      state.hp = Math.max(0, state.hp - damage);
      // The server confirmed this bullet: drop its charge so it is not subtracted twice.
      const objectId = Number(packet.data.objectId), bulletId = Number(packet.data.bulletId);
      const knownShot = Number.isInteger(objectId) && Number.isInteger(bulletId)
        ? state.shots.get(bulletKey(objectId, bulletId)) : undefined;
      state.evidence.observeDamage(knownShot && !knownShot.ambiguous && knownShot.expiresAt >= Date.now()
        ? knownShot.identity : null, damage, Date.now());
      if (Number.isInteger(objectId) && Number.isInteger(bulletId)) {
        const key = bulletKey(objectId, bulletId);
        state.charges = state.charges.filter(c => c.key !== key);
        const shot = state.shots.get(key);
        if (shot) shot.charged = true;
      }
    }
    state.healthAt = Date.now();
    noteConfirmedHp(state, state.healthAt);
    check(client, state, 'server-confirmed damage');
    checkLedger(client, state);
  });
  ctx.hookPacket('DEATH', (client, packet) => {
    if (!packet.isDefined) return;
    const state = stateFor(client);
    const now = Date.now();
    const age = state.healthAt === null ? 'unknown' : `${now - state.healthAt}ms`;
    const killer = String(packet.data.killedBy ?? 'unknown').replace(/[\r\n]/g, ' ').slice(0,120);
    const point = state.maxHp > 0 ? escapePoint(state, now) : { hp: 0, burst: 0, guarded: false };
    const scanAge = getDllThreatsAgeMs();
    const ledgerHp = predictedHp(state);
    ctx.log(`DEATH diagnostic — killer=${killer}; confirmed HP=${state.hp ?? 'unknown'}/${state.maxHp}`
      + `; health evidence age=${age}; threshold=${thresholdPct}%`
      + `; burstGuard=${burstGuard ? `on (escape point ${Math.round(point.hp)} HP, largest recent burst ${point.burst})` : 'off'}`
      + `; ledger HP=${ledgerHp === null ? 'unknown' : Math.round(ledgerHp)} (${state.charges.length} charged hit(s), ${state.shots.size} shot(s) known)`
      + `; forecast=${forecastEnabled ? `on (horizon ${horizonMs}ms, native scan age ${scanAge === null ? 'never' : `${scanAge}ms`})` : 'off'}`
      + `; enabled=${ctx.enabled}`
      + `; safe=${state.safe}; escapeRequested=${state.escaped}; mode=${predictionMode}`);
    stopRetry(state); // death is final; repeated ESCAPE cannot recover the character
  });
  // Never suppress server packets or hold outgoing hit reports. A DEATH packet
  // is still delivered normally; no prediction can turn it into a saved life.

  ctx.hookCommand('an', (client, _cmd, args) => {
    if (args.length) {
      const value = Number(args[0]);
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        ctx.sendNotification(client, 'AutoNexus', 'Usage: /an [0-100]'); return;
      }
      thresholdPct = value;
      ctx.updateSetting('ForceAutoNexusHealth', value);
    }
    ctx.sendNotification(client, 'AutoNexus', `Nexus at ${thresholdPct}% HP; burst guard ${burstGuard ? 'on' : 'off'}`
      + `; prediction ${predictionMode}; forecast ${forecastEnabled ? `on (${horizonMs}ms)` : 'off'}`);
  });
  ctx.hookCommand('reset', (client) => {
    const state = stateFor(client);
    const before = predictedHp(state);
    const charged = state.charges.length;
    clearLedger(state);
    ctx.sendNotification(client, 'AutoNexus', `Hit ledger cleared (${charged} charge(s), predicted HP was `
      + `${before === null ? 'unknown' : Math.round(before)}); confirmed HP ${state.hp ?? 'unknown'}/${state.maxHp}`);
  });
  ctx.hookCommand('nexus', (client) => escape(client, stateFor(client), 'manual', '/nexus command'));
  ctx.log(`Loaded — confirmed health active; prediction observation only (${DEFAULT_FORECAST_HORIZON_MS}ms);`
    + ` default nexus at ${thresholdPct}% HP until the saved profile applies; burst guard default on`);
  return { observation: (client: ClientConnection) => observations.get(client) ?? null };
}
