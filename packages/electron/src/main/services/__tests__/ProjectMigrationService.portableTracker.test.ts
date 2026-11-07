// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { encodeWorkspaceLocalId } from '../tracker/portableTrackerIdentity';

vi.mock('electron', async () => ({ app: { getPath: (await import('../../../../test-stubs/privateUserData')).testApp.getPath, getName: () => 'test-app', getVersion: () => '1.0.0', on: vi.fn() } }));
vi.mock('../../window/WindowManager', () => ({ findWindowByWorkspace: vi.fn(() => undefined) }));
import { ProjectMigrationService } from '../ProjectMigrationService';

const fixtures: Array<{ root: string; close(): Promise<void> }> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) { await f.close(); await fs.rm(f.root, { recursive: true, force: true }); }
});
async function fixture(backend: 'sqlite' | 'pglite') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-move-'));
  const workspace = path.join(root, 'project'); await fs.mkdir(workspace);
  let db: any;
  if (backend === 'sqlite') {
    db = new SQLiteDatabase({ dbDir: path.join(root, 'database'), schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'), log: () => {} });
    await db.initialize();
  } else {
    db = new PGlite();
    await db.exec(`CREATE TABLE worktrees (id TEXT PRIMARY KEY, workspace_id TEXT);
      CREATE TABLE tracker_items (id TEXT PRIMARY KEY, type TEXT NOT NULL, data JSONB NOT NULL, workspace TEXT NOT NULL, source TEXT);
      CREATE TABLE tracker_creation_receipts (item_id TEXT PRIMARY KEY REFERENCES tracker_items(id) ON DELETE CASCADE, workspace TEXT NOT NULL, request_hash TEXT NOT NULL, publication_status TEXT NOT NULL, error TEXT);
      CREATE TABLE ai_sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, provider TEXT, metadata JSONB);`);
  }
  fixtures.push({ root, close: () => db.close() });
  const createBackup = vi.fn(async () => ({ success: true }));
  const service = new ProjectMigrationService({ query: db.query.bind(db), createBackup } as any);
  const insert = async (id: string, data: unknown, source: string, ws = workspace) => db.query(
    'INSERT INTO tracker_items (id, type, data, workspace, source) VALUES ($1, $2, $3, $4, $5)', [id, 'task', JSON.stringify(data), ws, source]);
  return { root, workspace, db, service, createBackup, insert };
}

describe.each(['sqlite', 'pglite'] as const)('portable tracker project move guard (%s)', backend => {
  it('refuses Rename and Move before touching repository files, FK receipts, sessions or settings', async () => {
    const f = await fixture(backend);
    const id = encodeWorkspaceLocalId(f.workspace, 'portable-card');
    await f.insert(id, { trackerFormat: 1, portableId: 'portable-card', title: 'Retained card', linkedSessions: ['s1'] }, 'frontmatter');
    await f.db.query('INSERT INTO tracker_creation_receipts (item_id, workspace, request_hash, publication_status) VALUES ($1,$2,$3,$4)', [id, f.workspace, 'same-draft', 'local']);
    await f.db.query('INSERT INTO ai_sessions (id, workspace_id, provider, metadata) VALUES ($1,$2,$3,$4)', ['s1', f.workspace, 'codex', JSON.stringify({ linkedTrackerItemIds: [id] })]);
    const cardPath = path.join(f.workspace, 'portable-card.md'), commentsPath = path.join(f.workspace, 'portable-card.jsonl');
    await fs.writeFile(cardPath, '---\ntrackerFormat: 1\nid: portable-card\ntrackerStatus:\n  type: task\n---\nProject facts\n');
    await fs.writeFile(commentsPath, '{"id":"comment-1","body":"Preserve"}\n');
    const files = await Promise.all([fs.readFile(cardPath), fs.readFile(commentsPath)]);
    const before = JSON.stringify((await f.db.query('SELECT * FROM tracker_items ORDER BY id')).rows);
    const migrate = vi.spyOn(f.service as any, 'migrateDatabase');
    const settings = vi.spyOn(f.service as any, 'migrateWorkspaceSettings');
    const recent = vi.spyOn(f.service as any, 'updateRecentWorkspaces');
    const allowed = await f.service.canMoveProject(f.workspace);
    expect(allowed.canMove).toBe(false);
    expect(allowed.reason).toMatch(/file.*tracker.*workspace-local/i);
    expect(allowed.reason).toMatch(/open.*new path/i);
    expect(await f.service.renameProject(f.workspace, 'renamed')).toMatchObject({ success: false, error: allowed.reason });
    expect(await f.service.moveProject(f.workspace, path.join(f.root, 'moved'))).toMatchObject({ success: false, error: allowed.reason });
    expect(f.createBackup).not.toHaveBeenCalled(); expect(migrate).not.toHaveBeenCalled(); expect(settings).not.toHaveBeenCalled(); expect(recent).not.toHaveBeenCalled();
    expect(await fs.readdir(f.root)).not.toContain('renamed'); expect(await fs.readdir(f.root)).not.toContain('moved');
    expect(await Promise.all([fs.readFile(cardPath), fs.readFile(commentsPath)])).toEqual(files);
    expect(JSON.stringify((await f.db.query('SELECT * FROM tracker_items ORDER BY id')).rows)).toBe(before);
    expect((await f.db.query('SELECT item_id, workspace FROM tracker_creation_receipts')).rows).toEqual([{ item_id: id, workspace: f.workspace }]);
    const session = (await f.db.query('SELECT workspace_id, metadata FROM ai_sessions WHERE id=$1', ['s1'])).rows[0];
    expect(session.workspace_id).toBe(f.workspace);
    expect(typeof session.metadata === 'string' ? JSON.parse(session.metadata) : session.metadata).toEqual({ linkedTrackerItemIds: [id] });
  });

  it('keeps the existing native and legacy-file preflight available', async () => {
    const f = await fixture(backend);
    await f.insert('native-card', { title: 'Native' }, 'native');
    await f.insert('legacy-card', { title: 'Legacy full document' }, 'frontmatter');
    expect(await f.service.canMoveProject(f.workspace)).toEqual({ canMove: true });
  });

  it('does not block a different project because the shared database has portable cards', async () => {
    const f = await fixture(backend); const other = path.join(f.root, 'other');
    await f.insert(encodeWorkspaceLocalId(other, 'portable-card'), { trackerFormat: 1, portableId: 'portable-card' }, 'frontmatter', other);
    expect(await f.service.canMoveProject(f.workspace)).toEqual({ canMove: true });
  });
});