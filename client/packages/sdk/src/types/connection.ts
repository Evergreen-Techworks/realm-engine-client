export type AdmissionPhase = 'idle' | 'connecting' | 'queued' | 'admission-pending' | 'loaded' | 'entry-refused' | 'terminal' | 'cancelled' | 'dead' | 'disconnected';

export interface ConnectionStatus {
    generation: number;
    phase: AdmissionPhase;
    queuePosition: number | null;
    retryAt: number | null;
    reason: string | null;
}
