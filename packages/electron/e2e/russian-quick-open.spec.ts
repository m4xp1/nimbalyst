import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// A built main bundle or unpacked executable, never the owner's installed profile.
// Memory uses the real engine with a deterministic fake provider in this test process only.
test.describe.serial('Built Electron Russian Quick Open', () => {
  let app: ElectronApplication, page: Page, temp: string, workspace: string;
  const root = path.resolve(__dirname, '../../..');
  const sessionId = 'russian-quick-open-fixture';
  test.beforeAll(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nimbalyst-search-e2e-'));
    workspace = path.join(temp, 'Прие\u0308мка интерфейса');
    await fs.mkdir(path.join(workspace, 'docs'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'docs', 'Прие\u0308мкаИнтерфейса.md'), '# Русский интерфейс\n\n  😀 Прие\u0308мка на русском языке. RUSMEMORY7419\n');
    await fs.writeFile(path.join(workspace, 'Code.js'), 'const marker = "RUSMEMORY7419";\n');
    await fs.writeFile(path.join(workspace, 'docs', 'file-card.md'), '---\ntrackerStatus:\n  type: plan\ntitle: Файловая карточка\nstatus: draft\n---\nFILECARD7831 — актуальное тело файла.\n');
    // Bootstrap's static imports can initialize settings before its body sets
    // userData. Move isolation ahead of the built bundle.
    const isolate = path.join(temp,'isolate.cjs');
    await fs.mkdir(path.join(temp,'user'),{recursive:true});
    const mainPath = process.env.NIMBALYST_E2E_MAIN_PATH ?? path.join(root,'packages/electron/out/main/index.js');
    await fs.writeFile(isolate, `const {app}=require('electron'); app.setPath('userData',${JSON.stringify(path.join(temp,'user'))}); app.setPath('appData',${JSON.stringify(temp)}); app.setAppPath(${JSON.stringify(path.dirname(mainPath))}); require(${JSON.stringify(mainPath)});`);
    const { ELECTRON_RUN_AS_NODE, NODE_PATH, ELECTRON_RENDERER_URL, ...clean } = process.env;
    const executablePath = process.env.NIMBALYST_E2E_APP_PATH;
    app = await _electron.launch({
      ...(executablePath ? { executablePath } : {}),
      args: [...(executablePath ? [`--user-data-dir=${path.join(temp,'user')}`] : [isolate]), '--workspace', workspace],
      cwd: root, timeout: 45000,
      env: { ...clean, PLAYWRIGHT: '1', NIMBALYST_CDP_PORT: '0', NIMBALYST_USER_DATA_DIR: path.join(temp, 'user'), NIMBALYST_USER_DATA_PATH: path.join(temp, 'db'),
        NIMBALYST_PERMISSION_MODE: 'allow-all', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' },
    });
    page = await app.firstWindow();
    await page.getByTestId('tracker-mode-button').waitFor();
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(path.join(temp, 'user'));
    await app.evaluate(async ({ ipcMain, session }, { root, temp, workspace, sessionId }) => {
      const require = process.getBuiltinModule('module')!.createRequire(root + '/package.json');
      // Guard the Electron network as well as removing credentials. No real provider runs.
      (globalThis as any).__searchFakeCalls = 0;
      (globalThis as any).__searchOpenAiRequests = 0;
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*.openai.com/*', '*://openai.com/*'] }, (_details, callback) => {
        (globalThis as any).__searchOpenAiRequests++; callback({ cancel: true });
      });
      const { MemoryEngine } = require(require('node:path').join(root, 'packages/extensions/nimbalyst-memory/engine/dist/engine.js'));
      const engine = MemoryEngine.create({ root: workspace, dbPath: require('node:path').join(temp, 'memory.db'), factsDir: 'facts', sources: [{ sourceClass: 'docs', include: ['docs/**/*.md'] }] }, {
        info: { id: 'fake', model: 'search-ci', dims: 3 },
        embed: async (texts: string[]) => { (globalThis as any).__searchFakeCalls++; return texts.map(() => [1, 0, 0]); },
      });
      await engine.indexAll();
      await engine.syncFileRecords([{id:'tracker:fm:plan:docs/file-card.md',refType:'tracker',refId:'fm:plan:docs/file-card.md',sourceClass:'trackers',title:'Файловая карточка',text:'Type: plan',file:{path:'docs/file-card.md',markerKey:'trackerStatus',typeField:'type',expectedType:'plan',defaultType:'plan',fields:{status:'Status'}}}]);
      (globalThis as any).__searchEngine = engine;
      (globalThis as any).__searchIndexCalls = (globalThis as any).__searchFakeCalls;
      ipcMain.removeHandler('semantic-search:available'); ipcMain.handle('semantic-search:available', () => true);
      ipcMain.removeHandler('semantic-search:query'); ipcMain.handle('semantic-search:query', async (_event, _ws, query, k, classes) => {
        const hits = await engine.search(query, k, classes?.length ? { sourceClasses: classes } : undefined); (globalThis as any).__searchLastHits = hits;
        const entities = new Map();
        for (const h of hits) { const key = `${h.refType}\0${h.refId}`; if (!entities.has(key)) entities.set(key,h); }
        return [...entities.values()].map((h: any) => ({ ...h, title: h.headingPath[0] ?? '', snippet: h.text.slice(0, 240) }));
      });
      // Seed the existing text index, not an AI provider or a second search implementation.
      const Database = require(require('node:path').join(root, 'node_modules/better-sqlite3'));
      const db = new Database(require('node:path').join(temp, 'db/sqlite-db/nimbalyst.sqlite'));
      try {
        db.prepare('INSERT INTO ai_sessions (id, workspace_id, provider, model, title) VALUES (?,?,?,?,?)').run(sessionId, workspace, 'openai-codex', 'gpt-5', 'Русская ПРИЁМКА интерфейса');
        db.prepare("INSERT INTO ai_agent_messages (session_id, source, direction, content, searchable, searchable_text, message_kind, metadata) VALUES (?, 'user', 'input', ?, 1, ?, 'user', ?)").run(sessionId,
          'На русском языке. RUSMEMORY7419', 'На русском языке. RUSMEMORY7419', JSON.stringify({ promptProvenance: { actor: 'human', origin: 'composer' } }));
      } finally { db.close(); }
    }, { root, temp, workspace, sessionId });
    await page.evaluate(async workspace => (window as any).electronAPI.invoke('app-settings:set', 'recent.workspaces', [{path: workspace, name: 'Прие\u0308мка интерфейса', timestamp: Date.now()}]), workspace);
    // Remount after test-only Memory readiness and DB seed so every UI route is real.
    await page.reload(); await page.getByTestId('tracker-mode-button').waitFor();
    const imported = await page.evaluate(async () => (window as any).electronAPI.documentService.importTrackerItemFromFile({relativePath:'docs/file-card.md'}));
    expect(imported.success).toBe(true);
    const win = await app.browserWindow(page); await win.evaluate(w => { w.show(); w.focus(); });
  }, 60000);
  test.afterEach(async ({}, info) => {
    if (page && info.status !== info.expectedStatus) await page.screenshot({ path: info.outputPath('search-failure.png') });
  });
  test.afterAll(async () => {
    if (!app) return;
    await app.evaluate(async () => { await (globalThis as any).__searchEngine?.close(); });
    const timer = setTimeout(() => app.process().kill(), 5000);
    try { await app.close(); } finally { clearTimeout(timer); }
    // Keep fixture/evidence paths for diagnostics; only OS temp is touched.
  });
  async function search(tab: string, query: string) {
    if (!await page.getByTestId('unified-quick-open-search').isVisible()) await page.keyboard.press('Control+o');
    await page.locator('.unified-quick-open-tab').getByText(tab, { exact: true }).click();
    await page.getByTestId('unified-quick-open-search').fill(query);
  }
  async function openRow(row: ReturnType<Page['locator']>) {
    // A newly mounted pane deliberately ignores pointer events until movement.
    await page.mouse.move(1,1);
    await row.click();
    await expect(page.locator('.unified-quick-open-backdrop')).toBeHidden();
  }
  test('Files: NFC/ё/CamelCase, word forms, highlight and opening', async () => {
    await search('Files', 'ПРИЕМКА');
    const row = page.locator('.files-pane .unified-quick-open-item').filter({ hasText: 'Интерфейса.md' }).first();
    await expect(row).toBeVisible(); await expect(row.locator('mark').first()).toContainText('Прие\u0308мка');
    await page.getByTestId('unified-quick-open-search').fill('интерфейсами'); await expect(row).toBeVisible();
    await openRow(row); await expect(page.locator('.file-tabs-container [contenteditable=true]').filter({ visible: true }).first()).toContainText('RUSMEMORY7419');
  });
  test('In Files: forms in phrase order and UTF-16 highlighted source', async () => {
    await search('In Files', 'русскими языками');
    const row = page.locator('.in-files-pane .unified-quick-open-item').filter({ hasText: 'RUSMEMORY7419' }).first();
    await expect(row).toBeVisible(); await expect(row.locator('mark')).toContainText('русском языке');
    await page.getByTestId('unified-quick-open-search').fill('языками русскими'); await expect(row).toBeHidden();
    await page.getByTestId('unified-quick-open-search').fill('ПРИЕМКА'); await expect(row).toBeVisible();
    await expect(row.locator('mark')).toContainText('Прие\u0308мка'); await openRow(row);
  });
  test('Sessions: title forms, message FTS and opening', async () => {
    await search('Sessions', 'приемка');
    const row = page.locator('.sessions-pane .unified-quick-open-item').filter({ hasText: 'Русская ПРИЁМКА интерфейса' }).first();
    await expect(row).toBeVisible(); await expect(row.locator('mark')).toContainText('ПРИЁМКА');
    await page.getByTestId('unified-quick-open-search').fill('интерфейсами'); await expect(row).toBeVisible();
    await page.getByTestId('unified-quick-open-search').fill('языками');
    await page.getByRole('button', { name: 'Search contents' }).click(); await expect(row).toBeVisible();
    await openRow(row); await expect(page.getByText('Русская ПРИЁМКА интерфейса', { exact: true }).first()).toBeVisible();
  });
  test('Prompts: forms, original highlight and session opening', async () => {
    await search('Prompts', 'языками');
    const row = page.locator('.prompts-pane .unified-quick-open-item').filter({ hasText: 'RUSMEMORY7419' }).first();
    await expect(row).toBeVisible(); await expect(row.locator('mark')).toContainText('языке'); await openRow(row);
  });
  test('Projects: normalized Russian name, morphology and selection', async () => {
    await search('Projects', 'ПРИЕМКА');
    const row = page.locator('.projects-pane .unified-quick-open-item').filter({ hasText: 'Прие\u0308мка интерфейса' }).first();
    await expect(row).toBeVisible(); await expect(row.locator('mark').first()).toContainText('Прие\u0308мка');
    await page.getByTestId('unified-quick-open-search').fill('интерфейсами'); await expect(row).toBeVisible();
    expect(await app.evaluate(() => (globalThis as any).__searchFakeCalls - (globalThis as any).__searchIndexCalls)).toBe(0);
    await openRow(row);
  });
  test('Memory: real hybrid engine with fake embeddings, retained lexical signal and opening', async () => {
    await search('Memory', 'интерфейсами');
    const row = page.locator('.search-pane .unified-quick-open-item').filter({ hasText: 'Русский интерфейс' }).first();
    await expect(row).toBeVisible(); expect(await app.evaluate(() => (globalThis as any).__searchLastHits.some((h: any) => h.signals?.sparse && h.keywordMatch === 'stem'))).toBe(true);
    expect(await app.evaluate(() => (globalThis as any).__searchFakeCalls - (globalThis as any).__searchIndexCalls)).toBeGreaterThan(0);
    expect(await app.evaluate(() => (globalThis as any).__searchOpenAiRequests)).toBe(0);
    await openRow(row); await expect(page.locator('.file-tabs-container [contenteditable=true]').filter({ visible: true }).first()).toContainText('RUSMEMORY7419');
  });
  test('Memory: canonical file TRACKER in All/Docs/Trackers and opening the actual card', async () => {
    await search('Memory','FILECARD7831');
    const row = page.locator('.memory-search-pane .unified-quick-open-item').filter({hasText:'Файловая карточка'});
    await expect(row).toHaveCount(1); await expect(row).toContainText('Tracker');
    await page.getByRole('button',{name:'Docs',exact:true}).click(); await expect(row).toHaveCount(0);
    await page.getByRole('button',{name:'Trackers',exact:true}).click(); await expect(row).toHaveCount(1);
    await page.getByRole('button',{name:'All',exact:true}).click(); await expect(row).toHaveCount(1);
    await openRow(row);
    await expect(page.locator('[contenteditable=true]').filter({visible:true}).filter({hasText:'FILECARD7831'}).first()).toBeVisible();
    expect(await app.evaluate(() => (globalThis as any).__searchOpenAiRequests)).toBe(0);
  });
});
