import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { ACTIVE_EDITOR_SELECTOR, createTempWorkspace, dismissProjectTrustToast, launchElectronApp, waitForAppReady } from '../helpers';
import { closeTabByFileName, openFileFromTree, PLAYWRIGHT_TEST_SELECTORS } from '../utils/testHelpers';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

const checkpointWithTables = [
  '---\nstatus: draft\n# Keep these original bytes.\nupdated: 2026-11-07\n---\n\n# Checkpoint\n',
  ...Array.from({ length: 70 }, (_, i) =>
    `\n## Milestone ${i}\n\n| Status | Note |\n|---|---|\n| Pending | _Entry ${i}_ |\n`),
].join('');
const sourceRecoveryFixture = '# Source Recovery\n\n_Original formatting_\n\n' + 'a'.repeat(35_000) + '\n';

test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();
  await fs.writeFile(path.join(workspaceDir, 'CHECKPOINT.md'), checkpointWithTables);
  await fs.writeFile(path.join(workspaceDir, 'formatting-recovery.md'), sourceRecoveryFixture);
  electronApp = await launchElectronApp({ workspace: workspaceDir, recordVideo: false });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await waitForAppReady(page);
  await dismissProjectTrustToast(page);
});

test.afterAll(async () => {
  await electronApp?.close();
  if (workspaceDir) await fs.rm(workspaceDir, { recursive: true, force: true });
});

test('opens a checkpoint with tables and a pending review without rewriting the document', async () => {
  const filePath = path.join(workspaceDir, 'CHECKPOINT.md');
  const agentContent = checkpointWithTables.replace('| Pending | _Entry 0_ |', '| Ready | _Entry 0_ |');
  await page.evaluate(({ workspace, file, original }) => window.electronAPI.history.createTag(
    workspace, file, 'checkpoint-tables-review', original, 'checkpoint-session', 'checkpoint-edit',
  ), { workspace: workspaceDir, file: filePath, original: checkpointWithTables });
  await fs.writeFile(filePath, agentContent);

  await expect.poll(async () => page.evaluate(file => window.electronAPI.history.getPendingTags(file),
    filePath.replace(/\\/g, '/'))).toContainEqual(expect.objectContaining({ id: 'checkpoint-tables-review' }));
  await openFileFromTree(page, 'CHECKPOINT.md');
  const tab = page.locator('.tab-editor[data-file-path$="CHECKPOINT.md"]');
  await expect(tab.locator('[contenteditable="true"]').first()).toContainText('Checkpoint');
  await expect(tab.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader)).toBeVisible();
  expect(await fs.readFile(filePath, 'utf8')).toBe(agentContent);

  await tab.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffAcceptAllButton).dispatchEvent('click');
  await expect(tab.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader)).toHaveCount(0);
  await expect.poll(() => page.evaluate(file => window.electronAPI.history.getPendingTags(file), filePath)).toEqual([]);
  expect(await fs.readFile(filePath, 'utf8')).toBe(agentContent);
  await closeTabByFileName(page, 'CHECKPOINT.md');
});

test('moves a Markdown edit that exceeds the formatting budget to an unsaved source buffer', async () => {
  const filePath = path.join(workspaceDir, 'formatting-recovery.md');
  const newText = 'Recovered unsaved text. ' + 'z'.repeat(35_000);
  await openFileFromTree(page, 'formatting-recovery.md');
  const tab = page.locator('.tab-editor[data-file-path$="formatting-recovery.md"]');
  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(newText);
  await expect(editor).toContainText('Recovered unsaved text.');
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getFocusedWindow()?.webContents.send('file-save');
  });

  await expect(tab.getByRole('alert')).toContainText('Your edits are still in the editor.');
  await tab.getByRole('button', { name: 'Open Source Mode' }).click();
  await expect(tab.locator('.monaco-markdown-toolbar')).toBeVisible();
  await expect(tab.locator('.monaco-code-editor .view-lines')).toContainText('Recovered unsaved text.');
  // Give the ordinary autosave timer a chance to run before the explicit save.
  await page.waitForTimeout(2500);
  expect(await fs.readFile(filePath, 'utf8')).toBe(sourceRecoveryFixture);
  await tab.getByRole('button', { name: 'Save recovered text' }).click();
  await expect.poll(async () => (await fs.readFile(filePath, 'utf8')).trimEnd()).toBe(`# ${newText}`);
  await closeTabByFileName(page, 'formatting-recovery.md');
});
