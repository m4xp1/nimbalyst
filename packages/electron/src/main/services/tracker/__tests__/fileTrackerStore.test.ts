// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { FileTrackerStore } from '../fileTrackerStore';

describe('file tracker source of truth', () => {
  let root: string;
  let store: FileTrackerStore;
  const draft = { id: '01TESTCARD', type: 'task', fields: { title: 'Работа', status: 'to-do', tags: ['vpn'], owner: 'owner@example.org' }, body: '# Details\n\n| A | B |\n| --- | --- |\n| x | y |\n' };
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'nimbalyst-file-tracker-'));
    await mkdir(path.join(root, '.nimbalyst'));
    await writeFile(path.join(root, '.nimbalyst/tracker-storage.yaml'), 'version: 1\nmode: files\ndirectories:\n  task: docs/tasks\n');
    store = new FileTrackerStore(root);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it('persists once across simultaneous retries and a fresh instance without a database', async () => {
    const [first, retry] = await Promise.all([store.create(draft), store.create(draft)]);
    expect(first.relativePath).toBe('docs/tasks/01TESTCARD.md');
    expect(retry.id).toBe(first.id);
    expect(await readdir(path.join(root, 'docs/tasks'))).toEqual(['01TESTCARD.md']);
    expect((await new FileTrackerStore(root).create(draft)).fields.tags).toEqual(['vpn']);
    await expect(store.create({ ...draft, fields: { ...draft.fields, title: 'Different request' } })).rejects.toThrow(/different/i);
  });
  it('preserves original bytes and timestamps on reads and no-op edits', async () => {
    const card = await store.create(draft);
    const file = path.join(root, card.relativePath);
    const original = (await readFile(file, 'utf8')).replace('owner: owner@example.org', 'owner: owner@example.org # keep me');
    await writeFile(file, original);
    const read = await store.read(card.relativePath);
    await store.update(card.relativePath, { status: 'to-do' }, read.version);
    expect(await readFile(file, 'utf8')).toBe(original);
    const changed = await store.update(card.relativePath, { status: 'in-progress' }, read.version);
    expect(changed.fields.status).toBe('in-progress');
    expect(await readFile(file, 'utf8')).toContain('owner: owner@example.org # keep me');
    expect(changed.body).toBe(draft.body);
    await expect(store.update(card.relativePath, { status: 'done' }, read.version)).rejects.toThrow(/changed/i);
  });
  it('does not create a fallback DB card or delete anything when configuration or path is unavailable', async () => {
    await expect(store.create({ ...draft, type: 'bug' })).rejects.toThrow(/directory/i);
    await expect(store.read('../outside.md')).rejects.toThrow(/relative/i);
    await expect(store.read('docs/tasks/missing.md')).rejects.toThrow();
    expect(await readdir(root)).toEqual(['.nimbalyst']);
  });
  it('rejects oversized headers and metadata instead of dropping content', async () => {
    await expect(store.create({ ...draft, fields: { ...draft.fields, description: 'x'.repeat(501) } })).rejects.toThrow(/500/);
    await expect(store.create({ ...draft, fields: { ...draft.fields, custom: 'я'.repeat(17000) } })).rejects.toThrow(/frontmatter/i);
  });
  it('keeps local-only state out of portable metadata', async () => {
    await expect(store.create({ ...draft, fields: { ...draft.fields, linkedSessions: ['local-session'] } })).rejects.toThrow(/local/i);
  });
  it('saves project settings without migrating cards and detects concurrent config edits', async () => {
    const first = await store.configSnapshot();
    const card = await store.create(draft);
    const next = await store.saveConfig({ ...first.config, mode: 'database' }, first.version);
    expect(next.config.mode).toBe('database');
    expect((await store.read(card.relativePath)).text).toBe(card.text);
    await expect(store.saveConfig(first.config, first.version)).rejects.toThrow(/changed/);
  });
  it('never silently falls back to database mode for an existing empty config', async () => {
    await writeFile(path.join(root, '.nimbalyst/tracker-storage.yaml'), '');
    await expect(store.configSnapshot()).rejects.toThrow(/configuration/i);
  });
  it('stores discussion in JSONL and refuses a stale comment edit', async () => {
    const card = await store.create(draft);
    const comments = [{ id: 'comment-one', body: 'First\nSecond', deleted: false }];
    await store.writeComments(card, comments, []);
    expect(await new FileTrackerStore(root).readComments(card)).toEqual(comments);
    expect((await store.read(card.relativePath)).text).toBe(card.text);
    await expect(store.writeComments(card, [], [])).rejects.toThrow(/changed/);
  });
  it('keeps a retry on the original file after paths change or the file is renamed', async () => {
    const created = await store.create(draft);
    const first = await store.configSnapshot();
    await store.saveConfig({ ...first.config, directories: { task: 'new/tasks' } }, first.version);
    expect((await store.create(draft, created.relativePath)).relativePath).toBe(created.relativePath);
    await expect(readFile(path.join(root, 'new/tasks/01TESTCARD.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    const second = await store.configSnapshot();
    await store.saveConfig(first.config, second.version);
    await rename(path.join(root, created.relativePath), path.join(root, 'docs/tasks/renamed.md'));
    expect((await new FileTrackerStore(root).create(draft)).relativePath).toBe('docs/tasks/renamed.md');
  });
  it('serializes identical IDs across different type destinations', async () => {
    const config = await store.configSnapshot();
    await store.saveConfig({ ...config.config, directories: { task: 'docs/tasks', bug: 'docs/bugs' } }, config.version);
    const results = await Promise.allSettled([store.create(draft), store.create({ ...draft, type: 'bug' })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    // Either realpath may complete first; serialization guarantees one winner,
    // not the completion order of independent filesystem operations.
    const winner = results.find(result => result.status === 'fulfilled')!;
    if (winner.status !== 'fulfilled') throw new Error('Expected one saved card');
    expect(await readdir(path.join(root, 'docs'))).toEqual([winner.value.type === 'task' ? 'tasks' : 'bugs']);
    expect(await readdir(path.dirname(path.join(root, winner.value.relativePath)))).toEqual([`${draft.id}.md`]);
    expect((await store.read(winner.value.relativePath)).id).toBe(draft.id);
  });
});
