import { describe, expect, it } from 'vitest';
import { filterSearchText, matchSearchText, normalizeSearchText, searchTokens, SearchLexicon, stemSearchToken } from '../searchText';
import { fuzzyMatch, fuzzyMatchPath } from '../fuzzyMatch';
import { tokenize } from '../../../../extensions/nimbalyst-memory/engine/src/retrieval/bm25';

describe('Russian lexical search shared by Quick Open', () => {
  it.each(['ПРИЁМКА', 'приемка', 'прие\u0308мка'])('normalizes %s without rewriting source positions', query => {
    const text = '😀  Прие\u0308мка';
    const hit = matchSearchText(query, text)!;
    expect(hit.keywordMatch).toBe('exact');
    expect(text.slice(hit.start, hit.end)).toBe('Прие\u0308мка');
  });
  it.each(['язык', 'языке', 'языками'])('finds forms of %s', query => {
    expect(matchSearchText(query, 'На русском языке.')?.keywordMatch).toBe(query === 'языке' || query === 'язык' ? 'exact' : 'stem');
  });
  it.each(['русскими', 'интерфейсами', 'языками,'])('finds whole Russian word %s', query => {
    expect(matchSearchText(query, 'Русский интерфейс на русском языке.')?.keywordMatch).toBe('stem');
  });
  it('preserves phrase order, with forms and punctuation', () => {
    expect(matchSearchText('русскими интерфейсами', 'Русский интерфейс работает')?.keywordMatch).toBe('stem');
    expect(matchSearchText('интерфейсами русскими', 'Русский интерфейс работает')).toBeNull();
    expect(matchSearchText('русскими интерфейсами', 'Русский другой интерфейс')).toBeNull();
  });
  it('never stems identifiers, extensions, digits or mixed tokens', () => {
    for (const token of ['языками.md', 'src/языками', 'языками_12', 'языками12', 'языкAPI', 'file.json']) {
      expect(stemSearchToken(normalizeSearchText(token))).toBe(normalizeSearchText(token));
    }
    expect(matchSearchText('языками', 'язык.md')).toBeNull();
    expect(matchSearchText('языками.md', 'язык.md')).toBeNull();
  });
  it('keeps exact priority and stable caller order', () => {
    const texts = ['русский интерфейс', 'интерфейсами А', 'интерфейсами Б'];
    expect(filterSearchText(texts, 'интерфейсами', x => [x])).toEqual([texts[1], texts[2], texts[0]]);
  });
  it('retains Unicode CamelCase and correct offsets across delimiters', () => {
    const text = 'folder/Прие\u0308мкаПроекта.md';
    const hit = fuzzyMatch('ПриПро', text);
    expect(hit.matches).toBe(true);
    expect(hit.matchedIndices.map(i => text[i]).join('')).toBe('ПриПро');
  });
  it('inflects file names without inflecting path syntax/extensions', () => {
    expect(fuzzyMatchPath('интерфейсами', 'C:\\project\\Интерфейс.md').keywordMatch).toBe('stem');
    expect(fuzzyMatchPath('интерфейсами.md', 'C:\\project\\Интерфейс.md').matches).toBe(false);
  });
  it('keeps shared normalization consistent with Memory', () => {
    const text = 'Прие\u0308мка; русский язык, file.ts src/foo-bar 12 API_язык';
    expect(searchTokens(text)).toEqual(tokenize(text));
    expect(stemSearchToken('языками')).toBe(stemSearchToken('языке'));
  });
  it('expands live FTS lexemes only for Russian words', () => {
    const lexicon = new SearchLexicon(['языке', 'ЯЗЫКАМИ', 'приёмка', 'API_язык']);
    expect(lexicon.variants('язык', false)).toEqual(['язык']);
    expect(lexicon.variants('язык', true)).toEqual(['язык', 'языке', 'ЯЗЫКАМИ']);
    expect(lexicon.variants('приемка', false)).toEqual(['приёмка']);
    expect(lexicon.variants('API_язык', true)).toEqual(['API_язык']);
  });
});
