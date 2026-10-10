// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { createSQLiteStoreAdapter } from '../../database/sqlite/SQLiteStoreAdapter';
import { createPGLiteSessionStore } from '../PGLiteSessionStore';

// Match the real session-search columns; SQLite uses the full production schema.
const pgSchema = `CREATE TABLE worktrees (id text PRIMARY KEY, is_archived boolean DEFAULT false);
CREATE TABLE ai_sessions (id text PRIMARY KEY, workspace_id text, title text, provider text, model text,
 session_type text DEFAULT 'session', mode text, agent_role text, created_by_session_id text,
 worktree_id text, parent_session_id text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
 is_archived boolean DEFAULT false, is_pinned boolean DEFAULT false, branched_from_session_id text,
 branch_point_message_id bigint, branched_at timestamptz);
CREATE TABLE ai_agent_messages (id serial PRIMARY KEY, session_id text, source text, direction text, content text,
 searchable integer, searchable_text text, message_kind text, created_at timestamptz DEFAULT now());`;

describe.each(['sqlite', 'pglite'] as const)('%s Russian session search on real indexes', backend => {
  let sqlite: SQLiteDatabase | undefined, pg: PGlite | undefined, dir: string;
  let db: any, store: ReturnType<typeof createPGLiteSessionStore>;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-russian-fts-'));
    if (backend === 'sqlite') {
      sqlite = new SQLiteDatabase({ dbDir: dir, schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'), sampleRate: 0 });
      await sqlite.initialize(); db = createSQLiteStoreAdapter(sqlite);
    } else { pg = new PGlite(path.join(dir, 'pg')); await pg.exec(pgSchema); db = pg; }
    store = createPGLiteSessionStore(db);
  }, 30000);
  beforeEach(async () => {
    await db.query('DELETE FROM ai_agent_messages'); await db.query('DELETE FROM ai_sessions'); await db.query('DELETE FROM worktrees');
  });
  afterAll(async () => { await sqlite?.close(); await pg?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
  async function seed(id: string, text: string, title = 'Synthetic session', workspace = 'ws', kind = 'user', archived = false, date = new Date()) {
    await db.query('INSERT INTO ai_sessions (id, workspace_id, title, provider, is_archived) VALUES ($1,$2,$3,$4,$5)', [id, workspace, title, 'claude', archived]);
    await db.query(`INSERT INTO ai_agent_messages (session_id, source, direction, content, searchable, searchable_text, message_kind, created_at)
      VALUES ($1,$2,$3,$4,1,$4,$5,$6)`, [id, kind, kind === 'user' ? 'input' : 'output', text, kind, date]);
  }
  const search = (query: string, options: any = {}) => store.search('ws', query, { timeRange: 'all', ...options });
  it('finds Russian forms, preserves exact priority and deduplicates', async () => {
    await seed('stem', 'На русском языке.'); await seed('exact', 'Слова языками.', 'Synthetic');
    const hits = await search('языками');
    expect(hits.map(x => x.id)).toEqual(['exact', 'stem']);
    expect(hits.map(x => x.keywordMatch)).toEqual(['exact', 'stem']);
    expect((await search('русскими')).map(x => x.id)).toEqual(['stem']);
  });
  it.each(['приёмка', 'ПРИЕМКА', 'прие\u0308мка'])('finds NFC/case/ё variants: %s', async query => {
    await seed('cyrillic', 'ПРИЁМКА прошла успешно.', 'Русская ПРИЁМКА');
    expect((await search(query)).map(x => x.id)).toEqual(['cyrillic']);
  });
  it('finds decomposed text in pre-existing messages', async () => {
    await seed('decomposed', 'Прие\u0308мка завершена.');
    expect((await search('ПРИЕМКА')).map(x => x.id)).toEqual(['decomposed']);
  });
  it('finds forms in titles as well as messages', async () => {
    await seed('title', 'Unrelated message.', 'Русский интерфейс');
    expect((await search('интерфейсами')).map(x => x.id)).toEqual(['title']);
  });
  it('updates the lexicon after changing/deleting text and reopening the search store', async () => {
    await seed('changed', 'русский интерфейс'); expect((await search('интерфейсами')).length).toBe(1);
    await db.query('UPDATE ai_agent_messages SET searchable_text=$1 WHERE session_id=$2', ['русскими языками', 'changed']);
    expect(await search('интерфейсами')).toEqual([]);
    store = createPGLiteSessionStore(db); expect((await search('языке')).length).toBe(1);
    await db.query('DELETE FROM ai_agent_messages WHERE session_id=$1', ['changed']); expect(await search('языке')).toEqual([]);
  });
  it('preserves workspace, archive, period and message direction filters', async () => {
    await seed('input', 'На русском языке.'); await seed('output', 'На русском языке.', undefined, undefined, 'assistant');
    await seed('other', 'На русском языке.', undefined, 'other'); await seed('archived', 'На русском языке.', undefined, undefined, undefined, true);
    await seed('old', 'На русском языке.', undefined, undefined, undefined, false, new Date('2020-01-01'));
    expect(new Set((await search('языками', { direction: 'input', timeRange: '7d' })).map(x => x.id))).toEqual(new Set(['input']));
    expect((await search('языками', { direction: 'output' })).map(x => x.id)).toEqual(['output']);
    expect((await search('языками', { includeArchived: true })).some(x => x.id === 'archived')).toBe(true);
  });
  it('handles null transitions and retains indexed words after a real database restart', async () => {
    await seed('restart', 'На русском языке.');
    await db.query('UPDATE ai_agent_messages SET searchable_text=NULL WHERE session_id=$1', ['restart']);
    expect(await search('языками')).toEqual([]);
    await db.query('UPDATE ai_agent_messages SET searchable_text=$1 WHERE session_id=$2', ['русский интерфейс', 'restart']);
    expect((await search('интерфейсами')).map(x => x.id)).toEqual(['restart']);
    if (backend === 'sqlite') {
      await sqlite!.close(); sqlite = new SQLiteDatabase({dbDir: dir, schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'), sampleRate: 0});
      await sqlite.initialize(); db = createSQLiteStoreAdapter(sqlite);
    } else { await pg!.close(); pg = new PGlite(path.join(dir, 'pg')); db = pg; }
    store = createPGLiteSessionStore(db);
    expect((await search('интерфейсами')).map(x => x.id)).toEqual(['restart']);
  });
  it('keeps technical tokens and English FTS behavior', async () => {
    await seed('tech', 'RUSMEMORY7419 migration language');
    expect((await search('RUSMEMORY7419')).map(x => x.id)).toEqual(['tech']);
    expect((await search('migration')).map(x => x.id)).toEqual(['tech']);
    expect(await search('интерфейсами')).toEqual([]);
  });
});
