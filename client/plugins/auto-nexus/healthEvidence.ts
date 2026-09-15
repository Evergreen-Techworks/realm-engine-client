export interface EvidenceSnapshot {
  confirmedHp: number | null;
  pendingDamage: number;
  predictedHp: number | null;
  certainty: 'identified' | 'ambiguous';
  healthAt: number | null;
}

interface PendingEvidence {
  generation: number;
  remaining: number;
  coveredByHp: number;
  receivedAt: number;
  expiresAt: number;
  retainUntil: number;
  acknowledged: boolean;
  expired: boolean;
  uncertainOrdering: boolean;
}

const MAX_ENTRIES = 4096;
const RETENTION_MS = 12000;

export class HealthEvidence {
  private generation = 0;
  private confirmedHp: number | null = null;
  private healthAt: number | null = null;
  private ambiguous = false;
  private unassignedLossAt = -Infinity;
  private entries = new Map<string, PendingEvidence>();

  reset(generation: number): void {
    this.generation = generation;
    this.confirmedHp = null;
    this.healthAt = null;
    this.ambiguous = false;
    this.unassignedLossAt = -Infinity;
    this.entries.clear();
  }

  noteAmbiguity(): void { this.ambiguous = true; }

  observeHp(hp: number, atMs: number): void {
    if (!Number.isFinite(hp) || hp < 0 || !this.validTime(atMs)) return;
    this.prune(atMs);
    if (this.healthAt !== null && atMs < this.healthAt) { this.noteAmbiguity(); return; }
    let loss = this.confirmedHp === null ? 0 : Math.max(0, this.confirmedHp - hp);
    for (const entry of this.entries.values()) {
      if (entry.remaining <= 0) continue;
      this.noteAmbiguity();
      const covered = Math.min(loss, entry.remaining);
      entry.remaining -= covered;
      entry.coveredByHp += covered;
      loss -= covered;
    }
    if (loss > 0) this.unassignedLossAt = atMs;
    this.confirmedHp = hp;
    this.healthAt = atMs;
  }

  observeHit(identity: string, appliedDamage: number, expiresAt: number, atMs: number): void {
    if (!identity || !this.validDamage(appliedDamage) || !this.validTime(atMs) ||
        !Number.isFinite(expiresAt) || expiresAt <= atMs) return;
    this.prune(atMs);
    if (this.entries.has(identity)) return;
    const uncertainOrdering = atMs - this.unassignedLossAt <= RETENTION_MS ||
      (this.healthAt !== null && atMs < this.healthAt);
    if (uncertainOrdering) this.noteAmbiguity();
    const boundedExpiry = Math.min(expiresAt, atMs + RETENTION_MS);
    this.entries.set(identity, { generation: this.generation, remaining: appliedDamage, coveredByHp: 0,
      receivedAt: atMs, expiresAt: boundedExpiry, retainUntil: boundedExpiry + RETENTION_MS,
      acknowledged: false, expired: false, uncertainOrdering });
    this.bound();
  }

  observeDamage(identity: string | null, appliedDamage: number, atMs: number): void {
    if (!this.validDamage(appliedDamage) || !this.validTime(atMs)) return;
    this.prune(atMs);
    if (!identity) { this.noteAmbiguity(); return; }
    const entry = this.entries.get(identity);
    if (entry?.acknowledged) return;
    if (entry?.expired || (this.healthAt !== null && atMs < this.healthAt)) {
      this.noteAmbiguity();
      if (entry) entry.acknowledged = true;
      return;
    }
    const uncertainOrdering = entry?.uncertainOrdering ?? atMs - this.unassignedLossAt <= RETENTION_MS;
    if (uncertainOrdering) this.noteAmbiguity();
    const uncovered = uncertainOrdering ? 0 : Math.max(0, appliedDamage - (entry?.coveredByHp ?? 0));
    if (this.confirmedHp !== null) this.confirmedHp = Math.max(0, this.confirmedHp - uncovered);
    this.healthAt = atMs;
    if (entry) {
      const acknowledgedPending = Math.max(0, appliedDamage - entry.coveredByHp);
      if (acknowledgedPending !== entry.remaining) this.noteAmbiguity();
      entry.remaining = Math.max(0, entry.remaining - acknowledgedPending);
      entry.acknowledged = true;
      entry.retainUntil = Math.max(entry.retainUntil, atMs + RETENTION_MS);
    } else {
      this.entries.set(identity, { generation: this.generation, remaining: 0, coveredByHp: 0,
        receivedAt: atMs, expiresAt: atMs + RETENTION_MS, retainUntil: atMs + RETENTION_MS,
        acknowledged: true, expired: false, uncertainOrdering });
      this.bound();
    }
  }

  snapshot(nowMs: number): EvidenceSnapshot {
    if (this.validTime(nowMs)) this.prune(nowMs);
    const pendingDamage = [...this.entries.values()].reduce((total, entry) => total + entry.remaining, 0);
    return { confirmedHp: this.confirmedHp, pendingDamage,
      predictedHp: this.confirmedHp === null ? null : this.confirmedHp === 0 ? 0 : this.confirmedHp - pendingDamage,
      certainty: this.ambiguous ? 'ambiguous' : 'identified', healthAt: this.healthAt };
  }

  private validTime(value: number): boolean { return Number.isFinite(value) && value >= 0; }
  private validDamage(value: number): boolean { return Number.isFinite(value) && value > 0; }

  private prune(nowMs: number): void {
    for (const [identity, entry] of this.entries) {
      if (entry.generation !== this.generation || entry.retainUntil < nowMs) {
        this.entries.delete(identity);
      } else if (entry.expiresAt < nowMs && entry.remaining > 0) {
        entry.remaining = 0;
        entry.expired = true;
        this.noteAmbiguity();
      }
    }
  }

  private bound(): void {
    while (this.entries.size > MAX_ENTRIES) {
      this.entries.delete(this.entries.keys().next().value!);
      this.noteAmbiguity();
    }
  }
}
