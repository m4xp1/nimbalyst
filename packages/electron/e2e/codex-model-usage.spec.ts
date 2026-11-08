import { isolatedAgentEnvironment } from './isolatedAgentEnvironment';
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Host broadcasts exercise the real preload/listener/atom/indicator/popover path.
// Native scope detection is tested separately by the offline native and service gates.
for (const database of ['sqlite', 'pglite'] as const) test(`Codex usage follows account snapshots (${database})`, async () => {
  test.setTimeout(90000);
  const root = path.resolve(__dirname, '../../..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-codex-usage-e2e-'));
  const workspace = path.join(temp, 'workspace'), user = path.join(temp, 'profile'), db = path.join(temp, 'db'), processTemp = path.join(temp, 'tmp');
  for (const dir of [workspace, user, db, processTemp]) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(workspace, 'README.md'), '# Synthetic account usage fixture\n');
  if (database === 'pglite') await fs.writeFile(path.join(db, 'database-backend.json'), JSON.stringify({ backend: 'pglite', setAt: new Date().toISOString(), setBy: 'rollback' }));
  const main = process.env.NIMBALYST_E2E_MAIN_PATH ?? path.join(root, 'packages/electron/out/main/index.js');
  const isolate = path.join(temp, 'isolate.cjs');
  await fs.writeFile(isolate, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(user)});app.setPath('appData',${JSON.stringify(temp)});app.setAppPath(${JSON.stringify(path.dirname(main))});require(${JSON.stringify(main)});`);
  const env = isolatedAgentEnvironment(path.join(temp, 'agent-home')); delete env.ELECTRON_RENDERER_URL;
  let app: ElectronApplication | undefined;
  try {
    const executablePath = process.env.NIMBALYST_E2E_APP_PATH;
    app = await _electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [`--user-data-dir=${user}`] : [isolate]), '--workspace', workspace], cwd: root, timeout: 45000,
      env: { ...env, PLAYWRIGHT: '1', NIMBALYST_PERMISSION_MODE: 'allow-all', NIMBALYST_CDP_PORT: '0', NIMBALYST_USER_DATA_DIR: user, NIMBALYST_USER_DATA_PATH: db, TMP: processTemp, TEMP: processTemp } });
    const page = await app.firstWindow();
    await page.getByTestId('tracker-mode-button').waitFor();
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(user);
    expect(await page.evaluate(() => (window as any).electronAPI.invoke('db:migration:get-status'))).toMatchObject({ activeBackend: database });
    expect(await page.evaluate(() => (window as any).electronAPI.invoke('codex-usage:refresh'))).toMatchObject({ limits: [], error: 'Codex account access is disabled for this launch.' });
    await page.evaluate(() => (window as any).electronAPI.invoke('app-settings:set', 'hiddenGutterItems', []));
    const publish = (data: any) => app!.evaluate(({ BrowserWindow }, payload) => {
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('codex-usage:update', payload);
    }, data);
    const snapshot = (usedPercent: number) => ({ limits: [{ id: 'codex', name: null, planType: 'pro', windows: [{ slot: 'primary', usedPercent, windowDurationMins: 300, resetsAt: new Date(Date.now() + 3600000).toISOString() }], credits: null, individualLimit: null, rateLimitReachedType: null }], limitsAvailable: true, source: 'account', lastUpdated: Date.now() });
    const indicator = page.getByRole('button', { name: 'Codex Usage', exact: true });
    await publish(snapshot(100)); await expect(indicator).toHaveText('100%'); await indicator.click();
    const popover = page.getByTestId('codex-usage-popover'); await expect(popover).toBeVisible();
    // Manual refresh is deliberately denied in automated launches.
    await popover.getByRole('button', { name: 'Refresh usage' }).click();
    await expect(popover).toContainText('Codex account access is disabled');
    await publish(snapshot(100)); await expect(popover).toContainText('100%');
    await publish({ limits: [], limitsAvailable: false, refreshing: true, lastUpdated: 0 });
    await expect(indicator).toHaveText('--'); await expect(popover).toContainText('Updating current account limits');
    await expect(popover).not.toContainText('100%'); await expect(popover).not.toContainText('Updated just now');
    await publish(snapshot(12)); await expect(indicator).toHaveText('12%'); await expect(popover).toContainText('12%');
    await publish({ limits: [], limitsAvailable: false, lastUpdated: 0, error: 'Current Codex account limits are unavailable.' });
    await expect(indicator).toHaveText('--'); await expect(popover).toContainText('Current Codex account limits are unavailable');
    await expect(popover).not.toContainText('12%');
    await popover.getByRole('button', { name: 'Close', exact: true }).click(); await expect(popover).not.toBeVisible();
    await indicator.click(); await expect(popover).toBeVisible();
    await publish(snapshot(7)); await expect(indicator).toHaveText('7%'); await expect(popover).toContainText('7%');
  } finally {
    if (app) { const timer = setTimeout(() => app!.process().kill(), 5000); try { await app.close(); } finally { clearTimeout(timer); } }
    // Keep the artificial profile on failure for the standard screenshot/trace workflow.
  }
});
