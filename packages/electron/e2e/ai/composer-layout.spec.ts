import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchElectronApp, waitForAppReady } from '../helpers';
import { switchToAgentMode, PLAYWRIGHT_TEST_SELECTORS } from '../utils/testHelpers';
import { createTestSession } from '../utils/interactivePromptTestHelpers';

test('Agent composer reserves both action rows before a turn, including a legacy saved height', async () => {
  test.setTimeout(60_000);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-composer-layout-'));
  const workspace = path.join(temp, 'workspace');
  await fs.mkdir(workspace);
  const app = await launchElectronApp({ workspace, preserveTestDatabase: true, recordVideo: false,
    env: { PLAYWRIGHT_TEST: 'true', NIMBALYST_CDP_PORT: '0', NIMBALYST_USER_DATA_DIR: path.join(temp, 'profile'), NIMBALYST_USER_DATA_PATH: path.join(temp, 'db') } });
  try {
    const page = await app.firstWindow();
    await waitForAppReady(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(workspace => (window as any).electronAPI.invoke('workspace:update-state', workspace, { aiPanel: { promptBoxHeight: 36 } }), workspace);
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('ai:getSteerTarget');
      ipcMain.handle('ai:getSteerTarget', () => ({ supported: true, turnId: 'synthetic-turn' }));
    });
    const sessionId = await createTestSession(page, workspace, { title: 'Composer layout', provider: 'openai-codex', model: 'openai-codex:gpt-6-sol' });
    await switchToAgentMode(page);
    await page.locator(`#session-list-item-${sessionId}`).click();
    const input = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentChatInput).filter({ visible: true }).first();
    await expect(input).toBeVisible();
    await input.fill('');
    const row = input.locator('..').locator('..');
    const idle = (await row.boundingBox())!;
    await page.evaluate(({ sessionId, workspace }) => (window as any).electronAPI.invoke('ai-session-state:start', sessionId, workspace), { sessionId, workspace });
    await expect(row.getByRole('button', { name: 'Send now', exact: true })).toBeVisible();
    const active = (await row.boundingBox())!;
    expect(active.height).toBe(idle.height);
    expect(active.y).toBeCloseTo(idle.y, 0);
    const actions = (await row.locator('.ai-chat-active-actions').boundingBox())!;
    expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(actions.height);
    expect(await input.evaluate(element => {
      const css = getComputedStyle(element);
      return (element.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom)) / parseFloat(css.lineHeight);
    })).toBeGreaterThanOrEqual(2);
    await page.evaluate(sessionId => (window as any).electronAPI.invoke('ai-session-state:end', sessionId), sessionId);
    await expect(row.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
    expect((await row.boundingBox())!.height).toBe(idle.height);
  } finally { await app.close(); }
});
