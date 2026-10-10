// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
vi.mock('electron', () => ({ app: { isPackaged: false } }));
import { getRipgrepPath } from '../../services/ripgrepPath';
import { decodeRipgrepMatch, fileContentPattern, isRegexSearch } from '../fileContentSearch';

describe('In Files with real shipped ripgrep', () => {
  let dir: string, file: string;
  const lines = ['  😀 Прие\u0308мка: на русском языке.  ', 'Русский интерфейс готов.', 'Интерфейсами управляют команды.', 'RUSFILE7419 src/main.ts'];
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-russian-rg-')); file = path.join(dir, 'Приёмка.md'); fs.writeFileSync(file, lines.join('\n')); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  function search(query: string) {
    let output = '';
    try { output = execFileSync(getRipgrepPath(), ['--json', '-i', '--', fileContentPattern(query), file], { encoding: 'utf8' }); }
    catch (e: any) { if (e.status !== 1) throw e; output = e.stdout ?? ''; }
    return output.split('\n').filter(Boolean).map(row => JSON.parse(row)).filter(row => row.type === 'match')
      .map(row => decodeRipgrepMatch(row.data, query)).filter(Boolean);
  }
  it.each(['ПРИЁМКА', 'приемка', 'прие\u0308мка'])('normalizes query and existing file: %s', query => {
    const hits = search(query); expect(hits).toHaveLength(1);
    expect(hits[0]!.text.slice(hits[0]!.start, hits[0]!.end)).toBe('Прие\u0308мка');
  });
  it('finds inflected phrases in order without accidental suffix matching', () => {
    const hits = search('русскими интерфейсами'); expect(hits).toHaveLength(1);
    expect(hits[0]!.keywordMatch).toBe('stem'); expect(hits[0]!.text.slice(hits[0]!.start, hits[0]!.end)).toBe('Русский интерфейс');
    expect(search('интерфейсами русскими')).toEqual([]);
  });
  it('keeps exact matches before additional forms for callers', () => {
    const hits = search('интерфейсами'); expect(hits.map(hit => hit!.keywordMatch)).toEqual(['stem', 'exact']);
  });
  it('preserves explicit regex syntax and translates UTF-8 bytes after trimming', () => {
    const query = 'русском\\s+языке'; expect(isRegexSearch(query)).toBe(true); expect(fileContentPattern(query)).toBe(query);
    const hit = search(query)[0]!; expect(hit.text.slice(hit.start, hit.end)).toBe('русском языке'); expect(hit.start).toBe(hit.text.indexOf('русском'));
    expect(search('RUSFILE\\d+')[0]!.text.slice(0, 11)).toBe('RUSFILE7419');
  });
  it('retains technical markers and reacts to changed/deleted files', () => {
    expect(search('RUSFILE7419')).toHaveLength(1);
    fs.appendFileSync(file, '\nНа русском языке.'); expect(search('языками')).toHaveLength(2);
    fs.writeFileSync(file, 'Unrelated'); expect(search('языками')).toEqual([]);
  });
});
