import { matchAllSearchTerms, searchTextSnippet } from '@nimbalyst/search-text';
import type { LocalSearchHit } from './types.js';
export interface SearchDoc {
  id: string; title: string; kind: 'page' | 'row'; type: string | null; path: string | null;
  body: string; fields: Record<string, unknown>;
}
function fieldText(fields: Record<string, unknown>): string {
  return Object.values(fields).map(v => typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v)).join(' ');
}
/** Every word must match across fields, in any order. Literal forms precede Russian stems. */
export function searchDocs(docs: Iterable<SearchDoc>, query: string, limit: number): LocalSearchHit[] {
  const hits: LocalSearchHit[] = [], seen = new Set<string>();
  for (const doc of docs) {
    if (seen.has(doc.id)) continue;
    const rest = doc.body + '\n' + fieldText(doc.fields);
    const match = matchAllSearchTerms(query, [doc.title, rest]);
    if (!match) continue;
    seen.add(doc.id);
    const score = match.fields[0].counts.reduce((sum,n) => sum + (n ? 10 : 0), 0) + match.fields[1].counts.reduce((a,b) => a+b, 0);
    hits.push({ id: doc.id, title: doc.title, kind: doc.kind, type: doc.type, path: doc.path,
      ...searchTextSnippet(rest, query), score, keywordMatch: match.keywordMatch });
  }
  hits.sort((a,b) => Number(a.keywordMatch === 'stem') - Number(b.keywordMatch === 'stem') || b.score-a.score || a.title.localeCompare(b.title));
  return hits.slice(0, limit);
}
