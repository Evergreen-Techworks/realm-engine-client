export interface DllGroundEvent {
  rawDamage: number;
  tHitMs: number;
}

export interface DllGround {
  rawDamage: number;
  tHitMs: number;
  events: DllGroundEvent[];
}

export interface DllThreat {
  attackerObjId: number;
  bulletId: number;
  tHitMs: number;
  fallbackDamage: number;
  fallbackArmorPiercing: boolean;
}

// Threat wire schema version. Bump only in lockstep with the C++ encoder's
// THREAT_SCHEMA_VERSION in internal/src/core/ipc/IpcMessages.h. A version skew is
// rejected loud below (empty threat list + one-line warn) rather than misread.
export const THREAT_SCHEMA_VERSION = 1;

const GLOBAL_SLOT_KEY = '__LFG_dllThreatBus_v1';

type BusSlot = { threats: DllThreat[]; ground: DllGround; truncated: boolean; at: number };

function getBusSlot(): BusSlot {
  const g = globalThis as unknown as Record<string, unknown>;
  let slot = g[GLOBAL_SLOT_KEY] as BusSlot | undefined;
  if (!slot) {
    slot = { threats: [], ground: { rawDamage: 0, tHitMs: -1, events: [] }, truncated: false, at: 0 };
    g[GLOBAL_SLOT_KEY] = slot;
  }
  return slot;
}

export function publishDllThreats(
  threats: DllThreat[],
  ground: DllGround = { rawDamage: 0, tHitMs: -1, events: [] },
  truncated = false,
): void {
  const slot = getBusSlot();
  slot.threats = threats;
  slot.ground = ground;
  slot.truncated = truncated;
  slot.at = Date.now();
}

export function getDllThreats(maxAgeMs = 500): DllThreat[] {
  const slot = getBusSlot();
  if (slot.at === 0 || Date.now() - slot.at > maxAgeMs) return [];
  return slot.threats;
}

export function getDllGround(maxAgeMs = 500): DllGround | null {
  const slot = getBusSlot();
  if (slot.at === 0 || Date.now() - slot.at > maxAgeMs) return null;
  return slot.ground;
}

/** True when the DLL shed threats/ground under load — the list is known-partial. */
export function getDllThreatsTruncated(maxAgeMs = 500): boolean {
  const slot = getBusSlot();
  if (slot.at === 0 || Date.now() - slot.at > maxAgeMs) return false;
  return slot.truncated;
}

export function getDllThreatsAgeMs(): number | null {
  const slot = getBusSlot();
  return slot.at === 0 ? null : Date.now() - slot.at;
}

/**
 * The ONE decoder for the compact versioned threat wire string. Its inverse is
 * the C++ EncodeThreats in internal/src/core/ipc/IpcMessages.cpp — the two must
 * agree byte-for-byte on the layout below (see THREAT_SCHEMA_VERSION):
 *
 *   1;<ground>;<threats>;<T>
 *     <ground>  = <rawDamage>:<tHitMs>[|<rawDamage>:<tHitMs>]*  (leading summary
 *                 segment skipped; ground rawDamage/tHitMs taken from the first
 *                 event, matching the DLL's projection)
 *     <threats> = <attackerObjId>:<bulletId>:<tHitMs>:<fallbackDamage>:<fallbackArmorPiercing>
 *                 (comma-separated; field order authoritative here and in the encoder)
 *     <T>       = 0 | 1  truncated flag
 *
 * A version other than THREAT_SCHEMA_VERSION is rejected loud: returns an empty
 * result so auto-nexus falls back to server-confirmed damage.
 */
export function decodeThreatPayload(payload: string): {
  threats: DllThreat[];
  ground: DllGround;
  truncated: boolean;
} {
  const out: DllThreat[] = [];
  const ground: DllGround = { rawDamage: 0, tHitMs: -1, events: [] };
  if (!payload) return { threats: out, ground, truncated: false };

  // "1;<ground>;<threats>;<T>" — <ground>/<threats> never contain ';', so the
  // top level always splits into exactly [version, ground, threats, truncated].
  const segs = payload.split(';');
  if (segs.length < 4) return { threats: out, ground, truncated: false };

  const version = Number(segs[0]);
  if (version !== THREAT_SCHEMA_VERSION) {
    console.warn(
      `[DllThreatBus] threat payload schema ${segs[0]} != ${THREAT_SCHEMA_VERSION} — dropping`,
    );
    return { threats: out, ground, truncated: false };
  }

  const groundPart = segs[1];
  const threatsPart = segs[2];
  const truncated = segs[3] === '1';

  const gSegments = groundPart.split('|');
  for (let i = 1; i < gSegments.length; i++) {
    const g = gSegments[i].split(':');
    if (g.length !== 2) continue;
    const dmg = Number(g[0]);
    const t = Number(g[1]);
    if (!Number.isFinite(dmg) || !Number.isFinite(t)) continue;
    if (dmg <= 0) continue;
    if (ground.events.length === 0) {
      ground.rawDamage = dmg;
      ground.tHitMs = t;
    }
    ground.events.push({ rawDamage: dmg, tHitMs: t });
  }

  if (threatsPart) {
    for (const entry of threatsPart.split(',')) {
      const parts = entry.split(':');
      if (parts.length !== 5) continue;
      const attackerObjId = Number(parts[0]);
      const bulletId = Number(parts[1]);
      const tHitMs = Number(parts[2]);
      const fallbackDamage = Number(parts[3]);
      if (!Number.isFinite(attackerObjId) || !Number.isFinite(bulletId)
        || !Number.isFinite(tHitMs) || !Number.isFinite(fallbackDamage)) continue;
      out.push({
        attackerObjId,
        bulletId,
        tHitMs,
        fallbackDamage,
        fallbackArmorPiercing: parts[4] === '1',
      });
    }
  }

  return { threats: out, ground, truncated };
}
