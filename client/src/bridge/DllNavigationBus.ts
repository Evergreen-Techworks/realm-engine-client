import type { NavigationStatus } from '@realmengine/sdk';

type WireStatus = Omit<NavigationStatus, 'position'>;
type Slot = { nextId: number; listeners: Set<(status: WireStatus) => void> };
const globals = globalThis as unknown as Record<string, unknown>;
const slot = (globals.__realmNavigationBus ??= { nextId: Date.now() * 1000, listeners: new Set() }) as Slot;

export function nextNavigationId(): number {
  return ++slot.nextId;
}

export function decodeNavigationStatus(value: unknown): WireStatus | null {
  if (!value || typeof value !== 'object') return null;
  const status = value as WireStatus;
  if (!['point', 'ring'].includes(status.goalKind)
    || !Number.isSafeInteger(status.goalId) || status.goalId <= 0
    || !Number.isSafeInteger(status.generation) || status.generation < 0
    || !['routing', 'arrived', 'partial', 'unreachable'].includes(status.state)
    || typeof status.reason !== 'string' || status.reason.length > 128) return null;
  return { goalKind: status.goalKind, goalId: status.goalId, generation: status.generation, state: status.state, reason: status.reason };
}

export function publishNavigationStatus(status: WireStatus): void {
  for (const listener of slot.listeners) {
    try { listener(status); } catch { }
  }
}

export function subscribeNavigationStatus(listener: (status: WireStatus) => void): () => void {
  slot.listeners.add(listener);
  return () => { slot.listeners.delete(listener); };
}
