/**
 * BM25 sparse keyword scoring. Tokenization keeps dotted/slashed/underscored
 * runs intact (so `foo.ts`, `src/main`, `loadSessionContext` survive as terms)
 * which is exactly where pure dense retrieval is weak.
 */

import { RussianStemmer, normalizeSearchText } from '@nimbalyst/search-text';

export const LEXICAL_INDEX_VERSION = 3;
const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}_]*(?:[./-][\p{L}\p{N}][\p{L}\p{N}\p{M}_]*)*/gu;
const K1 = 1.5;
const B = 0.75;

export function tokenize(text: string): string[] {
  const matches = normalizeSearchText(text).match(TOKEN_RE);
  if (!matches) return [];
  return matches.filter((t) => t.length >= 2 || /[0-9]/.test(t));
}

/**
 * Term -> frequency map for one document.
 *
 * Uses a prototype-less object so tokens that collide with `Object.prototype`
 * members ("constructor", "toString", "hasOwnProperty", "__proto__", …) are
 * counted correctly. With a plain `{}`, `tf["constructor"] ?? 0` returns the
 * Object constructor function and `+ 1` builds a STRING — which then poisons
 * doc-length math and turns BM25's `avgdl` into NaN, silently killing keyword
 * retrieval for EVERY query. These tokens are common in code documentation.
 */
export function termFrequencies(text: string): Record<string, number> {
  const tf: Record<string, number> = Object.create(null);
  for (const t of tokenize(text)) tf[t] = (tf[t] ?? 0) + 1;
  return tf;
}

/** Safe own-property numeric read (tf maps may be JSON-revived with a prototype). */
function tfCount(tf: Record<string, number>, term: string): number {
  const v = Object.prototype.hasOwnProperty.call(tf, term) ? tf[term] : 0;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export interface Bm25Doc {
  id: string;
  /** Precomputed term frequencies (from termFrequencies at index time). */
  tf: Record<string, number>;
}

export interface Bm25Scored {
  id: string;
  score: number;
  keywordMatch?: 'exact' | 'stem';
  matchedTerms?:number;
}

/**
 * Brute-force BM25 over an in-memory doc set. Recomputes IDF/avgdl on
 * construction; cheap at a few thousand chunks.
 */
class Bm25Projection {
  private docs: Bm25Doc[];
  private docLen = new Map<string, number>();
  private df = new Map<string, number>();
  private avgdl = 0;
  private lengthNorm=new Map<string,number>();

  constructor(docs: Bm25Doc[]) {
    this.docs = docs;
    let total = 0;
    for (const d of docs) {
      let len = 0;
      for (const term in d.tf) {
        if (!Object.prototype.hasOwnProperty.call(d.tf, term)) continue;
        const c = tfCount(d.tf, term);
        if (c <= 0) continue;
        len += c;
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
      this.docLen.set(d.id, len);
      total += len;
    }
    this.avgdl = docs.length ? total / docs.length : 0;
    if(this.avgdl)for(const [id,len]of this.docLen)this.lengthNorm.set(id,K1*(1-B+B*len/this.avgdl));
  }

  private idf(term: string): number {
    const n = this.docs.length;
    const df = this.df.get(term) ?? 0;
    // BM25+ style non-negative idf.
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** Query-local IDF preparation: score each document without rescanning or sorting per term. */
  scorer(term:string):(id:string,tf:Record<string,number>)=>number{
    if(!this.avgdl)return()=>0;const idf=this.idf(term);
    return(id,tf)=>{const f=tfCount(tf,term);return f?idf*f*(K1+1)/(f+(this.lengthNorm.get(id)??K1)):0;};
  }

  /** Score every doc against the query; returns matches sorted desc. */
  search(terms: string[]): Bm25Scored[] {
    if (terms.length === 0 || this.avgdl === 0) return [];
    const queryTerms = Array.from(new Set(terms));
    const results: Bm25Scored[] = [];
    for (const d of this.docs) {
      const len = this.docLen.get(d.id) ?? 0;
      let score = 0;
      for (const term of queryTerms) {
        const f = tfCount(d.tf, term);
        if (!f) continue;
        const idf = this.idf(term);
        const denom = f + K1 * (1 - B + (B * len) / this.avgdl);
        score += idf * ((f * (K1 + 1)) / denom);
      }
      if (score > 0) results.push({ id: d.id, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results;
  }
}

// Exact terms remain the persisted index; the second projection is disposable.
const RUSSIAN_WORD = /^[а-я]+$/u;

export class Bm25Index {
  private exact: Bm25Projection;
  private stems: Bm25Projection;
  private stemmer = new RussianStemmer();
  private originalDocs:Bm25Doc[];
  private stemDocs=new Map<string,Bm25Doc>();

  constructor(docs: Bm25Doc[]) {
    this.originalDocs=docs;
    this.exact = new Bm25Projection(docs);
    const cache = new Map<string, string>();
    this.stems = new Bm25Projection(docs.map(d => {
      const tf: Record<string, number> = Object.create(null);
      for (const term of Object.keys(d.tf)) {
        const count = tfCount(d.tf, term);
        if (count <= 0) continue;
        let key = term;
        if (RUSSIAN_WORD.test(term)) {
          key = cache.get(term) ?? this.stemmer.stem(term);
          cache.set(term, key);
        }
        tf[key] = (tf[key] ?? 0) + count;
      }
      const projected={id:d.id,tf};this.stemDocs.set(d.id,projected);return projected;
    }));
  }

  /** Add every query concept once; a literal match does not disable other inflections. */
  searchComplete(query:string):Bm25Scored[]{
    const terms=informativeTerms(query),groups=new Map<string,string[]>();
    for(const term of terms){const key=RUSSIAN_WORD.test(term)?this.stemmer.stem(term):term;const list=groups.get(key)??[];list.push(term);groups.set(key,list);}
    const plans=[...groups].map(([concept,variants])=>({exact:variants.map(term=>this.exact.scorer(term)),stem:variants.some(term=>RUSSIAN_WORD.test(term))?this.stems.scorer(concept):null}));
    const combined:Bm25Scored[]=[];
    for(const doc of this.originalDocs){let score=0,matchedTerms=0,usedStem=false;const projected=this.stemDocs.get(doc.id)!;
      for(const plan of plans){let value=0;for(const exact of plan.exact)value=Math.max(value,exact(doc.id,doc.tf));if(!value&&plan.stem){value=plan.stem(doc.id,projected.tf);if(value)usedStem=true;}if(value){score+=value;matchedTerms++;}}
      if(score)combined.push({id:doc.id,score,matchedTerms,keywordMatch:usedStem?'stem':'exact'});
    }
    return combined.sort((a,b)=>groups.size===1&&a.keywordMatch!==b.keywordMatch?(a.keywordMatch==='exact'?-1:1):b.score-a.score);
  }

  search(query: string): Bm25Scored[] {
    const terms = tokenize(query);
    const exact = this.exact.search(terms).map(h => ({ ...h, keywordMatch: 'exact' as const }));
    const exactIds = new Set(exact.map(h => h.id));
    const stems = terms.filter(t => RUSSIAN_WORD.test(t)).map(t => this.stemmer.stem(t));
    const additional = this.stems.search(stems)
      .filter(h => !exactIds.has(h.id))
      .map(h => ({ ...h, keywordMatch: 'stem' as const }));
    // Preserve exact BM25 scores and ordering before unique morphology-only hits.
    return [...exact, ...additional];
  }
}


const QUERY_STOP_WORDS=new Set('как где откуда куда когда чтобы что это этот эта эти для над под при или который которая которое какие какой понять найти покажи the a an to of in on at and or how where which what is are from with by find show'.split(' '));
/** Only the scoring query is filtered; embedding input and persisted terms stay verbatim. */
export function informativeTerms(query:string):string[]{const all=[...new Set(tokenize(query))],content=all.filter(term=>!QUERY_STOP_WORDS.has(term));return content.length?content:all;}
export function queryConceptCount(query:string):number{const stemmer=new RussianStemmer();return new Set(informativeTerms(query).map(term=>RUSSIAN_WORD.test(term)?stemmer.stem(term):term)).size;}
