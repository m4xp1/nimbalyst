import { test, expect, type Locator } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ACTIVE_EDITOR_SELECTOR, launchElectronApp, waitForAppReady } from '../helpers';
import { openFileFromTree, switchToAgentMode, switchToFilesMode, PLAYWRIGHT_TEST_SELECTORS } from '../utils/testHelpers';
import { createTestSession, insertMessage } from '../utils/interactivePromptTestHelpers';

for (const backend of ['sqlite', 'pglite']) test(`annotation drafts, heading links and live context (${backend})`, async () => {
  test.setTimeout(150_000);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-annotation-drafts-'));
  const workspace = path.join(temp, 'workspace'), db = path.join(temp, 'db');
  await fs.mkdir(workspace); await fs.mkdir(db);
  if (backend === 'pglite') await fs.writeFile(path.join(db, 'database-backend.json'), JSON.stringify({ backend, setAt: new Date().toISOString(), setBy: 'rollback' }));
  const originalDocument = '# Notes\n\n' + 'A paragraph above the annotation.\n\n'.repeat(25) + 'Selected synthetic text.\n\n[Target section](./target.md#требование-языка)\n\n' + 'A long document paragraph for scrolling.\n\n'.repeat(50);
  await fs.writeFile(path.join(workspace, 'notes.md'), originalDocument);
  await fs.writeFile(path.join(workspace, 'target.md'), '# Target\n\n' + 'Target document filler.\n\n'.repeat(50) + '## Требование языка\n\nCorrect section.\n');
  const app = await launchElectronApp({ workspace, preserveTestDatabase: true, recordVideo: false,
    env: { PLAYWRIGHT_TEST: 'true', NIMBALYST_CDP_PORT: '0', NIMBALYST_USER_DATA_DIR: path.join(temp, 'profile'), NIMBALYST_USER_DATA_PATH: db } });
  try {
    const page = await app.firstWindow();
    await waitForAppReady(page);
    let screenshotIndex = 0;
    const checkPopupAtClick = async (point: { x: number; y: number }, boundary: Locator) => {
      const popup = page.locator('.chat-annotation-editor');
      await expect(popup).toBeVisible();
      await expect.poll(async () => {
        const box = (await popup.boundingBox())!;
        return Math.max(box.x - point.x, point.x - box.x - box.width, box.y - point.y, point.y - box.y - box.height);
      }).toBeLessThanOrEqual(14);
      const box = (await popup.boundingBox())!, bounds = (await boundary.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(bounds.x);
      expect(box.y).toBeGreaterThanOrEqual(bounds.y);
      expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height);
    };
    const checkAnnotationAppearance = async (source: Locator, boundary: Locator) => {
      const marker = page.getByRole('button', { name: 'Edit annotation 1', exact: true });
      const popup = page.locator('.chat-annotation-editor');
      const comment = page.getByRole('textbox', { name: 'Annotation comment', exact: true });
      const endpoint = await source.evaluate(element => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let last: Node = element;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) last = node;
        const range = document.createRange(); range.setStart(last, last.textContent!.length); range.collapse(true);
        return range.getBoundingClientRect().toJSON();
      });
      await expect(marker).toBeVisible();
      const openedPosition = (await marker.boundingBox())!;
      // The marker hugs the upper-right corner of the last selected glyph,
      // independent of whether the comment editor is mounted.
      // Floating UI rounds translations to device pixels.
      expect(Math.abs(openedPosition.y + openedPosition.height / 2 - endpoint.top)).toBeLessThanOrEqual(1);
      expect(Math.abs(openedPosition.x - endpoint.right - 1)).toBeLessThanOrEqual(1);
      const bounds = (await boundary.boundingBox())!, editorBox = (await popup.boundingBox())!;
      expect(editorBox.x).toBeGreaterThanOrEqual(bounds.x);
      expect(editorBox.y).toBeGreaterThanOrEqual(bounds.y);
      expect(editorBox.x + editorBox.width).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect(editorBox.y + editorBox.height).toBeLessThanOrEqual(bounds.y + bounds.height);
      const expectedWidth = await page.evaluate(() => (parseFloat(getComputedStyle(document.documentElement).fontSize) * 15 + 2) * 1.728);
      expect(editorBox.width).toBeCloseTo(Math.min(expectedWidth, bounds.width - 12), 0);
      expect(await marker.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(238, 198, 78)');
      await page.screenshot({ path: test.info().outputPath(`annotation-appearance-${++screenshotIndex}.png`) });
      await comment.press('Escape');
      await expect(popup).toHaveCount(0);
      await expect.poll(async () => (await marker.boundingBox())!.y).toBeCloseTo(openedPosition.y, 1);
      expect((await marker.boundingBox())!.x).toBeCloseTo(openedPosition.x, 1);
      const highlighted = await page.evaluate(() => [...(CSS.highlights.get('chat-annotations') ?? [])].map(range => range.toString()).join(''));
      expect(highlighted).toContain(await source.textContent());
      expect(await source.evaluate(element => getComputedStyle(element, '::highlight(chat-annotations)').backgroundColor)).toBe('rgb(253, 249, 235)');
      await marker.click();
      await expect(comment).toBeVisible();
      await checkPopupAtClick({ x: openedPosition.x + openedPosition.width / 2, y: openedPosition.y + openedPosition.height / 2 }, boundary);
      await expect.poll(async () => (await marker.boundingBox())!.y).toBeCloseTo(openedPosition.y, 1);
      expect((await marker.boundingBox())!.x).toBeCloseTo(openedPosition.x, 1);
      await comment.press('Escape');
    };
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
    const transcriptQuote = 'A long synthetic transcript selection spans several visible lines and remains attached to this exact message when selected either forward or backward.';
    await insertMessage(page, sessionId, 'input', JSON.stringify({ prompt: 'A synthetic prior turn' }), { source: 'openai-codex' });
    await insertMessage(page, sessionId, 'output', JSON.stringify({ method: 'item/completed', params: {
      threadId: 'fixture-thread', turnId: 'fixture-prior-turn', item: { id: 'fixture-final', type: 'agentMessage', phase: 'final_answer', text: transcriptQuote },
    } }), { source: 'openai-codex', metadata: { transport: 'app-server' } });
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
    const transcriptText = sidebar.getByText(transcriptQuote, { exact: true });
    await expect(transcriptText).toBeVisible();
    for (const backward of [false, true]) {
      const caret = await transcriptText.evaluate((element, backward) => {
        const node = element.firstChild!;
        const size = node.textContent!.length;
        const selection = window.getSelection()!;
        selection.setBaseAndExtent(node, backward ? size : 0, node, backward ? 0 : size);
        const range = selection.getRangeAt(0).cloneRange(); range.collapse(backward);
        return range.getBoundingClientRect().toJSON();
      }, backward);
      const add = page.getByRole('button', { name: 'Add annotation', exact: true });
      await expect(add).toBeVisible();
      const button = await add.boundingBox();
      expect(button!.x).toBeLessThanOrEqual(caret.x + 8);
      expect(button!.x + button!.width).toBeGreaterThanOrEqual(caret.x - 8);
      const background = await add.evaluate(element => getComputedStyle(element).backgroundColor);
      expect(background).not.toBe('transparent'); expect(background).not.toBe('rgba(0, 0, 0, 0)');
      await add.click();
      const note = page.getByRole('textbox', { name: 'Annotation comment', exact: true });
      await expect(note).toBeVisible(); await note.fill(backward ? 'Backward quote' : 'Forward quote');
      await checkPopupAtClick({ x: button!.x + button!.width / 2, y: button!.y + button!.height / 2 }, sidebar.locator('.rich-transcript-vlist'));
      await checkAnnotationAppearance(transcriptText, sidebar.locator('.rich-transcript-vlist'));
      const list = sidebar.locator('.draft-annotation-list'); await list.locator('summary').click();
      await list.getByRole('button', { name: `1. ${transcriptQuote}` }).click();
      const edit = list.getByRole('textbox', { name: 'Annotation comment in draft' });
      await expect(edit).toHaveValue(backward ? 'Backward quote' : 'Forward quote');
      await edit.fill(''); await edit.press('Escape'); await expect(list).toHaveCount(0);
    }
    const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
    const documentBoundary = editor.locator('xpath=ancestor::*[contains(@class,"editor-scroller")]').first();
    // A backward selection spans paragraphs and a link far beyond the viewport.
    // The toolbar is visible at its focus; the marker at its end is off screen.
    await editor.getByRole('heading', { name: 'Notes', exact: true }).click();
    await documentBoundary.evaluate(element => { element.scrollTop = 0; });
    await editor.evaluate(element => {
      const paragraphs = element.querySelectorAll('p');
      const first = paragraphs[0].firstChild!, last = paragraphs[paragraphs.length - 1].lastChild!;
      window.getSelection()!.setBaseAndExtent(last, last.textContent!.length, first, 0);
    });
    await expect(sidebar.locator('.selection-chip-preview')).toBeVisible();
    const toolbarAdd = page.getByRole('button', { name: 'Add annotation', exact: true });
    await expect(toolbarAdd).toBeVisible();
    const toolbarBox = (await toolbarAdd.boundingBox())!;
    await toolbarAdd.click();
    await checkPopupAtClick({ x: toolbarBox.x + toolbarBox.width / 2, y: toolbarBox.y + toolbarBox.height / 2 }, documentBoundary);
    const longComment = page.getByRole('textbox', { name: 'Annotation comment', exact: true });
    await longComment.fill('Long document quote');
    await expect(sidebar.locator('.selection-chip-preview')).toHaveCount(0);
    expect(await page.evaluate(() => window.getSelection()!.isCollapsed)).toBe(true);
    await expect(toolbarAdd).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('annotation-long-document.png') });
    await longComment.press('Escape');
    // Focusing the editor again must not restore Lexical's consumed selection.
    await editor.focus();
    await expect(sidebar.locator('.selection-chip-preview')).toHaveCount(0);
    await expect(toolbarAdd).toHaveCount(0);
    const longDraft = sidebar.locator('.draft-annotation-list');
    await longDraft.locator('summary').click();
    await longDraft.getByRole('button', { name: 'Find annotation source' }).click();
    await expect(page.getByRole('button', { name: 'Edit annotation 1', exact: true })).toBeInViewport();
    await expect(longComment).toHaveCount(0);
    await expect.poll(() => page.getByRole('button', { name: 'Edit annotation 1', exact: true }).evaluate(element => {
      const rect = element.getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element;
    })).toBe(true);
    await longDraft.getByRole('button', { name: 'Delete annotation' }).click();
    await editor.getByText('Selected synthetic text.', { exact: true }).click();
    await page.keyboard.press('End'); await page.keyboard.press('Shift+Home');
    await expect(sidebar.locator('.selection-chip-preview')).toContainText('Selected synthetic text.');
    await page.getByRole('button', { name: 'Add annotation', exact: true }).click();
    const comment = page.getByRole('textbox', { name: 'Annotation comment', exact: true });
    await expect(comment).toBeVisible();
    await comment.fill('Keep this exact quote.');
    await expect(sidebar.locator('.selection-chip-preview')).toHaveCount(0);
    const documentSource = editor.getByText('Selected synthetic text.', { exact: true });
    await checkAnnotationAppearance(documentSource, documentBoundary);
    // At the viewport edge, the badge is clipped rather than floating over controls.
    const documentBounds = (await documentBoundary.boundingBox())!;
    const sourceBounds = (await documentSource.boundingBox())!;
    await documentBoundary.evaluate((element, delta) => { element.scrollTop += delta; },
      sourceBounds.y - (documentBounds.y + 4));
    const documentMarker = page.getByRole('button', { name: 'Edit annotation 1', exact: true });
    await expect.poll(async () => (await documentMarker.boundingBox())!.y).toBeLessThan(documentBounds.y);
    await expect.poll(() => documentMarker.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.top + 2) === element;
    })).toBe(false);
    // The editor flips at either edge but stays entirely inside its document viewport.
    await documentSource.scrollIntoViewIfNeeded();
    await documentBoundary.evaluate((element) => { element.scrollTop -= 80; });
    await documentMarker.click();
    await expect(comment).toBeVisible();
    const boundedPopup = (await page.locator('.chat-annotation-editor').boundingBox())!;
    expect(boundedPopup.y).toBeGreaterThanOrEqual(documentBounds.y);
    expect(boundedPopup.y + boundedPopup.height).toBeLessThanOrEqual(documentBounds.y + documentBounds.height);
    await comment.press('Escape');
    await page.mouse.move(500, 450); await page.mouse.wheel(0, 250);
    await expect(comment).toHaveCount(0);
    const draft = sidebar.locator('.draft-annotation-list');
    await expect(draft).toContainText('1 annotation');
    await draft.locator('summary').click();
    await draft.getByRole('button', { name: '1. Selected synthetic text.' }).click();
    await expect(draft.getByRole('textbox', { name: 'Annotation comment in draft' })).toHaveValue('Keep this exact quote.');
    await draft.getByRole('button', { name: 'Find annotation source' }).click();
    await expect(documentSource).toBeInViewport();
    await expect(comment).toHaveCount(0);
    // Both session surfaces must consume the same draft without a scroll event.
    await switchToAgentMode(page);
    await expect(page.locator(`[data-session-id="${sessionId}"]`).filter({ visible: true }).first().locator('.draft-annotation-list')).toContainText('1 annotation');
    await switchToFilesMode(page);
    sidebar = page.getByTestId('chat-sidebar-panel').filter({ visible: true });
    await expect(sidebar.locator('.draft-annotation-list')).toContainText('1 annotation');
    const input = sidebar.locator(PLAYWRIGHT_TEST_SELECTORS.filesChatInput);
    await input.fill('Inspect the annotated text'); await input.press('Enter');
    await expect(sidebar.locator('.draft-annotation-list')).toHaveCount(0);
    expect(await page.evaluate(() => CSS.highlights.get('chat-annotations')?.size ?? 0)).toBe(0);
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
    await input.fill('');
    const inputRow = input.locator('..').locator('..');
    const idleRow = (await inputRow.boundingBox())!;
    await page.evaluate(({ sessionId, workspacePath }) => {
      return (window as any).electronAPI.invoke('ai-session-state:start', sessionId, workspacePath);
    }, { sessionId: calls[0].sessionId, workspacePath: workspace });
    await expect(sidebar.getByRole('button', { name: 'Send now', exact: true })).toBeVisible();
    // The second action row must fit into space already reserved while idle.
    await expect.poll(async () => (await inputRow.boundingBox())!.height).toBe(idleRow.height);
    expect((await inputRow.boundingBox())!.y).toBeCloseTo(idleRow.y, 0);
    expect(await input.evaluate(element => {
      const style = getComputedStyle(element);
      const contentHeight = element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      return contentHeight / parseFloat(style.lineHeight);
    })).toBeGreaterThanOrEqual(2);
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
    expect(await fs.readFile(path.join(workspace, 'notes.md'), 'utf8')).toBe(originalDocument);

    // A long transcript range has its focus visible but its last glyph below the viewport.
    const longSession = await createTestSession(page, workspace, { title: 'Long annotation fixture', provider: 'openai-codex', model: 'openai-codex:gpt-6-sol' });
    const longQuote = 'Long annotation passage. ' + 'Source text extending below the chat viewport. '.repeat(150);
    await insertMessage(page, longSession, 'output', JSON.stringify({ method: 'item/completed', params: {
      threadId: 'long-thread', turnId: 'long-turn', item: { id: 'long-answer', type: 'agentMessage', phase: 'final_answer', text: longQuote },
    } }), { source: 'openai-codex', metadata: { transport: 'app-server' } });
    await switchToAgentMode(page);
    await page.locator(`#session-list-item-${longSession}`).click();
    const longRoot = page.locator(`[data-session-id="${longSession}"]`).filter({ visible: true }).first();
    const longText = longRoot.locator('p').filter({ hasText: 'Long annotation passage.' });
    const longScroll = longRoot.locator('.rich-transcript-vlist');
    await expect(longText).toBeVisible();
    await expect(longRoot.locator('.rich-transcript-messages-wrapper')).toHaveClass(/scroll-ready/);
    // Use a real pointer/scroll gesture to leave the composer and disable follow-bottom.
    await longScroll.hover();
    await page.mouse.wheel(0, -10000);
    await expect.poll(() => longScroll.evaluate(element => element.scrollTop)).toBe(0);
    const chatBounds = (await longScroll.boundingBox())!;
    await page.mouse.click(chatBounds.x + 80, chatBounds.y + 100);
    const textBox = (await longText.boundingBox())!, scrollBox = (await longScroll.boundingBox())!;
    expect(textBox.y + textBox.height).toBeGreaterThan(scrollBox.y + scrollBox.height);
    await longText.evaluate(element => {
      const node = element.firstChild!;
      window.getSelection()!.setBaseAndExtent(node, node.textContent!.length, node, 0);
    });
    // Keep the focus end visible after the composer adds its Selection chip.
    await expect(longRoot.locator('.selection-chip-preview')).toBeVisible();
    await longScroll.hover();
    await page.mouse.wheel(0, -10000);
    await expect.poll(() => longScroll.evaluate(element => element.scrollTop)).toBe(0);
    const longAdd = page.getByRole('button', { name: 'Add annotation', exact: true });
    await expect(longAdd).toBeVisible();
    const addBox = (await longAdd.boundingBox())!;
    await longAdd.click();
    await checkPopupAtClick({ x: addBox.x + addBox.width / 2, y: addBox.y + addBox.height / 2 }, longScroll);
    await longComment.fill('Long chat quote');
    await expect(longRoot.locator('.selection-chip-preview')).toHaveCount(0);
    expect(await page.evaluate(() => window.getSelection()!.isCollapsed)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('annotation-long-chat.png') });
    await longComment.press('Escape');
    const longChatDraft = longRoot.locator('.draft-annotation-list');
    await longChatDraft.locator('summary').click();
    await longChatDraft.getByRole('button', { name: 'Find annotation source' }).click();
    const longMarker = page.getByRole('button', { name: 'Edit annotation 1', exact: true });
    await expect(longMarker).toBeInViewport();
    await expect(longComment).toHaveCount(0);
    await expect.poll(() => longMarker.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element;
    })).toBe(true);
  } finally { await app.close(); }
});
