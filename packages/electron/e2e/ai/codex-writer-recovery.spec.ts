import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchElectronApp, waitForAppReady } from '../helpers';
import { switchToAgentMode } from '../utils/testHelpers';
import { createTestSession, insertMessage } from '../utils/interactivePromptTestHelpers';

test('writer error exposes recovery without sending a prompt', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-writer-recovery-'));
  const workspace = path.join(temp, 'workspace');
  await fs.mkdir(workspace);
  const app = await launchElectronApp({ workspace, preserveTestDatabase: true, recordVideo: false,
    env: { PLAYWRIGHT_TEST: 'true', NIMBALYST_CDP_PORT: '0', NIMBALYST_USER_DATA_DIR: path.join(temp, 'profile'), NIMBALYST_USER_DATA_PATH: path.join(temp, 'db') } });
  try {
    const page = await app.firstWindow();
    await waitForAppReady(page);
    await switchToAgentMode(page);
    const id = await createTestSession(page, workspace, { title: 'Writer recovery', provider: 'openai-codex', model: 'openai-codex:gpt-6-sol' });
    await insertMessage(page, id, 'input', JSON.stringify({ prompt: 'Keep the saved conversation' }), { source: 'openai-codex' });
    const detail = 'Error: [CodexAppServer] thread/resume failed for thread fixture: thread fixture already has an active writer. The saved conversation is unchanged; resolve the error and retry this session.';
    await insertMessage(page, id, 'output', JSON.stringify({ method: 'error', params: { error: { message: detail } } }),
      { source: 'openai-codex', metadata: { transport: 'app-server' } });
    await app.evaluate(({ ipcMain }) => {
      (globalThis as any).writerCalls = [];
      ipcMain.removeHandler('ai:resolveCodexWriter');
      ipcMain.handle('ai:resolveCodexWriter', async (_event, id) => {
        (globalThis as any).writerCalls.push(id);
        await new Promise(resolve => setTimeout(resolve, 150));
        return (globalThis as any).writerCalls.length === 1
          ? { success: false, error: 'This chat is still open in another connection. Close it there, then try again.' }
          : { success: true };
      });
      (globalThis as any).unexpectedWriterSends = 0;
      ipcMain.removeHandler('ai:sendMessage');
      ipcMain.handle('ai:sendMessage', () => { (globalThis as any).unexpectedWriterSends++; return { success: false }; });
    });
    await page.locator(`#session-list-item-${id}`).click();
    const root = page.locator(`[data-session-id="${id}"]`).filter({ visible: true }).first();
    const retry = root.getByRole('button', { name: 'Try resolve', exact: true });
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(root.getByRole('status')).toContainText('Close it there');
    await retry.click();
    await expect(root.getByRole('status')).toHaveText('Connection restored. Send your message again.');
    expect(await app.evaluate(() => (globalThis as any).writerCalls)).toEqual([id, id]);
    expect(await app.evaluate(() => (globalThis as any).unexpectedWriterSends)).toBe(0);
  } finally { await app.close(); }
});
