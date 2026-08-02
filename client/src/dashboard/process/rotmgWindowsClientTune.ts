/**
 * Windows helpers to tune RotMG Exalt clients via Node → PowerShell Win32 APIs
 * (`powercfg`, `System.Diagnostics.Process`): CPU priority, affinity, system power plans,
 * and `SetProcessInformation` / `PROCESS_POWER_THROTTLING_EXECUTION_SPEED` (EcoQoS-class behavior).
 * Uses `RotMG Exalt.exe` (launcher/parent) and `RotMGExalt.exe` (Unity player), as Task Manager lists them.
 */
import { spawn } from 'child_process';
import { join } from 'path';

import { Logger } from '../../util/Logger.js';

import type { ClientRole } from './exaltClientRoles.js';
import { allocateAffinityMaskByRolePartition } from './affinityAllocate.js';
import type { EnumerateRealmClusterOptions, RealmClusterResolved } from './exaltRealmClusters.js';
import { enumerateRealmClustersWithRoles } from './exaltRealmClusters.js';
import { buildAffinityMask } from './affinityAllocate.js';
import { getAffinityModeForDisk, getEffectiveMultiboxRoleRules } from './tuningPresets.js';
import {
  getThermalDemotePreset,
  isThermalBackgroundDemotionActive,
  tighterIdlePreset,
} from './thermalStressLayer.js';

/** Multibox: foreground client opts out of execution-speed throttling; background/parked opt in (EcoQoS-class). */
export function multiboxRoleWantsEcoQosExecutionThrottle(role: ClientRole): boolean {
  return role !== 'active';
}

/** Resolves reliably when launched from Electron (PATH may omit System32). */
function powerCfgExePath(): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  return join(root, 'System32', 'powercfg.exe');
}

/**
 * Prefer 64-bit PowerShell even when Realm Engine / Node runs as WOW64 (`Sysnative`).
 * WMI/CIM from 32-bit PS can silently miss enumerate or mis-handle 64-bit game processes.
 */
function powershellExePath(): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  if (
    process.platform === 'win32' &&
    process.arch === 'ia32' &&
    !!process.env.PROCESSOR_ARCHITEW6432
  ) {
    return join(root, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export const ROTMG_EXALT_IMAGE = 'RotMG Exalt.exe';

/**
 * Unity/player child image (often holds the HWND / MainWindowTitle; parent may report blank).
 */
export const ROTMG_EXALT_CHILD_IMAGE = 'RotMGExalt.exe';

/** `Get-Process -Name` takes basename without `.exe`; must match [.NET ProcessName]. */
export const ROTMG_EXALT_PROCESS_NAME = 'RotMG Exalt';

/** No-space basename for the Unity subprocess. */
export const ROTMG_EXALT_CHILD_PROCESS_NAME = 'RotMGExalt';

export type ExaltProcessRow = {
  pid: number;
  /** `Win32_Process.Name` e.g. `RotMG Exalt.exe`, `RotMGExalt.exe` */
  imageName?: string;
  workingSetBytes: number;
  basePriority: number;
  priorityClass: string;
  /** Logical affinity mask Windows reports (often within safe integer range). */
  processorAffinityMask: string;
  /** `% Processor Time` (Win32_PerfFormattedData_PerfProc_Process), summed across cores if >100. */
  cpuPercent?: number | null;
  /** Main window title where available (background clients may show empty). */
  mainWindowTitle?: string | null;
  /** Resolved multibox role (parked ⇢ foreground-aware active/background). */
  role?: ClientRole;
  /** Related Realm launcher/player PIDs sharing one client shell. */
  clusterPids?: number[];
  /** From resolved role `ROLE_RULES[role]` (automated trims may honor this later). */
  trimEligible?: boolean;
};

export type PowerPlanRow = {
  guid: string;
  name: string;
  active: boolean;
};

export type PriorityPreset = 'Idle' | 'BelowNormal' | 'Normal' | 'AboveNormal' | 'High';

export type AffinityStrategy = 'none' | 'spread-one-core' | 'spread-two-cores' | 'spread-four-cores';

export type SpreadAffinityOptions = {
  strategy?: AffinityStrategy;
  /** Reduces the CPU index pool (bit positions start after this bias). Default 2. */
  reserveLogicalCores?: number;
  /** If true, only `RotMGExalt`; if that yields no processes, all Realm-named clients are used. */
  targetChildOnly?: boolean;
  /** Prefer logical CPU 1+ before 0 where possible. Default true when cpus&gt;1. */
  avoidCpuZero?: boolean;
};

export const DEFAULT_SPREAD_AFFINITY: SpreadAffinityOptions = {
  strategy: 'spread-two-cores',
  reserveLogicalCores: 2,
  targetChildOnly: true,
  avoidCpuZero: true,
};

export type SystemMemoryStatus = {
  totalPhysBytes: number;
  availPhysBytes: number;
  /** Rough physical memory utilization % (Win32_OperatingSystem). */
  memoryLoadPercent: number;
};

function isWin32(): boolean {
  return process.platform === 'win32';
}

const DEFAULT_PS_TIMEOUT_MS = 12_000;
const DEFAULT_EXE_TIMEOUT_MS = 15_000;

function killSpawnTree(child: ReturnType<typeof spawn>): void {
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }, 400);
}

function execPowerShell(script: string, timeoutMs = DEFAULT_PS_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const child = spawn(powershellExePath(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
    });
    let settled = false;
    const settle = (
      cb: () => void,
      timer: ReturnType<typeof setTimeout> | undefined,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cb();
    };
    const timer = setTimeout(() => {
      killSpawnTree(child);
      settle(() => reject(new Error(`PowerShell timed out after ${timeoutMs}ms`)), timer);
    }, timeoutMs);
    child.stdout.on('data', (d) => chunks.push(Buffer.from(d)));
    child.stderr.on('data', (d) => errChunks.push(Buffer.from(d)));
    child.on('error', (err) => settle(() => reject(err), timer));
    child.on('close', (code) => {
      settle(() => {
        const out = Buffer.concat(chunks).toString('utf8').trim();
        const errTxt = Buffer.concat(errChunks).toString('utf8').trim();
        if (code !== 0 && errTxt && !out) reject(new Error(errTxt));
        else resolve(out);
      }, timer);
    });
  });
}

async function execPowerShellJson<T>(script: string, timeoutMs = DEFAULT_PS_TIMEOUT_MS): Promise<T> {
  const out = await execPowerShell(script, timeoutMs);
  if (!out.trim()) throw new Error('PowerShell returned empty stdout (expected JSON).');
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new Error(`PowerShell did not return JSON: ${out.slice(0, 400)}`);
  }
}

function execPowerShellWithErr(
  script: string,
  timeoutMs = DEFAULT_PS_TIMEOUT_MS,
): Promise<{ out: string; err: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const child = spawn(powershellExePath(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
    });
    let settled = false;
    const settle = (
      cb: () => void,
      timer: ReturnType<typeof setTimeout> | undefined,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cb();
    };
    const timer = setTimeout(() => {
      killSpawnTree(child);
      settle(() => reject(new Error(`PowerShell timed out after ${timeoutMs}ms`)), timer);
    }, timeoutMs);
    child.stdout.on('data', (d) => chunks.push(Buffer.from(d)));
    child.stderr.on('data', (d) => errChunks.push(Buffer.from(d)));
    child.on('error', (err) => settle(() => reject(err), timer));
    child.on('close', (code) => {
      settle(() => {
        resolve({
          out: Buffer.concat(chunks).toString('utf8').trim(),
          err: Buffer.concat(errChunks).toString('utf8').trim(),
          code,
        });
      }, timer);
    });
  });
}

export function execFileCmd(
  args: string[],
  timeoutMs = DEFAULT_EXE_TIMEOUT_MS,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { windowsHide: true });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;
    const settle = (
      cb: () => void,
      timer: ReturnType<typeof setTimeout> | undefined,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cb();
    };
    const timer = setTimeout(() => {
      killSpawnTree(child);
      settle(() => reject(new Error(`${args[0] || 'process'} timed out after ${timeoutMs}ms`)), timer);
    }, timeoutMs);
    child.stdout.on('data', (d) => chunks.push(Buffer.from(d)));
    child.stderr.on('data', (d) => errChunks.push(Buffer.from(d)));
    child.on('error', (err) => settle(() => reject(err), timer));
    child.on('close', (code) =>
      settle(
        () =>
          resolve({
            code: code ?? 0,
            stdout: Buffer.concat(chunks).toString('utf8'),
            stderr: Buffer.concat(errChunks).toString('utf8'),
          }),
        timer,
      ),
    );
  });
}

/** Hints shown in dashboard — GUIDs vary; always reconcile with `powercfg /list`. */
export const SUGGESTED_REALM_POWER_HINTS = [
  {
    guid: '{8c5e7fda-e8bf-4a96-9a85-a6e23a635635}',
    label: 'High performance',
    hint: 'Native Windows preset — minimizes CPU scaling while multiboxing ROTMG.',
  },
  {
    guid: '{381b4222-f694-41f0-9685-ff5bb260df2e}',
    label: 'Balanced',
    hint: 'Default plan — quieter fans when Realm clients sit idle.',
  },
  {
    guid: '{a1841308-3541-4fab-bc81-f71556f20b4a}',
    label: 'Power saver',
    hint: 'Use when minimizing heat/power; gameplay may feel sluggish.',
  },
];

const GUID_REGEX = /\{?[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}\}?/;

function normalizePowerGuid(guid: string): string | null {
  const m = guid.trim().match(GUID_REGEX);
  if (!m) return null;
  const inner = String(m[0]).replace(/^\{/, '').replace(/\}$/, '').toLowerCase();
  return `{${inner}}`;
}

export async function tuningSupported(): Promise<{ ok: boolean; reason?: string }> {
  if (!isWin32()) return { ok: false, reason: 'Windows-only tuning (ROTmg Exalt client).' };
  return { ok: true };
}

export async function getSystemMemoryStatus(): Promise<SystemMemoryStatus | null> {
  if (!isWin32()) return null;
  const script = `
$os = Get-CimInstance Win32_OperatingSystem
$total = [int64]$os.TotalVisibleMemorySize * 1024L
$free = [int64]$os.FreePhysicalMemory * 1024L
$t = [double]$os.TotalVisibleMemorySize
$load = if ($t -le 0) { 0.0 } else { [math]::Round((1.0 - ([double]$os.FreePhysicalMemory / $t)) * 100.0, 1) }
@{ totalPhysBytes = $total; availPhysBytes = $free; memoryLoadPercent = [double]$load } | ConvertTo-Json -Compress
`.trim();
  try {
    const data = await execPowerShellJson<SystemMemoryStatus>(script);
    if (!data || typeof data.memoryLoadPercent !== 'number') return null;
    return {
      totalPhysBytes: Number(data.totalPhysBytes) || 0,
      availPhysBytes: Number(data.availPhysBytes) || 0,
      memoryLoadPercent: Number(data.memoryLoadPercent) || 0,
    };
  } catch {
    return null;
  }
}

export async function listExaltProcesses(): Promise<{
  processes: ExaltProcessRow[];
  logicalProcessors: number;
}> {
  const check = await tuningSupported();
  if (!check.ok) return { processes: [], logicalProcessors: 0 };

  const childImg = ROTMG_EXALT_CHILD_IMAGE.replace(/'/g, "''");

  const script = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$n = [int]$env:NUMBER_OF_PROCESSORS
$pidSet = @{}
function Ensure-Pid([int]$id) {
  try { $pidSet[("{0}" -f $id)] = $true } catch {}
}

foreach ($nm in @('RotMG Exalt','RotMGExalt')) {
  foreach ($pr in @(Get-Process -Name $nm -ErrorAction SilentlyContinue)) {
    Ensure-Pid ([int]$pr.Id)
  }
}

$wmiMatches = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $xp = try { [string]$_.ExecutablePath } catch { "" }
    $rn = try { ([string]$_.Name).Replace([char]0x00A0, " ").Trim() } catch { "" }
    ($rn -ieq "RotMG Exalt.exe") -or ($rn -ieq "${childImg}") -or (
      ($xp.Length -gt 0) -and (
        ($xp -match '(?i)RealmOfTheMadGod') -or
        ($xp -match '(?i)RotMGExalt\\.exe') -or
        ($xp -match '(?i)RotMG Exalt\\.exe')
      )
    )
  })
$wmiByPid = @{}
foreach ($wk in @($wmiMatches)) {
  try {
    $pk = [int]$wk.ProcessId
    Ensure-Pid $pk
    $wmiByPid[("{0}" -f $pk)] = $wk
  } catch {}
}

foreach ($kp in @($pidSet.Keys)) {
  $ik = "{0}" -f ([int]$kp)
  if (-not $wmiByPid.ContainsKey($ik)) {
    try {
      $row = @(Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f [int]$kp) -ErrorAction SilentlyContinue)
      if (@($row).Length -gt 0) { $wmiByPid[$ik] = $row[0] }
    } catch {}
  }
}

$pids = @( foreach ($k in @($pidSet.Keys)) { [int]$k } ) | Sort-Object -Unique

$perfByPid = @{}
if (@($pids).Length -gt 0) {
  try {
    $perfRows = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -ErrorAction SilentlyContinue |
      Where-Object { $null -ne $_.IDProcess -and ($pids -contains [int]$_.IDProcess) })
    foreach ($prow in @($perfRows)) {
      $pki = [int]$prow.IDProcess
      $pct = [double]$prow.PercentProcessorTime
      if (-not ([double]::IsNaN($pct))) { $perfByPid[("{0}" -f $pki)] = [Math]::Round($pct, 1) }
    }
  } catch {}
}

$built = New-Object System.Collections.ArrayList

foreach ($procId in @($pids)) {
  $sk = "{0}" -f $procId
  $wp = $null
  if ($wmiByPid.ContainsKey($sk)) { $wp = $wmiByPid[$sk] }

  $gp = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if (($null -eq $wp) -and ($null -eq $gp)) { continue }

  $imageNameStr = ""
  if ($null -ne $wp) {
    try {
      $imageNameStr = [string]$wp.Name.Replace([char]0x00A0, " ")
    } catch {
      $imageNameStr = try { [string]$wp.Name } catch { "" }
    }
    if (($null -ne $gp) -and ([string]::IsNullOrWhiteSpace($imageNameStr))) {
      try { $imageNameStr = ($gp.ProcessName + ".exe") } catch {}
    }
  } elseif ($null -ne $gp) {
    try { $imageNameStr = ($gp.ProcessName + ".exe") } catch { $imageNameStr = "RotMG.exe" }
  }

  $ws = [int64]0
  try {
    if ($null -ne $gp) { $ws = [int64]$gp.WorkingSet64 }
    elseif ($null -ne $wp -and $null -ne $wp.WorkingSetSize) {
      try { $ws = [int64]$wp.WorkingSetSize } catch { $ws = [int64]0 }
    }
  } catch { $ws = [int64]0 }

  $basePri = 0
  $priClassStr = "Unknown"
  $affStr = "--"
  $titleStr = ""

  try {
    if ($null -ne $gp) {
      $basePri = [int]$gp.BasePriority
      $priClassStr = try { [string]$gp.PriorityClass } catch { "Unknown" }
      try { $affStr = ([string][uint64]$gp.ProcessorAffinity) } catch { $affStr = "--" }
      if (-not ([string]::IsNullOrEmpty($gp.MainWindowTitle))) { $titleStr = [string]$gp.MainWindowTitle }
    } elseif ($null -ne $wp) {
      try { $basePri = [int]$wp.Priority } catch { $basePri = 0 }
      $priClassStr = "WMI"
    }
  } catch {}

  $cpuPct = $null
  $cpuKey = "{0}" -f $procId
  if ($perfByPid.ContainsKey($cpuKey)) {
    try { $cpuPct = [double]$perfByPid[$cpuKey] } catch {}
  }

  [void]$built.Add([PSCustomObject]@{
    pid = [int]$procId
    imageName = $imageNameStr
    workingSetBytes = $ws
    basePriority = $basePri
    priorityClass = $priClassStr
    processorAffinityMask = $affStr
    cpuPercent = $cpuPct
    mainWindowTitle = $titleStr
  })
}

@{ processes = @($built | Sort-Object pid); logicalProcessors = $n } | ConvertTo-Json -Depth 6 -Compress
`.trim();

  try {
    const { out, err, code } = await execPowerShellWithErr(script, 25_000);
    const raw = out.replace(/^\uFEFF/, '').trim();
    if (!raw) {
      Logger.warn(
        'rotmgWindowsTune',
        `listExaltProcesses: empty stdout (code=${String(code)}): ${(err || '').slice(0, 600)}`,
      );
      return { processes: [], logicalProcessors: 0 };
    }
    const data = JSON.parse(raw) as {
      processes?: ExaltProcessRow | ExaltProcessRow[] | null;
      logicalProcessors?: number;
    };

    let procsArray: ExaltProcessRow[] = [];
    const pc = data?.processes;
    if (!pc) procsArray = [];
    else if (Array.isArray(pc)) procsArray = pc;
    else procsArray = [pc];

    if (procsArray.length === 0 && err) {
      Logger.warn('rotmgWindowsTune', `listExaltProcesses: 0 matches. stderr=${err.slice(0, 600)}`);
    }

    return {
      processes: procsArray,
      logicalProcessors: Number(data?.logicalProcessors) || 0,
    };
  } catch (err) {
    Logger.warn('rotmgWindowsTune', String((err as Error).message || err));
    return { processes: [], logicalProcessors: 0 };
  }
}

export async function setAllExaltPriority(
  preset: PriorityPreset,
): Promise<{ ok: boolean; error?: string; applied: number }> {
  const check = await tuningSupported();
  if (!check.ok) return { ok: false, error: check.reason, applied: 0 };

  /** Map PowerShell literals — avoids user injection (`preset` constrained by TS caller). */
  const classLit =
    preset === 'High'
      ? 'High'
      : preset === 'AboveNormal'
        ? 'AboveNormal'
        : preset === 'BelowNormal'
          ? 'BelowNormal'
          : preset === 'Idle'
            ? 'Idle'
            : 'Normal';

  const script = `
$ErrorActionPreference = 'Stop'
$class = [System.Diagnostics.ProcessPriorityClass]::${classLit}
$i = 0
Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq '${ROTMG_EXALT_IMAGE}' -or $_.Name -ieq '${ROTMG_EXALT_CHILD_IMAGE}' } | ForEach-Object {
  $proc = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
  if ($null -ne $proc) {
    try {
      $proc.PriorityClass = $class
      $i++
    } catch {}
  }
}
@{ applied = $i } | ConvertTo-Json -Compress
`.trim();

  try {
    const data = await execPowerShellJson<{ applied?: number }>(script);
    return { ok: true, applied: Number(data?.applied) || 0 };
  } catch (err) {
    return {
      ok: false,
      error: String((err as Error).message || err),
      applied: 0,
    };
  }
}

/**
 * Multibox CPU spread — less aggressive than one core per process: strategy + reserve bias,
 * optional child-only (falls back to all Realm clients if no `RotMGExalt` row).
 */
export async function spreadAffinityEven(
  opts?: SpreadAffinityOptions,
): Promise<{
  ok: boolean;
  error?: string;
  applied: Array<{ pid: number; affinityMask?: string | null }>;
}> {
  const check = await tuningSupported();
  if (!check.ok) return { ok: false, error: check.reason, applied: [] };

  const o = { ...DEFAULT_SPREAD_AFFINITY, ...opts };
  const strategy = o.strategy ?? 'spread-two-cores';
  if (strategy === 'none') return { ok: true, applied: [] };

  const reserveNum = Math.max(0, Math.floor(o.reserveLogicalCores ?? 2));
  const targetChildOnly = o.targetChildOnly !== false;
  const avoidCpuZero = o.avoidCpuZero !== false;
  const tcoLit = targetChildOnly ? '$true' : '$false';
  const avoidLit = avoidCpuZero ? '$true' : '$false';

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$strat = '${strategy}'
$res = ${String(reserveNum)}
$tcOnly = ${tcoLit}
$avoid0 = ${avoidLit}
$cpus = [int]$env:NUMBER_OF_PROCESSORS
if ($cpus -lt 1) {
  @{ ok=$false; error='NUMBER_OF_PROCESSORS missing'; applied=@() } | ConvertTo-Json -Depth 6 -Compress
  exit
}
$byId = @{}
foreach ($nm in @('RotMG Exalt','RotMGExalt')) {
  foreach ($pr in @(Get-Process -Name $nm -ErrorAction SilentlyContinue)) {
    $byId["$($pr.Id)"] = $pr
  }
}
$list = @($byId.Values | Sort-Object Id)
if ($tcOnly) {
  $only = @($list | Where-Object { $_.ProcessName -ieq 'RotMGExalt' })
  if (@($only).Length -gt 0) { $list = $only }
}
if (@($list).Length -eq 0) {
  @{ ok=$true; applied=@() } | ConvertTo-Json -Depth 6 -Compress
  exit
}
$r = @()
for ($idx = 0; $idx -lt $list.Count; $idx++) {
  $proc = $list[$idx]
  $maskLong = [UInt64]0
  if ($strat -eq 'spread-one-core') {
    $slot = (($res + $idx) % $cpus)
    if ($avoid0 -and $cpus -gt 1 -and $slot -eq 0) { $slot = 1 }
    $maskLong = [UInt64]([UInt64]1 -shl $slot)
  }
  elseif ($strat -eq 'spread-two-cores') {
    $a = ($res + 2 * $idx) % $cpus
    $b = ($res + 2 * $idx + 1) % $cpus
    if ($avoid0 -and $cpus -gt 1) {
      if ($a -eq 0) { $a = 1 }
      if ($b -eq 0) { $b = if ($cpus -gt 2) { 2 } else { 1 } }
    }
    $maskLong = ([UInt64]1 -shl $a) -bor ([UInt64]1 -shl $b)
  }
  elseif ($strat -eq 'spread-four-cores') {
    for ($k = 0; $k -lt [Math]::Min(4,$cpus); $k++) {
      $slot = (($res + 4*[int]$idx + $k) % $cpus)
      $maskLong = $maskLong -bor ([UInt64]1 -shl $slot)
    }
  }
  try {
    $proc.ProcessorAffinity = [IntPtr]$maskLong
    $r += [PSCustomObject]@{ pid = [int]$proc.Id; affinityMask = ($maskLong.ToString()) }
  } catch {
    $r += [PSCustomObject]@{ pid = [int]$proc.Id; affinityMask = $null }
  }
}
@{ ok=$true; applied=@($r) } | ConvertTo-Json -Depth 6 -Compress
`.trim();

  try {
    const data = await execPowerShellJson<{
      ok?: boolean;
      error?: string;
      applied?: { pid: number; affinityMask?: string | null }[] | {
        pid: number;
        affinityMask?: string | null;
      };
    }>(script);
    if (data?.ok === false && data?.error) {
      return { ok: false, error: String(data.error), applied: [] };
    }
    const raw = data?.applied;
    const arr = !raw ? [] : Array.isArray(raw) ? raw : [raw];
    return { ok: true, applied: arr };
  } catch (err) {
    return {
      ok: false,
      error: String((err as Error).message || err),
      applied: [],
    };
  }
}

/** Removes explicit CPU pinning: sets every Realm client process affinity to all logical processors. */
export async function resetAllExaltAffinityToAllLogicalCpus(): Promise<{
  ok: boolean;
  error?: string;
  applied?: number;
}> {
  const check = await tuningSupported();
  if (!check.ok) return { ok: false, error: check.reason, applied: 0 };

  const raw = await listExaltProcesses();
  const lp = Math.max(1, Math.floor(Number(raw.logicalProcessors) || 1));
  const mask = buildAffinityMask([...Array(lp).keys()]);
  let applied = 0;
  const seen = new Set<number>();
  const rows = raw.processes || [];
  for (const row of rows) {
    const pid = Math.floor(Number(row.pid));
    if (!(pid > 0) || seen.has(pid)) continue;
    seen.add(pid);
    const r = await setAffinityMaskForPid(pid, mask);
    if (r.ok) applied++;
  }
  return { ok: true, applied };
}

/** Foreground/Parked-aware: each cluster receives saved multibox `ROLE_RULES`/`preset` priority (not one global Idle/Hot preset). Parked clusters may minimize per rule; affinity is handled separately (`applyResolvedRolesMultiboxClusters`). */
export async function applyMultiboxRolePrioritiesFromDisk(
  options?: EnumerateRealmClusterOptions,
): Promise<{
  ok: boolean;
  error?: string;
  snapshot?: Awaited<ReturnType<typeof enumerateRealmClustersWithRoles>>;
}> {
  const check = await tuningSupported();
  if (!check.ok) return { ok: false, error: check.reason };

  const snap = await enumerateRealmClustersWithRoles(options);
  const effective = getEffectiveMultiboxRoleRules();

  for (const cl of snap.clusters) {
    const rr = effective[cl.role];
    let usePriority = rr.priority;
    if (cl.role === 'background' && isThermalBackgroundDemotionActive()) {
      usePriority = tighterIdlePreset(rr.priority, getThermalDemotePreset()) as PriorityPreset;
    }
    const pr = await setExaltPidsPriority(cl.pids, usePriority);
    if (!pr.ok) return { ok: false, error: pr.error };

    await setPidsProcessPowerExecutionEcoQos(cl.pids, multiboxRoleWantsEcoQosExecutionThrottle(cl.role));

    if (cl.role === 'parked' && rr.allowMinimize) await minimizeRealmPidCluster(cl.seedPid);
  }

  return { ok: true, snapshot: snap };
}

/** Sets `ProcessorAffinity` via decimal `UInt64` bitmask string (`buildAffinityMask` output). */
export async function setAffinityMaskForPid(
  pid: number,
  maskDecimal: string,
): Promise<{ ok: boolean; error?: string }> {
  const check = await tuningSupported();
  if (!check.ok) return { ok: false, error: check.reason };
  const tid = Math.floor(Number(pid));
  const lit = maskDecimal.trim();
  if (!(tid > 0) || !/^\d+$/.test(lit)) return { ok: false, error: 'invalid affinity input' };

  const script = `
$ErrorActionPreference = 'Continue'
$p = Get-Process -Id ${String(tid)} -ErrorAction SilentlyContinue
if ($null -eq $p) {
  @{ ok = $false; error = 'process not found' } | ConvertTo-Json -Compress
  exit 1
}
$m = [UInt64]::Parse('${lit}')
$p.ProcessorAffinity = [IntPtr]$m
@{ ok = $true } | ConvertTo-Json -Compress
`.trim();

  try {
    const data = await execPowerShellJson<{ ok?: boolean; error?: string }>(script);
    if (!data?.ok) return { ok: false, error: String(data?.error || 'affinity failed') };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error).message || err) };
  }
}

async function applyPartitionAffinitySnapshot(snap: {
  clusters: RealmClusterResolved[];
  logicalProcessors: number;
}): Promise<{ ok: boolean; error?: string }> {
  const mode = getAffinityModeForDisk();
  if (mode === 'none') return { ok: true };

  if (mode === 'globalEven') {
    const r = await spreadAffinityEven();
    return { ok: r.ok, error: r.error };
  }

  const effective = getEffectiveMultiboxRoleRules();
  const o = DEFAULT_SPREAD_AFFINITY;
  const masks = allocateAffinityMaskByRolePartition(
    snap.clusters,
    effective,
    snap.logicalProcessors,
    Math.max(0, Math.floor(o.reserveLogicalCores ?? 2)),
    o.avoidCpuZero !== false,
  );

  for (const cl of snap.clusters) {
    const mask = masks.get(cl.seedPid);
    if (!mask) continue;
    for (const pid of cl.pids) {
      await setAffinityMaskForPid(pid, mask);
    }
  }

  return { ok: true };
}

/** Recomputes bitmask placement from persisted preset + FG/parked (watchdog-friendly). */
export async function rebalanceMultiboxAffinityFromDisk(): Promise<{ ok: boolean; error?: string }> {
  const snap = await enumerateRealmClustersWithRoles();
  return applyPartitionAffinitySnapshot(snap);
}

async function getActiveSchemeGuid(): Promise<string | undefined> {
  const r = await execFileCmd([powerCfgExePath(), '/getactivescheme']);
  const m = r.stdout.match(GUID_REGEX);
  return m ? normalizePowerGuid(m[0]) ?? undefined : undefined;
}

/** Currently active Windows power scheme (GUID string), if available. */
export async function getActivePowerPlanGuid(): Promise<string | undefined> {
  return getActiveSchemeGuid();
}

/** Parse `/list` — GUIDs are usually unbraced (`xxxxxxxx-xxxx-...`); names often in `(Label)`. */
export async function listPowerPlans(): Promise<PowerPlanRow[]> {
  if (!isWin32()) return [];
  const activeFromGet = await getActiveSchemeGuid();
  const exe = powerCfgExePath();
  let r = await execFileCmd([exe, '/list']);
  const text = `${r.stdout}\n${r.stderr}`;
  let lines = text.split(/\r?\n/).map((s) => s.trim());

  if (!lines.some((l) => /guid|GUID/i.test(l) || GUID_REGEX.test(l))) {
    r = await execFileCmd(['powercfg', '/list']);
    lines = `${r.stdout}`.split(/\r?\n/).map((s) => s.trim());
  }

  const rows: PowerPlanRow[] = [];
  for (const line of lines) {
    if (!line) continue;
    const gm = line.match(GUID_REGEX);
    if (!gm) continue;
    const guidNorm = normalizePowerGuid(gm[0]);
    if (!guidNorm) continue;
    const parens = /\(([^)]+)\)/.exec(line);
    let nameRaw = parens ? parens[1].replace(/\s*\*\s*$/, '').trim() : '';
    if (!nameRaw) {
      const tail = line.slice(line.indexOf(gm[0]) + gm[0].length).trim();
      const dash = tail.replace(/^[\s\u2013\u2014-]+/, '').trim();
      nameRaw = dash.split(/\s{2,}/)[0] || '';
    }
    if (!nameRaw) nameRaw = 'Power scheme';
    const matchesActive =
      !!activeFromGet && activeFromGet.toLowerCase() === guidNorm.toLowerCase();
    const activeStar = /\(\s*\*+\s*\)\s*$/.test(line) || /\s\*\s*$/.test(line.trim());
    rows.push({ guid: guidNorm, name: nameRaw, active: matchesActive || activeStar });
  }

  /** De-dupe GUIDs keeping best label */
  const by = new Map<string, PowerPlanRow>();
  for (const row of rows) {
    const k = row.guid.toLowerCase();
    if (!by.has(k)) by.set(k, row);
  }
  return [...by.values()];
}

export async function activatePowerPlan(rawGuid: string): Promise<{ ok: boolean; error?: string }> {
  if (!isWin32()) return { ok: false, error: 'Windows only.' };
  const g = normalizePowerGuid(rawGuid);
  if (!g) return { ok: false, error: 'Invalid power scheme GUID.' };

  const r = await execFileCmd([powerCfgExePath(), '/setactive', g]);
  // Don't classify the outcome by powercfg's stderr text — its access-denied
  // message is localized by the Windows UI language, so the old "unable"/"権限"
  // check missed German/French/Spanish/etc. failures. Verify the active scheme
  // actually changed, then fall back to the exit code; both are locale-independent.
  await new Promise((x) => setTimeout(x, 120));
  const verify = await getActiveSchemeGuid();
  if (verify?.toLowerCase() === g.toLowerCase()) return { ok: true };
  if (r.code === 0) return { ok: true };
  return {
    ok: false,
    error: r.stderr.trim() || r.stdout.trim() || `powercfg exited ${r.code}`,
  };
}

/**
 * Best-effort `EmptyWorkingSet` on specific PIDs (must be same user / accessible handles).
 */
export async function emptyWorkingSetForPids(pids: number[]): Promise<{
  ok: boolean;
  applied: number;
  error?: string;
}> {
  const check = await tuningSupported();
  if (!check.ok) return { ok: false, error: check.reason, applied: 0 };

  const cleaned = [
    ...new Set(
      pids
        .map((p) => Math.floor(Number(p)))
        .filter((p) => Number.isFinite(p) && p > 0),
    ),
  ];
  if (cleaned.length === 0) return { ok: true, applied: 0 };

  const lit = cleaned.join(',');
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PsTrim2 {
  [DllImport("psapi.dll", SetLastError = true)]
  public static extern bool EmptyWorkingSet(IntPtr hProcess);
}
"@ -ErrorAction SilentlyContinue
$i = 0
foreach ($id in @(${lit})) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($null -eq $p) { continue }
  try {
    if ([PsTrim2]::EmptyWorkingSet($p.Handle)) { $i++ }
  } catch {}
}
@{ applied = $i } | ConvertTo-Json -Compress
`.trim();

  try {
    const data = await execPowerShellJson<{ applied?: number }>(script);
    return { ok: true, applied: Number(data?.applied) || 0 };
  } catch (err) {
    return {
      ok: false,
      error: String((err as Error).message || err),
      applied: 0,
    };
  }
}

/**
 * Best-effort `EmptyWorkingSet` on every RotMG Exalt process (reduces WS without exiting).
 * Windows-only; no-op-ish on failures per process.
 */
export async function emptyWorkingSetAllExalt(): Promise<{ ok: boolean; applied: number; error?: string }> {
  const check = await tuningSupported();
  if (!check.ok) return { ok: false, error: check.reason, applied: 0 };

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PsTrim {
  [DllImport("psapi.dll", SetLastError = true)]
  public static extern bool EmptyWorkingSet(IntPtr hProcess);
}
"@ -ErrorAction SilentlyContinue
$i = 0
Get-Process -Name '${ROTMG_EXALT_PROCESS_NAME}', '${ROTMG_EXALT_CHILD_PROCESS_NAME}' -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    if ([PsTrim]::EmptyWorkingSet($_.Handle)) { $i++ }
  } catch {}
}
@{ applied = $i } | ConvertTo-Json -Compress
`.trim();

  try {
    const data = await execPowerShellJson<{ applied?: number }>(script);
    return { ok: true, applied: Number(data?.applied) || 0 };
  } catch (err) {
    return {
      ok: false,
      error: String((err as Error).message || err),
      applied: 0,
    };
  }
}

function priorityPresetToClassLiteral(preset: PriorityPreset): string {
  switch (preset) {
    case 'High':
      return 'High';
    case 'AboveNormal':
      return 'AboveNormal';
    case 'BelowNormal':
      return 'BelowNormal';
    case 'Idle':
      return 'Idle';
    default:
      return 'Normal';
  }
}

/** HWND of foreground window → owning PID (`user32`). */
export async function getForegroundPid(): Promise<number | null> {
  const check = await tuningSupported();
  if (!check.ok) return null;
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WinFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$hwnd = [WinFg]::GetForegroundWindow()
$foregroundPidOut = [uint32]0
[void][WinFg]::GetWindowThreadProcessId($hwnd, [ref]$foregroundPidOut)
@{ pid = [int]$foregroundPidOut } | ConvertTo-Json -Compress
`.trim();
  try {
    const data = await execPowerShellJson<{ pid?: number }>(script);
    const n = Math.floor(Number(data?.pid ?? 0));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Launcher RotMG Exalt.exe + Unity RotMGExalt.exe that belong to one running client shell.
 */
export async function getRelatedRealmProcessIds(seedPid: number): Promise<number[]> {
  const check = await tuningSupported();
  if (!check.ok) return [];
  const sid = Math.floor(Number(seedPid));
  if (!Number.isFinite(sid) || sid <= 0) return [];
  const script = `
$id = ${String(sid)}
$ids = New-Object System.Collections.Generic.HashSet[int]
[void]$ids.Add([int]$id)
try {
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
  if ($null -ne $cim) {
    $pp = [int]$cim.ParentProcessId
    $nm = [string]$cim.Name
    if ($nm -ieq '${ROTMG_EXALT_CHILD_IMAGE}' -and $pp -gt 0) {
      [void]$ids.Add([int]$pp)
    }
    if ($pp -gt 0) {
      Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        ([int]$_.ParentProcessId) -eq $pp -and (
          $_.Name -ieq '${ROTMG_EXALT_IMAGE}' -or $_.Name -ieq '${ROTMG_EXALT_CHILD_IMAGE}')
      } | ForEach-Object {
        try { [void]$ids.Add([int]$_.ProcessId) } catch {}
      }
    }
  }
} catch {}
@($ids | Sort-Object) | ConvertTo-Json -Compress
`.trim();
  try {
    const parsed = JSON.parse((await execPowerShell(script)).replace(/^\uFEFF/, '').trim()) as unknown;
    if (!Array.isArray(parsed)) return [sid];
    const out = [...new Set(parsed.map((x) => Math.floor(Number(x))).filter((n) => n > 0))].sort(
      (a, b) => a - b,
    );
    return out.length ? out : [sid];
  } catch {
    return [sid];
  }
}

export async function setExaltPidsPriority(
  pids: number[],
  preset: PriorityPreset,
): Promise<{ ok: boolean; applied: number; error?: string }> {
  const check = await tuningSupported();
  if (!check.ok) return { ok: false, error: check.reason, applied: 0 };
  const uniq = [...new Set(pids.map((p) => Math.floor(Number(p))).filter((p) => p > 0))];
  if (uniq.length === 0) return { ok: true, applied: 0 };
  const classLit = priorityPresetToClassLiteral(preset);
  const lit = uniq.join(',');
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$class = [System.Diagnostics.ProcessPriorityClass]::${classLit}
$i = 0
foreach ($procId in @(${lit})) {
  try {
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($null -eq $proc) { continue }
    $proc.PriorityClass = $class
    $i++
  } catch {}
}
@{ applied = $i } | ConvertTo-Json -Compress
`.trim();

  try {
    const data = await execPowerShellJson<{ applied?: number }>(script);
    return { ok: true, applied: Number(data?.applied) || 0 };
  } catch (err) {
    return {
      ok: false,
      error: String((err as Error).message || err),
      applied: 0,
    };
  }
}

/**
 * `PROCESS_POWER_THROTTLING_EXECUTION_SPEED` via `SetProcessInformation` (EcoQoS-class scheduling;
 * aligns with Task Manager “Efficiency mode” class of behavior on Windows 11 — not identical to the UI flag).
 * Best-effort: failures are ignored per-PID.
 */
export async function setPidsProcessPowerExecutionEcoQos(
  pids: number[],
  ecoOn: boolean,
): Promise<{ ok: boolean; applied: number; error?: string }> {
  const check = await tuningSupported();
  if (!check.ok) return { ok: false, error: check.reason, applied: 0 };
  const uniq = [...new Set(pids.map((p) => Math.floor(Number(p))).filter((p) => p > 0))];
  if (uniq.length === 0) return { ok: true, applied: 0 };

  const ecoPs = ecoOn ? '$true' : '$false';
  const lit = uniq.join(',');

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PsRealmEcoQos {
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_POWER_THROTTLING_STATE {
    public uint Version;
    public uint ControlMask;
    public uint StateMask;
  }
  private const uint PPT_VER = 1;
  private const uint PPT_EXEC_SPEED = 0x1;
  private const int PIC_POWER_THROTTLING = 4;
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetProcessInformation(
    IntPtr hProcess,
    int processInformationClass,
    ref PROCESS_POWER_THROTTLING_STATE state,
    int size);

  public static bool SetEcoExecution(IntPtr h, bool ecoOn) {
    var s = new PROCESS_POWER_THROTTLING_STATE();
    s.Version = PPT_VER;
    s.ControlMask = PPT_EXEC_SPEED;
    s.StateMask = ecoOn ? PPT_EXEC_SPEED : 0u;
    return SetProcessInformation(h, PIC_POWER_THROTTLING, ref s,
      Marshal.SizeOf(typeof(PROCESS_POWER_THROTTLING_STATE)));
  }
}
"@
$i = 0
foreach ($procId in @(${lit})) {
  try {
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($null -eq $proc) { continue }
    if ([PsRealmEcoQos]::SetEcoExecution($proc.Handle, ${ecoPs})) { $i++ }
  } catch {}
}
@{ applied = $i } | ConvertTo-Json -Compress
`.trim();

  try {
    const data = await execPowerShellJson<{ applied?: number }>(script);
    return { ok: true, applied: Number(data?.applied) || 0 };
  } catch (err) {
    return {
      ok: false,
      error: String((err as Error).message || err),
      applied: 0,
    };
  }
}

/**
 * Clears explicit `ProcessPowerThrottling` controls so Windows can manage QoS again (MSDN “reset” example).
 */
export async function resetPidsProcessPowerThrottlingToDefault(
  pids: number[],
): Promise<{ ok: boolean; applied: number; error?: string }> {
  const check = await tuningSupported();
  if (!check.ok) return { ok: false, error: check.reason, applied: 0 };
  const uniq = [...new Set(pids.map((p) => Math.floor(Number(p))).filter((p) => p > 0))];
  if (uniq.length === 0) return { ok: true, applied: 0 };

  const lit = uniq.join(',');

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PsRealmEcoQosReset {
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_POWER_THROTTLING_STATE {
    public uint Version;
    public uint ControlMask;
    public uint StateMask;
  }
  private const uint PPT_VER = 1;
  private const int PIC_POWER_THROTTLING = 4;
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetProcessInformation(
    IntPtr hProcess,
    int processInformationClass,
    ref PROCESS_POWER_THROTTLING_STATE state,
    int size);

  public static bool ResetDefault(IntPtr h) {
    var s = new PROCESS_POWER_THROTTLING_STATE();
    s.Version = PPT_VER;
    s.ControlMask = 0;
    s.StateMask = 0;
    return SetProcessInformation(h, PIC_POWER_THROTTLING, ref s,
      Marshal.SizeOf(typeof(PROCESS_POWER_THROTTLING_STATE)));
  }
}
"@
$i = 0
foreach ($procId in @(${lit})) {
  try {
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($null -eq $proc) { continue }
    if ([PsRealmEcoQosReset]::ResetDefault($proc.Handle)) { $i++ }
  } catch {}
}
@{ applied = $i } | ConvertTo-Json -Compress
`.trim();

  try {
    const data = await execPowerShellJson<{ applied?: number }>(script);
    return { ok: true, applied: Number(data?.applied) || 0 };
  } catch (err) {
    return {
      ok: false,
      error: String((err as Error).message || err),
      applied: 0,
    };
  }
}

/**
 * Applies one logical CPU spread (slot index) to every PID — same mask for launcher + Unity.
 */
export async function applyAffinityStrategyToClusterPids(
  pids: number[],
  strategy: AffinityStrategy,
  slotIndex: number,
  opts?: Pick<SpreadAffinityOptions, 'reserveLogicalCores' | 'avoidCpuZero'>,
): Promise<{ ok: boolean; applied: number; error?: string }> {
  const check = await tuningSupported();
  if (!check.ok) return { ok: false, error: check.reason, applied: 0 };
  if (strategy === 'none') return { ok: true, applied: 0 };
  const uniq = [...new Set(pids.map((p) => Math.floor(Number(p))).filter((p) => p > 0))];
  if (uniq.length === 0) return { ok: true, applied: 0 };
  const reserveNum = Math.max(
    0,
    Math.floor(
      opts?.reserveLogicalCores ?? DEFAULT_SPREAD_AFFINITY.reserveLogicalCores ?? 2,
    ),
  );
  const avoidCpuZero = opts?.avoidCpuZero !== false;
  const pidLit = uniq.join(',');
  const sidIdx = Math.max(0, Math.floor(Number(slotIndex)) || 0);
  const strategyEsc = String(strategy).replace(/'/g, "''");
  const avoidLit = avoidCpuZero ? '$true' : '$false';

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$pidsArr = @( ${pidLit} )
$strat = '${strategyEsc}'
$slotIdx = ${String(sidIdx)}
$res = ${String(reserveNum)}
$avoid0 = ${avoidLit}
$cpus = [int]$env:NUMBER_OF_PROCESSORS
if ($cpus -lt 1) {
  @{ ok=$false; error='NUMBER_OF_PROCESSORS missing'; applied=0 } | ConvertTo-Json -Compress
  exit
}
$maskLong = [UInt64]0
if ($strat -eq 'spread-one-core') {
  $slot = (($res + $slotIdx) % $cpus)
  if ($avoid0 -and $cpus -gt 1 -and $slot -eq 0) { $slot = 1 }
  $maskLong = [UInt64]([UInt64]1 -shl $slot)
}
elseif ($strat -eq 'spread-two-cores') {
  $a = ($res + 2 * $slotIdx) % $cpus
  $b = ($res + 2 * $slotIdx + 1) % $cpus
  if ($avoid0 -and $cpus -gt 1) {
    if ($a -eq 0) { $a = 1 }
    if ($b -eq 0) { $b = if ($cpus -gt 2) { 2 } else { 1 } }
  }
  $maskLong = ([UInt64]1 -shl $a) -bor ([UInt64]1 -shl $b)
}
elseif ($strat -eq 'spread-four-cores') {
  for ($k = 0; $k -lt [Math]::Min(4,$cpus); $k++) {
    $slot = (($res + 4*[int]$slotIdx + $k) % $cpus)
    $maskLong = $maskLong -bor ([UInt64]1 -shl $slot)
  }
}
else {
  @{ ok=$true; applied=0 } | ConvertTo-Json -Compress
  exit
}
$a = 0
foreach ($procId in $pidsArr) {
  try {
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($null -eq $proc) { continue }
    $proc.ProcessorAffinity = [IntPtr]$maskLong
    $a++
  } catch {}
}
@{ ok=$true; applied=$a } | ConvertTo-Json -Compress
`.trim();

  try {
    const data = await execPowerShellJson<{ ok?: boolean; error?: string; applied?: number }>(script);
    if (data?.ok === false && data?.error) {
      return { ok: false, error: String(data.error), applied: 0 };
    }
    return { ok: true, applied: Number(data?.applied) || 0 };
  } catch (err) {
    return {
      ok: false,
      error: String((err as Error).message || err),
      applied: 0,
    };
  }
}

type WinShowCmd = 'minimize' | 'restore';

async function realmMainWindowOp(
  pids: number[],
  cmd: WinShowCmd,
): Promise<{ ok: boolean; error?: string; done: boolean }> {
  const check = await tuningSupported();
  if (!check.ok) return { ok: false, error: check.reason, done: false };
  if (!pids.length) return { ok: true, done: false };
  const uniq = [...new Set(pids.map((p) => Math.floor(Number(p))).filter((p) => p > 0))];
  const pidLit = uniq.join(',');
  const show = cmd === 'minimize' ? 6 : 9;

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WinShow {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$n = ${String(show)}
$done = $false
foreach ($procId in @(${pidLit})) {
  try {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($null -eq $p) { continue }
    $hwnd = $p.MainWindowHandle
    if ($hwnd -eq [IntPtr]::Zero -or [int]$hwnd -eq 0) { continue }
    if ([WinShow]::ShowWindow($hwnd, $n)) { $done = $true }
  } catch {}
}
@{ ok = $done } | ConvertTo-Json -Compress
`.trim();

  try {
    const data = await execPowerShellJson<{ ok?: boolean }>(script);
    return { ok: true, done: !!data?.ok };
  } catch (err) {
    return {
      ok: false,
      error: String((err as Error).message || err),
      done: false,
    };
  }
}

/** Best-effort focus Realm main window (`SetForegroundWindow`). */
export async function bringRealmPidMainWindowForeground(pid: number): Promise<{ ok: boolean; error?: string }> {
  const check = await tuningSupported();
  if (!check.ok) return { ok: false, error: check.reason };
  const target = Math.floor(Number(pid));
  if (!Number.isFinite(target) || target <= 0) return { ok: false, error: 'invalid pid' };
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WinFg2 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
$target = ${String(target)}
$ok = $false
try {
  $p = Get-Process -Id $target -ErrorAction SilentlyContinue
  if ($null -ne $p) {
    $hwnd = $p.MainWindowHandle
    if ($hwnd -ne [IntPtr]::Zero -and [int]$hwnd -ne 0) {
      $ok = [WinFg2]::SetForegroundWindow($hwnd)
    }
  }
} catch {}
@{ ok = $ok } | ConvertTo-Json -Compress
`.trim();
  try {
    const data = await execPowerShellJson<{ ok?: boolean }>(script);
    return { ok: !!data?.ok };
  } catch (err) {
    return {
      ok: false,
      error: String((err as Error).message || err),
    };
  }
}

export type MoveRotmgAfterSpawnOpts = {
  /** Login email for this launch — used to match `Win32_Process.CommandLine` when the launcher PID tree breaks */
  email?: string;
  /** ISO time just before spawn — prefer Unity processes started after this */
  launchedAtIso?: string;
};

function buildEmailCommandLineMarker(email: string): string {
  const t = String(email || '').trim();
  if (!t) return '';
  const b = Buffer.from(t, 'utf8').toString('base64');
  return b.slice(0, Math.min(48, b.length));
}

/**
 * After `RotMG Exalt.exe` starts with a token line, Unity often ignores `-screen-x`/`-screen-y`.
 * Finds the real game HWND (EnumWindows largest visible per PID — MainWindowHandle is often wrong),
 * and falls back to matching `RotMGExalt` by command line / launch time when the launcher exits early.
 */
export async function moveRotmgLaunchedWindowAfterSpawn(
  launcherPid: number,
  rect: { x: number; y: number; width: number; height: number },
  opts?: MoveRotmgAfterSpawnOpts,
): Promise<{ ok: boolean; debug?: string }> {
  if (!isWin32()) return { ok: false, debug: 'not win32' };
  const seed = Math.floor(Number(launcherPid));
  if (!Number.isFinite(seed) || seed <= 0) return { ok: false, debug: 'invalid seed pid' };

  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  const cw = Math.max(200, Math.round(rect.width));
  const ch = Math.max(150, Math.round(rect.height));
  const marker = buildEmailCommandLineMarker(opts?.email ?? '');
  const launchIso = String(opts?.launchedAtIso ?? '').trim();
  const markerLit = marker.replace(/'/g, "''");
  const launchIsoLit = launchIso.replace(/'/g, "''");

  const maxAttempts = 120;
  const pauseMs = 250;
  /** Refreshed every 8th attempt via {@link findRotmgUnityPidForLauncher}. */
  let cachedUnityPid = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt % 8 === 0) {
      try {
        const u = await findRotmgUnityPidForLauncher(launcherPid);
        if (u != null && u > 0) cachedUnityPid = u;
      } catch {
        /* keep prior hint */
      }
    }
    const unityHint = Math.floor(cachedUnityPid);

    const script = `
$ErrorActionPreference = 'SilentlyContinue'
$seed = ${String(seed)}
$unityHint = ${String(unityHint)}
$x = ${String(x)}
$y = ${String(y)}
$cw = ${String(cw)}
$ch = ${String(ch)}
$marker = '${markerLit}'
$launchIso = '${launchIsoLit}'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WinMv {
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
  public delegate bool EnumDelegate(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumDelegate lpfn, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  static IntPtr _bestHwnd;
  static int _bestArea;
  static int _targetPid;
  static EnumDelegate _enumCb;
  static int Area(ref RECT r) { return Math.Max(0, r.Right - r.Left) * Math.Max(0, r.Bottom - r.Top); }
  static bool EnumProc(IntPtr hwnd, IntPtr lp) {
    if (!IsWindowVisible(hwnd)) return true;
    uint wp = 0;
    GetWindowThreadProcessId(hwnd, out wp);
    if ((int)wp != _targetPid) return true;
    RECT rr;
    if (!GetWindowRect(hwnd, out rr)) return true;
    int a = Area(ref rr);
    if (a > _bestArea && a >= 4000) { _bestArea = a; _bestHwnd = hwnd; }
    return true;
  }
  public static IntPtr BestVisibleTopHwndForPid(int want) {
    _bestHwnd = IntPtr.Zero;
    _bestArea = 0;
    _targetPid = want;
    _enumCb = new EnumDelegate(EnumProc);
    EnumWindows(_enumCb, IntPtr.Zero);
    return _bestHwnd;
  }
}
"@
function Try-Move([IntPtr]$hwnd) {
  if ($hwnd -eq [IntPtr]::Zero -or [int]$hwnd -eq 0) { return $false }
  $u = [uint32](0x0004 -bor 0x0040)
  if ([WinMv]::SetWindowPos($hwnd, [IntPtr]::Zero, $x, $y, $cw, $ch, $u)) { return $true }
  return [WinMv]::MoveWindow($hwnd, $x, $y, $cw, $ch, $true)
}
function Try-Pid([int]$tpid) {
  try {
    $gp = Get-Process -Id $tpid -EA SilentlyContinue
    if ($null -eq $gp) { return $false }
    $main = $gp.MainWindowHandle
    if ($main -ne [IntPtr]::Zero -and [int]$main -ne 0) {
      if (Try-Move $main) { return $true }
    }
  } catch {}
  try {
    $best = [WinMv]::BestVisibleTopHwndForPid($tpid)
    if ($best -ne [IntPtr]::Zero -and [int]$best -ne 0) {
      if (Try-Move $best) { return $true }
    }
  } catch {}
  return $false
}
$candidatePids = New-Object System.Collections.Generic.List[int]
$tryOrder = New-Object System.Collections.Generic.List[int]
$all = @(Get-CimInstance Win32_Process -EA SilentlyContinue)
$seen = New-Object System.Collections.Generic.HashSet[int]
$queue = New-Object System.Collections.Queue
if ($null -ne (Get-Process -Id $seed -EA SilentlyContinue)) { [void]$queue.Enqueue([int]$seed) }
while ($queue.Count -gt 0) {
  $pid = [int]$queue.Dequeue()
  if (-not $seen.Add($pid)) { continue }
  $row = @($all | Where-Object { [int]$_.ProcessId -eq $pid }) | Select-Object -First 1
  if ($null -eq $row) { continue }
  $nm = [string]$row.Name
  if ($nm -like '*RotMG*') { [void]$candidatePids.Add([int]$pid) }
  foreach ($ch in @($all | Where-Object { [int]$_.ParentProcessId -eq $pid })) {
    try { [void]$queue.Enqueue([int]$ch.ProcessId) } catch {}
  }
}
if ($marker.Length -gt 4) {
  foreach ($pr in @($all)) {
    try {
      $cn = [string]$pr.CommandLine
      if ($cn.Length -lt 24) { continue }
      if ($cn -like ('*' + $marker + '*')) {
        $pidm = [int]$pr.ProcessId
        [void]$candidatePids.Add($pidm)
        if (-not $tryOrder.Contains($pidm)) { [void]$tryOrder.Insert(0, $pidm) }
      }
    } catch {}
  }
}
$cutoff = $null
try {
  if ($launchIso.Length -gt 10) { $cutoff = [DateTimeOffset]::Parse($launchIso).LocalDateTime.AddSeconds(-3) }
} catch {}
if ($null -ne $cutoff) {
  foreach ($nm in @('RotMGExalt','RotMG Exalt')) {
    foreach ($gp in @(Get-Process -Name $nm -EA SilentlyContinue)) {
      try {
        $st = $gp.StartTime
        if ($null -ne $st -and $st -ge $cutoff) {
          [void]$candidatePids.Add([int]$gp.Id)
        }
      } catch {}
    }
  }
}
$recentCutoff = (Get-Date).AddSeconds(-45)
foreach ($nm in @('RotMGExalt','RotMG Exalt')) {
  foreach ($gp in @(Get-Process -Name $nm -EA SilentlyContinue)) {
    try {
      $st = $gp.StartTime
      if ($null -ne $st -and $st -ge $recentCutoff) {
        $pidr = [int]$gp.Id
        [void]$candidatePids.Add($pidr)
        if (-not $tryOrder.Contains($pidr)) { [void]$tryOrder.Add($pidr) }
      }
    } catch {}
  }
}
foreach ($p in $candidatePids) {
  if (-not $tryOrder.Contains($p)) { [void]$tryOrder.Add($p) }
}
if ($unityHint -gt 0) {
  $ih = [int]$unityHint
  if ($tryOrder.Contains($ih)) { [void]$tryOrder.Remove($ih) }
  [void]$tryOrder.Insert(0, $ih)
}
foreach ($tpid in $tryOrder) {
  if ($tpid -le 0) { continue }
  if (Try-Pid $tpid) {
    @{ moved = $true; seed = $seed; unityHint = $unityHint } | ConvertTo-Json -Compress
    exit 0
  }
}
@{ moved = $false; seed = $seed; unityHint = $unityHint; markerLength = $marker.Length; launchIso = $launchIso; candidatePids = @($candidatePids); tryOrder = @($tryOrder) } | ConvertTo-Json -Depth 6 -Compress
`.trim();

    try {
      const data = await execPowerShellJson<{
        moved?: boolean;
        seed?: number;
        unityHint?: number;
        markerLength?: number;
        launchIso?: string;
        candidatePids?: number[];
        tryOrder?: number[];
      }>(script, 18_000);
      if (data?.moved) return { ok: true };
      const dbg = JSON.stringify(data ?? {}).slice(0, 1200);
      if (attempt % 20 === 0) {
        Logger.warn('rotmgWindowsTune', `moveRotmgLaunchedWindowAfterSpawn attempt ${attempt}: ${dbg.slice(0, 800)}`);
      }
      if (attempt === maxAttempts - 1) {
        return { ok: false, debug: dbg };
      }
    } catch (err) {
      const msg = String((err as Error).message || err);
      if (attempt % 20 === 0) {
        Logger.warn('rotmgWindowsTune', `moveRotmgLaunchedWindowAfterSpawn attempt ${attempt} PS error: ${msg.slice(0, 400)}`);
      }
      if (attempt === maxAttempts - 1) {
        return { ok: false, debug: `ps_error:${msg.slice(0, 600)}` };
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pauseMs));
  }

  return { ok: false, debug: 'exhausted attempts' };
}

/**
 * First direct child of the launcher whose image looks like the Unity player (`RotMGExalt.exe`).
 * Polls briefly — child may appear after the launcher starts.
 */
export async function findRotmgUnityPidForLauncher(launcherPid: number): Promise<number | null> {
  if (!isWin32()) return null;
  const seed = Math.floor(Number(launcherPid));
  if (!Number.isFinite(seed) || seed <= 0) return null;

  const maxAttempts = 46;
  const pauseMs = 200;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
$lp = ${String(seed)}
$rows = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { [int]$_.ParentProcessId -eq $lp })
$unity = $null
foreach ($r in $rows) {
  $nm = [string]$r.Name
  if ($nm -like '*RotMGExalt*') {
    $unity = [int]$r.ProcessId
    break
  }
}
if ($null -ne $unity) {
  @{ pid = $unity } | ConvertTo-Json -Compress
} else {
  @{ pid = $null } | ConvertTo-Json -Compress
}
`.trim();

    try {
      const data = await execPowerShellJson<{ pid?: number | null }>(script, 8000);
      const p = Math.floor(Number(data?.pid));
      if (Number.isFinite(p) && p > 0) return p;
    } catch {
      /* Unity may not exist yet */
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pauseMs));
  }

  return null;
}

export async function minimizeRealmPidCluster(seedPid: number): Promise<{ ok: boolean; done: boolean; error?: string }> {
  const rel = await getRelatedRealmProcessIds(seedPid);
  const r = await realmMainWindowOp(rel, 'minimize');
  return { ok: r.ok, done: r.done, error: r.error };
}

export async function resizeRestoreRealmPidCluster(seedPid: number): Promise<{ ok: boolean; done: boolean; error?: string }> {
  const rel = await getRelatedRealmProcessIds(seedPid);
  const r = await realmMainWindowOp(rel, 'restore');
  return { ok: r.ok, done: r.done, error: r.error };
}

/** Applies preset role priority + partitioned affinity (presets + FG/parked). */
export async function applyClientRoleRuleToSeedPid(
  seedPid: number,
  role: ClientRole,
  _slotUnused = 0,
): Promise<{ ok: boolean; error?: string; pids: number[] }> {
  const check = await tuningSupported();
  if (!check.ok) return { ok: false, error: check.reason, pids: [] };

  const effective = getEffectiveMultiboxRoleRules();
  const rule = effective[role];
  let usePrio = rule.priority;
  if (role === 'background' && isThermalBackgroundDemotionActive()) {
    usePrio = tighterIdlePreset(rule.priority, getThermalDemotePreset()) as PriorityPreset;
  }
  const pids = await getRelatedRealmProcessIds(seedPid);
  const pr = await setExaltPidsPriority(pids, usePrio);
  if (!pr.ok) return { ok: false, error: pr.error, pids };

  await setPidsProcessPowerExecutionEcoQos(pids, multiboxRoleWantsEcoQosExecutionThrottle(role));

  if (role === 'parked' && rule.allowMinimize) {
    await minimizeRealmPidCluster(seedPid);
  }

  const snap = await enumerateRealmClustersWithRoles();
  const pa = await applyPartitionAffinitySnapshot(snap);
  return {
    ok: pa.ok !== false,
    pids,
    error: pa.error,
  };
}

/**
 * Applies role priority + affinity placement for every detected launcher/Unity cluster (FG + parked).
 */
export async function applyResolvedRolesMultiboxClusters(
  foregroundPid: number | null,
  parked: Set<number>,
): Promise<{
  ok: boolean;
  error?: string;
  slots: Array<{ seedPid: number; pids: number[]; role: ClientRole }>;
}> {
  const check = await tuningSupported();
  if (!check.ok) return { ok: false, error: check.reason, slots: [] };

  await import('./exaltProcessBaseline.js').then((m) => m.ensureProcessBaselineCapturedOnce());

  const prio = await applyMultiboxRolePrioritiesFromDisk({
    foregroundPid,
    parkedPids: parked,
  });
  if (!prio.ok || !prio.snapshot) return { ok: false, error: prio.error, slots: [] };

  const snap = prio.snapshot;
  const slots = snap.clusters.map((c) => ({
    seedPid: c.seedPid,
    pids: c.pids,
    role: c.role,
  }));

  const pa = await applyPartitionAffinitySnapshot(snap);
  return { ok: pa.ok !== false, error: pa.error, slots };
}

/** Best-effort ACPI max package temp + CPU min `% of Maximum Frequency` (Perf counter). */
export type WindowsThermalSample = {
  pkgMaxCelsius: number | null;
  /** Minimum across `% of Maximum Frequency` samples — low values imply clock cap / throttling. */
  minFreqPctOfMax: number | null;
};

/** Samples WMI `root\wmi MSAcpi_ThermalZoneTemperature` + perf `\Processor Information\% of Maximum Frequency`. */
export async function sampleWindowsThermalSignals(): Promise<WindowsThermalSample> {
  const check = await tuningSupported();
  if (!check.ok) return { pkgMaxCelsius: null, minFreqPctOfMax: null };

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$pkg = $null
$freqMin = $null

try {
  $zs = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue
  if ($null -ne $zs) {
    $temps = [System.Collections.Generic.List[double]]::new()
    foreach ($z in @($zs)) {
      try {
        $tc = [double]$z.CurrentTemperature
        $k = $tc / 10.0
        $c = $k - 273.15
        if ([double]::IsFinite($c) -and $c -gt -40 -and $c -lt 200) { [void]$temps.Add($c) }
      } catch {}
    }
    if ($temps.Count -gt 0) { $pkg = [double](($temps | Measure-Object -Maximum).Maximum) }
  }
} catch {}

try {
  $cat = '\\Processor Information(_Total)\\% of Maximum Frequency'
  $sx = Get-Counter $cat -ErrorAction Stop
  if ($sx.CounterSamples.Count -gt 0) {
    $freqMin = [double]$sx.CounterSamples[0].CookedValue
  }
} catch {}
if ($null -eq $freqMin -or [double]::IsNaN([double]$freqMin)) {
  try {
    $cats = '\\Processor Information(*)\\% of Maximum Frequency'
    $sx = Get-Counter $cats -ErrorAction Stop
    if ($sx.CounterSamples.Count -gt 0) {
      $vals = foreach ($cs in @($sx.CounterSamples)) {
        try { [double]$cs.CookedValue } catch { $null }
      }
      $valsOk = @( $vals | Where-Object { $_ -ne $null -and $_ -gt 0 -and $_ -lt 250 } )
      if ($valsOk.Count -gt 0) { $freqMin = [double](($valsOk | Measure-Object -Minimum).Minimum) }
    }
  } catch {}
}

@{ pkgMaxCelsius = $pkg; minFreqPctOfMax = $freqMin } | ConvertTo-Json -Compress
`.trim();

  try {
    const data = await execPowerShellJson<{
      pkgMaxCelsius?: number | null;
      minFreqPctOfMax?: number | null;
    }>(script);
    const toNum = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null;
    return {
      pkgMaxCelsius: toNum(data?.pkgMaxCelsius),
      minFreqPctOfMax: toNum(data?.minFreqPctOfMax),
    };
  } catch {
    return { pkgMaxCelsius: null, minFreqPctOfMax: null };
  }
}
