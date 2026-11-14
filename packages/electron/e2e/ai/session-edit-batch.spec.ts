import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchElectronApp, waitForAppReady } from '../helpers';
import { assertGitSandbox, gitSandboxEnv, FIXTURE_IDENTITY_ARGS } from '../../src/main/services/testSupport/gitTestSandbox';

// The service regressions produce the links from real Git snapshots. This
// checks their IPC/storage/UI projection, including restart, on both databases.
for (const backend of ['sqlite', 'pglite']) test(`33 session edits survive commit and restart (${backend})`, async () => {
  test.setTimeout(120_000);
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nim-session-batch-')));
  const workspace = path.join(temp, 'workspace');
  const db = path.join(temp, 'db');
  await fs.mkdir(workspace);
  await fs.mkdir(db);
  if (backend === 'pglite')
    await fs.writeFile(path.join(db, 'database-backend.json'), JSON.stringify({ backend, setAt: new Date().toISOString(), setBy: 'rollback' }));
  const git = (...args: string[]) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8', env: gitSandboxEnv(temp) });
  git('init', '-q');
  assertGitSandbox(workspace, temp);
  git('config', 'core.autocrlf', 'false');
  const names = Array.from({ length: 33 }, (_, index) => `batch-${index}.md`);
  for (const name of [...names, 'earlier.md']) await fs.writeFile(path.join(workspace, name), '# Original\n');
  git('add', '--', '.');
  git(...FIXTURE_IDENTITY_ARGS, 'commit', '-qm', 'Artificial clean baseline');
  expect(git('status', '--porcelain')).toBe('');
  await fs.writeFile(path.join(workspace, 'earlier.md'), '# Earlier unrelated change\n');
  const options = {
    workspace, recordVideo: false as const, preserveTestDatabase: true,
    env: { NIMBALYST_USER_DATA_DIR: path.join(temp, 'profile'), NIMBALYST_USER_DATA_PATH: db },
  };
  let app = await launchElectronApp(options);
  const sessionId = 'synthetic-bulk-session';
  try {
    let page = await app.firstWindow();
    await waitForAppReady(page);
    expect(await page.evaluate(() => (window as any).electronAPI.invoke('db:migration:get-status'))).toMatchObject({ activeBackend: backend });
    const inserted = await page.evaluate(({ sessionId, workspace }) =>
      (window as any).electronAPI.invoke('test:insert-session', { id: sessionId, workspaceId: workspace, provider: 'openai-codex', model: 'openai-codex:gpt-6-sol', title: 'Artificial bulk session' }), { sessionId, workspace });
    expect(inserted.success).toBe(true);
    for (const name of names) {
      const file = path.join(workspace, name);
      await fs.writeFile(file, '# Changed by the synthetic shell batch\n');
      const result = await page.evaluate(({ sessionId, workspace, file }) =>
        (window as any).electronAPI.invoke('session-files:add-link', sessionId, workspace, file, 'edited'), { sessionId, workspace, file });
      expect(result.success).toBe(true);
    }
    const openSession = async () => {
      await page.evaluate(({ sessionId, workspace }) =>
        window.dispatchEvent(new CustomEvent('open-ai-session', { detail: { sessionId, workspacePath: workspace } })), { sessionId, workspace });
      await expect(page.locator('.files-edited-sidebar').filter({ visible: true })).toBeVisible();
    };
    const selectScope = async (title: string) => {
      const panel = page.locator('.files-edited-sidebar').filter({ visible: true });
      await panel.locator('.files-scope-dropdown > button').click();
      await page.locator('.files-scope-dropdown__menu').getByText(title, { exact: true }).click();
      await page.keyboard.press('Escape');
      await expect(page.locator('.files-scope-dropdown__menu')).toHaveCount(0);
      return panel;
    };
    await openSession();
    for (const scope of ['All Session Edits', 'Uncommitted Session Edits']) {
      const panel = await selectScope(scope);
      for (const name of names) await expect(panel.getByText(name, { exact: true })).toBeVisible();
      await expect(panel.getByText('earlier.md', { exact: true })).toHaveCount(0);
      await expect(panel.locator('.file-edits-sidebar__root-checkbox')).toContainText('33 uncommitted');
    }
    const all = await selectScope('All Uncommitted Files');
    await expect(all.getByText('earlier.md', { exact: true })).toBeVisible();
    await app.close();
    git('add', '--', ...names);
    git(...FIXTURE_IDENTITY_ARGS, 'commit', '-qm', 'Commit synthetic batch');
    app = await launchElectronApp(options);
    page = await app.firstWindow();
    // The restored Agent mode intentionally hides the Files workspace sidebar.
    await page.getByTestId('tracker-mode-button').waitFor();
    await openSession();
    const history = await selectScope('All Session Edits');
    for (const name of names) await expect(history.getByText(name, { exact: true })).toBeVisible();
    const current = await selectScope('Uncommitted Session Edits');
    await expect(current.getByText('No uncommitted changes', { exact: true })).toBeVisible();
    const rest = await selectScope('All Uncommitted Files');
    await expect(rest.getByText('earlier.md', { exact: true })).toBeVisible();
    await expect(rest.getByText(names[0], { exact: true })).toHaveCount(0);
  } finally {
    await app.close();
  }
});
