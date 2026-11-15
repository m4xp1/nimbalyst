import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchElectronApp, waitForAppReady } from '../helpers';
import { switchToAgentMode } from '../utils/testHelpers';
import { createTestSession, insertMessage } from '../utils/interactivePromptTestHelpers';

test('draft annotation finds its source after virtualization and application restart', async () => {
  test.setTimeout(180_000);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-annotation-reload-'));
  const workspace = path.join(temp, 'workspace');
  await fs.mkdir(workspace);
  const options = { workspace, preserveTestDatabase: true, recordVideo: false as const,
    env: { PLAYWRIGHT_TEST: 'true', NIMBALYST_CDP_PORT: '0', NIMBALYST_USER_DATA_DIR: path.join(temp, 'profile'), NIMBALYST_USER_DATA_PATH: path.join(temp, 'db') } };
  let app = await launchElectronApp(options);
  try {
    let page = await app.firstWindow();
    await waitForAppReady(page);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await switchToAgentMode(page);
    const sessionId = await createTestSession(page, workspace, { title: 'Durable annotation', provider: 'openai-codex', model: 'openai-codex:gpt-6-sol' });
    const input = (id: string, prompt: string) => insertMessage(page, id, 'input', JSON.stringify({ prompt }), { source: 'openai-codex' });
    const output = (id: string, key: string, text: string) => insertMessage(page, id, 'output', JSON.stringify({
      method: 'item/completed', params: { threadId: id, turnId: key, item: { id: key, type: 'agentMessage', phase: 'final_answer', text } },
    }), { source: 'openai-codex', metadata: { transport: 'app-server' } });
    await input(sessionId, 'Start of the annotated passage.');
    await output(sessionId, 'annotated-answer', 'The **durable annotation** ends here.');
    for (let index = 0; index < 40; index++) {
      await input(sessionId, `Later question ${index}`);
      await output(sessionId, `later-${index}`, `Later answer ${index}. ` + 'Unrelated synthetic history. '.repeat(35));
    }
    await page.locator(`#session-list-item-${sessionId}`).click();
    const sessionRoot = () => page.locator(`[data-session-id="${sessionId}"]`).filter({ visible: true }).first();
    const list = () => sessionRoot().locator('.draft-annotation-list');
    const scroll = () => sessionRoot().locator('.rich-transcript-vlist');
    await expect(sessionRoot().getByText('Later question 39', { exact: true })).toBeVisible();
    await scroll().evaluate(element => { element.scrollTop = 0; });
    await expect(sessionRoot().getByText('Start of the annotated passage.', { exact: true })).toBeVisible();
    const original = await sessionRoot().evaluate(root => {
      const paragraphs = [...root.querySelectorAll('p')];
      const start = paragraphs.find(element => element.textContent === 'Start of the annotated passage.')!;
      const end = paragraphs.find(element => element.textContent === 'The durable annotation ends here.')!;
      const range = document.createRange();
      range.setStart(start.firstChild!, 0);
      range.setEnd(end.lastChild!, end.lastChild!.textContent!.length);
      window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
      return { id: start.closest<HTMLElement>('[data-annotation-message-id]')!.dataset.annotationMessageId,
        sequence: start.closest<HTMLElement>('[data-annotation-message-sequence]')?.dataset.annotationMessageSequence };
    });
    await page.getByRole('button', { name: 'Add annotation', exact: true }).click();
    const comment = () => page.getByRole('textbox', { name: 'Annotation comment', exact: true });
    await comment().fill('Persisted across a restart');
    await comment().press('Escape');
    await list().locator('summary').click();
    await expect.poll(() => page.evaluate(async id => {
      const result = await (window as any).electronAPI.invoke('sessions:get', id);
      return result.session?.metadata?.draftAnnotations?.[0]?.comment;
    }, sessionId)).toBe('Persisted across a restart');
    await scroll().evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(sessionRoot().getByText('Start of the annotated passage.', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit annotation 1', exact: true })).toHaveCount(0);
    await list().getByRole('button', { name: 'Find annotation source' }).click();
    await expect(sessionRoot().getByText('Start of the annotated passage.', { exact: true })).toBeInViewport();
    await expect(comment()).toHaveCount(0);
    expect(await page.evaluate(() => [...(CSS.highlights.get('chat-annotations') ?? [])].map(range => range.toString()).join('')))
      .toContain('Start of the annotated passage.');
    await page.getByRole('button', { name: 'Edit annotation 1', exact: true }).click();
    await expect(comment()).toHaveValue('Persisted across a restart');
    await comment().press('Escape');

    // Open another session first at next startup, changing global runtime ID allocation.
    const otherId = await createTestSession(page, workspace, { title: 'Load first after restart', provider: 'openai-codex', model: 'openai-codex:gpt-6-sol' });
    await input(otherId, 'Other session question');
    await output(otherId, 'other-answer', 'Other session answer');
    await page.locator(`#session-list-item-${otherId}`).click();
    await expect(page.getByText('Other session answer', { exact: true })).toBeVisible();
    await app.close();
    app = await launchElectronApp(options);
    page = await app.firstWindow();
    // The saved mode is Agent, whose Files sidebar is intentionally hidden.
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator(`#session-list-item-${otherId}`)).toBeVisible({ timeout: 20_000 });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.locator(`#session-list-item-${otherId}`).click();
    await expect(page.getByText('Other session answer', { exact: true })).toBeVisible();
    await page.locator(`#session-list-item-${sessionId}`).click();
    await expect(list()).toBeVisible();
    await list().locator('summary').click();
    await list().getByRole('button', { name: 'Find annotation source' }).click();
    await expect(sessionRoot().getByText('Start of the annotated passage.', { exact: true })).toBeInViewport();
    await expect(comment()).toHaveCount(0);
    const restored = await sessionRoot().locator(`[data-annotation-message-sequence="${original.sequence}"]`).evaluate(element =>
      (element as HTMLElement).dataset.annotationMessageId);
    expect(restored).not.toBe(original.id);
    expect(await page.evaluate(() => [...(CSS.highlights.get('chat-annotations') ?? [])].map(range => range.toString()).join('')))
      .toContain('The durable annotation ends here.');
    await page.getByRole('button', { name: 'Edit annotation 1', exact: true }).click();
    await expect(comment()).toHaveValue('Persisted across a restart');
    await comment().press('Escape');

    // Releasing the temporary navigation span must not lose the persisted marker.
    await scroll().hover(); await page.mouse.wheel(0, 1500);
    await scroll().evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(sessionRoot().getByText('Start of the annotated passage.', { exact: true })).toHaveCount(0);
    await list().getByRole('button', { name: 'Find annotation source' }).click();
    await expect(sessionRoot().getByText('Start of the annotated passage.', { exact: true })).toBeInViewport();
    await expect(comment()).toHaveCount(0);
  } finally { await app.close(); }
});
