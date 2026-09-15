import type { PluginLoadReport } from '../plugins/PluginManager.js';

export interface StartupDeps {
  loadPlugins(): Promise<PluginLoadReport>;
  applyProfile(): void | Promise<void>;
  startWatching(): void | Promise<void>;
  startProxy(): void;
  startPipe(): void;
  publish(report: PluginLoadReport): void;
  signal: AbortSignal;
}

export async function startServices(deps: StartupDeps): Promise<void> {
  if (deps.signal.aborted) return;
  const report = await deps.loadPlugins();
  if (deps.signal.aborted) return;
  await deps.applyProfile();
  if (deps.signal.aborted) return;
  await deps.startWatching();
  if (deps.signal.aborted) return;
  deps.publish(report);
  if (deps.signal.aborted) return;
  deps.startProxy();
  if (deps.signal.aborted) return;
  deps.startPipe();
}
