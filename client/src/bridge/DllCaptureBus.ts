/** Optional versioned diagnostic transport. Unknown fields never reach disk. */
export type CaptureDecision = Record<string, number | null>;
export interface CaptureRecord {
  type: 'encounterCapture'; version: 1; kind: 'native_scene' | 'native_decision' | 'native_present_interarrival' | 'native_update_timing' | 'native_autonexus_scan';
  processId: number; processStartUtcMs: number; anchorMs: number; anchorUtcMs: number; memoryBytes: number;
  decision?: CaptureDecision;
  [key: string]: unknown;
}
const decisionKeys = ['ms','sequence','generation','trigger','tick','hp','maxHp','lockId','mode','solve','x','y','goalX','goalY','targetX','targetY','speed','range','clearance','standClearance','lockX','lockY','rawGoalX','rawGoalY','move','fromLock','lockApproach','driveAccepted','dropped','suppressed'];
const scalar = (x: unknown): x is number | null => x === null || (typeof x === 'number' && Number.isFinite(x));
const numberNonnegative = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const uint = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const row = (x: unknown, n: number): x is Array<number | null> => Array.isArray(x) && x.length === n && x.every(scalar);
export function decodeCapture(value: unknown): CaptureRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.type !== 'encounterCapture' || v.version !== 1 || !['native_scene','native_decision','native_present_interarrival','native_update_timing','native_autonexus_scan'].includes(String(v.kind))) return null;
  const out: Record<string, unknown> = { type: 'encounterCapture', version: 1, kind: v.kind };
  for (const key of ['processId','processStartUtcMs','anchorMs','anchorUtcMs','anchorUncertaintyMs','memoryBytes','sceneQueueHighWater','decisionQueueHighWater','terminalQueueHighWater','frameQueueHighWater']) {
    if (!uint(v[key])) return null; out[key] = v[key];
  }
  if ((v.memoryBytes as number) > 4*1024*1024) return null;
  if (v.updateQueueHighWater !== undefined) {if(!uint(v.updateQueueHighWater))return null;out.updateQueueHighWater=v.updateQueueHighWater;}
  // AUTONEXUS-SCAN-DIAG begin — private AutoNexus scan record (native AutoNexusScanWire.h).
  if (v.kind === 'native_autonexus_scan') return decodeScan(v, out);
  // AUTONEXUS-SCAN-DIAG end
  if (v.kind === 'native_update_timing') {
    if (!uint(v.dropped) || !Array.isArray(v.updates) || v.updates.length > 128 || !v.updates.every(a => row(a,8) && a.slice(0,4).every(uint) && a.slice(4,7).every(x=>numberNonnegative(x)) && [0,1].includes(a[7] as number))) return null;
    out.dropped=v.dropped;out.updates=v.updates.map(a=>[...a]);return out as CaptureRecord;
  }
  if (v.kind === 'native_present_interarrival') {
    if (!uint(v.qpcFrequency) || v.qpcFrequency === 0 || !uint(v.dropped) || !Array.isArray(v.frames) || v.frames.length > 128 || !v.frames.every(a => row(a,5) && a.every(uint))) return null;
    out.qpcFrequency=v.qpcFrequency;out.dropped=v.dropped;out.frames=v.frames.map(a=>[...a]);return out as CaptureRecord;
  }
  if (!v.decision || typeof v.decision !== 'object' || Array.isArray(v.decision)) return null;
  const d = v.decision as Record<string, unknown>; const decision: CaptureDecision = {};
  for (const key of decisionKeys) { if (!scalar(d[key])) return null; decision[key] = d[key] as number | null; }
  for (const key of ['ms','sequence','generation','trigger','tick','dropped','suppressed']) if (!uint(d[key])) return null;
  if(d.observationAgeMs !== undefined){if(!scalar(d.observationAgeMs))return null;decision.observationAgeMs=d.observationAgeMs as number|null;}
  out.decision = decision;
  if (v.kind === 'native_scene') {
    for (const key of ['candidateTick','terrainTick','flags','enemiesObserved','enemyEntriesVisited','projectilesObserved','zonesObserved','candidatesObserved']) {
      if (!uint(v[key])) return null; out[key] = v[key];
    }
    for (const [key, cap, width] of [['enemies',64,9],['zones',64,4],['candidates',8,6]] as const) {
      const a = v[key]; if (!Array.isArray(a) || a.length > cap || !a.every(e => row(e,width))) return null;
      out[key] = a.map(e => [...e]);
    }
    if (!Array.isArray(v.projectiles) || v.projectiles.length > 128) return null;
    const projectiles: unknown[] = [];
    for (const p of v.projectiles) {
      if (!Array.isArray(p) || p.length !== 9 || !p.slice(0,8).every(scalar) || !Array.isArray(p[8]) || p[8].length > 8 || !p[8].every((a: unknown) => row(a,3))) return null;
      projectiles.push([...p.slice(0,8), p[8].map((a: Array<number | null>) => [...a])]);
    }
    out.projectiles = projectiles;
    for(const [key,parent,width] of [['enemyDetails','enemies',4],['zoneDetails','zones',7]] as const){
      if(v[key]!==undefined){const a=v[key];if(!Array.isArray(a)||a.length!==(out[parent] as unknown[]).length||!a.every(e=>row(e,width)))return null;out[key]=a.map(e=>[...e]);}
    }
    if(v.weaponProfile!==undefined){if(v.weaponProfile!==null&&!row(v.weaponProfile,11))return null;out.weaponProfile=v.weaponProfile===null?null:[...v.weaponProfile as Array<number|null>];}

    for (const key of ['cellX','cellY','cellStep']) { if (!scalar(v[key])) return null; out[key] = v[key]; }
    if (!Array.isArray(v.cells) || v.cells.length !== 289 || !v.cells.every(x => uint(x) && x <= 255)) return null;
    out.cells = [...v.cells];
    for (const [array,total] of [['enemies','enemiesObserved'],['projectiles','projectilesObserved'],['zones','zonesObserved'],['candidates','candidatesObserved']]) {
      if ((out[array] as unknown[]).length > (out[total] as number)) return null;
    }
  }
  return out as CaptureRecord;
}
// AUTONEXUS-SCAN-DIAG begin
const scanKeys = ['ms','sequence','hp','maxHp','defense','totalApplied','branch','x','y','vx','vy','targetValid','targetX','targetY','targetDist','horizonMs','hitPad','threatsObserved','threatCount'];
/** Rows: owner, bullet, raw, applied, flags, bx, by, bvx, bvy, tHitMs, trackClosest, trackClosestMs, holdClosest, holdClosestMs. */
function decodeScan(v: Record<string, unknown>, out: Record<string, unknown>): CaptureRecord | null {
  for (const key of ['scanQueueHighWater','channelBytes','dropped']) { if (!uint(v[key])) return null; out[key] = v[key]; }
  if (!v.scan || typeof v.scan !== 'object' || Array.isArray(v.scan)) return null;
  const s = v.scan as Record<string, unknown>; const scan: Record<string, number | null> = {};
  for (const key of scanKeys) { if (typeof s[key] !== 'number' || !Number.isFinite(s[key])) return null; scan[key] = s[key] as number; }
  for (const key of ['ms','sequence','branch','targetValid','threatsObserved','threatCount']) if (!uint(s[key])) return null;
  if (!Array.isArray(v.threats) || v.threats.length > 16 || v.threats.length !== scan.threatCount
    || (scan.threatCount as number) > (scan.threatsObserved as number) || !v.threats.every(a => row(a, 14))) return null;
  out.scan = scan; out.threats = v.threats.map(a => [...(a as Array<number | null>)]);
  return out as CaptureRecord;
}
// AUTONEXUS-SCAN-DIAG end
type Slot = { listeners: Set<(record: CaptureRecord) => void>; trigger?: (reason: string) => boolean };
const globalSlots = globalThis as unknown as Record<string, unknown>;
const slot = (globalSlots.__realmCaptureBus ??= { listeners: new Set() }) as Slot;
export function publishCapture(record: CaptureRecord): void {
  for (const listener of slot.listeners) { try { listener(record); } catch {} }
}
export function subscribeCapture(listener: (record: CaptureRecord) => void): () => void {
  slot.listeners.add(listener); return () => { slot.listeners.delete(listener); };
}

export function setCaptureTriggerSender(sender: (reason: string) => boolean): void { slot.trigger=sender; }
export function requestCaptureTrigger(reason: 'death' | 'escape' | 'hit' | 'map'): boolean {
  try { return slot.trigger?.(reason) === true; } catch { return false; }
}

/** Shared recorder wrapper keeps packet-reader identity keys intact. */
export function captureRecord(record: CaptureRecord, receivedUtcMs: number): Record<string, unknown> {
 return { ...record, k: record.kind, t: receivedUtcMs, clock: 'windows_monotonic_ms',
   clockUncertaintyMs: record.anchorUncertaintyMs, runIdentity: 'recorder-file',
   geometryCoverage: record.kind === 'native_scene' ? 'bounded_observation' : null, alternativeCoverage: record.kind === 'native_scene' ? 'bounded_evaluated' : null,
   calibrationProvenance: record.weaponProfile ?? null, enemyRuntimeConditions: record.enemyDetails ?? null, sourceObservationAgeMs: null };
}
