import type { PluginContext, ClientConnection, Packet, DllThreat, GameDataLoader } from './api.js';
import { sendDllFeature, StatType, getDllThreats, getDllThreatsAgeMs, getDllGround } from './api.js';
import { remainingHitMs } from './auto-nexus/forecastTiming.js';
import { HealthEvidence } from './auto-nexus/healthEvidence.js';
import { DiagGate } from '../src/util/DiagGate.js';
import { RateLimiter } from '../src/util/DiagRateLimit.js';
import { Logger } from '../src/util/Logger.js';
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

// Three layers protect the player. Owner decision 2026-09-22: prediction is
// ACTIVE by default again — the pre-2026-09-06 coverage, on v2's accounting.
//  1. Confirmed health — server HP (NEWTICK/UPDATE) and server DAMAGE amounts.
//  2. Hit ledger — each outgoing PLAYERHIT charges the damage the server stated
//     for that bullet in ENEMYSHOOT, after defense, until the next server HP;
//     a bullet the server never announced charges the assumed damage.
//  3. Forecast — everything predicted to land within a short horizon: bullets
//     (the server's packet damage when announced, else the DLL's fallback,
//     else the assumed-damage setting, piercing), AoE zones the server
//     announced with their own damage while the player stands inside, and the
//     native tile predictor's ground damage. The method_29 regen model lifts
//     predicted HP between server HP updates and resets when the server speaks.
// Global evidence ambiguity no longer vetoes an escape whose own bullets are
// clean; per-shot ambiguity still skips that shot. Outgoing PLAYERHITs are
// observed only: never held, dropped or modified.
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
/**
 * Damage charged for a threat with no packet damage and no usable DLL
 * fallback, treated as armor-piercing. 175 is the MultiTool Class89 value the
 * pre-2026-09-06 plugin assumed for unknown shots.
 */
const DEFAULT_ASSUMED_DAMAGE = 175;

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

/** One server-announced AoE zone (AOE packet), tracked while it lasts. */
interface TrackedAoe {
  ownerType: number | null;
  pos: { x: number; y: number };
  radius: number;
  rawDamage: number;
  armorPiercing: boolean;
  expiresAt: number;
}

interface EscapePoint { hp: number; burst: number; guarded: boolean }

type EscapeLayer = 'confirmed-health' | 'hit-ledger' | 'forecast' | 'manual';

export type PredictionMode = 'off' | 'observe' | 'active';
export interface RecoveryObservation {
  kind: 'escape-requested' | 'reconnect' | 'mapinfo';
  generation: number;
  at: number;
}
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
  escapeRequestedAt: number | null;
  reconnectAt: number | null;
  mapInfoAt: number | null;
  earliestImpactMs: number | null;
}

interface NexusState {
  generation: number;
  evidence: HealthEvidence;
  ownerIncarnations: Map<number, number>;
  shotSequence: number;
  startedAt: number;
  escapeRequestedAt: number | null;
  reconnectAt: number | null;
  mapInfoAt: number | null;
  hp: number | null;
  maxHp: number;
  healthAt: number | null;
  safe: boolean;
  /** Confirmed HP values from the last BURST_WINDOW_MS, oldest first. */
  samples: { at: number; hp: number; maxHp: number }[];
  /** Confirmed HP losses within one BURST_WINDOW_MS, from the last BURST_MEMORY_MS. */
  bursts: { at: number; loss: number }[];
  /** Bullets the server announced to this connection, by `owner:bulletId`. */
  shots: Map<string, ShotRecord>;
  lastShotPruneAt: number;
  /** Server-announced AoE zones still live (AOE packet). */
  aoes: TrackedAoe[];
  /** method_29 regen accumulator (fractional HP) and whole-point credit since the last explicit HP. */
  regenAccum: number;
  regenCredit: number;
  lastRegenAt: number;
  /** Hits charged since the last explicit server HP. */
  charges: Charge[];
  /** Condition bits charged bullets applied since the last server HP. */
  ledgerEffects: [number, number];
  /** item 4b (measurement only): performance.now() at the last noteConfirmedHp,
   *  i.e. the "decision" instant checkForm() reasons from. Undefined until the
   *  first HP event with diagnostics on. */
  hpEventAtMs?: number;
}

// item 4b, part D (measurement only): decision->socket-write latency, logged
// only when it exceeds 50ms (per the plan; no periodic aggregate for this
// one — see .superpowers/sdd/2026-09-18-process-stalls/investigation.md
// section 8). Rate-limited alongside the rest of this task's [Diag/*] lines.
const NEXUS_SLOW_MS = 50;
const nexusSlowLineLimiter = new RateLimiter(5, 5000);

export function register(ctx: PluginContext) {
  ctx.name = 'Auto Nexus';
  ctx.category = 'combat';
  let thresholdPct = 25;
  let showNotification = true;
  let retryCount = 4;
  let retryMs = 400;
  let burstGuard = true;
  let forecastEnabled = true;
  let predictionMode: PredictionMode = 'active';
  let unknownDamage = true;
  let assumedDamage = DEFAULT_ASSUMED_DAMAGE;
  let groundEnabled = true;
  let aoeEnabled = true;
  const observations = new WeakMap<ClientConnection, PredictionObservation>();
  const transitions = new WeakMap<ClientConnection, RecoveryObservation[]>();
  let horizonMs = DEFAULT_FORECAST_HORIZON_MS;
  let states = new WeakMap<ClientConnection, NexusState>();
  let activeClient: ClientConnection | null = null;
  const clients = new Set<ClientConnection>();

  function recordTransition(client: ClientConnection, kind: RecoveryObservation['kind'], generation = client.admission.generation): number {
    const at = performance.now();
    const history = transitions.get(client) ?? [];
    history.push({ kind, generation, at });
    if (history.length > 32) history.shift();
    transitions.set(client, history);
    return at;
  }

  function activePredictionAllowed(): boolean {
    return predictionMode === 'active';
  }

  ctx.registerSetting('PredictiveNexusMode', {
    label: 'Prediction', type: 'select', value: 'active',
    options: [{ label: 'Off', value: 'off' }, { label: 'Observe', value: 'observe' }, { label: 'Active', value: 'active' }],
  }, (value: string) => {
    // Only an explicit 'active' activates; invalid values never can.
    predictionMode = value === 'off' ? 'off' : value === 'active' ? 'active' : 'observe';
    if (value !== predictionMode) ctx.updateSetting('PredictiveNexusMode', predictionMode);
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
  // The observe-only era's `PredictionMode` joins them (2026-09-22): its saved
  // 'observe' was never a choice — it was the only non-off option — so
  // `PredictiveNexusMode` (default 'active') replaces it and stale values are
  // ignored by config replay.
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
  ctx.registerSetting('PredictiveNexusUnknownDamage', {
    label: 'Count unknown-damage bullets', type: 'boolean', value: true,
    visibleWhen: { key: 'PredictiveNexusForecast', value: true },
  }, (v: boolean) => {
    const next = v === true;
    if (next !== unknownDamage) ctx.log(`Unknown-damage bullet counting ${next ? 'on' : 'off'}`);
    unknownDamage = next;
  });
  ctx.registerSetting('PredictiveNexusAssumedDamage', {
    label: 'Assumed damage (no packet, no fallback)', advanced: true, type: 'range', value: DEFAULT_ASSUMED_DAMAGE,
    min: 25, max: 500, step: 25, visibleWhen: { key: 'PredictiveNexusUnknownDamage', value: true },
  }, (v: number) => {
    const n = Math.trunc(Number(v));
    assumedDamage = Number.isFinite(n) ? Math.max(25, Math.min(500, n)) : DEFAULT_ASSUMED_DAMAGE;
  });
  ctx.registerSetting('PredictiveNexusGround', {
    label: 'Count ground damage (native tile predictor)', type: 'boolean', value: true,
    visibleWhen: { key: 'PredictiveNexusForecast', value: true },
  }, (v: boolean) => {
    const next = v === true;
    if (next !== groundEnabled) ctx.log(`Ground-damage counting ${next ? 'on' : 'off'}`);
    groundEnabled = next;
    syncNativeForecast();
  });
  ctx.registerSetting('PredictiveNexusAoe', {
    label: 'Count server-announced AoE zones', type: 'boolean', value: true,
    visibleWhen: { key: 'PredictiveNexusForecast', value: true },
  }, (v: boolean) => {
    const next = v === true;
    if (next !== aoeEnabled) ctx.log(`AoE-zone counting ${next ? 'on' : 'off'}`);
    aoeEnabled = next;
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

  // Native Auto Nexus only publishes projectile + ground forecasts; it never
  // sends ESCAPE and its damage numbers are ignored here. The ground predictor
  // runs only while ground counting is on; the overlay stays off. Re-sent on
  // connect and map change so restored native state cannot linger.
  function syncNativeForecast(): void {
    const on = ctx.enabled && forecastEnabled && predictionMode !== 'off';
    sendDllFeature('autoNexusTilePredict', on && groundEnabled);
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
    for (const client of clients) client.recovery.cancelEscape(states.get(client)!.generation);
    clients.clear();
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
    for (const client of clients) client.recovery.cancelEscape(states.get(client)!.generation);
    clients.clear();
    activeClient = null;
    sendDllFeature('autoNexusEnabled', false);
    sendDllFeature('autoNexusProjPredict', false);
    sendDllFeature('autoNexusTilePredict', false);
    sendDllFeature('autoNexusDebugDraw', false);
  });

  function stateFor(client: ClientConnection): NexusState {
    let state = states.get(client);
    if (state && state.generation !== client.admission.generation) {
      client.recovery.cancelEscape(state.generation);
      observations.delete(client);
      state = undefined;
    }
    if (!state) {
      const evidence = new HealthEvidence();
      const generation = client.admission?.generation ?? 0;
      evidence.reset(generation);
      state = { generation, evidence, ownerIncarnations: new Map(), shotSequence: 0, startedAt: Date.now(),
        escapeRequestedAt: null, reconnectAt: null, mapInfoAt: null,
        hp: null, maxHp: 0, healthAt: null, safe: SAFE_ZONE_MAPS.has(
        String(client.playerData?.mapName ?? '').trim().toLowerCase()),
        samples: [], bursts: [], shots: new Map(), lastShotPruneAt: 0, charges: [], ledgerEffects: [0, 0],
        aoes: [], regenAccum: 0, regenCredit: 0, lastRegenAt: Date.now() };
      states.set(client, state);
      clients.add(client);
    }
    return state;
  }
  function clearLedger(state: NexusState): void {
    state.charges = [];
    state.ledgerEffects = [0, 0];
    state.evidence.reset(state.generation);
    if (state.hp !== null) state.evidence.observeHp(state.hp, Date.now());
  }
  function reset(client: ClientConnection, safe: boolean): void {
    const state = stateFor(client); client.recovery.cancelEscape(state.generation);
    state.generation = client.admission?.generation ?? 0;
    state.hp = null; state.maxHp = 0; state.healthAt = null; state.safe = safe;
    state.startedAt = Date.now(); state.escapeRequestedAt = null; state.reconnectAt = null; state.mapInfoAt = null;
    state.samples = []; state.bursts = [];
    state.shots.clear(); clearLedger(state);
    state.ownerIncarnations.clear(); state.shotSequence = 0;
    state.aoes = []; state.regenAccum = 0; state.regenCredit = 0; state.lastRegenAt = Date.now();
    observations.delete(client);
  }
  ctx.on('clientDisconnected', client => {
    const state = states.get(client);
    if (state) client.recovery.cancelEscape(state.generation);
    states.delete(client); clients.delete(client); observations.delete(client);
    if (activeClient === client) activeClient = null;
  });
  ctx.hookPacket('MAPINFO', (client, packet) => {
    if (!packet.isDefined) return;
    reset(client, SAFE_ZONE_MAPS.has(String(packet.data.name ?? '').trim().toLowerCase()));
    stateFor(client).mapInfoAt = recordTransition(client, 'mapinfo');
    syncNativeForecast();
  });
  ctx.hookPacket('CREATESUCCESS', client => { reset(client, stateFor(client).safe); });
  ctx.hookPacket('RECONNECT', client => { stateFor(client).reconnectAt = recordTransition(client, 'reconnect'); });

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
    const snapshot = state.evidence.snapshot(Date.now());
    if (snapshot.predictedHp === null) return null;
    // method_29 regen is a prediction like any other: credit accrued since the
    // last explicit server HP lifts the comparison, capped at max HP. It resets
    // whenever the server speaks (see statusHealth), so it never double-counts.
    return state.maxHp > 0 ? Math.min(snapshot.predictedHp + state.regenCredit, state.maxHp)
      : snapshot.predictedHp + state.regenCredit;
  }
  /**
   * method_29 (MultiTool Class89): base regen 2*(1+0.12*VIT) HP/s, +20/s while
   * Healing, nothing while Sick, −20/s while Bleeding, halved in combat. Whole
   * points move from the fractional accumulator into the credit.
   */
  function tickRegen(client: ClientConnection, state: NexusState, now: number): void {
    const dtSec = (now - state.lastRegenAt) / 1000;
    state.lastRegenAt = now;
    if (dtSec <= 0 || state.maxHp <= 0) return;
    const pd = client.playerData as typeof client.playerData & { hasConditionEffect?: (n: string) => boolean; powerLevel?: number };
    const has = (name: string) => pd?.hasConditionEffect?.(name) === true;
    const vit = Number(pd?.effectiveVitality);
    const base = 2 * (1 + 0.12 * (Number.isFinite(vit) && vit > 0 ? vit : 0));
    if (!has('Sick')) state.regenAccum += (has('Healing') ? 20 + base : base) * dtSec;
    if (has('Bleeding')) state.regenAccum -= 20 * dtSec;
    if (has('InCombat') || Number(pd?.powerLevel) >= 100) state.regenAccum /= 2;
    const whole = Math.trunc(state.regenAccum);
    state.regenAccum -= whole;
    state.regenCredit = Math.max(0, state.regenCredit + whole);
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
  ): boolean {
    if ((layer === 'hit-ledger' || layer === 'forecast') && !activePredictionAllowed()) return false;
    if (!client.connected || !ctx.enabled || state.generation !== client.admission.generation ||
        ['dead', 'disconnected', 'cancelled', 'terminal'].includes(client.admission.phase)) return false;
    if (!client.recovery.requestEscape(state.generation, { retries: retryCount, retryMs })) return false;
    // item 4b (measurement only): requestEscape() synchronously calls
    // sendEscape() before returning (RecoveryCoordinator.ts), so this point is
    // "escape packet send call returns" per the investigation's design.
    if (DiagGate.on() && state.hpEventAtMs !== undefined) {
      const elapsedMs = performance.now() - state.hpEventAtMs;
      if (elapsedMs > NEXUS_SLOW_MS && nexusSlowLineLimiter.allow()) {
        Logger.log('Diag/Nexus', `decision->write=${elapsedMs.toFixed(1)}ms (>${NEXUS_SLOW_MS}ms) layer=${layer}`);
      }
    }
    state.escapeRequestedAt = recordTransition(client, 'escape-requested', state.generation);
    const now = Date.now();
    const point = state.maxHp > 0 ? escapePoint(state, now) : null;
    const predicted = forecastHp ?? predictedHp(state);
    const round = (n: number | null) => (n === null ? 'unknown' : String(Math.round(n)));
    const detail = `layer=${layer}; predicted HP=${round(predicted)}/${state.maxHp}`
      + `; escape point=${point ? `${Math.round(point.hp)} HP (${point.guarded
        ? `burst guard, largest burst ${point.burst}` : `threshold ${thresholdPct}%`})` : 'unknown'}`
      + `; confirmed HP=${state.hp ?? 'unknown'}/${state.maxHp}`
      + ` age=${state.healthAt === null ? 'unknown' : `${now - state.healthAt}ms`}`
      // Global ambiguity no longer vetoes the escape (owner decision 2026-09-22);
      // it is named here so a decision made on ambiguous evidence stays legible.
      + (state.evidence.snapshot(now).certainty === 'ambiguous' ? '; evidence=ambiguous' : '')
      + `; bullets=${describeBullets(bullets)}`;
    try { ctx.log(`AUTO NEXUS — ${detail}; ${reason}`); } catch {}
    // Notification failures must never prevent the first ESCAPE or its retries.
    if (showNotification) {
      try {
        ctx.sendNotification(client, 'AutoNexus',
          `Escape requested (${layer}) at predicted HP ${round(predicted)}/${state.maxHp}; confirmed ${state.hp ?? 'unknown'}\n${reason}`);
      } catch (error) { try { ctx.log(`Auto Nexus notification failed: ${String(error)}`); } catch {} }
    }
    return true;
  }
  /** Record a newly confirmed HP value and any loss it completes within one reaction window. */
  function noteConfirmedHp(state: NexusState, now: number): void {
    // item 4b (measurement only): mark the decision instant. Set unconditionally
    // (not gated on armed()/escape happening) so it always reflects the most
    // recent HP event a decision could react to, per the investigation's design.
    if (DiagGate.on()) state.hpEventAtMs = performance.now();
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
    return ctx.enabled && !state.safe && state.hp !== null && state.maxHp > 0;
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
    if (!armed(state) || predictionMode === 'off' || (state.charges.length === 0 && !observations.has(client))) return;
    const predicted = predictedHp(state)!;
    observePrediction(client, state, 'hit-ledger', predicted);
    if (predicted > escapePoint(state, Date.now()).hp) return;
    escape(client, state, 'hit-ledger',
      `${state.charges.length} outgoing PLAYERHIT(s) charged at packet damage since the last server HP`,
      state.charges.map(({ key: _key, ...note }) => note));
  }
  /** Layer 3: ground + AoE zones + already-fired bullets predicted to hit within the horizon. */
  function checkForecast(client: ClientConnection, state: NexusState): void {
    if (!forecastEnabled || predictionMode === 'off' || !armed(state)) return;
    let effects = effectsOf(client, state);
    if (isInvulnerable(effects)) return;
    const now = Date.now();
    tickRegen(client, state, now);
    const ageMs = getDllThreatsAgeMs();
    const point = escapePoint(state, now);
    const defense = defenseOf(client);
    let hp = predictedHp(state)!;

    // ── Ground (native tile predictor; the wire GROUNDDAMAGE carries no damage) ──
    if (groundEnabled) {
      const ground = getDllGround();
      if (ground) {
        const events = Array.isArray(ground.events) && ground.events.length > 0 ? ground.events : [ground];
        let soonest: { raw: number; inMs: number } | null = null;
        for (const event of events) {
          const raw = Number(event?.rawDamage);
          const inMs = remainingHitMs(Number(event?.tHitMs), ageMs);
          if (inMs === null || inMs > horizonMs || !isPacketDamage(raw)) continue;
          if (!soonest || inMs < soonest.inMs) soonest = { raw, inMs };
        }
        if (soonest) {
          // Ground damage counts in full: treating it as piercing only ever
          // charges more, and tile damage has no projectile defense rules here.
          const applied = appliedDamage(soonest.raw, true, defense, effects);
          if (applied > 0) {
            hp -= applied;
            const note: BulletNote[] = [{ ownerType: null, raw: soonest.raw, applied, armorPiercing: true, inMs: soonest.inMs }];
            observePrediction(client, state, 'forecast', hp, soonest.inMs);
            if (hp <= point.hp && escape(client, state, 'forecast',
              `ground damage ${Math.round(applied)} predicted in ${Math.round(soonest.inMs)}ms (native tile predictor)`, note, hp)) return;
          }
        }
      }
    }

    // ── AoE zones the server announced with their own damage (AOE packet) ──
    if (aoeEnabled && state.aoes.length > 0) {
      const pos = ctx.getWorldState(client)?.getEntity(client.objectId)?.pos;
      if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
        state.aoes = state.aoes.filter(aoe => aoe.expiresAt >= now);
        const hits: BulletNote[] = [];
        for (const aoe of state.aoes) {
          const dx = pos.x - aoe.pos.x, dy = pos.y - aoe.pos.y;
          if (dx * dx + dy * dy > aoe.radius * aoe.radius) continue;
          const applied = appliedDamage(aoe.rawDamage, aoe.armorPiercing, defense, effects);
          if (applied <= 0) continue;
          hp -= applied;
          hits.push({ ownerType: aoe.ownerType, raw: aoe.rawDamage, applied, armorPiercing: aoe.armorPiercing });
        }
        if (hits.length > 0) {
          observePrediction(client, state, 'forecast', hp, null);
          if (hp <= point.hp && escape(client, state, 'forecast',
            `${hits.length} AoE zone(s) the player stands in (server-announced damage)`, hits, hp)) return;
        }
      }
    }

    // ── Bullets ──
    const threats = getDllThreats();
    if (threats.length === 0) return;
    if (ageMs === null || now - ageMs < state.startedAt || state.generation !== client.admission.generation) return;
    const seen = new Set<string>();
    const incoming: { shot: ShotRecord | undefined; threat: DllThreat; inMs: number }[] = [];
    for (const threat of threats) {
      const attacker = Number(threat?.attackerObjId), bulletId = Number(threat?.bulletId);
      if (!Number.isInteger(attacker) || !Number.isInteger(bulletId)) continue;
      const inMs = remainingHitMs(threat.tHitMs, ageMs);
      if (inMs === null || inMs > horizonMs) continue;
      const key = bulletKey(attacker, bulletId);
      if (seen.has(key)) continue;
      seen.add(key);
      const shot = state.shots.get(key);
      if (shot) {
        // A packet record always wins and is never counted twice. An ambiguous
        // record skips the bullet entirely rather than double-guessing it.
        if (!isPacketDamage(shot.rawDamage) || shot.ambiguous || shot.charged || shot.expiresAt < now) continue;
      } else if (!unknownDamage) {
        // Owner decision 2026-09-22: bullets without a packet record count too —
        // the pre-2026-09-06 coverage, charged below from the DLL fallback or
        // the assumed damage.
        continue;
      }
      incoming.push({ shot, threat, inMs });
    }
    if (incoming.length === 0) return;
    incoming.sort((a, b) => a.inMs - b.inMs);
    const counted: BulletNote[] = [];
    let unknownCount = 0;
    for (const { shot, threat, inMs } of incoming) {
      let raw: number, armorPiercing: boolean | null, onHitEffects: readonly string[], ownerType: number | null;
      const isUnknown = shot === undefined;
      if (shot) {
        raw = shot.rawDamage; armorPiercing = shot.armorPiercing;
        onHitEffects = shot.onHitEffects; ownerType = shot.ownerType;
      } else {
        // No packet record: the DLL's own damage estimate when it is a real
        // number (the synthetic 9999 marker is not one), else the assumed
        // damage, treated as piercing — an unknown can only charge more.
        const fallback = threat.fallbackDamage;
        const usable = isPacketDamage(fallback) && !isSyntheticThreat(threat.bulletId, fallback);
        raw = usable ? fallback : assumedDamage;
        armorPiercing = usable ? threat.fallbackArmorPiercing : true;
        onHitEffects = []; ownerType = null;
      }
      const applied = appliedDamage(raw, armorPiercing, defense, effects);
      effects = withOnHitEffects(effects, onHitEffects);
      if (applied <= 0) continue;
      if (isUnknown) unknownCount++;
      hp -= applied;
      counted.push({ ownerType, raw, applied, armorPiercing, inMs });
      observePrediction(client, state, 'forecast', hp, counted[0].inMs ?? null);
      if (hp <= point.hp) {
        // Stop charging only when a request actually went out; while latched or
        // observing, keep counting so the observation shows the whole volley.
        if (escape(client, state, 'forecast',
          `${counted.length} fired bullet(s) predicted to hit within ${horizonMs}ms`
          + (unknownCount > 0 ? `; ${unknownCount} unknown-damage bullet(s) (DLL fallback or assumed ${assumedDamage})` : '')
          + ` (native scan age ${ageMs ?? 'unknown'}ms)`, counted, hp)) return;
      }
    }
  }

  function observePrediction(client: ClientConnection, state: NexusState, layer: 'hit-ledger' | 'forecast', hp: number,
    earliestImpactMs: number | null = null): void {
    const point = escapePoint(state, Date.now());
    observations.set(client, {
      sampleAt: performance.now(), generation: client.admission?.generation ?? 0,
      mode: activePredictionAllowed() ? 'active' : predictionMode, layer,
      confirmedHp: state.hp, healthAgeMs: state.healthAt === null ? null : Date.now() - state.healthAt,
      predictedHp: hp, effectiveThreshold: point.hp, thresholdCrossed: hp <= point.hp, lethal: hp <= 0,
      nativeScanAgeMs: layer === 'forecast' ? getDllThreatsAgeMs() : null, sourceCertainty: 'ambiguous',
      pendingDamage: state.evidence.snapshot(Date.now()).pendingDamage,
      certainty: state.evidence.snapshot(Date.now()).certainty,
      escapeRequestedAt: state.escapeRequestedAt, reconnectAt: state.reconnectAt, mapInfoAt: state.mapInfoAt,
      earliestImpactMs,
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

  // ── AoE zones (server-announced, with their own damage) ───────────────────
  ctx.hookPacket('AOE', (client, packet) => {
    if (!aoeEnabled || !packet.isDefined) return;
    const data = packet.data ?? {};
    if (!isPacketDamage(data.damage)) return;
    const radius = Number(data.radius), px = Number(data.position?.x), py = Number(data.position?.y);
    if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(px) || !Number.isFinite(py)) return;
    const state = stateFor(client); syncMaxHp(client, state);
    // Duration matches AoeCapturePolicy: <=120 means seconds; anything sane
    // else is ms; a missing/garbage value keeps the zone visible for 3 s.
    const rawDur = Number(data.effectDuration);
    const durationMs = Number.isFinite(rawDur) && rawDur > 0 && rawDur < 120000
      ? (rawDur <= 120 ? rawDur * 1000 : rawDur) : 3000;
    state.aoes.push({
      ownerType: Number.isInteger(data.originType) ? data.originType : null,
      pos: { x: px, y: py }, radius, rawDamage: data.damage,
      armorPiercing: data.armorPierce === true, expiresAt: Date.now() + durationMs,
    });
    if (state.aoes.length > 64) state.aoes.shift();
  });

  // Observe only. The packet is forwarded exactly as the game client sent it.
  ctx.hookPacket('PLAYERHIT', (client, packet) => {
    if (!packet.isDefined) return;
    const objectId = Number(packet.data.objectId), bulletId = Number(packet.data.bulletId);
    if (!Number.isInteger(objectId) || !Number.isInteger(bulletId)) return;
    const state = stateFor(client);
    activeClient = client;
    let shot = state.shots.get(bulletKey(objectId, bulletId));
    if (!shot) {
      // The game reports a hit from a bullet the server never announced on this
      // connection. #52 charged 175+AP for unknown shots; do the same, as a real
      // shot record so the forecast cannot double-count the bullet and a server
      // DAMAGE for it can reconcile the charge like any other.
      if (!unknownDamage || !isPacketDamage(assumedDamage)) return;
      const now = Date.now();
      const ownerIncarnation = state.ownerIncarnations.get(objectId) ?? 0;
      shot = {
        identity: `${state.generation}:${objectId}:${ownerIncarnation}:${bulletId & 0xffff}:${++state.shotSequence}`,
        ownerIncarnation, receiptSequence: state.shotSequence, receivedAt: now, ambiguous: false,
        ownerId: objectId, ownerType: null, bulletType: 0, rawDamage: assumedDamage, armorPiercing: true,
        onHitEffects: [], expiresAt: now + shotTtlMs(undefined), charged: false,
      };
      state.shots.set(bulletKey(objectId, bulletId), shot);
    }
    if (shot.ambiguous || shot.charged || shot.expiresAt < Date.now()) return;
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
    tickRegen(client, state, Date.now());
    pruneShots(state, Date.now());
    const own = statuses.find(status => status?.objectId === client.objectId);
    const hpStat = own?.data?.find((stat: any) => stat.id === StatType.HP);
    if (hpStat && typeof hpStat.value === 'number' && Number.isFinite(hpStat.value)) {
      state.hp = Math.max(0, hpStat.value);
      state.healthAt = Date.now();
      state.evidence.observeHp(state.hp, state.healthAt);
      state.ledgerEffects = [0, 0];
      state.regenAccum = 0;                     // the server spoke: regen credit restarts
      state.regenCredit = 0;
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
      + `; safe=${state.safe}; escapeRequested=${state.escapeRequestedAt !== null}; mode=${predictionMode}`);
    client.recovery.cancelEscape(state.generation);
    state.safe = true;
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
  ctx.log(`Loaded — prediction ACTIVE by default (owner decision 2026-09-22); forecast horizon ${DEFAULT_FORECAST_HORIZON_MS}ms,`
    + ` unknown-damage bullets count (DLL fallback or assumed ${DEFAULT_ASSUMED_DAMAGE}),`
    + ` ground + AoE zones count, method_29 regen lifts predicted HP between server updates;`
    + ` nexus at ${thresholdPct}% HP until the saved profile applies; burst guard default on`);
  return {
    observation: (client: ClientConnection) => {
      const observation = observations.get(client);
      const state = states.get(client);
      if (!observation || !state || observation.generation !== client.admission.generation) return null;
      return { ...observation, escapeRequestedAt: state.escapeRequestedAt,
        reconnectAt: state.reconnectAt, mapInfoAt: state.mapInfoAt };
    },
    transitions: (client: ClientConnection) => (transitions.get(client) ?? []).map(event => ({ ...event })),
  };
}
