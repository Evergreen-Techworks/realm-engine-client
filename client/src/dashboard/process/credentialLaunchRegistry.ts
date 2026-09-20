/**
 * Authoritative mapping from RotMG credential launches (dashboard → spawn) to OS PIDs.
 * Unity.exe does not encode account id; we record it at launch time.
 *
 * In-memory indexes: per–launcher-PID rows, Unity PID alias, plus “latest launch” per account id and per email.
 */
import { Logger } from '../../util/Logger.js';
import { findRotmgUnityPidForLauncher } from './rotmgWindowsClientTune.js';

export type CredentialLaunchRecord = {
  /** Dashboard saved-account id when provided by the client */
  accountId: string | null;
  /** Dashboard display name when provided (for correlation without loading accounts file) */
  accountLabel: string | null;
  /** Normalized email from the launch request (correlation / debugging) */
  emailNormalized: string;
  pidLauncher: number;
  pidUnity: number | null;
  launchedAtMs: number;
};

const byLauncherPid = new Map<number, CredentialLaunchRecord>();
const byUnityPid = new Map<number, CredentialLaunchRecord>();
/** Latest row per dashboard account id (updated on each launch with that id). */
const latestByAccountId = new Map<string, CredentialLaunchRecord>();
/** Latest row per normalized email. */
const latestByEmailNormalized = new Map<string, CredentialLaunchRecord>();
/** Latest row per normalized display label — the only handle a caller that
 *  never sees credentials (e.g. an automated launch by label) can look up by. */
const latestByLabelNormalized = new Map<string, CredentialLaunchRecord>();

function normalizeEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}

function normalizeLabel(label: string): string {
  return String(label || '').trim().toLowerCase();
}

/**
 * Call immediately after a successful `spawn` of `RotMG Exalt.exe` with credential args.
 * On Windows, resolves Unity child PID asynchronously when it appears.
 */
export function registerCredentialLaunch(params: {
  launcherPid: number;
  accountId: string | null | undefined;
  email: string;
  /** Dashboard UI label for the account — optional */
  accountLabel?: string | null;
}): void {
  const launcherPid = Math.floor(Number(params.launcherPid));
  if (!Number.isFinite(launcherPid) || launcherPid <= 0) return;

  const accountId =
    typeof params.accountId === 'string' && params.accountId.trim() !== ''
      ? params.accountId.trim()
      : null;
  const accountLabel =
    typeof params.accountLabel === 'string' && params.accountLabel.trim() !== ''
      ? params.accountLabel.trim()
      : null;
  const emailNormalized = normalizeEmail(params.email);

  const rec: CredentialLaunchRecord = {
    accountId,
    accountLabel,
    emailNormalized,
    pidLauncher: launcherPid,
    pidUnity: null,
    launchedAtMs: Date.now(),
  };
  byLauncherPid.set(launcherPid, rec);
  latestByEmailNormalized.set(emailNormalized, rec);
  if (accountId) latestByAccountId.set(accountId, rec);
  if (accountLabel) latestByLabelNormalized.set(normalizeLabel(accountLabel), rec);

  Logger.log(
    'CredentialLaunch',
    `Registered launcher PID ${launcherPid}${accountId ? ` → account ${accountId}` : ''}${accountLabel ? ` "${accountLabel}"` : ''}${emailNormalized ? ` (${emailNormalized})` : ''}`,
  );

  void resolveUnityPidWhenReady(launcherPid);
}

async function resolveUnityPidWhenReady(launcherPid: number): Promise<void> {
  const unityPid = await findRotmgUnityPidForLauncher(launcherPid);
  if (unityPid == null || unityPid <= 0) return;

  const rec = byLauncherPid.get(launcherPid);
  if (!rec) return;

  if (rec.pidUnity != null && rec.pidUnity !== unityPid) {
    byUnityPid.delete(rec.pidUnity);
  }
  rec.pidUnity = unityPid;
  byUnityPid.set(unityPid, rec);

  Logger.log(
    'CredentialLaunch',
    `Bound Unity PID ${unityPid} to launcher ${launcherPid}${rec.accountId ? ` (account ${rec.accountId})` : ''}`,
  );
}

export function getCredentialLaunchByLauncherPid(pid: number): CredentialLaunchRecord | undefined {
  const n = Math.floor(Number(pid));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return byLauncherPid.get(n);
}

export function getCredentialLaunchByUnityPid(pid: number): CredentialLaunchRecord | undefined {
  const n = Math.floor(Number(pid));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return byUnityPid.get(n);
}

/** Most recent launch row for a dashboard account id, if any. */
export function getLatestCredentialLaunchByAccountId(accountId: string): CredentialLaunchRecord | undefined {
  const id = String(accountId || '').trim();
  if (!id) return undefined;
  return latestByAccountId.get(id);
}

/** Most recent launch row for an email (normalized like login). */
export function getLatestCredentialLaunchByEmail(email: string): CredentialLaunchRecord | undefined {
  return latestByEmailNormalized.get(normalizeEmail(email));
}

/** Most recent launch row for a dashboard display label (case/whitespace-insensitive). */
export function getLatestCredentialLaunchByAccountLabel(label: string): CredentialLaunchRecord | undefined {
  const l = normalizeLabel(label);
  if (!l) return undefined;
  return latestByLabelNormalized.get(l);
}

/** Read-only copy of the “latest per account id” index (for tooling). */
export function snapshotLatestCredentialLaunchByAccountId(): ReadonlyMap<string, CredentialLaunchRecord> {
  return new Map(latestByAccountId);
}

/** Read-only copy of the “latest per email” index. */
export function snapshotLatestCredentialLaunchByEmail(): ReadonlyMap<string, CredentialLaunchRecord> {
  return new Map(latestByEmailNormalized);
}

/**
 * All spawn rows still tracked by launcher PID, newest first.
 * Use this as the in-memory PID ↔ account table for diagnostics or future features.
 */
export function listCredentialLaunchRecords(): CredentialLaunchRecord[] {
  return Array.from(byLauncherPid.values()).sort((a, b) => b.launchedAtMs - a.launchedAtMs);
}

/** Alias for {@link listCredentialLaunchRecords} — explicit name for PID/account correlation tables. */
export function getCredentialPidAccountTable(): CredentialLaunchRecord[] {
  return listCredentialLaunchRecords();
}
