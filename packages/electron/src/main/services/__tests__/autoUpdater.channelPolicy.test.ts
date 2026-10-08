// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ channel: 'stable' }));
vi.mock('../../utils/store', () => ({ getReleaseChannel: () => settings.channel, store: {} }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn(), safeOn: vi.fn() }));
const testWindow = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('electron', () => ({
  app: { getVersion: () => '0.79.1', isPackaged: true },
  BrowserWindow: {
    getFocusedWindow: () => ({ isDestroyed: () => false, webContents: { send: testWindow.send } }),
    getAllWindows: () => [],
  },
  dialog: {},
}));
vi.mock('electron-log/main', () => ({ default: { transports: { file: {} }, info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../analytics/AnalyticsService', () => ({ AnalyticsService: {} }));
vi.mock('../../ipc/SessionStateHandlers', () => ({ hasActiveStreamingSessions: vi.fn() }));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({ getSessionStateManager: vi.fn() }));
vi.mock('../../database/initialize', () => ({ getDatabase: vi.fn() }));
vi.mock('../electronUpdaterPatch', () => ({ installAtomFeedFilter: vi.fn() }));
vi.mock('electron-updater', async () => {
  // Keep the dependency's REAL channel setter and semver admission logic.
  const { AppUpdater } = await import('electron-updater/out/AppUpdater');
  class TestUpdater extends AppUpdater {
    constructor() {
      super(undefined, { version: '0.78.1', name: 'test', isPackaged: true } as never);
    }
    protected async doDownloadUpdate(): Promise<string[]> { return []; }
    quitAndInstall(): void { throw new Error('This test must never install an update'); }
  }
  const updater = new TestUpdater();
  updater.setFeedURL = vi.fn();
  updater.isUpdateSupported = async () => true;
  updater.isUserWithinRollout = async () => true;
  return { autoUpdater: updater };
});

import { autoUpdater } from 'electron-updater';
import { AutoUpdaterService } from '../autoUpdater';

beforeEach(() => {
  autoUpdater.removeAllListeners();
  settings.channel = 'stable';
  testWindow.send.mockClear();
});

it('refuses older releases through launch, repeated checks, and channel changes', async () => {
  const dependency = autoUpdater as unknown as { isUpdateAvailable(info: { version: string }): Promise<boolean> };
  for (let launch = 0; launch < 2; launch++) {
    const service = new AutoUpdaterService();
    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
    expect(autoUpdater.setFeedURL).toHaveBeenCalledWith(expect.objectContaining({ owner: 'nimbalyst', repo: 'nimbalyst' }));
    for (const channel of ['stable', 'alpha', 'stable', 'stable']) {
      settings.channel = channel;
      service.reconfigureFeedURL();
      expect(autoUpdater.allowDowngrade).toBe(false);
      expect(await dependency.isUpdateAvailable({ version: '0.77.5' })).toBe(false);
      expect(await dependency.isUpdateAvailable({ version: '0.78.2' })).toBe(true);
    }
    autoUpdater.removeAllListeners();
  }
});

// Legacy fork-feed overrides must never redirect checks away from upstream.
afterEach(() => vi.unstubAllEnvs());

it('uses the upstream feed across channel changes even with legacy fork overrides', () => {
  vi.stubEnv('NIMBALYST_UPDATE_OWNER', 'm4xp1');
  vi.stubEnv('NIMBALYST_UPDATE_REPO', 'nimbalyst');
  const service = new AutoUpdaterService();
  for (const channel of ['stable', 'alpha', 'stable']) {
    settings.channel = channel;
    service.reconfigureFeedURL();
    expect(autoUpdater.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'github', owner: 'nimbalyst', repo: 'nimbalyst',
    });
    expect(autoUpdater.allowDowngrade).toBe(false);
  }
});

it('keeps the upstream feed when no build override is supplied', () => {
  vi.stubEnv('NIMBALYST_UPDATE_OWNER', undefined);
  vi.stubEnv('NIMBALYST_UPDATE_REPO', undefined);
  new AutoUpdaterService();
  expect(autoUpdater.setFeedURL).toHaveBeenLastCalledWith({
    provider: 'github', owner: 'nimbalyst', repo: 'nimbalyst',
  });
});

it('announces an upstream release and downloads only on request without installing on quit', async () => {
  const service = new AutoUpdaterService();
  const download = vi.spyOn(autoUpdater, 'downloadUpdate');
  const lookup = vi.spyOn(autoUpdater as unknown as {
    getUpdateInfoAndProvider(): Promise<{ info: unknown; provider: unknown }>;
  }, 'getUpdateInfoAndProvider').mockResolvedValue({
    info: {
      version: '0.79.2', releaseNotes: 'Upstream release', releaseDate: '2026-10-02',
      files: [{ url: 'Nimbalyst-Windows-x64.exe', sha512: 'test' }],
    },
    provider: {},
  });
  try {
    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
    const result = await autoUpdater.checkForUpdates();
    expect(result?.isUpdateAvailable).toBe(true);
    expect(result?.downloadPromise).toBeNull();
    expect(testWindow.send).toHaveBeenCalledWith('update-toast:show-available', {
      currentVersion: '0.79.1', newVersion: '0.79.2',
      releaseNotes: 'Upstream release', releaseDate: '2026-10-02',
      releaseChannel: 'stable', isManualCheck: false,
    });
    testWindow.send.mockClear();
    await service.checkForUpdatesWithUI();
    expect(testWindow.send).toHaveBeenCalledWith('update-toast:show-available',
      expect.objectContaining({ newVersion: '0.79.2', isManualCheck: true }));
    expect(download).not.toHaveBeenCalled();
    await autoUpdater.downloadUpdate();
    expect(download).toHaveBeenCalledTimes(1);
  } finally {
    lookup.mockRestore();
    download.mockRestore();
  }
});
