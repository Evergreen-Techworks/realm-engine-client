import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../util/Logger.js', () => ({
  Logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const credentialRegistry = vi.hoisted(() => ({
  getLatestCredentialLaunchByAccountLabel: vi.fn(() => undefined as { pidLauncher: number } | undefined),
}));
vi.mock('../../process/credentialLaunchRegistry.js', () => ({
  registerCredentialLaunch: vi.fn(),
  getLatestCredentialLaunchByAccountLabel: credentialRegistry.getLatestCredentialLaunchByAccountLabel,
}));

/**
 * This test constructs a real DevServer (as DevServer.loopback.test.ts does)
 * against a temp profile so `readDashboardAccounts()` reads real seeded JSON,
 * but replaces `GameLauncher.prototype.launchGameWithCredentials` with a spy
 * so no process is ever actually spawned — verifying only that
 * `launchSavedAccountByLabel` finds the right account, passes the right
 * fields through (including the Steam guid/secret overload), and never
 * exposes credentials in its own return value.
 */
describe('DevServer.launchSavedAccountByLabel', () => {
  const savedEnv = { USERPROFILE: process.env.USERPROFILE, REALM_ENGINE_USER_CONFIG_PATH: process.env.REALM_ENGINE_USER_CONFIG_PATH };
  let profile: string;
  let devServer: InstanceType<typeof import('../DevServer.js').DevServer>;
  let launchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    profile = mkdtempSync(join(tmpdir(), 're-launch-by-label-'));
    process.env.USERPROFILE = profile;
    process.env.REALM_ENGINE_USER_CONFIG_PATH = join(profile, 'config.json');

    const accountsDir = join(profile, 'Documents', 'Realmengine');
    mkdirSync(accountsDir, { recursive: true });
    writeFileSync(
      join(accountsDir, '_accounts.json'),
      JSON.stringify({
        accounts: [
          { id: 'a1', label: 'lab-1', email: 'lab1@example.com', password: 'hunter2', serverName: 'USEast' },
          { id: 'a2', label: 'Steam One', email: 'steamworks:guid', password: 'steam-secret', serverName: 'USWest', isSteam: true, steamId: '765000000000001' },
        ],
      }),
    );

    credentialRegistry.getLatestCredentialLaunchByAccountLabel.mockReset().mockReturnValue({ pidLauncher: 4242 });

    const { DevServer } = await import('../DevServer.js');
    const { PacketInspector } = await import('../PacketInspector.js');
    const { PluginManager } = await import('../../../plugins/PluginManager.js');
    const { GameLauncher } = await import('../GameLauncher.js');

    launchSpy = vi.spyOn(GameLauncher.prototype, 'launchGameWithCredentials').mockResolvedValue({ ok: true });

    const pluginManager = new PluginManager({} as any, join(profile, 'plugins'), join(profile, 'Plugins'));
    devServer = new DevServer(new PacketInspector(), pluginManager, join(profile, 'public'));
  });

  afterEach(() => {
    launchSpy.mockRestore();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(profile, { recursive: true, force: true });
  });

  it('finds the account by label (case/whitespace-insensitive) and launches it, returning the pid, never credentials', async () => {
    const result = await devServer.launchSavedAccountByLabel('  LAB-1  ');
    expect(result).toEqual({ ok: true, pid: 4242 });
    expect(launchSpy).toHaveBeenCalledTimes(1);
    const [email, password, serverName, opts] = launchSpy.mock.calls[0];
    expect(email).toBe('lab1@example.com');
    expect(password).toBe('hunter2');
    expect(serverName).toBe('USEast');
    expect(opts).toMatchObject({ accountId: 'a1', accountLabel: 'lab-1', isSteam: false });
    // The method's own return value never carries credentials.
    expect(JSON.stringify(result)).not.toMatch(/hunter2|lab1@example\.com/);
  });

  it('an explicit serverName overrides the saved account default', async () => {
    await devServer.launchSavedAccountByLabel('lab-1', 'Europe');
    const [, , serverName] = launchSpy.mock.calls[0];
    expect(serverName).toBe('Europe');
  });

  it('supports a Steam account: email/password fields double as guid/secret, isSteam+steamId passed through', async () => {
    const result = await devServer.launchSavedAccountByLabel('Steam One');
    expect(result.ok).toBe(true);
    const [guid, secret, serverName, opts] = launchSpy.mock.calls[0];
    expect(guid).toBe('steamworks:guid');
    expect(secret).toBe('steam-secret');
    expect(serverName).toBe('USWest');
    expect(opts).toMatchObject({ isSteam: true, steamId: '765000000000001' });
  });

  it('returns account-not-found for an unknown label without calling the launcher at all, with counts only', async () => {
    const result = await devServer.launchSavedAccountByLabel('nobody');
    expect(result).toEqual({ ok: false, error: 'account-not-found', matchCount: 0, totalAccounts: 2 });
    expect(launchSpy).not.toHaveBeenCalled();
    // Never leaks a real saved label or e-mail.
    expect(JSON.stringify(result)).not.toMatch(/lab-1|lab1@example\.com|Steam One/);
  });

  it('returns account-not-found for a blank label', async () => {
    const result = await devServer.launchSavedAccountByLabel('   ');
    expect(result).toEqual({ ok: false, error: 'account-not-found', matchCount: 0, totalAccounts: 2 });
    expect(launchSpy).not.toHaveBeenCalled();
  });

  it('matches ignoring case, whitespace, "-" and "_" interchangeably', async () => {
    for (const candidate of ['Lab_1', 'LAB1', 'Lab 1', 'lab_1', 'L A B - 1']) {
      launchSpy.mockClear();
      const result = await devServer.launchSavedAccountByLabel(candidate);
      expect(result.ok).toBe(true);
      expect(launchSpy).toHaveBeenCalledTimes(1);
    }
  });

  it('returns account-ambiguous (never guessing) when more than one saved account normalizes to the same label', async () => {
    const accountsDir = join(profile, 'Documents', 'Realmengine');
    writeFileSync(
      join(accountsDir, '_accounts.json'),
      JSON.stringify({
        accounts: [
          { id: 'a1', label: 'lab-1', email: 'lab1@example.com', password: 'hunter2', serverName: 'USEast' },
          { id: 'a2', label: 'Steam One', email: 'steamworks:guid', password: 'steam-secret', serverName: 'USWest', isSteam: true, steamId: '765000000000001' },
          { id: 'a3', label: 'twin-1', email: 'twin1@example.com', password: 'p1', serverName: 'USEast' },
          { id: 'a4', label: 'Twin_1', email: 'twin1b@example.com', password: 'p2', serverName: 'USEast' },
        ],
      }),
    );
    const result = await devServer.launchSavedAccountByLabel('Twin 1');
    expect(result).toEqual({ ok: false, error: 'account-ambiguous', matchCount: 2, totalAccounts: 4 });
    expect(launchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/twin1@example\.com|twin1b@example\.com|twin-1|Twin_1/);
  });

  it('maps a launcher failure to the generic launch-failed error, not the launcher-specific message', async () => {
    launchSpy.mockResolvedValue({ ok: false, error: 'RotMG Exalt.exe not found at: C:\\bogus' });
    const result = await devServer.launchSavedAccountByLabel('lab-1');
    expect(result).toEqual({ ok: false, error: 'launch-failed' });
  });

  it('omits pid when the credential registry has no row for this label', async () => {
    credentialRegistry.getLatestCredentialLaunchByAccountLabel.mockReturnValue(undefined);
    const result = await devServer.launchSavedAccountByLabel('lab-1');
    expect(result).toEqual({ ok: true, pid: undefined });
  });
});
