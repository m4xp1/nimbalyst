import { normalizeSearchText, searchTokens, SearchLexicon } from '@nimbalyst/runtime/utils/searchText';

type Dialect = 'sqlite' | 'postgres';
export function needsRussianFtsProjection(query: string): boolean {
  return searchTokens(query).some(t => /^[а-я]+$/u.test(t)) && !/["*^()|+\\]/u.test(query);
}
/** Quoted native lexemes; expansion cannot inject MATCH/tsquery operators. */
export function russianFtsQueries(query: string, lexicon: SearchLexicon, dialect: Dialect): { exact: string; stem: string | null } {
  const quote = (word: string) => dialect === 'sqlite' ? '"' + word.replace(/"/g, '""') + '"' : "'" + word.replace(/'/g, "''").replace(/\\/g, '\\\\') + "'";
  const build = (morphology: boolean) => searchTokens(query).map(token => {
    const variants = lexicon.variants(normalizeSearchText(token), morphology);
    return '(' + variants.map(quote).join(dialect === 'sqlite' ? ' OR ' : ' | ') + ')';
  }).join(dialect === 'sqlite' ? ' AND ' : ' & ');
  const exact = build(false), stem = build(true);
  return { exact, stem: stem === exact ? null : stem };
}
export class FtsLexiconCache {
  private signature = '';
  private lexicon = new SearchLexicon([]);
  update(terms: string[]): SearchLexicon {
    const signature = terms.join('\u0000');
    if (signature !== this.signature) { this.signature = signature; this.lexicon = new SearchLexicon(terms); }
    return this.lexicon;
  }
}
