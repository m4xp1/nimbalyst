import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { launchElectronApp, waitForAppReady } from '../helpers';
import { createTestSession, insertMessage } from '../utils/interactivePromptTestHelpers';
import { PLAYWRIGHT_TEST_SELECTORS, switchToAgentMode } from '../utils/testHelpers';

test('folds Codex activity, restores manual expansion after restart, and paints user messages', async () => {
  test.setTimeout(120_000);
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-transcript-activity-'));
  const workspace = path.join(fixture, 'workspace');
  await fs.mkdir(workspace);
  let app: ElectronApplication | undefined;
  const launch = async (preserveTestDatabase = false): Promise<Page> => {
    app = await launchElectronApp({
      workspace, preserveTestDatabase, recordVideo: false,
      env: { PLAYWRIGHT_TEST: 'true', NIMBALYST_USER_DATA_DIR: path.join(fixture, 'profile') },
    });
    const page = await app.firstWindow();
    if (preserveTestDatabase) {
      await page.locator(PLAYWRIGHT_TEST_SELECTORS.agentMode).waitFor({ state: 'visible' });
    } else {
      await waitForAppReady(page);
      await switchToAgentMode(page);
    }
    return page;
  };
  const activity = (page: Page) => page.getByRole('button', { name: 'Agent activity', exact: true });
  const commentary = 'Checking the synthetic workspace';
  const answer = 'The synthetic workspace is ready.';
  try {
    let page = await launch();
    const sessionId = await createTestSession(page, workspace, {
      title: 'Activity disclosure', provider: 'openai-codex', model: 'openai-codex:gpt-6-sol',
    });
    await insertMessage(page, sessionId, 'input', JSON.stringify({ prompt: 'Check the synthetic workspace' }), { source: 'openai-codex' });
    for (const [id, phase, text] of [['progress', 'commentary', commentary], ['answer', 'final_answer', answer]]) {
      await insertMessage(page, sessionId, 'output', JSON.stringify({
        method: 'item/completed',
        params: { threadId: 'test-thread', turnId: 'test-turn', item: { id, phase, text, type: 'agentMessage' } },
      }), { source: 'openai-codex', metadata: { transport: 'app-server' } });
    }
    const openSession = (target: Page) => target.locator(`#session-list-item-${sessionId}`).click();
    await openSession(page);
    await expect(page.getByText(answer, { exact: true })).toBeVisible();
    await expect(activity(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByText(commentary, { exact: true })).toHaveCount(0);
    await expect(page.locator('.rich-transcript-message.user')).toHaveCSS('background-color', 'rgb(233, 243, 254)');
    await activity(page).click();
    await expect(page.getByText(commentary, { exact: true })).toBeVisible();
    await app!.close();
    app = undefined;

    page = await launch(true);
    await openSession(page);
    await expect(activity(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText(commentary, { exact: true })).toBeVisible();
    await activity(page).click();
    await expect(page.getByText(commentary, { exact: true })).toHaveCount(0);
    await expect(page.getByText(answer, { exact: true })).toBeVisible();
  } finally {
    await app?.close();
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
