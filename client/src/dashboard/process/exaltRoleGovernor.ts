import { loadExaltTuneSettings, saveExaltTuneSettings } from './exaltTuneSettings.js';
import {
  loadExaltClientRoles,
  saveExaltClientRoles,
} from './exaltClientRoles.js';
import { enumerateRealmClustersWithRoles } from './exaltRealmClusters.js';
import {
  applyMultiboxRolePrioritiesFromDisk,
  applyResolvedRolesMultiboxClusters,
  activatePowerPlan,
  getForegroundPid,
  listPowerPlans,
  rebalanceMultiboxAffinityFromDisk,
  resetAllExaltAffinityToAllLogicalCpus,
  setAllExaltPriority,
  tuningSupported,
} from './rotmgWindowsClientTune.js';
import { reloadSmartTrimTimerState } from '../trim/smartTrimScheduler.js';
import { syncExaltTuneWatchdogFromDisk } from './exaltTuneWatchdog.js';
import { applyTuningPresetToDisk, type TuningPresetName } from './tuningPresets.js';
import { clearThermalBackgroundDemotion } from './thermalStressLayer.js';

/** Re-read foreground + parked clusters (no process mutation). */
export async function refreshResolvedClientRoles() {
  return enumerateRealmClustersWithRoles();
}

export async function applyRolePrioritiesFromDisk() {
  return applyMultiboxRolePrioritiesFromDisk();
}

export async function applyRoleAffinityFromDisk() {
  return rebalanceMultiboxAffinityFromDisk();
}

export function applyRoleTrimPolicyFromDisk() {
  reloadSmartTrimTimerState();
}

/**
 * Safety reset: Normal priority + full CPU affinity, clears parked list, stops CPU watchdog, clears dashboard preset name.
 * Optionally activates the Balanced power plan (matched by its well-known GUID, name as fallback).
 */
export async function restoreAllClientTuning(options?: {
  activateBalancedPowerPlan?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    saveExaltClientRoles({ parkedPids: [] });

    const cur = loadExaltTuneSettings();
    saveExaltTuneSettings({
      tuningPreset: null,
      watchdog: { ...cur.watchdog, enabled: false },
      thermal: { ...cur.thermal, enabled: false },
    });
    syncExaltTuneWatchdogFromDisk();

    clearThermalBackgroundDemotion();

    const sup = await tuningSupported();
    if (sup.ok) {
      await setAllExaltPriority('Normal');
      await resetAllExaltAffinityToAllLogicalCpus();
    }

    if (options?.activateBalancedPowerPlan && sup.ok) {
      const plans = await listPowerPlans();
      // Prefer the well-known Balanced scheme GUID. Matching the friendly name
      // alone fails on non-English Windows, where powercfg localizes it (German
      // "Ausbalanciert", Spanish "Equilibrado", Japanese "バランス", …), so the
      // safety reset would never re-apply Balanced. Name match stays as fallback.
      const BALANCED_GUID = '381b4222-f694-41f0-9685-ff5bb260df2e';
      const guidOnly = (g: string): string => String(g).replace(/[{}]/g, '').trim().toLowerCase();
      const bal =
        plans.find((p) => guidOnly(p.guid) === BALANCED_GUID) ||
        plans.find((p) => /\bbalanced\b/i.test(p.name)) ||
        plans.find((p) => /^balanced$/i.test(String(p.name).trim()));
      if (bal) await activatePowerPlan(bal.guid);
    }

    reloadSmartTrimTimerState();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e) };
  }
}

/** Apply saved foreground + parked list (`loadExaltClientRoles`) and current disk preset. */
export async function applyEffectiveMultiboxPolicyFromDisk() {
  const fg = await getForegroundPid();
  const parked = new Set(loadExaltClientRoles().parkedPids);
  return applyResolvedRolesMultiboxClusters(fg, parked);
}

/** Alias: one call applies per-role priority + affinity (`applyResolvedRolesMultiboxClusters`). */
export async function applyRoleTuning(): Promise<{
  ok: boolean;
  error?: string;
  slots: Array<{ seedPid: number; pids: number[]; role: import('./exaltClientRoles.js').ClientRole }>;
}> {
  return applyEffectiveMultiboxPolicyFromDisk();
}

/**
 * Optional `preset` writes tuning JSON first; always applies resolved role priorities + affinity for live FG/parked.
 */
export async function applyMultiboxPresetAndLivePolicy(parsed?: {
  preset?: string;
}) {
  const raw = String(parsed?.preset || '').trim();
  if (raw) {
    const want = raw.toLowerCase().replace(/\s+/g, '');
    const NAMES: readonly TuningPresetName[] = ['safe', 'balanced', 'multibox', 'aggressive', 'lowHeat'];
    const key = NAMES.find((n) => n.toLowerCase().replace(/\s+/g, '') === want);
    if (key) applyTuningPresetToDisk(key);
  }
  reloadSmartTrimTimerState();
  syncExaltTuneWatchdogFromDisk();
  return applyEffectiveMultiboxPolicyFromDisk();
}
