import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ACTIVE_EDITOR_SELECTOR, launchElectronApp, waitForAppReady } from '../helpers';
import { openFileFromTree, switchToAgentMode, switchToFilesMode, PLAYWRIGHT_TEST_SELECTORS } from '../utils/testHelpers';
import { createTestSession } from '../utils/interactivePromptTestHelpers';

for (const backend of ['sqlite', 'pglite']) test(`annotation drafts, heading links and live context (${backend})`, async () => {
  test.setTimeout(150_000);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-annotation-drafts-'));
  const workspace = path.join(temp, 'workspace'), db = path.join(temp, 'db');
  await fs.mkdir(workspace); await fs.mkdir(db);
  if (backend === 'pglite') await fs.writeFile(path.join(db, 'database-backend.json'), JSON.stringify({ backend, setAt: new Date().toISOString(), setBy: 'rollback' }));
  await fs.writeFile(path.join(workspace, 'notes.md'), '# Notes\n\nSelected synthetic text.\n\n[Target section](./target.md#требование-языка)\n\n' + 'A long document paragraph for scrolling.\n\n'.repeat(50));
  await fs.writeFile(path.join(workspace, 'target.md'), '# Target\n\n' + 'Target document filler.\n\n'.repeat(50) + '## Требование языка\n\nCorrect section.\n');
  const app = await launchElectronApp({ workspace, preserveTestDatabase: true, recordVideo: false,
    env: { PLAYWRIGHT_TEST: 'true', NIMBALYST_USER_DATA_DIR: path.join(temp, 'profile'), NIMBALYST_USER_DATA_PATH: db } });
  try {
    const page = await app.firstWindow();
    await waitForAppReady(page);
    // The existing formatting toolbar is deliberately hidden below 1026px.
    await page.setViewportSize({ width: 1440, height: 1000 });
    expect(await page.evaluate(() => window.innerWidth)).toBe(1440);
    expect(await page.evaluate(() => (window as any).electronAPI.invoke('db:migration:get-status'))).toMatchObject({ activeBackend: backend });
    await app.evaluate(({ ipcMain }) => {
      const calls: any[] = [], steering: any[] = [];
      Object.assign(globalThis, { annotationCalls: calls, annotationSteering: steering });
      ipcMain.removeHandler('ai:sendMessage');
      ipcMain.handle('ai:sendMessage', (event, message, context, sessionId, workspacePath) => {
        calls.push({ message, context, sessionId });
        event.sender.send('ai:message-logged', { sessionId, workspacePath, direction: 'input' });
        return { success: true };
      });
      ipcMain.removeHandler('ai:getSteerTarget');
      ipcMain.handle('ai:getSteerTarget', () => ({ supported: true, turnId: 'synthetic-turn' }));
      ipcMain.removeHandler('ai:steerCurrentTurn');
      ipcMain.handle('ai:steerCurrentTurn', (_event, request) => { steering.push(request); return { success: true, turnId: 'synthetic-turn' }; });
    });
    const sessionId = await createTestSession(page, workspace, { title: 'Annotation fixture', provider: 'openai-codex', model: 'openai-codex:gpt-6-sol' });
    await page.evaluate(({ sessionId, workspace }) => window.dispatchEvent(new CustomEvent('open-ai-session', { detail: { sessionId, workspacePath: workspace } })), { sessionId, workspace });
    await expect(page.locator(`[data-session-id="${sessionId}"]`).filter({ visible: true }).first()).toBeVisible();
    await switchToFilesMode(page);
    await openFileFromTree(page, 'notes.md');
    const toggleChat = () => app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(window => window.isVisible() && window.webContents.getURL().includes('index.html'));
      window?.webContents.send('toggle-ai-chat-panel');
    });
    let sidebar = page.getByTestId('chat-sidebar-panel').filter({ visible: true });
    if (!await sidebar.isVisible()) await toggleChat();
    await expect(sidebar).toBeVisible();
    await sidebar.getByTitle('Session History', { exact: true }).click();
    await page.getByText('Annotation fixture', { exact: true }).filter({ visible: true }).click();
    await expect(sidebar).toHaveAttribute('data-session-id', sessionId);
    const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
    await editor.getByText('Selected synthetic text.', { exact: true }).click();
    await page.keyboard.press('End'); await page.keyboard.press('Shift+Home');
    await expect(sidebar.locator('.selection-chip-preview')).toContainText('Selected synthetic text.');
    await page.getByRole('button', { name: 'Add to chat', exact: true }).click();
    const comment = page.getByRole('textbox', { name: 'Annotation comment', exact: true });
    await expect(comment).toBeVisible();
    await comment.fill('Keep this exact quote.');
    await expect(sidebar.locator('.selection-chip-preview')).toHaveCount(0);
    await page.mouse.move(500, 450); await page.mouse.wheel(0, 250);
    await expect(comment).toHaveCount(0);
    const draft = sidebar.locator('.draft-annotation-list');
    await expect(draft).toContainText('1 annotation');
    await draft.locator('summary').click();
    await draft.getByRole('button', { name: '1. Selected synthetic text.' }).click();
    await expect(draft.getByRole('textbox', { name: 'Annotation comment in draft' })).toHaveValue('Keep this exact quote.');
    await draft.getByRole('button', { name: 'Find annotation source' }).click();
    await expect(comment).toBeVisible();
    await comment.press('Escape');
    // Both session surfaces must consume the same draft without a scroll event.
    await switchToAgentMode(page);
    await expect(page.locator(`[data-session-id="${sessionId}"]`).filter({ visible: true }).first().locator('.draft-annotation-list')).toContainText('1 annotation');
    await switchToFilesMode(page);
    sidebar = page.getByTestId('chat-sidebar-panel').filter({ visible: true });
    await expect(sidebar.locator('.draft-annotation-list')).toContainText('1 annotation');
    const input = sidebar.locator(PLAYWRIGHT_TEST_SELECTORS.filesChatInput);
    await input.fill('Inspect the annotated text'); await input.press('Enter');
    await expect(sidebar.locator('.draft-annotation-list')).toHaveCount(0);
    const calls = await app.evaluate(() => (globalThis as any).annotationCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].context.chatAnnotations).toHaveLength(1);
    expect(calls[0].context.textSelection).toBeUndefined();
    expect(calls[0].context.chatAnnotations[0].comment).toBe('Keep this exact quote.');

    // The same native-count event updates the visible view before any turn-end event.
    const publishUsage = (tokens?: number) => app.evaluate(({ BrowserWindow }, { sessionId, tokens }) => {
      const tokenUsage = { inputTokens: 500000, outputTokens: 1000, totalTokens: 501000,
        ...(tokens === undefined ? {} : { currentContext: { tokens, contextWindow: 258400 }, contextWindow: 258400 }) };
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('ai:tokenUsageUpdated', { sessionId, tokenUsage });
    }, { sessionId: calls[0].sessionId, tokens });
    await publishUsage(236000);
    await expect(sidebar.getByTestId('context-indicator')).toContainText('91%');
    await publishUsage(); await expect(sidebar.getByTestId('context-indicator')).toHaveText('--');
    await publishUsage(4555); await expect(sidebar.getByTestId('context-indicator')).toContainText('2%');
    await publishUsage(0); await expect(sidebar.getByTestId('context-indicator')).toContainText('0%');

    // Drive a synthetic active turn through the normal lifecycle channel.
    await page.evaluate(({ sessionId, workspacePath }) => {
      return (window as any).electronAPI.invoke('ai-session-state:start', sessionId, workspacePath);
    }, { sessionId: calls[0].sessionId, workspacePath: workspace });
    await expect(sidebar.getByRole('button', { name: 'Send now', exact: true })).toBeVisible();
    await input.fill('Correct the active task');
    const stop = await sidebar.getByRole('button', { name: 'Cancel request', exact: true }).boundingBox();
    const queue = await sidebar.getByRole('button', { name: 'Queue message', exact: true }).boundingBox();
    const send = await sidebar.getByRole('button', { name: 'Send now', exact: true }).boundingBox();
    expect(stop && queue && send).toBeTruthy();
    expect(send!.width).toBe(send!.height);
    expect(send!.x).toBeCloseTo(stop!.x, 0);
    expect(send!.y).toBeGreaterThan(stop!.y);
    expect(queue!.y).toBeCloseTo(send!.y, 0);
    await input.press('Enter');
    await expect.poll(() => app.evaluate(() => (globalThis as any).annotationSteering.length)).toBe(1);
    expect(await app.evaluate(() => (globalThis as any).annotationCalls.length)).toBe(1);

    // Open a relative target and wait for the mounted editor to reveal its heading.
    await editor.getByRole('heading', { name: 'Notes', exact: true }).click();
    await editor.getByText('Target section', { exact: true }).click();
    await expect(page.locator(ACTIVE_EDITOR_SELECTOR)).toContainText('Correct section.');
    await expect(page.locator(ACTIVE_EDITOR_SELECTOR).getByRole('heading', { name: 'Требование языка' })).toBeInViewport();
    expect(await fs.readFile(path.join(workspace, 'notes.md'), 'utf8')).toContain('Selected synthetic text.');
  } finally { await app.close(); }
});
