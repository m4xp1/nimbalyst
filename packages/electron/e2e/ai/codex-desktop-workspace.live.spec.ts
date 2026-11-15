import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { buildElectronArgs, buildTestEnv, waitForAppReady } from '../helpers';

// Dedicated live account check, explicitly enabled by the owner. No inference or browser sign-in.
test('Desktop login supports an isolated Nimbalyst workspace across restarts', async () => {
  test.skip(process.env.NIMBALYST_LIVE_DESKTOP_WORKSPACE !== '1', 'Requires explicit authorization to use the local Desktop login');
  test.setTimeout(100_000);
  const main = process.env.NIMBALYST_E2E_MAIN_PATH;
  expect(main).toBeDefined();
  const sourceHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const sourceHash = async () => createHash('sha256').update(await fs.readFile(path.join(sourceHome, 'auth.json'))).digest('hex');
  const before = await sourceHash();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-desktop-picker-'));
  const workspace = path.join(root, 'workspace'), profile = path.join(root, 'profile');
  await fs.mkdir(workspace); await fs.mkdir(profile);
  await fs.writeFile(path.join(workspace, 'notes.md'), '# Isolated workspace check\n');
  const env = buildTestEnv('', { env: {
    NIMBALYST_USER_DATA_DIR: profile, NIMBALYST_USER_DATA_PATH: profile, NIMBALYST_CDP_PORT: '0', PLAYWRIGHT_TEST: 'true',
  } });
  // The explicit live runner opts in after the standard offline environment isolation.
  env.CODEX_HOME = sourceHome; env.NIMBALYST_ALLOW_CODEX_ACCESS = '1';
  const launch = () => _electron.launch({ args: buildElectronArgs(main!, workspace, profile), env, cwd: path.resolve(__dirname, '../../../..') });
  let app: ElectronApplication | undefined;
  try {
    app = await launch();
    let page = await app.firstWindow(); await waitForAppReady(page);
    await page.evaluate(() => (window as any).electronAPI.invoke('codex-workspace:get', true));
    // Startup returns the current account immediately; full membership arrives asynchronously.
    await expect.poll(async () => (await page.evaluate(() => (window as any).electronAPI.invoke('codex-workspace:get'))).choices.length,
      { timeout: 20_000 }).toBeGreaterThan(1);
    const status = await page.evaluate(() => (window as any).electronAPI.invoke('codex-workspace:get'));
    expect(status.canSwitch).toBe(true);
    expect(status.choices.length).toBeGreaterThan(1);
    const target = status.choices.find((choice: { id: string }) => choice.id !== status.selectedId);
    await page.getByTestId('codex-usage-indicator').click();
    let picker = page.getByRole('combobox', { name: 'Workspace', exact: true });
    await expect(picker).toBeEnabled();
    await picker.selectOption(target.id);
    await expect.poll(() => page.evaluate(() => (window as any).electronAPI.invoke('codex-workspace:get')),
      { timeout: 30_000 }).toMatchObject({ selectedId: target.id, independent: true, signingIn: false });
    await expect(picker).toBeEnabled(); await expect(picker).toHaveValue(target.id);
    expect(await sourceHash()).toBe(before);
    await app.close(); app = undefined;
    app = await launch();
    page = await app.firstWindow(); await waitForAppReady(page);
    await page.getByTestId('codex-usage-indicator').click();
    picker = page.getByRole('combobox', { name: 'Workspace', exact: true });
    await expect(picker).toBeEnabled(); await expect(picker).toHaveValue(target.id);
    expect(await sourceHash()).toBe(before);
  } finally {
    await app?.close();
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root).startsWith('nim-desktop-picker-')).toBe(true);
    await fs.rm(path.join(profile, 'codex-desktop-workspace-auth', 'auth.json'), { force: true, maxRetries: 10, retryDelay: 200 });
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
