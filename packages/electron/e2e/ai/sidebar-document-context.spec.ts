import { expect, test } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ACTIVE_EDITOR_SELECTOR, launchElectronApp, waitForAppReady } from '../helpers';
import { openFileFromTree, PLAYWRIGHT_TEST_SELECTORS, switchToFilesMode } from '../utils/testHelpers';

test('Files context and selection follow the active document before sending', async () => {
  test.setTimeout(90_000);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-sidebar-context-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'previous.md'), '# Previous\n\nPrior fixture text.\n');
  await fs.writeFile(path.join(workspace, 'current.md'), '# Current\n\nCurrent selection marker.\n');
  const app = await launchElectronApp({
    workspace, recordVideo: false,
    env: { PLAYWRIGHT_TEST: 'true', NIMBALYST_USER_DATA_DIR: path.join(root, 'profile') },
  });
  try {
    await app.evaluate(({ ipcMain }) => {
      const calls: { filePath?: string; text?: string; body?: string }[] = [];
      Object.assign(globalThis, { sidebarContextCalls: calls });
      ipcMain.removeHandler('ai:sendMessage');
      ipcMain.handle('ai:sendMessage', (_event, _prompt, context) => {
        calls.push({ filePath: context.filePath, text: context.textSelection?.text, body: context.content });
        return { success: true };
      });
    });
    const page = await app.firstWindow();
    await waitForAppReady(page);
    await switchToFilesMode(page);
    await openFileFromTree(page, 'previous.md');
    const sidebar = page.getByTestId('chat-sidebar-panel').filter({ visible: true });
    const toggle = () => app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(w => w.isVisible() && w.webContents.getURL().includes('index.html'));
      if (!window) throw new Error('Test window not found');
      window.webContents.send('toggle-ai-chat-panel');
    });
    if (await sidebar.isVisible()) {
      await toggle();
      await expect(sidebar).toHaveCount(0);
    }
    await toggle();
    const label = sidebar.locator('.document-context-indicator');
    await expect(label).toContainText('previous.md');
    await openFileFromTree(page, 'current.md');
    await expect(label).toContainText('current.md');
    const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
    await expect(editor).toContainText('Current selection marker.');
    await editor.getByText('Current selection marker.', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+Home');
    await expect(sidebar.locator('.selection-chip-preview')).toContainText('Current selection marker.');
    const input = sidebar.locator(PLAYWRIGHT_TEST_SELECTORS.filesChatInput);
    await input.fill('Inspect the synthetic document');
    await input.press('Enter');
    const calls = () => app.evaluate(() =>
      (globalThis as any).sidebarContextCalls as Array<{ filePath: string; text: string; body: string }>);
    await expect.poll(async () => (await calls()).length).toBe(1);
    const [sent] = await calls();
    expect(path.basename(sent.filePath)).toBe('current.md');
    expect(sent.text).toBe('Current selection marker.');
    expect(sent.body).toContain('# Current');
    await toggle();
    await expect(sidebar).toHaveCount(0);
    await toggle();
    await expect(label).toContainText('current.md');
    await openFileFromTree(page, 'previous.md');
    await expect(label).toContainText('previous.md');
    await expect(sidebar.locator('.selection-chip-preview')).toHaveCount(0);
  } finally {
    await app.close();
  }
});
