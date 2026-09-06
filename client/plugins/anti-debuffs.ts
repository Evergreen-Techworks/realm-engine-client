import type { PluginContext } from './api.js';
import type { ClientConnection } from './api.js';
import { StatType } from './api.js';
import { ConditionEffect } from './api.js';

/**
 * Anti-Debuffs — faithful port of MultiTool's Class41.
 *
 * Two mechanisms, exactly as MultiTool does them:
 *
 * 1. PLAYERHIT (C→S, packet 90) — method_4:
 *    Looks up the projectile in ProjectileTracker (same key "${ownerId}:${bulletId}").
 *    Reads projDef.conditionEffects and checks each enabled debuff toggle.
 *    If any match: suppresses the packet (packet.send = false) — the server
 *    never sees the hit, so the debuff is never applied server-side — and
 *    queues every effect name on that projectile for the next NEWTICK clear.
 *
 * 2. NEWTICK (S→C, packet 10) — method_0 / method_5:
 *    Finds the player's Status entry (by objectId == client.objectId).
 *    Locates stat 29 (Effects) and stat 95 (Effects2) inside it.
 *    Builds two clear masks and ANDs them out:
 *      a) Debuff bits from blocked-projectile effects collected since last tick.
 *      b) Visual-only bits (Blind, Hallucinating, Drunk, Confused, Unstable,
 *         Darkness) — always cleared if the setting is on.
 *    If the player entry is absent from this tick's statuses (server only sends
 *    changed stats), nothing to do — the game client retains the previous
 *    (already-cleaned) values.
 *    Marks packet.modified = true so the proxy re-serializes it.
 *
 * Bit positions — Effects (stat 29):
 *   Quiet      0x0000_0002   Weak        0x0000_0004
 *   Slowed     0x0000_0008   Sick        0x0000_0010
 *   Dazed      0x0000_0020   Stunned     0x0000_0040
 *   Blind      0x0000_0080   Hallucinating 0x0000_0100
 *   Drunk      0x0000_0200   Confused    0x0000_0400
 *   Paralyzed  0x0000_2000   Bleeding    0x0000_8000
 *   PetStasis  0x0020_0000   ArmorBroken 0x0400_0000
 *   Unstable   0x2000_0000   Darkness    0x4000_0000
 *
 * Bit positions — Effects2 (stat 95):
 *   Petrified  0x0000_0008   Silence     0x0001_0000
 */

// ── Stat IDs ─────────────────────────────────────────────────────────────────

const STAT_EFFECTS  = StatType.Effects;   // 29
const STAT_EFFECTS2 = StatType.Effects2;  // 95

// ── Effects (stat 29) bitmasks — derived from canonical ConditionEffect indices ──
// Effects holds bits 0-30, so the mask is `1 << ConditionEffect.<name>`.

const BIT_QUIET        = 1 << ConditionEffect.Quiet;         // 0x00000002
const BIT_WEAK         = 1 << ConditionEffect.Weak;          // 0x00000004
const BIT_SLOWED       = 1 << ConditionEffect.Slowed;        // 0x00000008
const BIT_SICK         = 1 << ConditionEffect.Sick;          // 0x00000010
const BIT_DAZED        = 1 << ConditionEffect.Dazed;         // 0x00000020
const BIT_STUNNED      = 1 << ConditionEffect.Stunned;       // 0x00000040
const BIT_BLIND        = 1 << ConditionEffect.Blind;         // 0x00000080  visual-only
const BIT_HALLUC       = 1 << ConditionEffect.Hallucinating; // 0x00000100  visual-only
const BIT_DRUNK        = 1 << ConditionEffect.Drunk;         // 0x00000200  visual-only
const BIT_CONFUSED     = 1 << ConditionEffect.Confused;      // 0x00000400  visual-only
const BIT_PARALYZED    = 1 << ConditionEffect.Paralyzed;     // 0x00002000
const BIT_BLEEDING     = 1 << ConditionEffect.Bleeding;      // 0x00008000
const BIT_PET_STASIS   = 1 << ConditionEffect.Stasis;        // 0x00200000
const BIT_ARMOR_BROKEN = 1 << ConditionEffect.ArmorBroken;   // 0x04000000
const BIT_UNSTABLE     = 1 << ConditionEffect.Unstable;      // 0x20000000  visual-only
const BIT_DARKNESS     = 1 << ConditionEffect.Darkness;      // 0x40000000  visual-only

// ── Effects2 (stat 95) bitmasks ───────────────────────────────────────────────
// Effects2 holds bits 31+, so the in-stat bit index is `ConditionEffect.<name> - 31`.

const BIT2_PETRIFIED   = 1 << (ConditionEffect.Petrified - 31);  // index 34 → bit 3  (0x00000008)
const BIT2_SILENCE     = 1 << (ConditionEffect.Silenced - 31);   // index 47 → bit 16 (0x00010000)

// ── Per-client state ──────────────────────────────────────────────────────────

interface ADbState {
  // Effect names (XML keys) collected from blocked PLAYERHIT projectiles.
  // Consumed and cleared every NEWTICK.
  pending: Set<string>;
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export function register(ctx: PluginContext) {
  ctx.name     = 'Anti-Debuffs';
  ctx.category = 'combat';

  // ── Settings — per-debuff toggles (defaults match MultiTool) ─────────────

  // Combat debuffs (blocked via PLAYERHIT suppression)
  let ignoreQuiet      = false;
  let ignoreWeak       = false;
  let ignoreSlowed     = false;
  let ignoreSick       = false;
  let ignoreDazed      = false;
  let ignoreStunned    = false;
  let ignoreParalyzed  = false;
  let ignoreBleeding   = false;
  let ignoreArmorBreak = false;
  let ignorePetStasis  = false;
  let ignorePetrified  = false;
  let ignoreSilence    = false;
  let ignoreCurse      = false;
  let ignoreDrought    = false;

  // Visual-only (cleared in NEWTICK only — not toggled in MultiTool logic)
  let ignoreBlind        = true;
  let ignoreHallucinating = true;
  let ignoreDrunk        = true;
  let ignoreConfused     = true;
  let ignoreUnstable     = true;
  let ignoreDarkness     = true;

  // ── Dashboard ─────────────────────────────────────────────────────────────

  ctx.registerSetting('ignoreBlind', {
    label: 'Ignore Blind (client)', type: 'boolean', value: ignoreBlind,
  }, (v: boolean) => { ignoreBlind = v; });

  ctx.registerSetting('ignoreHallucinating', {
    label: 'Ignore Hallucinating (client)', type: 'boolean', value: ignoreHallucinating,
  }, (v: boolean) => { ignoreHallucinating = v; });

  ctx.registerSetting('ignoreDrunk', {
    label: 'Ignore Drunk (client)', type: 'boolean', value: ignoreDrunk,
  }, (v: boolean) => { ignoreDrunk = v; });

  ctx.registerSetting('ignoreConfused', {
    label: 'Ignore Confused (client)', type: 'boolean', value: ignoreConfused,
  }, (v: boolean) => { ignoreConfused = v; });

  ctx.registerSetting('ignoreDarkness', {
    label: 'Ignore Darkness (client)', type: 'boolean', value: ignoreDarkness,
  }, (v: boolean) => { ignoreDarkness = v; });

  ctx.registerSetting('ignoreUnstable', {
    label: 'Ignore Unstable (client)', type: 'boolean', value: ignoreUnstable,
  }, (v: boolean) => { ignoreUnstable = v; });

  ctx.registerSetting('ignoreQuiet', {
    label: 'Block Quiet projectiles', advanced: true, type: 'boolean', value: ignoreQuiet,
  }, (v: boolean) => { ignoreQuiet = v; });

  ctx.registerSetting('ignoreWeak', {
    label: 'Block Weak projectiles', advanced: true, type: 'boolean', value: ignoreWeak,
  }, (v: boolean) => { ignoreWeak = v; });

  ctx.registerSetting('ignoreSlowed', {
    label: 'Block Slowed projectiles', advanced: true, type: 'boolean', value: ignoreSlowed,
  }, (v: boolean) => { ignoreSlowed = v; });

  ctx.registerSetting('ignoreSick', {
    label: 'Block Sick projectiles', advanced: true, type: 'boolean', value: ignoreSick,
  }, (v: boolean) => { ignoreSick = v; });

  ctx.registerSetting('ignoreDazed', {
    label: 'Block Dazed projectiles', advanced: true, type: 'boolean', value: ignoreDazed,
  }, (v: boolean) => { ignoreDazed = v; });

  ctx.registerSetting('ignoreStunned', {
    label: 'Block Stunned projectiles', advanced: true, type: 'boolean', value: ignoreStunned,
  }, (v: boolean) => { ignoreStunned = v; });

  ctx.registerSetting('ignoreParalyzed', {
    label: 'Block Paralyzed projectiles', advanced: true, type: 'boolean', value: ignoreParalyzed,
  }, (v: boolean) => { ignoreParalyzed = v; });

  ctx.registerSetting('ignoreBleeding', {
    label: 'Block Bleeding projectiles', advanced: true, type: 'boolean', value: ignoreBleeding,
  }, (v: boolean) => { ignoreBleeding = v; });

  ctx.registerSetting('ignoreArmorBreak', {
    label: 'Block Armor Break projectiles', advanced: true, type: 'boolean', value: ignoreArmorBreak,
  }, (v: boolean) => { ignoreArmorBreak = v; });

  ctx.registerSetting('ignorePetStasis', {
    label: 'Block Pet Stasis projectiles', advanced: true, type: 'boolean', value: ignorePetStasis,
  }, (v: boolean) => { ignorePetStasis = v; });

  ctx.registerSetting('ignorePetrified', {
    label: 'Block Petrified projectiles', advanced: true, type: 'boolean', value: ignorePetrified,
  }, (v: boolean) => { ignorePetrified = v; });

  ctx.registerSetting('ignoreSilence', {
    label: 'Block Silence projectiles', advanced: true, type: 'boolean', value: ignoreSilence,
  }, (v: boolean) => { ignoreSilence = v; });

  ctx.registerSetting('ignoreCurse', {
    label: 'Block Curse projectiles', advanced: true, type: 'boolean', value: ignoreCurse,
  }, (v: boolean) => { ignoreCurse = v; });

  ctx.registerSetting('ignoreDrought', {
    label: 'Block Drought projectiles', advanced: true, type: 'boolean', value: ignoreDrought,
  }, (v: boolean) => { ignoreDrought = v; });

  // ── Per-client state ──────────────────────────────────────────────────────

  const states = new Map<ClientConnection, ADbState>();

  function getState(client: ClientConnection): ADbState {
    let s = states.get(client);
    if (!s) { s = { pending: new Set() }; states.set(client, s); }
    return s;
  }

  ctx.on('clientConnected',    (c) => states.set(c, { pending: new Set() }));
  ctx.on('clientDisconnected', (c) => states.delete(c));

  // ── Helper: build the Effects clear mask from a set of XML effect names ───
  //
  // Exact port of method_5's num/num2 accumulation, but we always clear the
  // bits regardless of whether they're currently set (safe to AND-clear a 0).

  function buildClearMasks(effectNames: Set<string>): { e1: number; e2: number } {
    let e1 = 0;
    let e2 = 0;
    if (effectNames.has('Quiet'))        e1 |= BIT_QUIET;
    if (effectNames.has('Weak'))         e1 |= BIT_WEAK;
    if (effectNames.has('Slowed'))       e1 |= BIT_SLOWED;
    if (effectNames.has('Sick'))         e1 |= BIT_SICK;
    if (effectNames.has('Dazed'))        e1 |= BIT_DAZED;
    if (effectNames.has('Stunned'))      e1 |= BIT_STUNNED;
    if (effectNames.has('Paralyzed'))    e1 |= BIT_PARALYZED;
    if (effectNames.has('Bleeding'))     e1 |= BIT_BLEEDING;
    if (effectNames.has('Armor Broken')) e1 |= BIT_ARMOR_BROKEN;
    if (effectNames.has('Stasis') || effectNames.has('Pet Stasis'))
                                         e1 |= BIT_PET_STASIS;
    if (effectNames.has('Petrified'))    e2 |= BIT2_PETRIFIED;
    if (effectNames.has('Silence') || effectNames.has('Silenced'))
                                         e2 |= BIT2_SILENCE;
    // Curse and Drought don't have standard bits in the visible Class41 code
    // but block the hit — clearing logic is covered by PLAYERHIT suppression.
    return { e1, e2 };
  }

  // ── PLAYERHIT hook — method_4 ────────────────────────────────────────────
  //
  // Packet 90, C→S.  Fields: bulletId (int16), objectId (int32=ownerId).
  // ProjectileTracker key: "${ownerId}:${bulletId}".

  ctx.hookPacket('PLAYERHIT', (client, packet) => {
    if (!packet.isDefined) return;

    const bulletId = packet.data.bulletId as number;
    const objectId = packet.data.objectId as number;

    const tracker = ctx.projectileTracker;
    if (!tracker) return;

    const bullet = tracker.getBullet(`${objectId}:${bulletId}`);
    if (!bullet?.projDef) return;

    const effects = bullet.projDef.conditionEffects;
    if (!effects || effects.length === 0) return;

    // Check whether any enabled toggle matches a condition effect on this bullet.
    // Exact ordering from Class41.method_4.
    let shouldBlock = false;
    for (const ce of effects) {
      const name = ce.effect;
      if (ignoreQuiet      && name === 'Quiet')        { shouldBlock = true; break; }
      if (ignoreWeak       && name === 'Weak')         { shouldBlock = true; break; }
      if (ignoreSlowed     && name === 'Slowed')       { shouldBlock = true; break; }
      if (ignoreSick       && name === 'Sick')         { shouldBlock = true; break; }
      if (ignoreDazed      && name === 'Dazed')        { shouldBlock = true; break; }
      if (ignoreStunned    && name === 'Stunned')      { shouldBlock = true; break; }
      if (ignoreParalyzed  && name === 'Paralyzed')    { shouldBlock = true; break; }
      if (ignoreBleeding   && name === 'Bleeding')     { shouldBlock = true; break; }
      if (ignoreArmorBreak && name === 'Armor Broken') { shouldBlock = true; break; }
      if (ignorePetStasis  && (name === 'Stasis' || name === 'Pet Stasis')) { shouldBlock = true; break; }
      if (ignorePetrified  && name === 'Petrified')    { shouldBlock = true; break; }
      if (ignoreSilence    && (name === 'Silence' || name === 'Silenced')) { shouldBlock = true; break; }
      if (ignoreCurse      && name === 'Curse')        { shouldBlock = true; break; }
      if (ignoreDrought    && name === 'Drought')      { shouldBlock = true; break; }
    }

    if (!shouldBlock) return;

    // Block the hit — server never registers this as a hit.
    packet.send = false;

    // Collect all effect names from this projectile for NEWTICK bit-clearing.
    // MultiTool: foreach (KeyValuePair<string, float> item in statusEffects) hashSet_0.Add(item.Key)
    const state = getState(client);
    for (const ce of effects) {
      state.pending.add(ce.effect);
    }
  });

  // ── NEWTICK hook — method_0 / method_5 ──────────────────────────────────
  //
  // Packet 10, S→C.  Find the player's Status entry, then modify Effects and
  // Effects2 stats in-place.  Mark packet.modified = true so the proxy
  // re-serializes the packet before forwarding to the game client.

  ctx.hookPacket('NEWTICK', (client, packet) => {
    if (!packet.isDefined) return;

    const state     = getState(client);
    const myOid     = client.objectId;   // 0 before CREATESUCCESS
    const statuses  = packet.data.statuses as Array<{
      objectId: number;
      data:     Array<{ id: number; value: number | string; stackCount?: number }>;
    }> | undefined;

    if (!statuses || myOid === 0) {
      state.pending.clear();
      return;
    }

    // Build the visual-only clear mask (num3 in MultiTool, always applied).
    let clearE1visual = 0;
    if (ignoreBlind)          clearE1visual |= BIT_BLIND;
    if (ignoreHallucinating)  clearE1visual |= BIT_HALLUC;
    if (ignoreDrunk)          clearE1visual |= BIT_DRUNK;
    if (ignoreConfused)       clearE1visual |= BIT_CONFUSED;
    if (ignoreUnstable)       clearE1visual |= BIT_UNSTABLE;
    if (ignoreDarkness)       clearE1visual |= BIT_DARKNESS;

    // Build the projectile-debuff clear masks from pending blocked hits.
    const { e1: clearE1debuffs, e2: clearE2debuffs } = buildClearMasks(state.pending);
    state.pending.clear();

    const clearE1 = clearE1visual | clearE1debuffs;
    const clearE2 = clearE2debuffs;

    if (clearE1 === 0 && clearE2 === 0) return;

    // Find the player's status entry.
    // If the server didn't include our entry this tick the bits haven't
    // changed — the game client already holds the previous (cleaned) value.
    for (const status of statuses) {
      if (status.objectId !== myOid) continue;

      let patched = false;

      for (const stat of status.data) {
        if (stat.id === STAT_EFFECTS && clearE1 !== 0) {
          const original = stat.value as number;
          const cleaned  = original & ~clearE1;
          if (cleaned !== original) {
            stat.value = cleaned;
            patched = true;
          }
        } else if (stat.id === STAT_EFFECTS2 && clearE2 !== 0) {
          const original = stat.value as number;
          const cleaned  = original & ~clearE2;
          if (cleaned !== original) {
            stat.value = cleaned;
            patched = true;
          }
        }
      }

      if (patched) {
        packet.modified = true;
      }
      break;
    }
  });

  ctx.log('Loaded — blocks debuff projectile hits and clears visual condition bits');
}
