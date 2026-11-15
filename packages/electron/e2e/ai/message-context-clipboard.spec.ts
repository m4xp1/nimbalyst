import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchElectronApp, waitForAppReady } from '../helpers';
import { switchToAgentMode } from '../utils/testHelpers';
import { createTestSession, insertMessage } from '../utils/interactivePromptTestHelpers';

test('native message copy restores context into another draft, supports undo and survives restart', async () => {
  test.setTimeout(180_000);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-message-clipboard-'));
  const workspace = path.join(temp, 'workspace');
  await fs.mkdir(workspace);
  const filePath = path.join(workspace, 'notes.md');
  await fs.writeFile(filePath, '# Notes\n\nOriginal document.');
  const options = { workspace, preserveTestDatabase: true, recordVideo: false as const,
    env: { PLAYWRIGHT_TEST: 'true', NIMBALYST_CDP_PORT: '0', NIMBALYST_USER_DATA_DIR: path.join(temp, 'profile'), NIMBALYST_USER_DATA_PATH: path.join(temp, 'db') } };
  let app = await launchElectronApp(options);
  let previousClipboard: { text: string; html: string; rtf: string; image: string } | undefined;
  try {
    previousClipboard = await app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage().toDataURL() }));
    let page = await app.firstWindow();
    await waitForAppReady(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await switchToAgentMode(page);
    const sourceId = await createTestSession(page, workspace, { title: 'Clipboard source', provider: 'openai-codex', model: 'openai-codex:gpt-6-sol' });
    const targetId = await createTestSession(page, workspace, { title: 'Clipboard target', provider: 'openai-codex', model: 'openai-codex:gpt-6-sol' });
    await insertMessage(page, sourceId, 'input', JSON.stringify({ prompt: 'Original chat passage.' }), { source: 'openai-codex' });
    const annotation = { id: 'original-note', source: { type: 'file', filePath }, quote: 'Original document.', before: '', after: '', comment: 'Check this annotation.' };
    const chatAnnotation = { ...annotation, id: 'chat-note', source: { type: 'message', sessionId: sourceId, messageId: '1', messageSequence: 0 },
      quote: 'Original chat passage.', comment: 'Check the original chat.' };
    const selection = { id: 'selected-chat', source: { type: 'message', sessionId: sourceId, messageId: '1', messageSequence: 0 },
      quote: 'Selected chat passage', before: '', after: '', comment: '' };
    const draftContext = { document: { filePath, content: '# Notes\n\nOriginal document.', fileType: 'markdown',
      textSelection: { text: 'Notes', filePath, timestamp: Date.now() },
      editorContextItems: [{ id: 'shape', label: 'Copied shape', description: 'Selected shape detail' }] }, selection };
    await insertMessage(page, sourceId, 'input', JSON.stringify({ prompt: 'Copy the complete message' }), {
      source: 'openai-codex', metadata: { annotations: [annotation, chatAnnotation, selection], draftContext },
    });
    const open = async (id: string) => {
      await page.evaluate(({ id, workspace }) => window.dispatchEvent(new CustomEvent('open-ai-session', { detail: { sessionId: id, workspacePath: workspace } })), { id, workspace });
      await expect(page.locator('[data-testid="agent-mode-chat-input"]').filter({ visible: true })).toBeVisible();
    };
    const root = (id: string) => page.locator(`[data-session-id="${id}"]`).filter({ visible: true }).first();
    await open(sourceId);
    await root(sourceId).getByTitle('Copy message with context', { exact: true }).last().click();
    const clipboard = await app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML() }));
    expect(clipboard.text).toContain('Check this annotation.');
    expect(clipboard.html).toContain('data-nimbalyst-message=');
    await open(targetId);
    let input = root(targetId).getByTestId('agent-mode-chat-input').locator('textarea');
    // Some layouts apply the test ID directly to the input container.
    if (await input.count() === 0) input = root(targetId).locator('textarea').last();
    await input.fill('Before ');
    await input.press('End');
    await input.press('Control+V');
    await expect(input).toHaveValue('Before Copy the complete message');
    await expect(root(targetId).locator('.draft-annotation-list summary')).toHaveText('2 annotations');
    await expect(root(targetId).getByText('Copied shape', { exact: true })).toBeVisible();
    await expect(root(targetId).getByText('notes.md', { exact: true })).toBeVisible();
    await expect(root(targetId).locator('.selection-chip-preview').filter({ hasText: 'Selected chat passage' })).toBeVisible();
    await input.press('Control+Z');
    await expect(input).toHaveValue('Before ');
    await expect(root(targetId).locator('.draft-annotation-list')).toHaveCount(0);
    await expect(root(targetId).getByText('Copied shape', { exact: true })).toHaveCount(0);
    await input.press('Control+Shift+Z');
    await expect(input).toHaveValue('Before Copy the complete message');
    await expect(root(targetId).locator('.draft-annotation-list summary')).toHaveText('2 annotations');
    await root(targetId).locator('.draft-annotation-list summary').click();
    await root(targetId).getByRole('button', { name: '1. Original document.' }).click();
    await expect(root(targetId).getByRole('textbox', { name: 'Annotation comment in draft' })).toHaveValue(annotation.comment);
    await page.screenshot({ path: test.info().outputPath('restored-message-context.png') });
    await root(targetId).getByRole('button', { name: 'Find annotation source' }).nth(1).click();
    await expect(root(sourceId).locator('[data-annotation-message-sequence="0"]').getByText('Original chat passage.', { exact: true })).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Edit annotation 2', exact: true })).toBeInViewport();
    await expect(page.locator('.chat-annotation-editor')).toHaveCount(0);
    await open(targetId);
    // Wait for the existing debounced text/annotation persistence, then restart
    // only this synthetic application and verify durable draft metadata.
    await expect.poll(async () => page.evaluate(async (id) => {
      const session = await (window as any).electronAPI.invoke('sessions:get', id);
      return session?.draftInput ?? session?.session?.draftInput;
    }, targetId)).toBe('Before Copy the complete message');
    await app.close();
    app = await launchElectronApp(options);
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator(`#session-list-item-${targetId}`)).toBeVisible({ timeout: 20000 });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await open(targetId);
    await expect(root(targetId).getByText('Copied shape', { exact: true })).toBeVisible();
    await expect(root(targetId).locator('.draft-annotation-list summary')).toHaveText('2 annotations');
    await app.evaluate(({ ipcMain }) => {
      (globalThis as any).copiedSend = null;
      ipcMain.removeHandler('ai:sendMessage');
      ipcMain.handle('ai:sendMessage', (event, text, context, sessionId, workspacePath) => {
        (globalThis as any).copiedSend = { text, context };
        event.sender.send('ai:message-logged', { sessionId, workspacePath, direction: 'input' });
        return new Promise(resolve => { (globalThis as any).finishCopiedSend = () => resolve({ success: true }); });
      });
    });
    input = root(targetId).locator('textarea').last();
    await input.press('Enter');
    await expect.poll(() => app.evaluate(() => (globalThis as any).copiedSend)).toMatchObject({
      text: 'Before Copy the complete message', context: { filePath, draftContext,
        chatAnnotations: [expect.objectContaining({ quote: annotation.quote, comment: annotation.comment }),
          expect.objectContaining({ quote: chatAnnotation.quote, comment: chatAnnotation.comment, source: chatAnnotation.source }), selection] },
    });
    await expect(root(targetId).locator('.draft-annotation-list')).toHaveCount(0);
    await expect(root(targetId).getByText('Copied shape', { exact: true })).toHaveCount(0);
    // The accepted context clears before the synthetic agent turn finishes.
    await app.evaluate(() => (globalThis as any).finishCopiedSend());
  } finally {
    if (previousClipboard) await app.evaluate(({ clipboard, nativeImage }, previous) => {
      clipboard.write({ text: previous.text, html: previous.html, rtf: previous.rtf, image: nativeImage.createFromDataURL(previous.image) });
    }, previousClipboard).catch(() => {});
    await app.close();
  }
});
