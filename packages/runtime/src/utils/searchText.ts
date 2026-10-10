import RussianStemmer from '../../../extensions/nimbalyst-memory/engine/src/retrieval/snowball/russian-stemmer.js';

export type KeywordMatch = 'exact' | 'stem';
const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}_]*(?:[./-][\p{L}\p{N}][\p{L}\p{N}\p{M}_]*)*/gu;
const RUSSIAN_WORD = /^[а-я]+$/u;
const stemmer = new RussianStemmer();

/** Same lexical normalization as Memory; never changes the stored text. */
export function normalizeSearchText(text: string): string {
  return text.normalize('NFC').toLowerCase().normalize('NFC').replace(/ё/g, 'е');
}
export function stemSearchToken(token: string): string {
  return RUSSIAN_WORD.test(token) ? stemmer.stemWord(token) : token;
}
export interface SearchProjection {
  text: string;
  /** Original UTF-16 start/end for every normalized UTF-16 unit. */
  starts: number[];
  ends: number[];
}
const segments = new Intl.Segmenter('ru', { granularity: 'grapheme' });
export function projectSearchText(text: string, preserveCase = false): SearchProjection {
  const result: SearchProjection = { text: '', starts: [], ends: [] };
  for (const { segment, index } of segments.segment(text)) {
    const normalized = preserveCase ? segment.normalize('NFC').replace(/ё/g, 'е').replace(/Ё/g, 'Е') : normalizeSearchText(segment);
    result.text += normalized;
    for (let i = 0; i < normalized.length; i++) { result.starts.push(index); result.ends.push(index + segment.length); }
  }
  return result;
}
export function originalSearchIndices(projection: SearchProjection, indices: number[]): number[] {
  const result = new Set<number>();
  for (const i of indices) {
    for (let j = projection.starts[i]; j < projection.ends[i]; j++) result.add(j);
  }
  return [...result].sort((a, b) => a - b);
}
export function searchTokens(text: string): string[] {
  return normalizeSearchText(text).match(TOKEN_RE) ?? [];
}
export interface TextSearchMatch { keywordMatch: KeywordMatch; matchedIndices: number[]; start: number; end: number }
/** Literal normalized matches first, then consecutive word forms in phrase order. */
export function matchSearchText(query: string, target: string): TextSearchMatch | null {
  const q = normalizeSearchText(query.trim());
  if (!q) return { keywordMatch: 'exact', matchedIndices: [], start: 0, end: 0 };
  const projection = projectSearchText(target);
  const at = projection.text.indexOf(q);
  if (at >= 0) {
    const matchedIndices = originalSearchIndices(projection, Array.from({ length: q.length }, (_, i) => at + i));
    return { keywordMatch: 'exact', matchedIndices, start: matchedIndices[0], end: matchedIndices.at(-1)! + 1 };
  }
  const qs = q.match(TOKEN_RE) ?? [];
  if (!qs.length || !qs.some(t => RUSSIAN_WORD.test(t))) return null;
  // Punctuation-only syntax, identifiers and paths are not rewritten as words.
  if (q.replace(TOKEN_RE, '').trim().match(/[^\s,!?;:'"«»—–]/u)) return null;
  const ts = [...projection.text.matchAll(TOKEN_RE)];
  for (let i = 0; i <= ts.length - qs.length; i++) {
    if (!qs.every((token, j) => stemSearchToken(token) === stemSearchToken(ts[i + j][0]))) continue;
    const first = ts[i].index!, last = ts[i + qs.length - 1];
    const end = last.index! + last[0].length;
    const matchedIndices = originalSearchIndices(projection, Array.from({ length: end - first }, (_, j) => first + j));
    return { keywordMatch: 'stem', matchedIndices, start: matchedIndices[0], end: matchedIndices.at(-1)! + 1 };
  }
  return null;
}

/** A disposable projection of native FTS lexemes, rebuilt when the dictionary changes. */
export class SearchLexicon {
  private exact = new Map<string, string[]>();
  private stems = new Map<string, string[]>();
  constructor(terms: Iterable<string>) {
    for (const term of terms) {
      const normalized = normalizeSearchText(term);
      const exact = this.exact.get(normalized) ?? []; exact.push(term); this.exact.set(normalized, exact);
      if (RUSSIAN_WORD.test(normalized)) {
        const stem = stemSearchToken(normalized), forms = this.stems.get(stem) ?? [];
        forms.push(term); this.stems.set(stem, forms);
      }
    }
  }
  variants(token: string, morphology: boolean): string[] {
    const normalized = normalizeSearchText(token);
    const exact = this.exact.get(normalized) ?? [token];
    return [...new Set([...exact, ...(morphology && RUSSIAN_WORD.test(normalized) ? this.stems.get(stemSearchToken(normalized)) ?? [] : [])])];
  }
}

/** Stable exact-first filtering, preserving the caller’s order within each tier. */
export function filterSearchText<T>(items: readonly T[], query: string, texts: (item: T) => string[]): T[] {
  if (!query.trim()) return [...items];
  const exact: T[] = [], stem: T[] = [];
  for (const item of items) {
    const matches = texts(item).map(text => matchSearchText(query, text)).filter(Boolean);
    if (matches.some(m => m!.keywordMatch === 'exact')) exact.push(item);
    else if (matches.length) stem.push(item);
  }
  return [...exact, ...stem];
}