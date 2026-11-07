// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import { createSQLiteStoreAdapter } from '../../../database/sqlite/SQLiteStoreAdapter';
import { FileTrackerStore } from '../fileTrackerStore';
import { projectPortableTracker } from '../portableTrackerProjection';
import { encodeWorkspaceLocalId, mapPortableTrackerRelationshipIds } from '../portableTrackerIdentity';
import type { FieldDefinition } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';

const roots: string[] = [];
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.(); close = undefined;
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
describe.each(['sqlite', 'pglite'] as const)('portable tracker on %s', backend => {
  it('rejects same-workspace native and legacy ID collisions without changing files or rows, but allows a foreign workspace ID', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-tracker-collision-')); roots.push(workspace);
    const foreignWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-tracker-foreign-')); roots.push(foreignWorkspace);
    await fs.mkdir(path.join(workspace, '.nimbalyst'));
    await fs.writeFile(path.join(workspace, '.nimbalyst/tracker-storage.yaml'), 'version: 1\nmode: files\ndirectories:\n  task: docs/tasks\n');
    const store = new FileTrackerStore(workspace);
    let db: any;
    if (backend === 'sqlite') {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-collision-db-')); roots.push(directory);
      const sqlite = new SQLiteDatabase({ dbDir: directory, schemaDir: path.resolve(__dirname, '../../../database/sqlite/schemas'), log: () => {} });
      await sqlite.initialize(); db = createSQLiteStoreAdapter(sqlite); close = () => sqlite.close();
    } else {
      const pg = new PGlite(); close = () => pg.close(); db = pg;
      await pg.exec(`CREATE TABLE tracker_items (id TEXT PRIMARY KEY, type TEXT, type_tags TEXT[], data JSONB,
        workspace TEXT, document_path TEXT, line_number INTEGER, created TIMESTAMPTZ, updated TIMESTAMPTZ,
        last_indexed TIMESTAMPTZ, sync_status TEXT, content JSONB, archived BOOLEAN, archived_at TIMESTAMPTZ,
        source TEXT, source_ref TEXT, issue_key TEXT);`);
    }
    for (const source of ['native', 'frontmatter']) {
      for (const scope of ['same', 'foreign']) {
        const id = `${scope}-${source}-card`;
        const card = await store.create({ id, type: 'task', fields: { title: 'From Git', status: 'to-do' }, body: '# Preserve this Markdown\n' });
        const text = await fs.readFile(path.join(workspace, card.relativePath), 'utf8');
        await db.query(`INSERT INTO tracker_items (id, type, data, workspace, created, updated, last_indexed, sync_status, archived, source)
          VALUES ($1, 'task', $2, $3, NOW(), NOW(), NOW(), 'local', FALSE, $4)`,
        [id, JSON.stringify({ title: 'Existing card', untouched: true }), scope === 'same' ? workspace : foreignWorkspace, source]);
        const existing = (await db.query('SELECT * FROM tracker_items WHERE id = $1', [id])).rows[0];
        if (scope === 'same') {
          await expect(projectPortableTracker(db, workspace, card)).rejects.toThrow(/already belongs to.*database.*legacy/i);
          expect((await db.query('SELECT id FROM tracker_items WHERE id = $1', [encodeWorkspaceLocalId(workspace, id)])).rows).toEqual([]);
        } else {
          expect((await projectPortableTracker(db, workspace, card)).id).toBe(encodeWorkspaceLocalId(workspace, id));
        }
        expect((await db.query('SELECT * FROM tracker_items WHERE id = $1', [id])).rows[0]).toEqual(existing);
        expect(await fs.readFile(path.join(workspace, card.relativePath), 'utf8')).toBe(text);
      }
    }
  });

  it('restores current facts and comments from files, retains only local state, and does not cache the body', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-tracker-')); roots.push(workspace);
    await fs.mkdir(path.join(workspace, '.nimbalyst'));
    await fs.writeFile(path.join(workspace, '.nimbalyst/tracker-storage.yaml'), 'version: 1\nmode: files\ndirectories:\n  task: docs/tasks\n');
    const store = new FileTrackerStore(workspace);
    let db: any;
    if (backend === 'sqlite') {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-projection-db-')); roots.push(directory);
      const sqlite = new SQLiteDatabase({ dbDir: directory, schemaDir: path.resolve(__dirname, '../../../database/sqlite/schemas'), log: () => {} });
      await sqlite.initialize(); db = createSQLiteStoreAdapter(sqlite); close = () => sqlite.close();
    } else {
      const pg = new PGlite(); close = () => pg.close(); db = pg;
      await pg.exec(`CREATE TABLE tracker_items (id TEXT PRIMARY KEY, type TEXT, type_tags TEXT[], data JSONB,
        workspace TEXT, document_path TEXT, line_number INTEGER, created TIMESTAMPTZ, updated TIMESTAMPTZ,
        last_indexed TIMESTAMPTZ, sync_status TEXT, content JSONB, archived BOOLEAN, archived_at TIMESTAMPTZ,
        source TEXT, source_ref TEXT, issue_key TEXT);`);
    }
    let card = await store.create({ id: 'card-stable-id', type: 'task', fields: {
      title: 'Задача', status: 'to-do', priority: 'medium', owner: 'owner@example.test',
      key: 'TASK-stable', typeTags: ['task', 'bug'], tags: ['vpn'], dependsOn: ['other-card'],
      customField: 'custom', description: 'Short searchable description',
    }, body: '# Full body\n\n| Header |\n| --- |\n| Data |\n' });
    const comments = [{ id: 'comment-1', body: 'Discuss design', createdAt: 100, authorIdentity: { displayName: 'Owner' }, deleted: false }];
    await store.writeComments(card, comments, []);
    const original = await fs.readFile(path.join(workspace, card.relativePath), 'utf8');
    let row = await projectPortableTracker(db, workspace, card, await store.readComments(card));
    expect(row.id).toBe(encodeWorkspaceLocalId(workspace, card.id));
    const data = (r: any) => typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    expect(data(row)).toMatchObject({ customField: 'custom', dependsOn: ['other-card'], comments });
    expect(row.issue_key).toBe('TASK-stable');
    expect(row.content).toBeNull();
    expect(await fs.readFile(path.join(workspace, card.relativePath), 'utf8')).toBe(original);
    await db.query('UPDATE tracker_items SET data = $1 WHERE id = $2', [JSON.stringify({ ...data(row), linkedSessions: ['machine-local'], activity: [{ action: 'opened' }], metaAgent: { sessionId: 'local-review' } }), row.id]);
    card = await store.update(card.relativePath, { status: 'done', customField: null, typeTags: ['task'], archived: true }, card.version);
    row = await projectPortableTracker(db, workspace, card, comments);
    expect(data(row)).toMatchObject({ status: 'done', linkedSessions: ['machine-local'], activity: [{ action: 'opened' }], metaAgent: { sessionId: 'local-review' }, comments });
    expect(data(row)).not.toHaveProperty('customField');
    expect(Boolean(row.archived)).toBe(true);
    expect(typeof row.type_tags === 'string' ? JSON.parse(row.type_tags) : row.type_tags).toEqual(['task']);
    await db.query('DELETE FROM tracker_items WHERE id = $1', [row.id]);
    row = await projectPortableTracker(db, workspace, await new FileTrackerStore(workspace).read(card.relativePath), comments);
    expect(data(row)).toMatchObject({ status: 'done', comments });
    expect(data(row)).not.toHaveProperty('linkedSessions');
    expect(data(row)).not.toHaveProperty('metaAgent');
    expect(String(data(row).created)).toBe(card.fields.created);
    expect(row.content).toBeNull();
    const other = await store.create({ id: 'other-card', type: 'task', fields: { title: 'Other', status: 'to-do' }, body: '' });
    const cloneWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-tracker-clone-')); roots.push(cloneWorkspace);
    await fs.cp(workspace, cloneWorkspace, { recursive: true });
    const cloneStore = new FileTrackerStore(cloneWorkspace);
    const defs: FieldDefinition[] = [{ name: 'dependsOn', type: 'relationship', multiValue: true }];
    const target = await projectPortableTracker(db, workspace, other);
    const cloneTarget = await projectPortableTracker(db, cloneWorkspace, await cloneStore.read(other.relativePath));
    row = await projectPortableTracker(db, workspace, card, comments, defs);
    const clone = await projectPortableTracker(db, cloneWorkspace, await cloneStore.read(card.relativePath), comments, defs);
    expect(clone.id).not.toBe(row.id);
    expect(data(clone)).toMatchObject({ portableId: card.id, status: 'done', comments });
    expect(data(row).dependsOn).toEqual([{ itemId: target.id }]);
    expect(data(clone).dependsOn).toEqual([{ itemId: cloneTarget.id }]);
    expect(target.id).not.toBe(cloneTarget.id);
    expect(mapPortableTrackerRelationshipIds(cloneWorkspace, data(clone), defs, 'toPortable').dependsOn).toEqual([{ itemId: 'other-card' }]);
    const cloneCard = await cloneStore.read(card.relativePath);
    await cloneStore.update(cloneCard.relativePath, { status: 'in-progress' }, cloneCard.version);
    expect((await store.read(card.relativePath)).fields.status).toBe('done');
    expect((await cloneStore.read(card.relativePath)).fields.status).toBe('in-progress');
    // Existing DB/legacy cards remain valid relationship targets in mixed mode.
    await db.query(`INSERT INTO tracker_items (id, type, data, workspace, created, updated, last_indexed, sync_status, archived, source)
      VALUES ($1, 'task', $2, $3, NOW(), NOW(), NOW(), 'local', FALSE, 'native')`, ['native-card', JSON.stringify({ title: 'Native' }), workspace]);
    card = await store.update(card.relativePath, { dependsOn: ['native-card', 'other-card'] }, card.version);
    row = await projectPortableTracker(db, workspace, card, comments, defs);
    expect(data(row).dependsOn).toEqual([{ itemId: 'native-card' }, { itemId: target.id }]);
  });
});
