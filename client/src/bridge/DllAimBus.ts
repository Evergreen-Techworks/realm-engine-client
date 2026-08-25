/**
 * DllAimBus — the killaura aim state published by the injected DLL.
 *
 * Mirrors DllThreatBus.ts exactly: one globalThis-keyed slot, a publisher fed by
 * InternalBridge, age-gated getters, and the ONE decoder for the compact wire
 * string (its C++ inverse is IpcMessages::EncodeAim).
 */

export interface DllAim {
  armed: boolean;
  mode: 0 | 1;          // 0 = at-target, 1 = at-mouse
  targetId: number;
  tx: number;
  ty: number;
  px: number;
  py: number;
  standoffTiles: number;
  maxOffsetTiles: number;
  /** DLL GetTickCount64() low 32 bits — diagnostics only. DO NOT compare to Date.now(). */
  stamp: number;

  // ── v2: the ONE authoritative shot origin ──────────────────────────────
  // The DLL solves the shot origin exactly once per killaura refresh and sends
  // the RESULT, not the ingredients. `ox`/`oy` are the SAME absolute-world-tile
  // point the DLL moved the local bullet to. Consumers must forward this value,
  // never re-derive one from tx/ty/standoff: two independent derivations that
  // disagree is precisely why the server was refusing the hit claims.
  /** false = that refresh refused an origin (standoff/maxOffset caps) — do NOT rewrite. */
  originValid: boolean;
  /** Absolute world tiles. Meaningful only when `originValid`. */
  ox: number;
  oy: number;
  /** KillAura refresh counter that produced `ox`/`oy`. Monotonic; never reused. */
  generation: number;
}

// Aim wire schema version. Bump only in lockstep with AIM_SCHEMA_VERSION in
// internal/src/core/ipc/IpcBridge.h. A version skew is rejected loud below
// (null + one-line warn) so killaura fails closed rather than misreading.
//
// v2 added originValid/ox/oy/generation (4 trailing tokens, 11 -> 15).
export const AIM_SCHEMA_VERSION = 2;

const GLOBAL_SLOT_KEY = '__LFG_dllAimBus_v1';

type BusSlot = { aim: DllAim | null; at: number };

function getBusSlot(): BusSlot {
  const g = globalThis as unknown as Record<string, unknown>;
  let slot = g[GLOBAL_SLOT_KEY] as BusSlot | undefined;
  if (!slot) {
    slot = { aim: null, at: 0 };
    g[GLOBAL_SLOT_KEY] = slot;
  }
  return slot;
}

export function publishDllAim(aim: DllAim | null): void {
  const slot = getBusSlot();
  slot.aim = aim;
  // A dropped/rejected payload clears the slot outright: consumers must fail
  // closed rather than keep acting on the last good aim.
  slot.at = aim ? Date.now() : 0;
}

/** Latest aim state, or null if none / older than maxAgeMs (local receive clock). */
export function getDllAim(maxAgeMs = 250): DllAim | null {
  const slot = getBusSlot();
  if (slot.at === 0 || Date.now() - slot.at > maxAgeMs) return null;
  return slot.aim;
}

export function getDllAimAgeMs(): number | null {
  const slot = getBusSlot();
  return slot.at === 0 ? null : Date.now() - slot.at;
}

/** Last rejected version token, so a skew warns once-ish instead of per-tick. */
let warnedVersionToken: string | null = null;

/**
 * The ONE decoder for the compact aim wire string. Its inverse is
 * IpcMessages::EncodeAim in internal/src/core/ipc/IpcMessages.cpp.
 *
 *   "2;<armed>;<mode>;<targetId>;<tx>;<ty>;<px>;<py>;<standoff>;<maxOffset>;<stamp>"
 *     ";<originValid>;<ox>;<oy>;<generation>"
 *
 * EXACTLY 15 ';'-separated tokens; field order is authoritative here and there.
 * A version other than AIM_SCHEMA_VERSION is rejected loud (console.warn, returns
 * null) so killaura fails closed rather than misreading.
 *
 * Every failure returns null — never a partial object.
 */
export function decodeAimPayload(payload: string): DllAim | null {
  if (!payload) return null;

  const segs = payload.split(';');
  if (segs.length !== 15) return null;

  const version = Number(segs[0]);
  if (version !== AIM_SCHEMA_VERSION) {
    if (warnedVersionToken !== segs[0]) {
      warnedVersionToken = segs[0];
      console.warn(
        `[DllAimBus] aim payload schema ${segs[0]} != ${AIM_SCHEMA_VERSION} — dropping`,
      );
    }
    return null;
  }

  const targetId = Number(segs[3]);
  const tx = Number(segs[4]);
  const ty = Number(segs[5]);
  const px = Number(segs[6]);
  const py = Number(segs[7]);
  const standoffTiles = Number(segs[8]);
  const maxOffsetTiles = Number(segs[9]);
  const stamp = Number(segs[10]);
  const ox = Number(segs[12]);
  const oy = Number(segs[13]);
  const generation = Number(segs[14]);

  if (!Number.isFinite(tx) || !Number.isFinite(ty)
    || !Number.isFinite(px) || !Number.isFinite(py)
    || !Number.isFinite(standoffTiles) || !Number.isFinite(maxOffsetTiles)
    || !Number.isFinite(ox) || !Number.isFinite(oy)) return null;
  if (!Number.isInteger(targetId) || !Number.isInteger(stamp)
    || !Number.isInteger(generation)) return null;

  return {
    armed: segs[1] === '1',
    mode: segs[2] === '1' ? 1 : 0,
    targetId,
    tx,
    ty,
    px,
    py,
    standoffTiles,
    maxOffsetTiles,
    stamp,
    originValid: segs[11] === '1',
    ox,
    oy,
    generation,
  };
}
