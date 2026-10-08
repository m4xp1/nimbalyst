// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Bm25Index, termFrequencies, tokenize } from '../retrieval/bm25.js';
import RussianStemmer from '../retrieval/snowball/russian-stemmer.js';
import { FactsStore } from '../facts/facts.js';
import { MemoryEngine } from '../engine.js';
import { SqliteStore } from '../store/sqliteStore.js';
import type { StoredChunk } from '../types.js';

const roots: string[] = [];
const temporary = () => { const p = mkdtempSync(path.join(tmpdir(), 'mem-stems-')); roots.push(p); return p; };
afterEach(() => { vi.restoreAllMocks(); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const doc = (id: string, text: string) => ({ id, tf: termFrequencies(text) });

describe('additive Russian Snowball projection', () => {
  it.each([
    ['язык', 'на русском языке'], ['языками', 'на русском языке'],
    ['русский', 'на русском языке'], ['русскому', 'русский'],
    ['интерфейс', 'дизайн интерфейса'], ['интерфейсами', 'дизайн интерфейса'],
    ['ЁЛКА', 'елками'], ['«ЯЗЫК!»', 'языке'],
  ])('finds %s in %s without replacing persisted terms', (query, text) => {
    const original = doc('target', text);
    const before = JSON.stringify(original.tf);
    const hits = new Bm25Index([original]).search(query);
    expect(hits.map(h => h.id)).toEqual(['target']);
    expect(hits[0].keywordMatch).toBe('stem');
    expect(JSON.stringify(original.tf)).toBe(before);
  });

  it('preserves exact BM25 values and order ahead of stronger stem-only matches', () => {
    const docs = [doc('stem', 'языке'), doc('exact-a', 'язык длинный посторонний документ'), doc('exact-b', 'язык')];
    const hits = new Bm25Index(docs).search('язык');
    expect(hits.map(h => [h.id, h.keywordMatch])).toEqual([
      ['exact-b', 'exact'], ['exact-a', 'exact'], ['stem', 'stem'],
    ]);
    // Original BM25 with lengths 1,4,1 and df=2 out of 3.
    const idf = Math.log(1 + (3 - 2 + .5) / (2 + .5));
    expect(hits[0].score).toBeCloseTo(idf * 2.5 / (1 + 1.5 * (.25 + .75 / 2)), 12);
    expect(hits[1].score).toBeCloseTo(idf * 2.5 / (1 + 1.5 * (.25 + .75 * 4 / 2)), 12);
    expect(new Set(hits.map(h => h.id)).size).toBe(hits.length);
  });

  it('does not stem paths, extensions, numbers, identifiers or mixed scripts', () => {
    const technical = ['src/языке', 'языке.md', 'языке_2', 'языке2', 'uiязыке', 'языке-ui', 'языке/json'];
    for (const token of technical) {
      const index = new Bm25Index([doc('tech', token)]);
      expect(index.search('язык')).toEqual([]);
      expect(index.search(token)).toMatchObject([{ id: 'tech', keywordMatch: 'exact' }]);
    }
    expect(tokenize('src/main.json loadSessionContext 123')).toEqual(['src/main.json', 'loadsessioncontext', '123']);
  });

  it('keeps unrelated Russian words apart and documents expected suffix conflation', () => {
    expect(new Bm25Index([doc('cat', 'кот')]).search('код')).toEqual([]);
    // Snowball is a suffix stemmer, not a dictionary: semantic disambiguation is absent.
    const stemmer = new RussianStemmer();
    expect(stemmer.stem('вина')).toBe(stemmer.stem('вино')); // false positive: fault/wine
    expect(stemmer.stem('орган')).not.toBe(stemmer.stem('органами')); // known false negative
    expect(stemmer.stem('язык')).toBe(stemmer.stem('языке'));
  });

  it('gives recall the same exact-before-stem behavior without an embedding provider', async () => {
    const facts = new FactsStore(temporary(), 'facts');
    await facts.remember({ text: 'Интерфейс продукта должен быть на русском языке.' });
    await facts.remember({ text: 'язык описывает словарь' });
    const hits = await facts.recall({ query: 'язык' });
    expect(hits.map(h => h.text)).toEqual(['язык описывает словарь', 'Интерфейс продукта должен быть на русском языке.']);
    expect((await facts.recall({ query: 'интерфейса' }))[0].text).toContain('Интерфейс');
  });

  it('builds from an old saved lexical index without changing text, vectors, schema or TF', async () => {
    const root = temporary(), dbPath = path.join(root, 'index.db');
    const embedder = { info: { id: 'fake', model: 'saved-model', dims: 2 }, embed: vi.fn(async () => [[1, 0]]) };
    const store = new SqliteStore(dbPath);
    store.setEmbedderInfo(embedder.info);
    store.setSourcePathFormat(2);
    const chunk: StoredChunk = {
      id: 'fact#0', sourcePath: 'fact.md', sourceClass: 'facts', refType: 'doc-file', refId: 'fact.md',
      headingPath: [], ordinal: 0, text: 'Интерфейс продукта на русском языке.',
      sparseTerms: termFrequencies('Интерфейс продукта на русском языке.'), contentHash: 'unchanged',
      denseEmbedding: [1, 0], embedderId: 'fake', model: 'saved-model', dims: 2, updatedAt: 1,
    };
    store.upsertChunks([chunk]); store.close();
    const read = () => {
      const db = new Database(dbPath);
      const result = { rows: db.prepare('SELECT * FROM chunks').all(), schema: db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all(), meta: db.prepare('SELECT * FROM meta ORDER BY key').all() };
      db.close(); return result;
    };
    const before = read();
    const engine = MemoryEngine.create({ root, dbPath, factsDir: 'facts', sources: [] }, embedder);
    try {
      expect(embedder.embed).not.toHaveBeenCalled();
      const hits = await engine.search('язык');
      expect(hits[0].keywordMatch).toBe('stem');
      expect(hits[0].signals).toEqual({ dense: true, sparse: true });
      expect(embedder.embed).toHaveBeenCalledTimes(1); // query only, never saved text
      expect(read()).toEqual(before);
    } finally { await engine.close(); }
  });
});
