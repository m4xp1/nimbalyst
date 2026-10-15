// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initWiki, openWiki, type LocalWiki } from '../index.js';
import { searchDocs, type SearchDoc } from '../search.js';
const doc = (id: string, title: string, body = '', fields = {}): SearchDoc => ({ id, title, body, fields, kind: 'page', type: null, path: id + '.md' });
let root = ''; let wiki: LocalWiki | undefined;
afterEach(async () => { wiki?.close(); wiki = undefined; if (root) await rm(root, { recursive: true, force: true }); root = ''; });
describe('Local Wiki Russian AND search', () => {
  it('matches all terms in any order across title, body and fields; exact precedes forms', () => {
    const docs = [doc('stem', 'Интерфейсами', 'на русском языке', { note: 'Ёлками' }), doc('exact', 'Заметки', 'языками интерфейсами елками')];
    expect(searchDocs(docs, 'ЕЛКАМИ языками интерфейсами', 20).map(h => [h.id, h.keywordMatch])).toEqual([['exact', 'exact'], ['stem', 'stem']]);
    expect(searchDocs(docs, 'интерфейсами, языками! ёлками', 20).map(h => h.id)).toEqual(['exact', 'stem']);
    expect(searchDocs(docs, 'интерфейс отсутствует', 20)).toEqual([]);
  });
  it('keeps Latin substrings and technical identifiers, without stemming inside them', () => {
    for (const marker of ['src/языке.md', 'языке_2', 'языке2', 'uiязыке', 'языке-ui', 'loadSessionContext', '123']) {
      expect(searchDocs([doc('x', marker)], marker.toUpperCase(), 20)).toHaveLength(1);
      expect(searchDocs([doc('x', marker)], 'языками', 20)).toEqual([]);
    }
    expect(searchDocs([doc('x', 'Automation.md')], 'utom', 20)).toHaveLength(1);
  });
  it('snippets point to real word forms with intact combining marks and UTF-16 ranges', () => {
    const hit = searchDocs([doc('x', 'Other', '😀 '.repeat(100) + 'Ёлками и е\u0308лка возле русского языка ' + 'tail '.repeat(60))], 'елка языками', 20)[0];
    expect(hit.keywordMatch).toBe('stem');
    expect(hit.snippet).toContain('Ёлками');
    const words = hit.highlights!.map(r => hit.snippet.slice(r.start, r.end));
    expect(words).toContain('Ёлками'); expect(words).toContain('е\u0308лка'); expect(words).toContain('языка');
    expect(hit.snippet).not.toMatch(/[\uD800-\uDBFF]$/u);
    expect(hit.snippet.length).toBeLessThan(180);
  });
  it('preserves title priority and distinct ids with equal bodies', () => {
    expect(searchDocs([doc('body', 'Other', 'язык'), doc('title', 'ЯЗЫК'), doc('copy', 'Other', 'язык')], 'язык', 20).map(h => h.id)).toEqual(['title', 'body', 'copy']);
  });
  it('searches actual Markdown/CSV, filters before limits, rescans and restarts', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'wiki-ru-')); const dir = path.join(root, 'wiki'), types = path.join(root, 'types');
    await initWiki(dir); await mkdir(types);
    await writeFile(path.join(types, 'idea.yaml'), 'type: idea\nstorage: table\ntitleField: title\nfields:\n  - name: title\n    type: string\n  - name: note\n    type: string\n');
    await writeFile(path.join(dir, 'Note.md'), '---\nid: note\ntype: idea\n---\nНа русском языке\n');
    await writeFile(path.join(dir, 'Hidden.md'), '---\nid: hidden\n---\nязык язык язык\n');
    await writeFile(path.join(dir, 'idea.csv'), 'id,title,note\nrow,Интерфейсами,Ёлками\n');
    wiki = await openWiki(dir, { typesDir: types });
    expect((await wiki.search('елка интерфейс')).map(h => h.id)).toEqual(['row']);
    expect((await wiki.search('язык', { limit: 1, excludeIds: ['hidden'], typeIds: ['idea'] })).map(h => h.id)).toEqual(['note']);
    await rename(path.join(dir, 'Note.md'), path.join(dir, 'Renamed.md')); await wiki.rescan();
    expect((await wiki.search('язык')).find(h => h.id === 'note')?.path).toBe('Renamed.md');
    await writeFile(path.join(dir, 'Renamed.md'), '---\nid: note\ntype: idea\n---\nНовый маркер\n'); await wiki.rescan();
    expect((await wiki.search('язык')).map(h => h.id)).toEqual(['hidden']);
    wiki.close(); wiki = await openWiki(dir, { typesDir: types });
    expect((await wiki.search('новыми маркерами')).map(h => h.id)).toEqual(['note']);
    await rm(path.join(dir, 'Renamed.md'));
    expect(await wiki.search('маркер')).toEqual([]); // no stale scanned body even before the watcher
    await wiki.rescan();
    expect(await wiki.search('маркер')).toEqual([]);
  });
});
