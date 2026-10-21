/**
 * Hybrid retriever: dense cosine + BM25 sparse, fused with RRF, plus
 * expand-to-section using the chunk heading breadcrumb. Operates over an
 * in-memory snapshot of stored chunks (rebuilt cheaply when the index changes).
 */
import type { SearchHit, StoredChunk, SourceSearchRecord, SearchFieldMatch } from '../types.js';
import { cosineSimilarity,norm,dot } from './cosine.js';
import {sourceKeywordText,sourceFieldMatcher,compareSearchResults,prepareSourceFields} from './sourceFields.js';
import { Bm25Index,termFrequencies,queryConceptCount } from './bm25.js';
import { assertRankSensitive, DEFAULT_K, reciprocalRankFusion } from './rrf.js';

const DENSE_CANDIDATES = 50;
const SPARSE_CANDIDATES = 50;
const PAGE_CANDIDATES = 20;

/**
 * Tunable fusion parameters.
 *
 * Exposed as a constructor option so the evaluation harness can sweep them as
 * arms rather than by editing constants — every default below is a golden-set
 * measurement, and the harness is how the next person re-checks it.
 */
export interface FusionConfig {
  /** RRF rank-saturation constant. See `rrf.ts` for why this is pool-relative. */
  rrfK: number;
  /** Weight on the dense (embedding cosine) arm. */
  denseWeight: number;
  /** Weight on the sparse (BM25) arm. */
  sparseWeight: number;
  /**
   * Weight on the page-level arm (amendment A2). Zero disables it entirely,
   * which is the shipped default — see `DEFAULT_FUSION`.
   */
  pageWeight: number;
  /** How many page-level candidates enter fusion when the arm is enabled. */
  pageCandidates: number;
  /** How many candidates each arm contributes to fusion. */
  denseCandidates: number;
  sparseCandidates: number;
  /**
   * Skip the rank-sensitivity guard. ONLY for the evaluation harness, which
   * needs to score the historical consensus-dominated configuration to show
   * what the fix bought. Never set this in shipped retrieval.
   */
  allowRankInsensitive?: boolean;
}

/**
 * Measured against the golden set (53 questions, openai text-embedding-3-small)
 * via `npm run memory:eval`. Re-derive these rather than reuse them after an
 * embedder change: they were tuned against 1536-dim vectors, and a smaller
 * model has a different score distribution and a weaker dense arm.
 *
 * `k = 8` and `sparseWeight = 0.5` sit in the MIDDLE of a plateau (k 2..20 x
 * sparseWeight 0.3..0.6 all score 54.7-56.6% recall@5 with no source class
 * falling below both input arms), not on its maximum. That is deliberate: at
 * n=53 the difference between the plateau's best and middle cell is one
 * question, so picking the argmax would be fitting noise.
 */
export const DEFAULT_FUSION: FusionConfig = {
  rrfK: DEFAULT_K,
  denseWeight: 1,
  sparseWeight: 0.5,
  // Amendment A2's page-level arm: implemented, measured, and left OFF.
  //
  // It is directionally positive but not distinguishable from zero at n=53 —
  // paired bootstrap vs this two-arm config gives +5.7pp recall@5
  // [-3.8, +15.1] at its best weight, and MRR peaks at a DIFFERENT weight
  // (0.4) than recall does (0.5), which is what noise looks like rather than
  // an effect. It also consistently costs the `rules` class (77.8% -> 55.6%).
  //
  // The rows are still indexed and the arm still works, so re-testing it
  // against a larger golden set or a new embedder is a weight change, not a
  // re-implementation: run `--arms=rrf,rrf-page0.4,rrf-page0.5`.
  pageWeight: 0,
  denseCandidates: DENSE_CANDIDATES,
  sparseCandidates: SPARSE_CANDIDATES,
  pageCandidates: PAGE_CANDIDATES,
};

function citation(c: { sourcePath: string; headingPath: string[] }): string {
  const heading = c.headingPath[c.headingPath.length - 1];
  return heading ? `${c.sourcePath}#${heading}` : c.sourcePath;
}

export class Retriever {
  private chunks: StoredChunk[];
  private byId = new Map<string, StoredChunk>();
  private bm25: Bm25Index;
  private documents=new Map<string,SourceSearchRecord>();
  private metadataIds=new Map<string,SourceSearchRecord>();
  private denseNorms=new WeakMap<number[],number>();
  private fusion: FusionConfig;
  /** Page-level rows (A2), kept apart from `chunks`. Only embedded ones. */
  private pages: StoredChunk[] = [];
  /** Chunks grouped by source, for resolving a page hit to a citable section. */
  private chunksBySource = new Map<string, StoredChunk[]>();

  constructor(chunks: StoredChunk[], fusion?: Partial<FusionConfig>,documents:SourceSearchRecord[]=[]) {
    // Page rows are a separate retrieval arm, not extra chunks. They must stay
    // out of `chunks` (and therefore out of BM25, cosine, expandSection and the
    // returned hits) or every source would surface twice and the whole first
    // 8 KB of a document would compete with its own sections.
    this.chunks = chunks.filter((c) => c.granularity !== 'page');
    this.pages = chunks.filter((c) => c.granularity === 'page' && c.denseEmbedding?.length);
    for(const c of chunks)if(c.denseEmbedding?.length)this.denseNorms.set(c.denseEmbedding,norm(c.denseEmbedding));
    for (const c of this.chunks) this.byId.set(c.id, c);
    for (const c of this.chunks) {
      const list = this.chunksBySource.get(c.sourcePath);
      if (list) list.push(c);
      else this.chunksBySource.set(c.sourcePath, [c]);
    }
    for(const record of documents)if(record.version===1&&this.chunksBySource.has(record.sourcePath)){prepareSourceFields(record);if(record.denseEmbedding?.length)this.denseNorms.set(record.denseEmbedding,norm(record.denseEmbedding));this.documents.set(record.sourcePath,record);this.metadataIds.set('\0metadata\0'+record.sourcePath,record);}
    this.bm25 = new Bm25Index([...this.chunks.map(c=>({id:c.id,tf:c.sparseTerms})),...[...this.metadataIds].map(([id,record])=>({id,tf:termFrequencies(sourceKeywordText(record))}))]);
    this.fusion = { ...DEFAULT_FUSION, ...fusion };
    // Fail at construction, not silently at rank time: a pool-depth or k change
    // that makes fusion a consensus vote produces no error and no visible
    // symptom, just a permanently worse ranking.
    if (!this.fusion.allowRankInsensitive) {
      assertRankSensitive(
        this.fusion.rrfK,
        Math.max(this.fusion.denseCandidates, this.fusion.sparseCandidates),
        this.armWeights()
      );
    }
  }

  get size(): number {
    return this.chunks.length;
  }

  /** Weights of the arms actually in play; a zero-weight arm is not fused. */
  private armWeights(): number[] {
    const w = [this.fusion.denseWeight, this.fusion.sparseWeight];
    if (this.fusion.pageWeight > 0) w.push(this.fusion.pageWeight);
    return w;
  }

  /**
   * Rank page-level rows (A2), then resolve each to a citable chunk.
   *
   * A page vector says "this DOCUMENT is relevant", which is not an answer: the
   * caller needs a section it can quote and open. So each retrieved page is
   * mapped to its best-matching chunk by cosine, and it is that chunk's id that
   * enters fusion, at the page's rank. Without this the arm would return hits
   * with no heading, which no caller — and no golden target — can match.
   */
  private pageRanked(
    queryVector: number[],
    inScope: (c: StoredChunk) => boolean
  ): string[] {
    const ranked = this.pages
      .filter((p) => inScope(p))
      .map((p) => ({ p, s: cosineSimilarity(queryVector, p.denseEmbedding!) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, this.fusion.pageCandidates);

    const ids: string[] = [];
    const seen = new Set<string>();
    for (const { p } of ranked) {
      const candidates = (this.chunksBySource.get(p.sourcePath) ?? []).filter(
        (c) => inScope(c) && c.denseEmbedding?.length
      );
      if (!candidates.length) continue;
      let best = candidates[0];
      let bestScore = -Infinity;
      for (const c of candidates) {
        const s = cosineSimilarity(queryVector, c.denseEmbedding!);
        if (s > bestScore) {
          bestScore = s;
          best = c;
        }
      }
      if (seen.has(best.id)) continue;
      seen.add(best.id);
      ids.push(best.id);
    }
    return ids;
  }

  /**
   * @param queryVector dense query embedding (same embedder as the index), or
   *   null to run sparse-only (e.g. before any embedding is available).
   * @param opts.sourceClasses restrict retrieval to these source classes (e.g.
   *   `['sessions']`). Applied BEFORE the dense/sparse candidate cap so a small
   *   class isn't crowded out of the (capped) global candidate pool by a large
   *   one — the difference between "find a session about X" working or not.
   */
  search(
    queryText: string,
    queryVector: number[] | null,
    k = 5,
    opts?: { sourceClasses?: string[]; accepts?: (chunk:StoredChunk)=>boolean },
  ): SearchHit[] {
    const allowed =
      opts?.sourceClasses && opts.sourceClasses.length ? new Set(opts.sourceClasses) : null;
    const inScope = (c: StoredChunk): boolean => (!allowed || allowed.has(c.sourceClass)) && (!opts?.accepts || opts.accepts(c));

    const queryNorm=queryVector?norm(queryVector):0;
    const similarity=(vector:number[])=>{const length=this.denseNorms.get(vector)??norm(vector);return queryVector&&queryNorm&&length?dot(queryVector,vector)/(queryNorm*length):0;};
    // Entity caps precede fusion: one verbose source cannot consume the pool.
    type Entity={first:StoredChunk;bestDense?:StoredChunk;bestSparse?:StoredChunk;complete?:StoredChunk;dense?:number;contextCosine?:number;sparse?:number;completeScore?:number;priority:number;matches:SearchFieldMatch[];keywordMatch?:'exact'|'stem'};
    const entities=new Map<string,Entity>(),key=(c:StoredChunk)=>c.refType+'\0'+c.refId;
    for(const chunk of this.chunks){if(!inScope(chunk))continue;const id=key(chunk),entity=entities.get(id)??{first:chunk,priority:0,matches:[]};entities.set(id,entity);
      if(queryVector?.length&&chunk.denseEmbedding?.length){const score=similarity(chunk.denseEmbedding);if(entity.dense===undefined||score>entity.dense){entity.dense=score;entity.bestDense=chunk;}}
    }
    const matchFields=sourceFieldMatcher(queryText);
    for(const record of this.documents.values()){
      const chunk=this.chunksBySource.get(record.sourcePath)?.find(inScope);if(!chunk)continue;const entity=entities.get(key(chunk))!;
      const match=matchFields(record);if(match.priority>=entity.priority){entity.priority=match.priority;entity.matches=match.matches;}
      if(queryVector?.length&&record.denseEmbedding?.length===queryVector.length){const score=similarity(record.denseEmbedding);entity.contextCosine=Math.max(entity.contextCosine??-Infinity,score);entity.dense=Math.max(entity.dense??-Infinity,score);}
    }
    const concepts=queryConceptCount(queryText);
    for(const hit of this.bm25.searchComplete(queryText)){
      const metadata=this.metadataIds.get(hit.id),chunk=metadata?this.chunksBySource.get(metadata.sourcePath)?.find(inScope):this.byId.get(hit.id);if(!chunk||!inScope(chunk))continue;
      const entity=entities.get(key(chunk))!;
      if(!metadata&&(hit.matchedTerms??0)>=concepts&&concepts>0&&hit.score>(entity.completeScore??-Infinity)){entity.complete=chunk;entity.completeScore=hit.score;}
      if(hit.score>(entity.sparse??-Infinity)){entity.sparse=hit.score;entity.keywordMatch=hit.keywordMatch;if(!metadata)entity.bestSparse=chunk;}
    }
    const denseRanked=[...entities].filter(([,entity])=>entity.dense!==undefined).sort((a,b)=>b[1].dense!-a[1].dense!).slice(0,this.fusion.denseCandidates).map(([id])=>id);
    const sparseRanked=[...entities].filter(([,entity])=>entity.sparse!==undefined||entity.priority>0).sort((a,b)=>b[1].priority-a[1].priority||(b[1].sparse??0)-(a[1].sparse??0)).slice(0,this.fusion.sparseCandidates).map(([id])=>id);
    const denseSet=new Set(denseRanked),sparseSet=new Set(sparseRanked);
    const pageRanked=this.fusion.pageWeight>0&&queryVector?.length?[...new Set(this.pageRanked(queryVector,inScope).map(id=>key(this.byId.get(id)!)))]:[];
    const fused=reciprocalRankFusion([{ids:denseRanked,weight:this.fusion.denseWeight},{ids:sparseRanked,weight:this.fusion.sparseWeight},...(pageRanked.length?[{ids:pageRanked,weight:this.fusion.pageWeight}]:[])].filter(arm=>arm.weight>0),this.fusion.rrfK);
    const ranked=fused.map(hit=>({...hit,fieldPriority:this.fusion.sparseWeight>0?entities.get(hit.id)!.priority:0})).sort(compareSearchResults);
    const hits:SearchHit[]=[];
    for(const {id,score,fieldPriority}of ranked.slice(0,Math.max(0,k))){const entity=entities.get(id)!,c=entity.complete??entity.bestDense??entity.bestSparse??entity.first;
      hits.push({chunkId:c.id,sectionId:c.sectionId,sourceRange:c.sourceRange,coordinateSpace:c.coordinateSpace,context:c.context,sourcePath:c.sourcePath,sourceClass:c.sourceClass,refType:c.refType,refId:c.refId,headingPath:c.headingPath,text:c.text,score,citation:citation(c),
        signals:{dense:this.fusion.denseWeight>0&&denseSet.has(id),sparse:this.fusion.sparseWeight>0&&sparseSet.has(id)},
        ...(entity.matches.length?{matchedFields:entity.matches}:{}),...(fieldPriority?{fieldPriority}:{}),...(entity.keywordMatch&&sparseSet.has(id)?{keywordMatch:entity.keywordMatch}:{}),
        similarity:{...(queryVector?.length&&c.denseEmbedding?.length&&denseSet.has(id)?{cosine:similarity(c.denseEmbedding)}:{}),...(entity.contextCosine!==undefined?{contextCosine:entity.contextCosine}:{}),...(entity.sparse!==undefined&&sparseSet.has(id)?{bm25:entity.sparse}:{})},
      });
    }
    return hits;
  }

  /**
   * Expand a hit to its full heading section: all chunks in the same source
   * whose heading breadcrumb is the matched path (or a descendant of it),
   * concatenated in document order.
   */
  expandSection(sourcePath: string, headingPath: string[],sectionId?:string): {
    sourcePath: string;
    headingPath: string[];
    text: string;
  } | null {
    const inSource = this.chunks
      .filter((c) => c.sourcePath === sourcePath)
      .sort((a, b) => a.ordinal - b.ordinal);
    if (inSource.length === 0) return null;

    const key = headingPath.join('\u0000');
    const matching = inSource.filter((c) => {
      const ck = c.headingPath.join('\u0000');
      return ck === key || ck.startsWith(key + '\u0000');
    });
    let section = matching.length ? matching : inSource;
    if(sectionId){
      const start=inSource.findIndex(c=>c.sectionId===sectionId);if(start<0)return null;
      const anchor=inSource[start];let end=start+1;
      while(end<inSource.length&&(inSource[end].sectionId===sectionId||inSource[end].headingPath.length>anchor.headingPath.length))end++;
      section=inSource.slice(start,end);
    }
    return {
      sourcePath,
      headingPath,
      text: section.map((c,i)=>i>0&&c.sourceRange!==undefined&&c.sourceRange.start===section[i-1].sourceRange?.end?c.text:(i?'\n\n':'')+c.text).join(''),
    };
  }
}
