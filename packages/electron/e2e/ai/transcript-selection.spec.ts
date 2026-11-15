import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchElectronApp, waitForAppReady } from '../helpers';
import { switchToAgentMode, PLAYWRIGHT_TEST_SELECTORS } from '../utils/testHelpers';
import { createTestSession, insertMessage } from '../utils/interactivePromptTestHelpers';

test('Agent selections span folded activity, stay attached on scroll and become one draft annotation', async () => {
  test.setTimeout(150_000);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-transcript-selection-'));
  const workspace = path.join(temp, 'workspace');
  await fs.mkdir(workspace);
  const app = await launchElectronApp({ workspace, preserveTestDatabase: true, recordVideo: false,
    env: { PLAYWRIGHT_TEST: 'true', NIMBALYST_CDP_PORT: '0', NIMBALYST_USER_DATA_DIR: path.join(temp, 'profile'), NIMBALYST_USER_DATA_PATH: path.join(temp, 'db') } });
  try {
    const page = await app.firstWindow();
    await waitForAppReady(page);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await switchToAgentMode(page);
    const sessionId = await createTestSession(page, workspace, { title: 'Selection review', provider: 'openai-codex', model: 'openai-codex:gpt-6-sol' });
    const output = (id: string, turnId: string, text: string, phase = 'final_answer') => insertMessage(page, sessionId, 'output', JSON.stringify({
      method: 'item/completed', params: { threadId: 'selection-thread', turnId, item: { id, type: 'agentMessage', phase, text } },
    }), { source: 'openai-codex', metadata: { transport: 'app-server' } });
    const input = (prompt: string) => insertMessage(page, sessionId, 'input', JSON.stringify({ prompt }), { source: 'openai-codex' });
    for (let i = 0; i < 35; i++) {
      await input(`Earlier question ${i}`);
      await output(`filler-${i}`, `turn-${i}`, `Earlier answer ${i}. ` + 'Synthetic transcript filler. '.repeat(30));
    }
    await input('First selected user prompt');
    await output('first-answer', 'first-turn', 'First selected assistant answer.');
    await input('Middle selected user prompt');
    await output('progress', 'middle-turn', 'Checking synthetic files', 'commentary');
    await insertMessage(page, sessionId, 'output', JSON.stringify({ method: 'item/completed', params: {
      threadId: 'selection-thread', turnId: 'middle-turn', item: { id: 'synthetic-command', type: 'commandExecution',
        command: 'echo synthetic', cwd: workspace, status: 'completed', exitCode: 0, aggregatedOutput: 'synthetic' },
    } }), { source: 'openai-codex', metadata: { transport: 'app-server' } });
    await output('middle-answer', 'middle-turn', 'Middle selected assistant answer.');
    await input('Last selected user prompt');
    await output('last-answer', 'last-turn', 'Previous line\n\nActual selected final line.');
    await page.locator(`#session-list-item-${sessionId}`).click();
    const session = page.locator(`[data-session-id="${sessionId}"]`).filter({ visible: true }).first();
    const first = session.getByText('First selected assistant answer.', { exact: true });
    const last = session.getByText('Last selected user prompt', { exact: true });
    const scroll = session.locator('.rich-transcript-vlist');
    const add = page.getByRole('button', { name: 'Add annotation', exact: true });
    await expect(last).toBeVisible();
    await expect(session.getByRole('button', { name: 'Agent activity', exact: true })).toHaveAttribute('aria-expanded', 'false');
    const selectSpan = () => session.evaluate(root => {
      const paragraphs = [...root.querySelectorAll('p')];
      const start = paragraphs.find(p => p.textContent === 'First selected assistant answer.')!.firstChild!;
      const end = paragraphs.find(p => p.textContent === 'Last selected user prompt')!.firstChild!;
      window.getSelection()!.setBaseAndExtent(start, 0, end, end.textContent!.length);
      return window.getSelection()!.toString();
    });
    const selected = await selectSpan();
    expect(selected).toContain('Middle selected user prompt');
    await expect(session.locator('.selection-chip-preview')).toContainText('First selected assistant answer.');
    await expect(add).toBeVisible();
    await last.click();
    await expect(session.locator('.selection-chip-preview')).toHaveCount(0);
    await expect(add).toBeHidden();
    await selectSpan();
    await expect(session.locator('.selection-chip-preview')).toHaveCount(1);
    await session.getByRole('button', { name: 'Remove Selection from context', exact: true }).click();
    await expect(session.locator('.selection-chip-preview')).toHaveCount(0);
    expect(await page.evaluate(() => window.getSelection()!.toString())).toBe('');
    await page.evaluate(() => document.dispatchEvent(new Event('selectionchange')));
    await expect(session.locator('.selection-chip-preview')).toHaveCount(0);
    await selectSpan();
    await expect(add).toBeVisible();
    const before = await add.boundingBox();
    await scroll.evaluate(element => { element.scrollTop -= 50; });
    await expect.poll(async () => (await add.boundingBox())!.y).toBeGreaterThan(before!.y + 20);
    await scroll.evaluate(element => { element.scrollTop = 0; });
    await expect(session.getByText('Earlier question 0', { exact: true })).toBeVisible();
    await expect(add).toBeHidden();
    expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(selected);
    await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(add).toBeVisible();
    expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(selected);
    await add.click();
    const comment = page.getByRole('textbox', { name: 'Annotation comment', exact: true });
    await expect(comment).toBeVisible();
    await comment.fill('A cross-message annotation');
    await comment.press('Escape');
    await expect(session.locator('.selection-chip-preview')).toHaveCount(0);
    const list = session.locator('.draft-annotation-list');
    await list.locator('summary').click();
    await expect(list.getByRole('button', { name: 'Find annotation source' })).toBeVisible();
    await expect(list.getByRole('button', { name: 'Delete annotation' })).toBeVisible();
    expect(await list.evaluate(element => {
      const input = element.closest('.ai-chat-input');
      return input !== null;
    })).toBe(true);
    const quote = list.locator('li button').first();
    await expect(quote).not.toContainText('content_copy');
    await expect(quote).not.toContainText('Finished in');
    expect(await quote.evaluate(element => getComputedStyle(element).color)).not.toBe('rgb(79, 125, 243)');
    await quote.click();
    await expect(list.getByRole('textbox', { name: 'Annotation comment in draft' })).toHaveValue('A cross-message annotation');
    await list.getByRole('button', { name: 'Find annotation source' }).click();
    await expect(first).toBeInViewport();
    await expect(comment).toHaveCount(0);
    await list.getByRole('button', { name: 'Delete annotation' }).click();
    await expect(list).toHaveCount(0);
    await session.evaluate(root => {
      const events: unknown[] = []; (window as any).selectionProbe = events;
      const scroller = root.querySelector('.rich-transcript-vlist')!;
      const record = (reason: string) => {
        const selection = window.getSelection();
        const line = [...root.querySelectorAll('p')].find(p => p.textContent === 'Actual selected final line.');
        events.push({ reason, text: selection?.toString().slice(0, 60), collapsed: selection?.isCollapsed,
          anchor: selection?.anchorNode?.parentElement?.tagName, focus: selection?.focusNode?.parentElement?.tagName,
          top: line?.getBoundingClientRect().top, offset: scroller.scrollTop, height: scroller.scrollHeight, viewport: scroller.clientHeight,
          button: document.querySelector('.add-transcript-selection-to-chat')?.getAttribute('style') });
        if (events.length > 20) events.shift();
      };
      document.addEventListener('selectionchange', () => record('selection'));
      scroller.addEventListener('scroll', () => record('scroll'));
      new ResizeObserver(() => record('resize')).observe(scroller);
      record('before');
    });
    const finalLine = session.getByText('Actual selected final line.', { exact: true });
    // Wheel input also cancels virtua's pending navigation adjustment after Find.
    await scroll.hover(); await page.mouse.wheel(0, 2000);
    await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);
    await expect(finalLine).toBeInViewport();
    // A real selection gesture releases the temporary row span retained by Find.
    await finalLine.click();

    // A backward selection starts after the last character of a previous line.
    // Its button must anchor to the next line's actual selected text.
    await session.evaluate(root => {
      const paragraphs = [...root.querySelectorAll('p')];
      const previous = paragraphs.find(p => p.textContent === 'Previous line')!.firstChild!;
      const actual = paragraphs.find(p => p.textContent === 'Actual selected final line.')!.firstChild!;
      window.getSelection()!.setBaseAndExtent(actual, actual.textContent!.length, previous, previous.textContent!.length);
    });
    await expect(add).toBeVisible().catch(async error => {
      console.log('Selection geometry', await session.evaluate(root => {
        const selected = window.getSelection(), scroller = root.querySelector('.rich-transcript-vlist');
        const button = document.querySelector('.add-transcript-selection-to-chat');
        const line = [...root.querySelectorAll('p')].find(p => p.textContent === 'Actual selected final line.');
        return { selected: selected?.toString(), collapsed: selected?.isCollapsed,
          anchor: selected?.anchorNode?.parentElement?.outerHTML, focus: selected?.focusNode?.parentElement?.outerHTML,
          line: line?.getBoundingClientRect().toJSON(), scroll: scroller?.getBoundingClientRect().toJSON(),
          offset: scroller?.scrollTop, height: scroller?.scrollHeight, button: button?.outerHTML };
      }));
      throw error;
    });
    const caret = await finalLine.evaluate(element => {
      const range = document.createRange(); range.setStart(element.firstChild!, 0); range.collapse(true);
      return range.getBoundingClientRect().toJSON();
    });
    const button = await add.boundingBox();
    expect(button!.y + button!.height).toBeGreaterThan(caret.y - 12);
    expect(button!.y + button!.height).toBeLessThan(caret.y + 5);
    expect(await add.evaluate(element => getComputedStyle(element).userSelect)).toBe('none');
    const start = await first.boundingBox(), end = await last.boundingBox();
    await page.mouse.move(start!.x + 3, start!.y + 8); await page.mouse.down();
    await page.mouse.move(end!.x + end!.width - 3, end!.y + 8, { steps: 4 });
    await expect(add).toHaveCount(0);
    await page.mouse.move(5, 5, { steps: 2 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => {
      const range = window.getSelection()?.getRangeAt(0);
      return Boolean(range?.startContainer.parentElement?.closest('[data-annotation-message-id]') &&
        range.endContainer.parentElement?.closest('[data-annotation-message-id]'));
    })).toBe(true);
    expect(await page.evaluate(() => window.getSelection()!.toString())).not.toContain('Selection review');
    await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(last).toBeInViewport();
    await selectSpan();

    // Sending native Selection without creating an annotation also consumes it.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('ai:sendMessage');
      ipcMain.handle('ai:sendMessage', (event, _message, context, sessionId, workspacePath) => {
        Object.assign(globalThis, { selectedContext: context });
        event.sender.send('ai:message-logged', { sessionId, workspacePath, direction: 'input' });
        return { success: true };
      });
    });
    const composer = session.locator(PLAYWRIGHT_TEST_SELECTORS.agentChatInput);
    await composer.fill('Use the selected context'); await composer.press('Enter');
    await expect(session.locator('.selection-chip-preview')).toHaveCount(0);
    expect(await app.evaluate(() => (globalThis as any).selectedContext.chatAnnotations.length)).toBe(1);
  } catch (error) {
    console.log('Selection probe', JSON.stringify(await (await app.firstWindow()).evaluate(() => (window as any).selectionProbe)));
    throw error;
  } finally { await app.close(); }
});
