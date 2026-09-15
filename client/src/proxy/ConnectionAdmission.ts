import type { AdmissionPhase } from '@realmengine/sdk';
export type { AdmissionPhase } from '@realmengine/sdk';
export interface AdmissionSnapshot {
  generation: number;
  phase: AdmissionPhase;
  queuePosition: number | null;
  portalId: number | null;
  retryAt: number | null;
  reason: string | null;
  source: 'server' | 'transport' | 'user' | null;
}
export type AdmissionEvent = { generation: number } & (
  | { type: 'begin' | 'map-loaded' | 'cancel' | 'death' | 'disconnect' }
  | { type: 'queue'; position: number }
  | { type: 'portal-refused'; portalId: number; retryAt: number; reason: string }
  | { type: 'terminal'; reason: string; source?: 'server' | 'transport' }
  | { type: 'transport-retry'; retryAt: number; reason: string }
);
export const initialAdmission = (): AdmissionSnapshot => ({ generation: 0, phase: 'idle', queuePosition: null, portalId: null, retryAt: null, reason: null, source: null });
const stopped = new Set<AdmissionPhase>(['terminal', 'cancelled', 'dead', 'disconnected']);

export function reduceAdmission(state: AdmissionSnapshot, event: AdmissionEvent): AdmissionSnapshot {
  if (event.type === 'begin') return event.generation > state.generation ? { ...initialAdmission(), generation: event.generation, phase: 'connecting' } : state;
  if (event.generation !== state.generation || stopped.has(state.phase)) return state;
  switch (event.type) {
    case 'queue': return Number.isInteger(event.position) && event.position >= 0
      ? { ...state, phase: event.position === 0 ? 'admission-pending' : 'queued', queuePosition: event.position, retryAt: null, source: 'server' } : state;
    case 'map-loaded': return { ...state, phase: 'loaded', queuePosition: null, portalId: null, retryAt: null, reason: null, source: 'server' };
    case 'portal-refused': return { ...state, phase: 'entry-refused', queuePosition: null, portalId: event.portalId, retryAt: event.retryAt, reason: event.reason, source: 'server' };
    case 'transport-retry': return { ...state, phase: 'connecting', retryAt: event.retryAt, reason: event.reason, source: 'transport' };
    case 'terminal': return { ...state, phase: 'terminal', retryAt: null, reason: event.reason, source: event.source ?? 'server' };
    case 'cancel': return { ...state, phase: 'cancelled', retryAt: null, source: 'user' };
    case 'death': return { ...state, phase: 'dead', retryAt: null, source: 'server' };
    case 'disconnect': return { ...state, phase: 'disconnected', retryAt: null, source: 'transport' };
  }
}
