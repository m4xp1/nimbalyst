// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { load, dump } from 'js-yaml';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { createSQLiteStoreAdapter } from '../../database/sqlite/SQLiteStoreAdapter';

const state = vi.hoisted(() => ({ db: null as any, models: new Map<string, any>(), localNumbers: new Map<string, { prefix: string; counter: number }>() }));
vi.mock('../tracker/workspaceLocalKeyStore', () => ({ workspaceLocalKeyStore: {
  read: (workspace: string) => state.localNumbers.get(workspace) ?? {},
  write: (workspace: string, next: { prefix: string; counter: number }) => state.localNumbers.set(workspace, next),
  takenPrefixes: () => [],
} }));
const watchState = vi.hoisted(() => ({ entries: [] as Array<{ changed: (id: string, current: () => boolean) => Promise<void>; track: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>, gate: undefined as Promise<void> | undefined }));
vi.mock('../tracker/portableTrackerWatch', () => ({ createPortableTrackerWatch: vi.fn(async (_workspace: string, changed: (id: string, current: () => boolean) => Promise<void>) => {
  const entry = { changed, track: vi.fn(), dispose: vi.fn() }; watchState.entries.push(entry);
  if (watchState.gate) await watchState.gate;
  return { track: entry.track, dispose: entry.dispose };
}) }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({ database: { query: (...args: any[]) => state.db.query(...args) } }));
vi.mock('../TrackerSyncManager', () => ({ syncTrackerItem: vi.fn(), unsyncTrackerItem: vi.fn(), isTrackerSyncActive: () => false }));
vi.mock('../MainBodyDocService', () => ({ applyHeadlessBodyMarkdown: vi.fn() }));
vi.mock('../TrackerIdentityService', () => ({ getCurrentIdentity: () => ({ email: 'owner@example.test' }) }));
vi.mock('../../utils/store', () => ({ getWorkspaceState: () => ({}), isAnalyticsEnabled: () => false }));
vi.mock('../../../../../tracker-schema/src/TrackerDataModel', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../../../tracker-schema/src/TrackerDataModel')>()), globalRegistry: {
  get: (type: string) => state.models.get(type), getForWorkspace: (_root: string, type: string) => state.models.get(type), hasWorkspaceLayer: () => true,
} }));
import { ElectronDocumentService } from '../ElectronDocumentService';
import { FileTrackerStore } from '../tracker/fileTrackerStore';
import { encodeWorkspaceLocalId } from '../tracker/portableTrackerIdentity';

let service: ElectronDocumentService | undefined;
let sqlite: SQLiteDatabase | undefined;
let workspace: string | undefined;
afterEach(async () => {
  // Reads can start the service's lazy metadata scan. Settle that work before
  // deleting its artificial directory or replacing this fixture's database.
  await (service as any)?.initializationPromise;
  service?.destroy(); service = undefined;
  await sqlite?.close(); sqlite = undefined;
  if (workspace) await fs.rm(workspace, { recursive: true, force: true });
  state.models.clear(); state.localNumbers.clear();
  watchState.entries.length = 0; watchState.gate = undefined; vi.restoreAllMocks();
});

describe('portable card application routes', () => {
  async function oneCard() {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'nimbalyst-portable-comments-'));
    const task = load(await fs.readFile(path.resolve(__dirname, '../../../../../runtime/src/plugins/TrackerPlugin/models/builtins/task.yaml'), 'utf8')) as any;
    state.models.set('task', task);
    await fs.mkdir(path.join(workspace, '.nimbalyst'));
    await fs.writeFile(path.join(workspace, '.nimbalyst/tracker-storage.yaml'), 'version: 1\nmode: files\ndirectories:\n  task: cards/tasks\n');
    sqlite = new SQLiteDatabase({ dbDir: path.join(workspace, 'private-test-db'), schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'), log: () => {} });
    await sqlite.initialize(); state.db = createSQLiteStoreAdapter(sqlite);
    service = new ElectronDocumentService(workspace);
    const item = await service.createTrackerItem({ id: 'watched-card', type: 'task', title: 'Watch', status: 'to-do', priority: 'medium', workspace });
    return { item, store: new FileTrackerStore(workspace), card: await new FileTrackerStore(workspace).read('cards/tasks/watched-card.md') };
  }
  it('refreshes sidecar changes without rewriting Markdown and never recreates a deleted projection', async () => {
    const { item, store, card } = await oneCard();
    const entry = watchState.entries[0]; expect(entry.track).toHaveBeenCalledWith(card.id);
    const changed = vi.fn(); service!.watchTrackerItems(changed);
    const comments = [{ id: 'external-comment', body: 'From Git' }];
    await store.writeComments(card, comments, []);
    await entry.changed(card.id, () => true);
    const row = (await state.db.query('SELECT data FROM tracker_items WHERE id = $1', [item.id])).rows[0];
    expect(JSON.parse(row.data).comments).toEqual(comments);
    expect((await store.read(card.relativePath)).text).toBe(card.text);
    expect(changed).toHaveBeenCalledTimes(1);
    await entry.changed(card.id, () => true); expect(changed).toHaveBeenCalledTimes(1);
    // Deleting the row while the sidecar read is in flight must not upsert it back.
    await store.writeComments(card, [{ id: 'newer', body: 'Later' }], comments);
    const original = FileTrackerStore.prototype.readComments;
    vi.spyOn(FileTrackerStore.prototype, 'readComments').mockImplementationOnce(async function(this: FileTrackerStore, value: { id: string }) {
      const result = await original.call(this, value);
      await state.db.query('DELETE FROM tracker_items WHERE id = $1', [item.id]);
      return result;
    });
    await entry.changed(card.id, () => true);
    expect((await state.db.query('SELECT id FROM tracker_items WHERE id = $1', [item.id])).rows).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it('reports saved-but-unindexed creation and safely reuses its ID after recovery', async () => {
    await oneCard();
    const payload = { id: 'projection-failure', type: 'task', title: 'Saved once', status: 'to-do', priority: 'medium', workspace: workspace! };
    vi.spyOn(service as any, 'projectPortableCard').mockRejectedValueOnce(new Error('test database unavailable'));
    await expect(service!.createTrackerItem(payload)).rejects.toMatchObject({ itemId: encodeWorkspaceLocalId(workspace!, payload.id), shared: false });
    const file = path.join(workspace!, 'cards/tasks/projection-failure.md');
    const original = await fs.readFile(file, 'utf8');
    const recovered = await service!.createTrackerItem(payload);
    expect(recovered.id).toBe(encodeWorkspaceLocalId(workspace!, payload.id));
    expect(await fs.readFile(file, 'utf8')).toBe(original);
    expect((await fs.readdir(path.dirname(file))).filter(name => name.includes('projection-failure'))).toEqual(['projection-failure.md']);
  });
  it('recognizes tracker headers beyond 4 KiB during a large-project scan', async () => {
    await oneCard();
    const file = path.join(workspace!, 'late-marker.md');
    await fs.writeFile(file, `\uFEFF---\nnotes: ${'x'.repeat(6000)}\ntrackerStatus:\n  type: task\n---\nbody`);
    expect(await (service as any).hasTrackerFrontmatter(file)).toBe(true);
  });
  it('writes secondary type relationships as portable IDs and restores their local projection', async () => {
    const { item, store, card } = await oneCard();
    const release = load(await fs.readFile(path.resolve(__dirname, '../../../../../runtime/src/plugins/TrackerPlugin/models/builtins/release.yaml'), 'utf8')) as any;
    state.models.set('release', release);
    const target = await service!.createTrackerItem({ id: 'secondary-target', type: 'task', title: 'Target', status: 'to-do', priority: 'medium', workspace: workspace! });
    await service!.updateTrackerItem(item.id, { typeTags: ['task', 'release'], items: [target.id] });
    expect((await store.read(card.relativePath)).fields.items).toEqual([{ itemId: 'secondary-target' }]);
    expect((await service!.getTrackerItemById(item.id))?.customFields?.items).toEqual([{ itemId: target.id }]);
  });
  it('creates reciprocal file relationships once and rejects raw or local self references before writing', async () => {
    const { item: target, store, card: targetCard } = await oneCard();
    const payload = { id: 'dependency-source', type: 'task', title: 'Dependent', status: 'to-do', priority: 'medium', workspace: workspace!, customFields: { dependsOn: [target.id] } };
    const item = await service!.createTrackerItem(payload);
    const beforeRetry = await store.read(targetCard.relativePath);
    expect(beforeRetry.fields.blocks).toEqual(expect.arrayContaining([expect.objectContaining({ itemId: payload.id })]));
    await service!.createTrackerItem(payload);
    expect((await store.read(targetCard.relativePath)).text).toBe(beforeRetry.text);
    const source = await store.read(`cards/tasks/${payload.id}.md`);
    await expect(service!.updateTrackerItem(item.id, { dependsOn: [payload.id] })).rejects.toThrow(/self/i);
    await expect(service!.updateTrackerItem(item.id, { dependsOn: [item.id] })).rejects.toThrow(/self/i);
    expect((await store.read(source.relativePath)).text).toBe(source.text);
    await expect(service!.createTrackerItem({ ...payload, id: 'self-reference', customFields: { dependsOn: ['self-reference'] } })).rejects.toThrow(/self/i);
    await expect(fs.readFile(path.join(workspace!, 'cards/tasks/self-reference.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('disposes a late subscription and ignores callback completion after service destruction', async () => {
    let release!: () => void;
    watchState.gate = new Promise<void>(resolve => { release = resolve; });
    const { card, store } = await oneCard();
    const entry = watchState.entries[0], changed = vi.fn(); service!.watchTrackerItems(changed);
    service!.destroy(); release(); await vi.waitFor(() => expect(entry.dispose).toHaveBeenCalledOnce());
    expect(entry.track).not.toHaveBeenCalled();
    await store.writeComments(card, [{ id: 'late', body: 'Late' }], []);
    await entry.changed(card.id, () => true); expect(changed).not.toHaveBeenCalled();
  });
  it('creates all builtin types without changing their schemas, edits files first, restores stable IDs and keeps unavailable sources', async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'nimbalyst-portable-service-'));
    const builtins = path.resolve(__dirname, '../../../../../runtime/src/plugins/TrackerPlugin/models/builtins');
    const directories: Record<string, string> = {};
    for (const name of await fs.readdir(builtins)) {
      if (!name.endsWith('.yaml')) continue;
      const model = load(await fs.readFile(path.join(builtins, name), 'utf8')) as any;
      state.models.set(model.type, model); directories[model.type] = `cards/${model.type}`;
    }
    expect([...state.models.keys()].sort()).toEqual(['bug', 'capture', 'citation', 'decision', 'github-issue', 'github-pr', 'idea', 'milestone', 'plan', 'release', 'source', 'task']);
    await fs.mkdir(path.join(workspace, '.nimbalyst'));
    await fs.writeFile(path.join(workspace, '.nimbalyst/tracker-storage.yaml'), dump({ version: 1, mode: 'files', directories }));
    sqlite = new SQLiteDatabase({ dbDir: path.join(workspace, 'private-test-db'), schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'), log: () => {} });
    await sqlite.initialize(); state.db = createSQLiteStoreAdapter(sqlite);
    service = new ElectronDocumentService(workspace);
    const store = new FileTrackerStore(workspace);
    // Use actual builtin fields rather than an arbitrary custom-field bag. The
    // matrix covers strings, dates, datetimes, numbers, arrays, URLs and objects.
    const specificFields: Record<string, { initial: Record<string, unknown>; updated: Record<string, unknown> }> = {
      capture: {
        initial: { capturedAt: '2026-11-01T10:00:00.000Z', resolvedUrl: 'https://example.test/first', contentType: 'text/plain', digest: 'sha256-first', outcome: 'retrieved' },
        updated: { capturedAt: '2026-11-02T11:30:00.000Z', resolvedUrl: 'https://example.test/second', contentType: 'text/markdown', digest: 'sha256-second', outcome: 'partial' },
      },
      citation: {
        initial: { locator: { selectorType: 'repo-lines', version: 1, repository: 'github.com/example/project', commit: 'a'.repeat(40), path: 'docs/first.md', startLine: 2, endLine: 4 }, excerpt: 'Original evidence', explanation: 'Original reasoning', relation: 'supports' },
        updated: { locator: { selectorType: 'repo-lines', version: 1, repository: 'github.com/example/project', commit: 'b'.repeat(40), path: 'docs/second.md', startLine: 7, endLine: 9 }, excerpt: 'Revised evidence', explanation: 'Revised reasoning', relation: 'context' },
      },
      decision: {
        initial: { chosen: 'Option A', stakeholders: ['owner@example.test'] },
        updated: { chosen: 'Option B', stakeholders: ['owner@example.test', 'reviewer@example.test'] },
      },
      milestone: {
        initial: { startDate: '2026-11-01', targetDate: '2026-12-01' },
        updated: { startDate: '2026-11-02', targetDate: '2026-12-02' },
      },
      plan: {
        initial: { planType: 'feature', progress: 20, startDate: '2026-11-01', stakeholders: ['owner@example.test'] },
        updated: { planType: 'research', progress: 70, startDate: '2026-11-02', stakeholders: ['owner@example.test', 'reviewer@example.test'] },
      },
      release: {
        initial: { version: '1.0.0', gitTag: 'v1.0.0', channel: 'alpha', releasedAt: '2026-11-01T10:00:00.000Z' },
        updated: { version: '1.1.0', gitTag: 'v1.1.0', channel: 'stable', releasedAt: '2026-11-02T11:30:00.000Z' },
      },
      source: {
        initial: { url: 'https://example.test/original', publisher: 'Original publisher', sourceKind: 'web-page', aliases: ['original-source'] },
        updated: { url: 'https://example.test/revised', publisher: 'Revised publisher', sourceKind: 'repository', aliases: ['original-source', 'revised-source'] },
      },
    };
    const saved = new Map<string, Awaited<ReturnType<FileTrackerStore['read']>>>();
    for (const [type, model] of state.models) {
      const workflow = model.fields.find((field: any) => field.name === 'status');
      const status = workflow?.default ?? workflow?.options?.[0]?.value ?? '';
      const nextStatus = workflow.options.find((option: any) => option.value !== status)?.value;
      expect(nextStatus, `${type} has another real workflow status`).toBeTruthy();
      const specific = specificFields[type] ?? { initial: {}, updated: {} };
      for (const name of Object.keys(specific.initial)) {
        expect(model.fields.some((field: any) => field.name === name), `${type}.${name} is a builtin field`).toBe(true);
      }
      const payload = { id: `${type}-stable-id`, creationRequestId: `${type}-stable-id`, type, workspace, title: `${type} title`, status, priority: 'medium',
        description: 'Short summary', tags: ['vpn'], owner: 'owner@example.test', content: '# Details\n\n| A | B |\n|---|---|\n| 1 | 2 |\n', customFields: { custom: 'keep this', ...specific.initial } };
      const item = await service.createTrackerItem(payload);
      expect(item.id).toBe(encodeWorkspaceLocalId(workspace, payload.id));
      expect(item.issueKey).toBe(`${type}-${payload.id}`.toUpperCase());
      const retry = await service.createTrackerItem(payload);
      expect(retry.id).toBe(item.id);
      expect(await fs.readdir(path.join(workspace, directories[type]))).toEqual([`${payload.id}.md`]);
      const relative = `${directories[type]}/${payload.id}.md`;
      const before = await store.read(relative);
      const selfIdentifier = type === 'plan' ? { planId: payload.id } : type === 'decision' ? { decisionId: payload.id } : {};
      expect(before.fields).toMatchObject({ title: payload.title, status, key: item.issueKey, owner: payload.owner, tags: payload.tags, ...selfIdentifier, ...specific.initial });
      const typeTags = [type, type === 'task' ? 'bug' : 'task'];
      await service.updateTrackerItem(item.id, { title: `${type} revised title`, status: nextStatus, owner: 'new@example.test', tags: ['vpn', 'review'], typeTags, ...specific.updated });
      const after = await store.read(relative);
      expect(after.fields).toMatchObject({ title: `${type} revised title`, status: nextStatus, key: item.issueKey, owner: 'new@example.test', tags: ['vpn', 'review'], typeTags, custom: 'keep this', description: 'Short summary', ...selfIdentifier, ...specific.updated });
      expect(after.fields.created).toBe(before.fields.created);
      expect(after.body).toBe(before.body);
      await service.updateTrackerItemContent(item.id, 'New body\n', undefined, after.version);
      expect((await store.read(relative)).body).toBe('New body\n');
      expect((await store.read(relative)).fields.description).toBe('Short summary');
      expect((await service.archiveTrackerItem(item.id, true)).archived).toBe(true);
      const archived = await store.read(relative);
      expect(archived.fields.archived).toBe(true);
      saved.set(type, archived);
    }
    // Use a genuinely new database, not just a cleared tracker_items table: no
    // cached metadata, identity or body rows can help restore these cards.
    await (service as any).initializationPromise;
    service.destroy();
    await sqlite.close();
    sqlite = new SQLiteDatabase({ dbDir: path.join(workspace, 'private-restored-db'), schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'), log: () => {} });
    await sqlite.initialize(); state.db = createSQLiteStoreAdapter(sqlite);
    expect((await state.db.query('SELECT id FROM tracker_items')).rows).toEqual([]);
    service = new ElectronDocumentService(workspace);
    await service.refreshWorkspaceData();
    const restored = await service.listTrackerItems();
    expect(restored.map(item => item.id).sort()).toEqual([...state.models.keys()].map(type => encodeWorkspaceLocalId(workspace!, `${type}-stable-id`)).sort());
    expect(restored.every(item => item.archived && item.owner === 'new@example.test')).toBe(true);
    for (const item of restored) {
      const card = saved.get(item.type)!;
      expect(item).toMatchObject({ title: card.fields.title, status: card.fields.status, issueKey: card.fields.key, owner: card.fields.owner, tags: card.fields.tags, typeTags: card.fields.typeTags, created: card.fields.created, updated: card.fields.updated });
      expect(item.customFields).toMatchObject(specificFields[item.type]?.updated ?? {});
      const row = (await state.db.query('SELECT data FROM tracker_items WHERE id = $1', [item.id])).rows[0];
      expect(JSON.parse(row.data)).toMatchObject({ ...card.fields, portableId: card.id, trackerFormat: 1 });
      expect((await store.read(card.relativePath)).text).toBe(card.text);
    }
    const file = path.join(workspace, 'cards/task/task-stable-id.md');
    await fs.rename(file, `${file}.offline`);
    await expect(service.archiveTrackerItem('task-stable-id', false)).rejects.toThrow();
    expect((await state.db.query('SELECT archived FROM tracker_items WHERE id = $1', [encodeWorkspaceLocalId(workspace, 'task-stable-id')])).rows[0].archived).toBe(1);
    // Session-only state must still work while the file is unavailable.
    await service.updateTrackerItem('task-stable-id', { linkedSessions: ['local-session'] });
    await fs.rename(`${file}.offline`, file);
    await service.deleteTrackerItem('task-stable-id');
    await expect(fs.readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await state.db.query('SELECT id FROM tracker_items WHERE id = $1', [encodeWorkspaceLocalId(workspace, 'task-stable-id')])).rows).toEqual([]);
  });
});
