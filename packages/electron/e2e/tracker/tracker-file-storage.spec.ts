import { isolatedAgentEnvironment } from '../isolatedAgentEnvironment';
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { load } from 'js-yaml';

// The same spec runs against the built main and the unpacked application. Only
// synthetic workspaces/profiles and a fake MCP client are used; no agent turn.
for (const database of ['sqlite', 'pglite'] as const) test.describe.serial(`Portable tracker files (${database})`, () => {
  const root = path.resolve(__dirname, '../../../..');
  const agentId = 'portable-tracker-fake-agent';
  const portableId = 'portable-agent-task-001';
  const legacyText = '---\ntrackerStatus:\n  type: plan\ntitle: Existing legacy plan\nstatus: draft\nupdated: 2026-09-08\n---\n# Legacy body\n\n| A | B |\n| :--- | ---: |\n| 1 | 2 |\n';
  let app: ElectronApplication, page: Page, client: Client;
  let temp: string, workspace: string, profile = 0, closed = true;
  let toolNames: string[] = [];
  let uiCard: any, agentCard: any, nativeId: string, savedAgentFile: Buffer;

  const invoke = (channel: string, ...args: any[]) => page.evaluate(({ channel, args }) =>
    (window as any).electronAPI.invoke(channel, ...args), { channel, args });
  const cards = (): Promise<any[]> => invoke('document-service:tracker-items-list');
  async function call(name: string, args: any = {}) {
    const actualName = toolNames.find(candidate => candidate === name || candidate.endsWith(`__${name}`));
    expect(actualName, `MCP exposes ${name}`).toBeTruthy();
    const result = await client.callTool({ name: actualName!, arguments: args });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return JSON.parse((result.content as any)[0].text);
  }
  async function close() {
    await client?.close();
    if (!app || closed) return;
    const timer = setTimeout(() => app.process().kill(), 5000);
    try { await app.close(); } finally { clearTimeout(timer); closed = true; }
  }
  async function launch() {
    const user = path.join(temp, `user-${profile}`), db = path.join(temp, `db-${profile}`);
    await fs.mkdir(user, { recursive: true }); await fs.mkdir(db, { recursive: true });
    if (database === 'pglite') await fs.writeFile(path.join(db, 'database-backend.json'), JSON.stringify({ backend: 'pglite', setAt: new Date().toISOString(), setBy: 'rollback' }));
    const main = process.env.NIMBALYST_E2E_MAIN_PATH ?? path.join(root, 'packages/electron/out/main/index.js');
    const isolate = path.join(temp, `isolate-${profile}.cjs`);
    await fs.writeFile(isolate, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(user)});app.setPath('appData',${JSON.stringify(temp)});app.setAppPath(${JSON.stringify(path.dirname(main))});require(${JSON.stringify(main)});`);
    const clean = isolatedAgentEnvironment(path.join(temp, 'agent-home')); delete clean.ELECTRON_RENDERER_URL;
    const executablePath = process.env.NIMBALYST_E2E_APP_PATH;
    app = await _electron.launch({ ...(executablePath ? { executablePath } : {}),
      args: [...(executablePath ? [`--user-data-dir=${user}`] : [isolate]), '--workspace', workspace],
      cwd: root, timeout: 45000,
      env: { ...clean, PLAYWRIGHT: '1', NIMBALYST_CDP_PORT: '0', NIMBALYST_ALLOW_OPENAI_API: '0',
        NIMBALYST_PERMISSION_MODE: 'allow-all', NIMBALYST_USER_DATA_DIR: user, NIMBALYST_USER_DATA_PATH: db,
        OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', TMP: path.join(temp, 'tmp'), TEMP: path.join(temp, 'tmp') },
    });
    closed = false; page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.isDestroyed())!.setSize(1024, 768));
    await page.getByTestId('tracker-mode-button').waitFor();
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(user);
    expect((await invoke('db:migration:get-status')).activeBackend).toBe(database);
    const agentEnvironment = await app.evaluate(() => ({
      home: process.getBuiltinModule('os')!.homedir(),
      codexHome: process.env.CODEX_HOME,
      allowed: process.env.NIMBALYST_ALLOW_CODEX_ACCESS,
      desktopPipe: process.env.CODEX_APP_TOOLS_PIPE_PATH,
    }));
    expect(agentEnvironment).toEqual({
      home: path.join(temp, 'agent-home'), codexHome: path.join(temp, 'agent-home', '.codex'),
      allowed: '0', desktopPipe: undefined,
    });
    expect(await invoke('openai-codex:check-login')).toMatchObject({ isLoggedIn: false, authMode: null, email: null });
    expect(await invoke('codex-usage:refresh')).toMatchObject({
      limits: [], limitsAvailable: false, error: 'Codex account access is disabled for this launch.',
    });
    await app.evaluate(({ session }) => {
      (globalThis as any).__trackerOpenAI = 0;
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*.openai.com/*', '*://openai.com/*'] }, (_details, callback) => {
        (globalThis as any).__trackerOpenAI++; callback({ cancel: true });
      });
    });
    expect((await invoke('test:insert-session', { id: agentId, workspaceId: workspace, provider: 'openai-codex', title: 'Fake tracker client' })).success).toBe(true);
    await invoke('permissions:trustWorkspace', workspace);
    const { port } = await invoke('mcp:get-server-port'), { token } = await invoke('mcp:get-auth-token');
    client = new Client({ name: 'portable-tracker-fake-agent', version: '1' }, { capabilities: {} });
    // Built-in tracker tools are served by their dedicated endpoint. The
    // retired bare /mcp endpoint deliberately returns an empty tool surface.
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/trackers?workspacePath=${encodeURIComponent(workspace)}&workspaceId=${encodeURIComponent(workspace)}&sessionId=${agentId}`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    toolNames = (await client.listTools()).tools.map(tool => tool.name);
    expect(toolNames, 'Dedicated tracker endpoint exposes built-in tools').toEqual(expect.arrayContaining(['tracker_create', 'tracker_update', 'tracker_get', 'tracker_add_comment']));
  }
  async function openCard(item: any) {
    const modeButton = page.getByTestId('tracker-mode-button');
    // Clicking the active mode toggles its sidebar; do not hide it on a later
    // card open in this serial workflow.
    if (await modeButton.getAttribute('aria-pressed') !== 'true') await modeButton.click();
    const typeButton = page.locator(`[data-testid="tracker-type-button"][data-tracker-type="${item.type}"]`);
    if (!await typeButton.isVisible()) await page.getByRole('button', { name: 'Show Tracker sidebar', exact: true }).click();
    await typeButton.click();
    const row = page.locator(`[data-testid="tracker-table-row"][data-item-id="${item.id}"]`);
    await expect(row).toBeVisible();
    // A long issue key plus owner/tags must not consume the card title at a narrow window size.
    await expect(row.getByText(item.title, { exact: true })).toBeVisible();
    await row.locator('.tracker-table-cell.title').click();
    await expect(page.locator('.tracker-item-detail')).toBeVisible();
  }
  async function readCard(item: any) {
    const text = await fs.readFile(path.join(workspace, item.sourceRef), 'utf8');
    return { text, fields: load(text.split(/^---\s*$/m)[1]!) as any };
  }
  test.beforeAll(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nimbalyst-portable-tracker-'));
    workspace = path.join(temp, 'Artificial project');
    await fs.mkdir(path.join(workspace, 'docs'), { recursive: true }); await fs.mkdir(path.join(temp, 'tmp'));
    execFileSync('git', ['init', workspace], { stdio: 'ignore', windowsHide: true });
    await fs.writeFile(path.join(workspace, 'docs/legacy.md'), legacyText);
    await launch();
  }, 90000);
  test.afterEach(async ({}, info) => { if (page && info.status !== info.expectedStatus) await page.screenshot({ path: info.outputPath('portable-tracker-failure.png') }); });
  test.afterAll(close);

  test('saves file mode and paths through settings, creates from UI and preserves existing cards', async () => {
    const legacy = await call('tracker_create', { type: 'bug', title: 'Existing database bug' });
    nativeId = legacy.structured.item.id;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.isDestroyed())!.webContents.send('open-settings-command', { category: 'project-trackers', scope: 'project', timestamp: Date.now() }));
    const storage = page.getByRole('region', { name: 'Tracker storage' });
    await storage.getByLabel('New card storage').selectOption('files');
    await storage.getByLabel('Tasks folder', { exact: true }).fill('docs/work/tasks');
    await storage.getByLabel('Bugs folder', { exact: true }).fill('docs/work/bugs');
    await storage.getByRole('button', { name: 'Save storage settings' }).click();
    await expect(storage.getByRole('status')).toContainText('Saved.');
    expect((load(await fs.readFile(path.join(workspace, '.nimbalyst/tracker-storage.yaml'), 'utf8')) as any).directories).toEqual({ task: 'docs/work/tasks', bug: 'docs/work/bugs' });
    await page.getByTestId('tracker-mode-button').click();
    await page.locator('[data-testid="tracker-type-button"][data-tracker-type="task"]').click();
    await page.getByTestId('tracker-toolbar-new-button').click();
    await page.getByTestId('tracker-quick-add-input').fill('Portable UI task');
    await page.getByTestId('tracker-quick-add-input').press('Enter');
    await expect.poll(async () => (await cards()).some(item => item.title === 'Portable UI task')).toBe(true);
    uiCard = (await cards()).find(item => item.title === 'Portable UI task');
    expect(uiCard.source).toBe('frontmatter'); expect(uiCard.sourceRef).toMatch(/^docs[\\/]work[\\/]tasks[\\/].+\.md$/);
    expect((await readCard(uiCard)).fields.trackerFormat).toBe(1);
    expect((await cards()).find(item => item.id === nativeId)?.source).toBe('native');
    expect(await fs.readFile(path.join(workspace, 'docs/legacy.md'), 'utf8')).toBe(legacyText);
    const overrides = await fs.readdir(path.join(workspace, '.nimbalyst/trackers')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    expect(overrides.filter(name => /\.ya?ml$/.test(name))).toEqual([]);
  });

  test('uses actual MCP tools for idempotent create, fields, relations and comments', async () => {
    const request = { id: portableId, type: 'task', title: 'Portable agent task', description: 'Short searchable summary', content: '# Original body\n\n| A | B |\n| :--- | ---: |\n| 1 | 2 |\n' };
    const first = await call('tracker_create', request), retry = await call('tracker_create', request);
    expect(retry.structured.item.id).toBe(first.structured.item.id);
    expect((await cards()).filter(item => item.title === request.title)).toHaveLength(1);
    agentCard = (await cards()).find(item => item.id === first.structured.item.id);
    await call('tracker_update', { id: agentCard.id, status: 'in-progress', priority: 'high', owner: 'fixture-owner', tags: ['portable', 'review'], typeTags: ['task', 'bug'], fields: { dependsOn: [{ itemId: uiCard.id, title: uiCard.title, trackerType: 'task' }] } });
    await call('tracker_add_comment', { trackerId: agentCard.id, body: 'Portable comment survives clean profile' });
    const got = (await call('tracker_get', { id: agentCard.id })).structured.item;
    expect(got).toMatchObject({ status: 'in-progress', priority: 'high', owner: 'fixture-owner', typeTags: ['task', 'bug'], tags: ['portable', 'review'] });
    expect(got.comments).toEqual(expect.arrayContaining([expect.objectContaining({ body: 'Portable comment survives clean profile' })]));
    const stored = await readCard(agentCard);
    expect(stored.fields).toMatchObject({ id: portableId, trackerFormat: 1, owner: 'fixture-owner', status: 'in-progress', description: request.description });
    expect(stored.fields.dependsOn[0].itemId).toBe((await readCard(uiCard)).fields.id);
    expect(stored.fields.comments).toBeUndefined(); expect(stored.fields.activity).toBeUndefined(); expect(stored.fields.linkedSessions).toBeUndefined();
    expect(await fs.readFile(path.join(workspace, `.nimbalyst/tracker-comments/${portableId}.jsonl`), 'utf8')).toContain('Portable comment survives clean profile');
    expect((await readCard(uiCard)).fields.blocks[0].itemId).toBe(portableId);
    await openCard(agentCard);
    await expect(page.getByTestId('tracker-detail-title')).toHaveValue('Portable agent task');
    await expect(page.locator('.tracker-type-tags-editor').getByRole('button', { name: 'Remove Bug type' })).toBeVisible();
    await expect(page.locator('.tracker-item-detail')).toContainText('fixture-owner');
    await page.keyboard.press('Escape');
  });

  test('opening the card and its editor leaves the exact file bytes and mtime unchanged', async () => {
    const file = path.join(workspace, agentCard.sourceRef);
    const before = { bytes: await fs.readFile(file), mtime: (await fs.stat(file)).mtimeMs };
    await openCard(agentCard);
    const button = page.getByTestId('tracker-open-in-editor');
    await expect(button).toBeVisible();
    await button.click();
    await expect(page.locator('.file-tabs-container [contenteditable=true]').filter({ visible: true }).first()).toContainText('Original body');
    // Cross the editor's autosave debounce, not merely the first paint.
    await page.waitForTimeout(1200);
    expect(await fs.readFile(file)).toEqual(before.bytes); expect((await fs.stat(file)).mtimeMs).toBe(before.mtime);
    savedAgentFile = before.bytes;
    expect(await app.evaluate(() => (globalThis as any).__trackerOpenAI)).toBe(0);
  });

  test('rebuilds from project files in a clean profile without migrating old cards', async () => {
    await close(); profile++; await launch();
    // The agent may read a raw portable ID before anyone opens the board.
    expect((await call('tracker_get', { id: portableId })).structured.item.portableId).toBe(portableId);
    await expect.poll(async () => (await cards()).some(item => item.issueKey === agentCard.issueKey), { timeout: 20000 }).toBe(true);
    const restored = (await cards()).find(item => item.issueKey === agentCard.issueKey);
    expect(restored).toMatchObject({ source: 'frontmatter', title: 'Portable agent task', status: 'in-progress', priority: 'high', owner: 'fixture-owner', typeTags: ['task', 'bug'] });
    const got = (await call('tracker_get', { id: restored.id })).structured.item;
    expect(got.comments).toEqual(expect.arrayContaining([expect.objectContaining({ body: 'Portable comment survives clean profile' })]));
    expect(got.customFields.dependsOn[0].itemId).toBe((await cards()).find(item => item.issueKey === uiCard.issueKey).id);
    expect((await cards()).some(item => item.id === nativeId)).toBe(false);
    expect(await fs.readFile(path.join(workspace, restored.sourceRef))).toEqual(savedAgentFile);
    expect(await fs.readFile(path.join(workspace, 'docs/legacy.md'), 'utf8')).toBe(legacyText);
    expect((await invoke('document-service:tracker-storage:get', { workspacePath: workspace })).config.mode).toBe('files');
    expect(await app.evaluate(() => (globalThis as any).__trackerOpenAI)).toBe(0);
  }, 90000);
});
