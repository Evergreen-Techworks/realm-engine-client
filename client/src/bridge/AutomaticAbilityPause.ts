// Short leases expire if a script stops, crashes or loses its connection.
// Plugins are bundled independently; share the lease bus with the host bundle.
const globalBus = globalThis as typeof globalThis & {
  __realmAutomaticAbilityPauses_v1?: WeakMap<object, number>;
};
const pauses = globalBus.__realmAutomaticAbilityPauses_v1 ??= new WeakMap<object, number>();

export function pauseAutomaticAbility(client: object, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return;
  const deadline = Date.now() + Math.min(1000, durationMs);
  pauses.set(client, Math.max(pauses.get(client) ?? 0, deadline));
}

export function automaticAbilityPaused(client: object): boolean {
  return Date.now() < (pauses.get(client) ?? 0);
}
