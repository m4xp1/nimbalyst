/**
 * MemoryEngine — the host-agnostic orchestrator. Owns the store, indexer,
 * retriever snapshot, facts store, and embedder. Enforces the embedder-identity
 * invariant: if the configured embedder differs from what the store was built
 * with, the store is reset (vectors are non-comparable) and a full re-index is
 * required.
 *
 * ZERO host-app imports. The MCP server (mcp/server.ts) is a thin adapter over
 * these methods.
 */
import { readFile, stat } from 'node:fs/promises';
import { safeIndexError, type FileIndexStatus, type SafeIndexError, type FileOperation } from './indexStatus.js';
import type {
  Embedder,
  EngineConfig,
  Fact,
  RetrievalCapabilities,
  SearchHit,
  VirtualRecord,
  FileRecord,
  SourceSet,
  StoredChunk,
} from './types.js';
import { SqliteStore } from './store/sqliteStore.js';
import { resolveInRoots, resolveRoots, type ResolvedRoot } from './roots.js';
import { isInsideRealRoot } from './sourceRules.js';
import { Indexer, type IndexProgress } from './indexer/indexer.js';
import { IndexWatcher } from './indexer/watcher.js';
import { FileWork } from './indexer/fileWork.js';
import { Retriever } from './retrieval/retriever.js';
import { FactsStore, type RecallQuery, type RememberInput } from './facts/facts.js';

export interface EngineStatus {
  available?: {chunks:number;sourceFiles:number;indexedFiles:number;bySourceClass:Record<string,number>;lastIndexedAt:number|null};
  operation?:FileOperation|null;
  lastFullScan?:FileIndexStatus;
  chunks: number;
  /** Chunks that carry a dense vector (the dense retrieval arm). */
  denseChunks: number;
  /** Chunk count keyed by source class (e.g. design/docs/plans/facts). */
  bySourceClass: Record<string, number>;
  /** Distinct source files currently represented in the index. */
  sourceFiles: number;
  /** Epoch millis of the most recent chunk write, or null when empty. */
  lastIndexedAt: number | null;
  embedder: { id: string; model: string; dims: number };
  embedderChanged: boolean;
  indexing: boolean;
  fileIndex?: FileIndexStatus;
  indexedFiles?: number;
  watching?: boolean;
  chunksWithoutVectors?: number;
  embeddingError?: SafeIndexError | null;
  /**
   * Last query-embedding failure, if any. When set, search has been running
   * sparse-only (BM25) — a strong signal something is wrong with the embedder
   * (bad key, network, or fd starvation) rather than with retrieval logic.
   */
  lastEmbedError: string | null;
  retrieval: RetrievalCapabilities;
  root: string;
}

/** Refresh the retrieval snapshot every N files during a full index pass so
 *  partial results are searchable within seconds rather than after the whole
 *  (potentially many-minute) corpus pass completes. */
const SNAPSHOT_REFRESH_EVERY_FILES = 25;

/**
 * Current `sourcePath` key format.
 *
 * 1 — bare POSIX path relative to the single engine root.
 * 2 — same for the primary root, plus `@<rootId>/<rel>` for a source set with
 *     its own root (see `roots.ts`).
 *
 * A store stamped with a DIFFERENT version is wiped and re-indexed: the format
 * is the chunk primary key, so a partial migration leaves rows nothing can
 * address or prune, and the index is explicitly rebuildable.
 *
 * An UNSTAMPED store is not wiped. Formats 1 and 2 agree on every path a format-1
 * store can contain (it has no non-primary roots by construction), so stamping
 * it is sufficient and re-embedding the whole corpus would buy nothing. The
 * stamp exists to make the next format change a forced rebuild rather than this
 * same reasoning done again from scratch.
 */
const SOURCE_PATH_FORMAT = 2;

export class MemoryEngine {
  private store: SqliteStore;
  private roots: ResolvedRoot[];
  private rootScans:Record<string,FileIndexStatus>={};
  private indexer: Indexer;
  private facts: FactsStore;
  private retriever: Retriever;
  private watcher: IndexWatcher | null = null;
  private indexing = false;
  private fileWork=new FileWork();
  private policyGeneration=0;
  private closed=false;
  private snapshot:StoredChunk[]=[];
  private operation:FileOperation|null=null;
  private rootOperations:Record<string,FileOperation>={};
  private pendingPaths=new Set<string>();
  private pendingDiscovery=false;
  private activeSourcePaths:string[]|null|undefined;
  private interruptedScan=false;
  private indexFinished: Promise<void> = Promise.resolve();
  private finishIndex: (() => void) | null = null;
  private fileIndex:FileIndexStatus={state:'not-started',phase:null,discoveredFiles:null,completedFiles:null,failedFiles:null,error:null};
  /** True when the stored embedder differed and a re-index is needed. */
  private embedderChanged = false;
  /** Last query-embedding error message, or null if the last embed succeeded. */
  private lastEmbedError: string | null = null;

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.config.onLog?.(level, message);
  }

  private constructor(
    private config: EngineConfig,
    private embedder: Embedder,
    store: SqliteStore
  ) {
    this.store = store;
    this.roots = resolveRoots(config.root, config.sources);
    this.indexer = new Indexer(config, store, embedder);
    const saved=store.getIndexDiagnostics().scans;
    this.fileIndex=saved.all??this.fileIndex;
    this.rootScans={...saved};delete this.rootScans.all;
    this.facts = new FactsStore(config.root, config.factsDir);
    this.snapshot=store.loadAll();
    this.retriever = new Retriever(this.snapshot.filter(chunk => this.indexer.readable(chunk)));
  }

  static create(config: EngineConfig, embedder: Embedder): MemoryEngine {
    const store = new SqliteStore(config.dbPath, config.nativeBinding);
    const prior = store.getEmbedderInfo();
    const info = embedder.info;
    let changed = false;
    if (!prior) {
      store.setEmbedderInfo(info);
    } else if (prior.id !== info.id || prior.model !== info.model || prior.dims !== info.dims) {
      // Non-comparable vectors — wipe and re-key. Caller must re-index.
      store.reset();
      store.setEmbedderInfo(info);
      changed = true;
    }

    // sourcePath key format. See SOURCE_PATH_FORMAT: a mismatch is a full
    // rebuild, an absent stamp is just stamped.
    const priorFormat = store.getSourcePathFormat();
    if (priorFormat !== null && priorFormat !== SOURCE_PATH_FORMAT) {
      config.onLog?.(
        'info',
        `[engine] sourcePath format ${priorFormat} -> ${SOURCE_PATH_FORMAT}; rebuilding the shadow index`
      );
      store.reset();
      // Deliberately NOT `embedderChanged` — the embedder didn't change, and
      // both callers re-index unconditionally at startup anyway.
    }
    if (priorFormat !== SOURCE_PATH_FORMAT) store.setSourcePathFormat(SOURCE_PATH_FORMAT);

    const engine = new MemoryEngine(config, embedder, store);
    engine.embedderChanged = changed;
    return engine;
  }

  /** Harness memory and virtual records belong to the primary logical workspace. */
  private coverageRoot(sourcePath:string,sourceClass?:string):string|null {
    if(sourceClass==='harness-memory')return null;
    return this.roots.find(root=>root.id && sourcePath.startsWith('@'+root.id+'/'))?.id??null;
  }
  private fileStatus(rootId?:string|null):FileIndexStatus {
    const base=rootId===undefined?this.fileIndex:this.rootScans[rootId??'primary']??{state:'not-started' as const,phase:null,discoveredFiles:null,completedFiles:null,failedFiles:null,error:null};
    const failures=this.indexer.failuresForStatus().filter(f=>rootId===undefined || f.rootId===rootId);
    const remaining=base.remainingFiles??(base.discoveredFiles===null?null:Math.max(0,base.discoveredFiles-(base.completedFiles??0)-(base.failedFiles??0)));
    const error=failures[0]?.error??base.globalError??(base.phase==='enumerate'?base.error:null);
    const settled=base.state!=='not-started' && base.state!=='building';
    const hasSaved=rootId===undefined?this.store.count()>0:this.store.sourceSummaries().some(row=>this.coverageRoot(row.sourcePath,row.sourceClass)===rootId);
    return {...base,remainingFiles:remaining,failedFiles:failures.length,failureCount:failures.length,failures:failures.slice(0,100),error,
      completedFiles:settled&&base.discoveredFiles!==null?Math.max(0,base.discoveredFiles-(remaining??0)-failures.length):base.completedFiles,
      state:this.indexing?'building':failures.length || error || (remaining??0)>0?(hasSaved?'partial':'failed'):settled?'ready':base.state};
  }
  private persistDiagnostics():void {
    this.store.setIndexDiagnostics({...this.store.getIndexDiagnostics(),scans:{all:{...this.fileIndex},...this.rootScans}});
  }

  ruleFilePaths():string[]{return this.indexer.ruleFilePaths();}

  /** Rebuild the in-memory retrieval snapshot from the store. */
  private refreshSnapshot(): void {
    this.snapshot=this.store.loadAll();
    this.retriever = new Retriever(this.snapshot.filter(chunk => this.indexer.readable(chunk)));
  }

  indexAll(onProgress?: (p: IndexProgress) => void): Promise<{ indexed: number; files: number }> {
    return this.fileWork.run(()=>this.indexAllNow(onProgress));
  }
  private beginOperation(kind:FileOperation['kind'],state:'queued'|'running'='running'):FileOperation {
    const op:FileOperation={id:(this.operation?.id??0)+1,kind,state,phase:'enumerate',totalFiles:null,completedFiles:0,failedFiles:0,remainingFiles:null,error:null};
    this.operation=op;this.rootOperations={};return op;
  }
  private progressOperation(op:FileOperation,p:IndexProgress):void {
    if(this.operation!==op)return;
    op.phase=p.phase;op.totalFiles=p.phase==='enumerate'?null:p.total;op.completedFiles=p.done;op.failedFiles=p.failed??0;
    op.remainingFiles=op.totalFiles===null?null:Math.max(0,p.total-p.done-(p.failed??0));
    if(p.sources){for(const source of p.sources){const key=this.coverageRoot(source.sourcePath,source.sourceClass)??'primary';
      const scoped=this.rootOperations[key]??={...op,rootId:key==='primary'?null:key,totalFiles:0,completedFiles:0,failedFiles:0,remainingFiles:0};scoped.totalFiles!++;scoped.remainingFiles!++;
    }}
    if(p.file&&p.success!==undefined){const scoped=this.rootOperations[this.coverageRoot(p.file)??'primary'];if(scoped){if(p.success)scoped.completedFiles++;else scoped.failedFiles++;scoped.remainingFiles=Math.max(0,(scoped.remainingFiles??0)-1);}}
  }
  private finishOperation(op:FileOperation,error?:unknown,cancelled=false):void {
    if(this.operation!==op)return;
    op.error=error?(typeof error==='object'&&error!==null&&'category' in error&&'action' in error?error as SafeIndexError:safeIndexError(error)):null;
    op.state=cancelled?'cancelled':error?'failed':op.failedFiles?'partial':'completed';
    for(const scoped of Object.values(this.rootOperations)){scoped.error=op.error;scoped.state=cancelled?'cancelled':error&&(scoped.remainingFiles??0)>0?'failed':scoped.failedFiles?'partial':'completed';}
  }
  private async indexAllNow(onProgress?: (p: IndexProgress) => void): Promise<{ indexed: number; files: number }> {
    if (this.indexing) throw new Error('An index pass is already running. Wait for it to finish.');
    if(this.closed)throw Error('Memory is closed.');
    const indexer=this.indexer,generation=this.policyGeneration,op=this.beginOperation('scan');let passError:unknown;
    this.indexing = true;
    this.indexFinished = new Promise(resolve => { this.finishIndex = resolve; });
    this.fileIndex={state:'building',phase:'enumerate',discoveredFiles:null,completedFiles:0,failedFiles:0,remainingFiles:null,error:null};
    try {
      this.startWatching(true);
      await this.watcher?.ready();
      // Publish changed chunks during a long pass, but do not deserialize the
      // entire catalog (including virtual records) for unchanged file batches.
      let snapshotIndexed = 0;
      const result = await indexer.indexAll((p) => {
        if(generation!==this.policyGeneration)return;
        this.progressOperation(op,p);
        this.fileIndex.phase=p.phase;
        if (p.phase === 'index' || p.phase === 'done') {
          this.fileIndex.discoveredFiles=p.total;this.fileIndex.completedFiles=p.done;this.fileIndex.failedFiles=p.failed??0;
          this.fileIndex.remainingFiles=Math.max(0,p.total-p.done-(p.failed??0));
        }
        if(p.sources){
          this.rootScans={};
          for(const root of this.roots)this.rootScans[root.id==='harness-memory'?'primary':root.id??'primary']={state:'building',phase:'index',discoveredFiles:0,completedFiles:0,failedFiles:0,remainingFiles:0,error:null};
          for(const source of p.sources){const key=this.coverageRoot(source.sourcePath,source.sourceClass)??'primary';
            const scan=this.rootScans[key]??={state:'building',phase:'index',discoveredFiles:0,completedFiles:0,failedFiles:0,remainingFiles:0,error:null};
            scan.discoveredFiles!++;scan.remainingFiles!++;
          }
        }
        if(p.file && p.success!==undefined){const scan=this.rootScans[this.coverageRoot(p.file)??'primary'];if(scan){
          if(p.success)scan.completedFiles!++;else scan.failedFiles!++;
          scan.remainingFiles=Math.max(0,(scan.remainingFiles??0)-1);
        }}

        if (p.phase === 'index' && p.done > 0 && p.done % SNAPSHOT_REFRESH_EVERY_FILES === 0 && (p.indexed ?? 0) > snapshotIndexed) {
          this.refreshSnapshot();
          snapshotIndexed = p.indexed!;
        }
        if(p.success===false)this.refreshSnapshot();
        onProgress?.(p);
      });
      if(generation===this.policyGeneration)this.fileIndex.state='ready';
      this.embedderChanged = false;
      // Pruning and metadata-only changes are published in finally.
      return result;
    } catch (error) {
      passError=error;
      this.fileIndex.error=safeIndexError(error);
      this.fileIndex.failedFiles=this.indexer.failuresForStatus().length;
      this.fileIndex.state=this.store.count()>0 ? 'partial' : 'failed';
      throw error;
    } finally {
      this.refreshSnapshot();
      this.finishOperation(op,passError,generation!==this.policyGeneration);
      this.indexing = false;
      for(const scan of Object.values(this.rootScans))scan.state=(scan.failedFiles??0)>0 || (scan.remainingFiles??0)>0?'partial':'ready';
      this.persistDiagnostics();
      this.finishIndex?.();
      this.finishIndex = null;
    }
  }

  /** Wait for a current pass without polling or swallowing its published status. */
  async waitForIndexing(): Promise<void> {
    await this.indexFinished;
  }

  /** Invalidate pending file embeddings before a host root change is queued. */
  cancelFileIndexing(): void { this.indexer.cancel(); }

  updateSources(
    sources:SourceSet[],workspaceExclude:string[],options?:{paths?:string[];incremental?:boolean}
  ):Promise<{indexed:number;files:number}> {
    if(this.closed)return Promise.reject(Error('Memory is closed.'));
    const previous=this.indexer;
    previous.cancel();
    if(this.indexing)this.interruptedScan=true;
    if(this.activeSourcePaths===null)this.pendingDiscovery=true;
    else for(const path of this.activeSourcePaths??[])this.pendingPaths.add(path);
    for(const path of options?.paths??[])this.pendingPaths.add(path);
    if(!options?.paths)this.pendingDiscovery=true;
    this.config={...this.config,sources,workspaceExclude};
    this.roots=resolveRoots(this.config.root,sources);
    this.indexer=new Indexer(this.config,this.store,this.embedder);
    this.indexer.inheritState(previous);this.indexer.noteRulePaths([...this.pendingPaths]);
    const generation=++this.policyGeneration;
    this.watcher?.configure(this.config,this.indexer);
    const queued=this.beginOperation('rules','queued');
    return this.fileWork.run(async()=>{
      if(generation!==this.policyGeneration||this.closed)return{indexed:0,files:0};
      const indexer=this.indexer,paths=this.pendingDiscovery?undefined:[...this.pendingPaths];
      this.pendingPaths.clear();this.pendingDiscovery=false;this.activeSourcePaths=paths??null;
      try {
        this.startWatching(true);await this.watcher?.refreshConfiguration();
        if(this.interruptedScan || !options?.incremental){this.interruptedScan=false;return await this.indexAllNow();}
        const op=queued;op.state='running';let error:unknown;
        try{return await indexer.reconcile(paths,previous,p=>this.progressOperation(op,p));}
        catch(e){error=e;throw e;}
        finally{this.refreshSnapshot();this.finishOperation(op,error,generation!==this.policyGeneration);this.persistDiagnostics();}
      }finally{this.activeSourcePaths=undefined;await this.watcher?.acknowledge(paths??[]);}
    });
  }

  startWatching(seedOnly=false):void {
    if(this.watcher)return;
    this.watcher=new IndexWatcher(this.config,this.indexer,()=>{this.refreshSnapshot();this.persistDiagnostics();},(error,sourcePath)=>{
      this.refreshSnapshot();
      if(this.operation){this.operation.error=safeIndexError(error);this.operation.state='failed';}
      if(!sourcePath)this.fileIndex.globalError=safeIndexError(error);
    },async()=>{},work=>this.fileWork.run(async()=>{
      if(this.closed)return;
      const op=this.beginOperation('watch');
      try{await work();if(op.state==='failed')this.finishOperation(op,op.error);else this.finishOperation(op);}catch(error){this.finishOperation(op,error);throw error;}
    }),p=>{if(this.operation?.kind==='watch')this.progressOperation(this.operation,p);});
    this.watcher.start(seedOnly);
  }

  // --- Virtual records (DB-resident content: trackers, sessions, …) ---------

  /**
   * Ingest records that don't live on disk. Chunks, embeds (only changed
   * records, by content hash), and upserts them into the same hybrid index as
   * files — so one `search()` spans markdown + trackers + sessions. Refreshes
   * the retrieval snapshot so the new records are immediately searchable.
   *
   * Each record's `id` must be globally unique (the host namespaces it); it is
   * the synthetic source path and the `removeRecords` key.
   */
  async ingestRecords(records: VirtualRecord[]): Promise<{ ingested: number }> {
    const { embedded, changed } = await this.indexer.indexRecords(records);
    const projection=this.store.getSessionProjection();
    for(const record of records) if(record.refType==='session') projection.parents[record.id]=record.parentSessionId??null;
    this.store.setSessionProjection(projection);
    if (changed > 0) this.refreshSnapshot();
    return { ingested: embedded };
  }

  async syncFileRecords(records: FileRecord[], obsoleteIds: string[] = []): Promise<void> {
    try {
      for (const id of obsoleteIds) this.store.deleteSource(id);
      await this.indexer.syncFileRecords(records);
    } finally {
      this.refreshSnapshot();
      this.watcher?.refreshEntityPaths();
    }
  }

  /**
   * Remove virtual records by their `id` (the same value passed as
   * `VirtualRecord.id`). Idempotent — unknown ids are no-ops. Refreshes the
   * retrieval snapshot.
   */
  removeRecords(ids: string[]): void {
    if (ids.length === 0) return;
    for (const id of ids) this.store.deleteSource(id);
    this.refreshSnapshot();
  }

  clearSessionRecords(): { removed: number } {
    const removed = this.store.clearSessionRecords();
    this.store.setSessionProjection({version:0,parents:{}});
    this.refreshSnapshot();
    return { removed };
  }

  // --- Retrieval -----------------------------------------------------------

  completeSessionProjection(version:number|undefined,parents:Record<string,string|null>): void {
    for(const source of this.store.sourcePaths()) {
      if(source.startsWith('session:') && !(source in parents)) this.store.deleteSource(source);
    }
    this.store.setSessionProjection({version:version??this.store.getSessionProjection().version,parents});
    this.refreshSnapshot();
  }

  async search(
    query: string,
    k = 5,
    opts?: { sourceClasses?: string[] },
  ): Promise<SearchHit[]> {
    let vec: number[] | null = null;
    try {
      const [embedded] = await this.embedder.embed([query]);
      vec = embedded ?? null;
      if (this.lastEmbedError) {
        this.log('info', '[engine] query embedding recovered; dense retrieval re-enabled');
        this.lastEmbedError = null;
      }
    } catch (err) {
      if((err as {code?:string})?.code==='EMBEDDING_INPUT_TOO_LARGE')throw err;
      // Fall back to sparse-only, but DO NOT swallow silently — a persistent
      // failure here is the difference between hybrid and BM25-only retrieval.
      vec = null;
      const msg = (err as Error)?.message ?? String(err);
      if (this.lastEmbedError !== msg) {
        this.log('warn', `[engine] query embedding failed; falling back to sparse-only (${safeIndexError(err).category})`);
      }
      this.lastEmbedError = msg;
    }
    const parents=this.store.getSessionProjection().parents;
    return this.retriever.search(query, vec, k, {...opts,accepts:chunk=>this.indexer.readable(chunk)}).filter(hit=>!this.indexer.sourceFailed(hit.sourcePath)).map(hit=>hit.refType==='session'
      ? {...hit,parentSessionId:parents[hit.sourcePath]??null}:hit);
  }

  expand(sourcePath: string, headingPath: string[]): { sourcePath: string; headingPath: string[]; text: string } | null {
    if(!this.snapshot.some(chunk=>chunk.sourcePath===sourcePath&&this.indexer.readable(chunk)))return null;
    return this.retriever.expandSection(sourcePath, headingPath);
  }

  /**
   * The most-recently-modified document in a source class (by file mtime), with
   * its content. Host-agnostic: "latest plan" is just latestDoc('plans') to the
   * caller. Returns null when the class has no files on disk.
   */
  async latestDoc(
    sourceClass: string
  ): Promise<{ path: string; content: string; mtimeMs: number } | null> {
    const [latest] = await this.recentDocs(sourceClass, 1);
    return latest ?? null;
  }

  /**
   * The N most-recently-modified documents in a source class (newest first),
   * each with its content. Host-agnostic; honors `config.exclude`. Used by
   * auto-distillation to harvest candidate facts from recent decisions/plans.
   * Returns `[]` when the class has no files.
   */
  async recentDocs(
    sourceClass: string,
    limit: number
  ): Promise<Array<{ path: string; content: string; mtimeMs: number }>> {
    const files = await this.indexer.filesForClass(sourceClass);
    const stamped: Array<{ path: string; mtimeMs: number }> = [];
    for (const sp of files) {
      try {
        const { abs } = resolveInRoots(this.roots, sp);
        const st = await stat(abs);
        stamped.push({ path: sp, mtimeMs: st.mtimeMs });
      } catch {
        // File vanished between glob and stat — skip it.
      }
    }
    stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const top = stamped.slice(0, Math.max(0, limit));
    const out: Array<{ path: string; content: string; mtimeMs: number }> = [];
    for (const s of top) {
      const { content } = await this.readDoc(s.path);
      out.push({ path: s.path, content, mtimeMs: s.mtimeMs });
    }
    return out;
  }

  /**
   * Read a managed doc by `sourcePath` (or a bare primary-relative path).
   *
   * Guarded: the resolved path must land inside ONE OF the configured roots.
   * This is a set-membership test, not a relaxation of the old single-root
   * check — a path escaping the root it names still throws even when other
   * roots exist, and there is no configuration that disables it. It is the only
   * thing standing between this tool and arbitrary file reads.
   */
  async readDoc(sourcePath: string): Promise<{ path: string; content: string }> {
    let resolved: ReturnType<typeof resolveInRoots>;
    try {
      resolved = resolveInRoots(this.roots, sourcePath);
    } catch (err) {
      throw new Error(`read_doc: ${(err as Error).message}`);
    }
    if (!await isInsideRealRoot(resolved.root.dir, resolved.abs)) throw new Error('read_doc: file escapes its configured root');
    const content = await readFile(resolved.abs, 'utf8');
    return { path: resolved.sourcePath, content };
  }

  /**
   * Roots whose content is personal and machine-local. Anything that publishes
   * indexed content off this machine (the phase-4 committed JSONL replica, team
   * sync, an export) MUST exclude these — see `SourceRoot.personal`.
   */
  personalRoots(): ResolvedRoot[] {
    return this.roots.filter((r) => r.personal);
  }

  /** True when a `sourcePath` belongs to a personal, machine-local root. */
  isPersonalSourcePath(sourcePath: string): boolean {
    try {
      return resolveInRoots(this.roots, sourcePath).root.personal;
    } catch {
      // Unresolvable — treat as personal. A path we cannot attribute is never
      // safe to publish.
      return true;
    }
  }

  // --- Facts ---------------------------------------------------------------

  remember(input: RememberInput): Promise<string> {
    return this.facts.remember(input);
  }

  recall(q: RecallQuery): Promise<Fact[]> {
    return this.facts.recall(q);
  }

  topFacts(limit = 8): Promise<Fact[]> {
    return this.facts.top(limit);
  }

  /** Delete a fact by its relative sourcePath. Returns true if removed. The
   *  fact's chunks are pruned from the shadow index on the next index pass. */
  deleteFact(sourcePath: string): Promise<boolean> {
    return this.facts.delete(sourcePath);
  }

  // --- Lifecycle -----------------------------------------------------------

  status(rootId?:string|null): EngineStatus {
    const summaries=this.store.sourceSummaries().filter(row=>(!row.sourcePath.startsWith('@')||this.roots.some(root=>root.id&&row.sourcePath.startsWith('@'+root.id+'/'))) && (rootId===undefined || this.coverageRoot(row.sourcePath,row.sourceClass)===rootId));
    const bySourceClass:Record<string,number>={};
    for(const row of summaries)bySourceClass[row.sourceClass]=(bySourceClass[row.sourceClass]??0)+row.chunks;
    const chunks=summaries.reduce((n,row)=>n+row.chunks,0),dense=summaries.reduce((n,row)=>n+row.dense,0);
    const availableRows=this.snapshot.filter(row=>row.granularity!=='page'&&this.indexer.readable(row)&&(rootId===undefined||this.coverageRoot(row.sourcePath,row.sourceClass)===rootId));
    const availableClasses:Record<string,number>={};for(const row of availableRows)availableClasses[row.sourceClass]=(availableClasses[row.sourceClass]??0)+1;
    const available={chunks:availableRows.length,sourceFiles:new Set(availableRows.map(r=>r.sourcePath)).size,indexedFiles:new Set(availableRows.filter(r=>r.refType==='doc-file').map(r=>r.sourcePath)).size,bySourceClass:availableClasses,lastIndexedAt:availableRows.length?Math.max(...availableRows.map(r=>r.updatedAt)):null};
    const semanticAvailable = this.embedder.info.dims > 0 && !this.lastEmbedError;
    const retrieval: RetrievalCapabilities = {
      mode: semanticAvailable ? 'hybrid' : 'keyword-only',
      semantic: semanticAvailable
        ? { available: true }
        : {
            available: false,
            reason: 'optional-embedding-provider-unavailable',
          },
      keyword: { available: true, source: 'local-project-index' },
    };
    return {
      available,operation:rootId===undefined?this.operation:this.rootOperations[rootId??'primary']??null,lastFullScan:rootId===undefined?{...this.fileIndex}:this.rootScans[rootId??'primary'],
      chunks,
      denseChunks:dense,
      bySourceClass,
      sourceFiles: new Set(summaries.map(row=>row.sourcePath)).size,
      lastIndexedAt: summaries.length?Math.max(...summaries.map(row=>row.updatedAt)):null,
      embedder: this.embedder.info,
      embedderChanged: this.embedderChanged,
      indexing: rootId===undefined?this.operation?.state==='running'||this.operation?.state==='queued':this.rootOperations[rootId??'primary']?.state==='running',
      fileIndex:this.fileStatus(rootId),
      indexedFiles:new Set(summaries.filter(row=>row.refType==='doc-file').map(row=>row.sourcePath)).size,
      watching: this.watcher?.isWatching(rootId) ?? false,
      chunksWithoutVectors: chunks-dense,
      embeddingError: this.lastEmbedError ? safeIndexError(new Error(this.lastEmbedError)) : null,
      lastEmbedError: this.lastEmbedError,
      retrieval,
      root: this.config.root,
    };
  }

  /** Allocated database size; temporary SQLite journals are not indexed content. */
  async indexSizeBytes(): Promise<number> {
    return this.store.sizeBytes();
  }

  async close(): Promise<void> {
    this.closed=true;this.indexer.cancel();
    await this.fileWork.idle();
    await this.waitForIndexing();
    await this.watcher?.stop();
    this.store.close();
  }
}
