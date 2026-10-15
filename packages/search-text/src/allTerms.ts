import { normalizeSearchText, projectSearchText, stemSearchToken, type KeywordMatch, type SearchProjection } from './index.js';
export interface SearchRange { start: number; end: number }
export interface TermSearchField { ranges: SearchRange[]; counts: number[] }
export interface AllTermsMatch { keywordMatch: KeywordMatch; fields: TermSearchField[] }
const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}_]*(?:[./\\-][\p{L}\p{N}][\p{L}\p{N}\p{M}_]*)*/gu;
const RUSSIAN = /^[а-я]+$/u;
const EDGE_PUNCTUATION = /^[,!?;:'"«»()[\]{}—–]+|[,!?;:'"«»()[\]{}—–]+$/gu;
function terms(query: string): string[] {
  return normalizeSearchText(query).split(/\s+/).map(t => t.replace(EDGE_PUNCTUATION, '')).filter(Boolean);
}
function sourceRange(p: SearchProjection, start: number, end: number): SearchRange {
  return { start: p.starts[start], end: p.ends[end - 1] };
}
/** Non-phrase AND search. Technical tokens keep literal substring matching. */
function fieldsFor(query: string, texts: readonly string[]): { fields: TermSearchField[]; exact: boolean[]; found: boolean[] } {
  const qs = terms(query), exact = qs.map(() => false), found = qs.map(() => false);
  const fields = texts.map(text => {
    const p = projectSearchText(text), tokens = [...p.text.matchAll(WORD)];
    const ranges: SearchRange[] = [], counts = qs.map(() => 0);
    qs.forEach((q, i) => {
      for (let at = p.text.indexOf(q); at >= 0 && counts[i] < 20; at = p.text.indexOf(q, at + q.length)) {
        const containing = RUSSIAN.test(q) ? tokens.find(t => RUSSIAN.test(t[0]) && t.index! <= at && t.index! + t[0].length >= at + q.length) : undefined;
        ranges.push(containing ? sourceRange(p, containing.index!, containing.index! + containing[0].length) : sourceRange(p, at, at + q.length)); counts[i]++; exact[i] = found[i] = true;
      }
      if (counts[i] || !RUSSIAN.test(q)) return;
      const stem = stemSearchToken(q);
      for (const token of tokens) {
        if (!RUSSIAN.test(token[0]) || stemSearchToken(token[0]) !== stem) continue;
        const before = p.text[token.index! - 1] ?? '', after = p.text[token.index! + token[0].length] ?? '';
        if (/[/\\_]/u.test(before) || /[/\\_]/u.test(after)) continue;
        const r = sourceRange(p, token.index!, token.index! + token[0].length);
        // Preserve technical camelCase identifiers even when entirely Cyrillic.
        if (/[а-яё][А-ЯЁ]/u.test(text.slice(r.start, r.end))) continue;
        ranges.push(r); counts[i]++; found[i] = true;
        if (counts[i] >= 20) break;
      }
    });
    return { ranges: mergeSearchRanges(ranges), counts };
  });
  return { fields, exact, found };
}
export function mergeSearchRanges(ranges: readonly SearchRange[]): SearchRange[] {
  const merged: SearchRange[] = [];
  for (const range of [...ranges].sort((a,b) => a.start-b.start || a.end-b.end)) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}
export function matchAllSearchTerms(query: string, texts: readonly string[]): AllTermsMatch | null {
  const { fields, exact, found } = fieldsFor(query, texts);
  if (!found.length || !found.every(Boolean)) return null;
  return { keywordMatch: exact.every(Boolean) ? 'exact' : 'stem', fields };
}
/** Also useful when some required words are in another field. */
export function searchTermRanges(query: string, text: string): SearchRange[] {
  return fieldsFor(query, [text]).fields[0].ranges;
}
/** Coordinates are UTF-16 in the final snippet; cuts never split a grapheme. */
export function searchTextSnippet(text: string, query: string, length = 140): { snippet: string; highlights: SearchRange[] } {
  const flat = text.replace(/\s+/g, ' ').trim(), ranges = searchTermRanges(query, flat);
  const first = ranges[0], desiredStart = Math.max(0, (first?.start ?? 0) - 45);
  const desiredEnd = Math.min(flat.length, Math.max(desiredStart + length, first?.end ?? 0));
  const boundaries = [0, ...Array.from(new Intl.Segmenter('ru', { granularity: 'grapheme' }).segment(flat), s => s.index + s.segment.length)];
  const start = boundaries.find(b => b >= desiredStart) ?? flat.length;
  const end = boundaries.find(b => b >= desiredEnd) ?? flat.length;
  const prefix = start > 0 ? '…' : '';
  return {
    snippet: prefix + flat.slice(start, end) + (end < flat.length ? '…' : ''),
    highlights: ranges.filter(r => r.start >= start && r.end <= end).map(r => ({ start: r.start-start+prefix.length, end: r.end-start+prefix.length })),
  };
}
