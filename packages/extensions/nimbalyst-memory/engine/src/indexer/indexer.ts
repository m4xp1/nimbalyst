/// <reference path="../picomatch.d.ts" />

/**
 * Markdown indexer: walk source globs → chunk → hash → embed (only dirty
 * chunks) → upsert into the shadow store. Incremental by content hash; unchanged
 * chunks reuse their stored embedding so a one-line edit re-embeds one chunk,
 * not the whole file.
 */
import { readFile } from 'node:fs/promises';
import { expandSourcePatterns, isInsideRealRoot, pathOverrideFor, type PathOverride } from '../sourceRules.js';
import path from 'node:path';
import fg from 'fast-glob';
import picomatch from 'picomatch';
import type {
  Chunk,
  Embedder,
  EngineConfig,
  SourceSet,
  StoredChunk,
  VirtualRecord,
  FileRecord,
} from '../types.js';
import { parseFrontmatter } from '../frontmatter.js';
import { safeIndexError, isProviderIndexFailure, type SourceIndexFailure } from '../indexStatus.js';
import { PAGE_VECTOR_BYTES } from '../types.js';
import { embeddingInput, utf8Prefix, MAX_CHUNK_BODY_BYTES } from '../embeddingInput.js';
import { chunkMarkdown } from '../chunker.js';
import { sha256 } from '../hash.js';
import { termFrequencies } from '../retrieval/bm25.js';
import type { SqliteStore } from '../store/sqliteStore.js';
import {
  locateAbsolute,
  parseSourcePath,
  resolveInRoots,
  resolveRoots,
  rootForSet,
  toSourcePath,
  type ResolvedRoot,
} from '../roots.js';

export interface IndexProgress {
  phase: 'enumerate' | 'index' | 'prune' | 'done';
  file?: string;
  done: number;
  total: number;
  /** Chunks requiring embedding so far; unchanged files do not advance this. */
  indexed?: number;
  failed?:number; success?:boolean; sources?:FileRef[];
}

interface FileRef {
  /** `sourcePath` (root-prefixed for non-primary roots). */
  sourcePath: string;
  sourceClass: string;
}

/** A source chunked + dirty-checked but not yet embedded (see `prepareContent`). */
interface PreparedSource {
  sourcePath: string;
  /** All chunks for the source; reusable ones already carry their dense vector. */
  stored: StoredChunk[];
  /** Chunks needing a (re)embed, as indices into `stored` plus the embed input. */
  pending: { idx: number; input: string }[];
  /** Every row already stored with identical content and metadata; nothing to write. */
  unchanged: boolean;
}

/** True when every field chunking produced matches the stored row. */
function sameChunk(next: Chunk, prev: StoredChunk): boolean {
  const a = next as unknown as Record<string, unknown>;
  const b = prev as unknown as Record<string, unknown>;
  return Object.keys(a).every((k) => JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null));
}

/** Embed input includes the heading breadcrumb for extra context. */
function embedInput(headingPath: string[], text: string): string {
  return embeddingInput(headingPath, text);
}

/**
 * Build the page-level row for one source: amendment A2's whole-document
 * vector, stored beside that source's chunks.
 *
 * It carries no `sparseTerms`, so it cannot leak into BM25 statistics, and an
 * empty `headingPath`, because a page row is a document-level SIGNAL rather
 * than a citable answer — the retriever resolves a page hit to the best chunk
 * inside that document before returning it.
 *
 * Returns null for a source short enough that the page vector would just be a
 * copy of its only chunk, which would cost an embedding to say nothing.
 */
function pageRowFor(
  sourcePath: string,
  sourceClass: string,
  raw: string,
  chunkCount: number,
  ref?: { refType?: string; refId?: string }
): Chunk | null {
  if (chunkCount <= 1) return null;
  const text = utf8Prefix(raw, Math.min(PAGE_VECTOR_BYTES, MAX_CHUNK_BODY_BYTES));
  if (!text.trim()) return null;
  return {
    id: `${sourcePath}#page`,
    sourcePath,
    sourceClass,
    headingPath: [],
    // Sorts ahead of every real chunk and can never collide with one.
    ordinal: -1,
    text,
    contentHash: sha256(text),
    refType: ref?.refType ?? 'doc-file',
    refId: ref?.refId ?? sourcePath,
    granularity: 'page',
  };
}

export class Indexer {
  private failures = new Map<string,SourceIndexFailure>();
  sourceFailed(sourcePath:string):boolean {return this.failures.has(sourcePath);}
  failuresForStatus():SourceIndexFailure[] { return [...this.failures.values()]; }
  private recordFailure(sourcePath:string,error:unknown):void {
    const rootId=this.roots.find(root=>root.id && sourcePath.startsWith('@'+root.id+'/'))?.id??null;
    const record=[...this.fileRecords.values()].find(record=>record.id===sourcePath);
    const relativePath=record?.file.path??(rootId&&rootId!=='harness-memory'?sourcePath.slice(rootId.length+2):sourcePath);
    this.failures.set(sourcePath,{sourcePath,relativePath,rootId:rootId==='harness-memory'?null:rootId,error:safeIndexError(error),updatedAt:Date.now()});
    this.persistFailures();
  }
  private clearFailure(sourcePath:string):void { if(this.failures.delete(sourcePath))this.persistFailures(); }
  private persistFailures():void { this.store.setIndexDiagnostics({...this.store.getIndexDiagnostics(),failures:[...this.failures.values()]}); }
  private failureKey(sourcePath:string):string {
    const key=this.entityFileKey(sourcePath);return (key&&this.fileRecords.get(key)?.id)||sourcePath;
  }
  private cancelled = false;
  cancel(): void { this.cancelled = true; }
  private rootOverrides=new Map<string,PathOverride[]>();
  private knownFiles=new Set<string>();
  private unsupportedFiles=new Set<string>();
  private rootExcluded = new Map<string, (p: string) => boolean>();
  private fileRecords = new Map<string, FileRecord>();
  private validatedFiles = new Set<string>();
  private entityIds = new Set<string>();
  private fileLanes = new Map<string, Promise<number>>();
  private roots: ResolvedRoot[];
  private matchers: { sourceClass: string; root: ResolvedRoot; isMatch: (p: string) => boolean }[];
  private isExcluded: (p: string) => boolean;
  private ignoreGlobs: string[];
  private isWorkspaceExcluded: (p:string) => boolean;

  constructor(
    private config: EngineConfig,
    private store: SqliteStore,
    private embedder: Embedder
  ) {
    this.roots = resolveRoots(config.root, config.sources);
    this.failures = new Map(store.getIndexDiagnostics().failures.map(f=>[f.sourcePath,f]));
    // A matcher is bound to its set's root: `docs/**/*.md` declared against the
    // primary root must not claim a `docs/x.md` that lives under another root.
    this.matchers = config.sources.map((set) => ({
      sourceClass: set.sourceClass,
      root: rootForSet(this.roots, set),
      isMatch: picomatch(expandSourcePatterns(set.include, rootForSet(this.roots,set).dir), { dot: true }),
    }));
    for (const root of this.roots) {
      this.rootOverrides.set(root.dir,config.sources.filter(set=>rootForSet(this.roots,set).dir===root.dir).flatMap(set=>set.pathOverrides??[]));
      const patterns = config.sources.filter(set => rootForSet(this.roots, set).dir === root.dir).flatMap(set => set.exclude ?? []);
      this.rootExcluded.set(root.dir, patterns.length ? picomatch(expandSourcePatterns(patterns, root.dir), {dot:true,nocase:true}) : () => false);
    }
    const exclude = config.exclude ?? [];
    this.isWorkspaceExcluded = config.workspaceExclude?.length ? picomatch(expandSourcePatterns(config.workspaceExclude, config.root),{dot:true,nocase:true}) : () => false;
    this.isExcluded = exclude.length ? picomatch(exclude, { dot: true, nocase: true }) : () => false;
    this.ignoreGlobs = exclude;
    for (const record of this.store.getFileRecords()) {
      const key = this.entityFileKey(record.file?.path);
      if (key) this.fileRecords.set(key, record);
    }
    this.entityIds = new Set([...this.fileRecords.values()].map(r => r.id));
    for(const sp of store.fileSourcePaths())this.knownFiles.add(sp);
  }

  private entityFileKey(ref: string | undefined): string | null {
    if (!ref || /^[a-z][a-z\d+.-]*:\/\//i.test(ref)) return null;
    const abs = path.resolve(this.config.root, ref.replace(/[\\/]/g, path.sep));
    const rel = path.relative(this.config.root, abs);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  }

  entityFilePaths(): string[] { return [...this.fileRecords.values()].map(r => path.resolve(this.config.root, r.file.path.replace(/[\\/]/g, path.sep))); }

  readable(chunk: StoredChunk): boolean {
    if(this.failures.has(chunk.sourcePath))return false;
    if (chunk.refType === 'doc-file') {
      if (chunk.sourcePath.startsWith('@') && !this.roots.some(root => root.id && chunk.sourcePath.startsWith('@'+root.id+'/'))) return false;
      return this.classifyDocument(chunk.sourcePath) !== null;
    }
    return !this.entityIds.has(chunk.sourcePath) || this.validatedFiles.has(chunk.sourcePath);
  }

  /** Replace the complete ownership manifest; never persist a copy of the file body here. */
  async syncFileRecords(records: FileRecord[]): Promise<void> {
    const old = this.fileRecords;
    this.fileRecords = new Map();
    for (const record of records) {
      const key = this.entityFileKey(record.file?.path);
      if (key) this.fileRecords.set(key, record);
      else this.store.deleteSource(record.id);
    }
    this.store.setFileRecords([...this.fileRecords.values()]);
    this.entityIds = new Set([...this.fileRecords.values()].map(r => r.id));
    for (const [key, previous] of old) {
      if (this.fileRecords.get(key)?.id !== previous.id) {
        this.store.deleteSource(previous.id);
        this.validatedFiles.delete(previous.id);
      }
    }
    // Remove old DOCUMENT clones by normalized path, never by their text.
    for (const sourcePath of this.store.fileSourcePaths()) {
      try {
        const { abs } = resolveInRoots(this.roots, sourcePath);
        const key = this.entityFileKey(abs);
        if (key && this.fileRecords.has(key)) this.store.deleteSource(sourcePath);
      } catch { /* An unrelated root's key is not ours to remove. */ }
    }
    for (const record of this.fileRecords.values()) await this.indexFile(record.file.path, record.sourceClass);
    for (const [key, previous] of old) {
      if (!this.fileRecords.has(key)) {
        const hit = this.classify(previous.file.path);
        if (hit) await this.indexFile(hit.sourcePath, hit.sourceClass);
      }
    }
  }

  /** The configured roots, primary first. */
  sourceRoots(): ResolvedRoot[] {
    return this.roots;
  }

  /**
   * `sourcePath`s of the files in a given source class, honoring the configured
   * excludes. Host-agnostic: a source class is just a label on a glob set, so
   * this is "the docs that belong to this class" with no app knowledge.
   */
  async filesForClass(sourceClass: string): Promise<string[]> {
    const out = new Set<string>();
    for (const set of this.config.sources) {
      if (set.sourceClass !== sourceClass) continue;
      for (const sp of await this.globSet(set)) out.add(sp);
    }
    return Array.from(out);
  }

  /** Resolve all source files (first matching source set wins). */
  async enumerate(): Promise<FileRef[]> {
    const seen = new Map<string, string>();
    for (const set of this.config.sources) {
      const matches = await this.globSet(set);
      for (const sp of matches) if (!seen.has(sp)) seen.set(sp, set.sourceClass);
    }
    for (const record of this.fileRecords.values()) {
      const hit = this.classify(record.file.path);
      if (hit) seen.set(hit.sourcePath, record.sourceClass);
    }
    this.knownFiles=new Set(seen.keys());
    return Array.from(seen.entries()).map(([sourcePath, sourceClass]) => ({
      sourcePath,
      sourceClass,
    }));
  }

  /**
   * Walk one source set against ITS root and return `sourcePath`s — prefixed for
   * a non-primary root, so a `README.md` under two roots yields two distinct
   * keys instead of colliding on the chunk primary key.
   */
  private async globSet(set: SourceSet): Promise<string[]> {
    const root = rootForSet(this.roots, set);
    const rels = await fg(expandSourcePatterns(set.include, root.dir), {
      cwd: root.dir,
      absolute: false,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      suppressErrors: false,
      ignore: [
        ...this.ignoreGlobs,
        ...((this.rootOverrides.get(root.dir)??[]).some(o=>o.mode==='include')?[]:[...expandSourcePatterns(set.exclude??[],root.dir),...(root.id===null?expandSourcePatterns(this.config.workspaceExclude??[],this.config.root):[])]),
      ],
    });
    const safe: string[] = [];
    for (const rel of rels) {
      if (
        this.excludedByRules(root,rel)
      )
        continue;
      if (
        root.id === null &&
        !(await isInsideRealRoot(root.dir, path.resolve(root.dir, rel)))
      )
        continue;
      if (!this.classifyDocument(toSourcePath(root,rel))) continue;
      const abs = path.resolve(root.dir, rel);
      if (locateAbsolute(this.roots, abs)?.root.dir !== root.dir || !await isInsideRealRoot(root.dir, abs)) continue;
      safe.push(toSourcePath(root, rel));
    }
    return safe;
  }

  /** Full (incremental) index pass. */
  async indexAll(onProgress?: (p: IndexProgress) => void): Promise<{ indexed: number; files: number }> {
    onProgress?.({ phase: 'enumerate', done: 0, total: 0 });
    const files = await this.enumerate();
    const live = new Set(files.map((f) => f.sourcePath));
    onProgress?.({phase:'index',done:0,total:files.length,indexed:0,failed:0,sources:files});

    let indexed = 0, completed = 0, failed = 0;
    for (let i = 0; i < files.length; i++) {
      if (this.cancelled) return { indexed, files: i };
      const f = files[i];
      try {
        indexed += await this.indexFile(f.sourcePath, f.sourceClass);
        completed++;
        onProgress?.({phase:'index',file:f.sourcePath,done:completed,total:files.length,indexed,failed,success:true});
      } catch(error) {
        failed++;
        onProgress?.({phase:'index',file:f.sourcePath,done:completed,total:files.length,indexed,failed,success:false});
        if(isProviderIndexFailure(error))throw error;
      }
    }

    if (this.cancelled) return { indexed, files: files.length };
    // Drop files that no longer exist on disk. Only file-backed sources are
    // considered — virtual records (trackers, sessions) are never pruned here,
    // so a markdown re-index can't wipe the catalog.
    onProgress?.({ phase: 'prune', done: 0, total: 0 });
    for (const sourcePath of this.store.fileSourcePaths()) {
      if (!live.has(sourcePath)) this.store.deleteSource(sourcePath);
    }

    const liveFailures=new Set(files.map(f=>this.failureKey(f.sourcePath)));
    for(const key of this.failures.keys())if(!liveFailures.has(key))this.clearFailure(key);
    onProgress?.({ phase: 'done', done: completed, total: files.length,failed });
    return { indexed, files: files.length };
  }

  /** Index a single file by `sourcePath`. Returns the number of chunks (re)embedded. */
  async indexFile(sourcePath: string, sourceClass: string): Promise<number> {
    this.knownFiles.add(sourcePath);
    const key = this.entityFileKey(sourcePath) ?? sourcePath;
    const previous = this.fileLanes.get(key) ?? Promise.resolve(0);
    const next = previous.catch(() => 0).then(() => this.indexFileNow(sourcePath, sourceClass));
    this.fileLanes.set(key, next);
    try {
      const result=await next;
      if(!this.cancelled)this.clearFailure(this.failureKey(sourcePath));
      return result;
    } catch(error) {
      if(!this.cancelled)this.recordFailure(this.failureKey(sourcePath),error);
      throw error;
    } finally { if (this.fileLanes.get(key) === next) this.fileLanes.delete(key); }
  }

  private async indexFileNow(sourcePath: string, sourceClass: string): Promise<number> {
    const key = this.entityFileKey(sourcePath);
    const record = key ? this.fileRecords.get(key) : undefined;
    if (record) return this.indexEntityFile(record);
    let abs: string;
    let root: ResolvedRoot;
    try {
      ({ abs, root } = resolveInRoots(this.roots, sourcePath));
      if (!this.classify(sourcePath)) { this.store.deleteSource(sourcePath); return 0; }
    } catch (err) {
      // Outside every configured root. Never seen for a path we derived, so this
      // is a bug rather than a deletion — log it and touch nothing, so a bad
      // path can't prune real index rows.
      this.config.onLog?.('warn', `[indexer] refusing to index ${sourcePath}: ${(err as Error).message}`);
      return 0;
    }
    let raw: string;
    try {
      if (!await isInsideRealRoot(root.dir,abs)) { this.store.deleteSource(sourcePath); return 0; }
      const bytes = await readFile(abs);
      if (bytes.includes(0)) { this.unsupportedFiles.add(sourcePath);this.store.deleteSource(sourcePath); return 0; }
      try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { this.unsupportedFiles.add(sourcePath);this.store.deleteSource(sourcePath); return 0; }
      this.unsupportedFiles.delete(sourcePath);
    } catch (err) {
      if (!['ENOENT','ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
      // File vanished mid-pass; treat as deletion.
      this.store.deleteSource(sourcePath);
      return 0;
    }
    // `sourcePath` is the index key; `refId` is what a caller opens. They are
    // the same string for the primary root, but a file under another root is
    // not reachable from the workspace path, so it carries its absolute path
    // instead — otherwise a hit from that root can be found and not opened.
    return this.indexContent(
      sourcePath,
      sourceClass,
      raw,
      root.id === null ? undefined : { refId: abs }
    );
  }

  private async indexEntityFile(record: FileRecord): Promise<number> {
    const abs = path.resolve(this.config.root, record.file.path.replace(/[\\/]/g, path.sep));
    const rel = path.relative(this.config.root, abs).split(path.sep).join('/');
    this.validatedFiles.delete(record.id);
    this.store.deleteSource(rel);
    let embedding = false;
    try {
      if (record.file.disabled || this.excludedByRules(this.roots[0],rel) || !await isInsideRealRoot(this.config.root, abs)) {
        this.store.deleteSource(record.id); return 0;
      }
      const bytes = await readFile(abs);
      if (bytes.includes(0)) throw new Error('Binary file body');
      const raw = new TextDecoder('utf-8', {fatal:true}).decode(bytes).replace(/^\uFEFF/, '');
      const parsed = parseFrontmatter(raw);
      const marker = parsed.data[record.file.markerKey];
      const fields = marker && typeof marker === 'object' && !Array.isArray(marker)
        ? { ...parsed.data, ...marker as Record<string, unknown> } : null;
      const type = fields && record.file.typeField ? fields[record.file.typeField] ?? record.file.defaultType : undefined;
      if (!fields || (record.file.expectedType && type !== record.file.expectedType)) {
        this.store.deleteSource(record.id);
        const hit = this.classifyDocument(rel);
        embedding = true;
        return hit ? await this.indexContent(hit.sourcePath, hit.sourceClass, raw) : 0;
      }
      const metadata = Object.entries(record.file.fields).flatMap(([name,label]) => {
        const value = fields[name];
        return value == null || value === '' ? [] : [`${label}: ${Array.isArray(value) ? value.join(', ') : String(value)}`];
      });
      const title = typeof fields.title === 'string' ? fields.title : record.title;
      const text = [title ? `# ${title}` : '', record.text, ...metadata, parsed.body].filter(Boolean).join('\n\n');
      embedding = true;
      const count = await this.indexContent(record.id, record.sourceClass, text, {refType:record.refType,refId:record.refId});
      this.validatedFiles.add(record.id);
      return count;
    } catch (error) {
      if (embedding || !['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))throw error;
      this.store.deleteSource(record.id);this.store.deleteSource(rel);
      return 0;
    }
  }

  /**
   * Index a virtual record set (trackers, sessions — anything that does NOT live
   * on disk). Dirty-checks per record exactly like a file, but batches the embed
   * call across ALL records so a large backfill is one (internally-paginated)
   * embedder round-trip, not one per record. Returns the number of chunks
   * (re)embedded.
   */
  async indexRecords(records: VirtualRecord[]): Promise<{ embedded: number; changed: number }> {
    if (records.length === 0) return { embedded: 0, changed: 0 };

    const prepared: PreparedSource[] = [];
    const inputs: string[] = [];
    const backref: { p: number; idx: number }[] = [];
    for (const rec of records) {
      const raw = rec.title ? `# ${rec.title}\n\n${rec.text}` : rec.text;
      const p = this.prepareContent(rec.id, rec.sourceClass, raw, {
        refType: rec.refType,
        refId: rec.refId,
      });
      const pi = prepared.push(p) - 1;
      for (const pend of p.pending) {
        backref.push({ p: pi, idx: pend.idx });
        inputs.push(pend.input);
      }
    }

    if (inputs.length) {
      const vectors = await this.embedder.embed(inputs);
      backref.forEach((b, i) => {
        prepared[b.p].stored[b.idx].denseEmbedding = vectors[i] ?? null;
      });
    }

    // Hosts re-send every record on each backfill pass. An unchanged record is
    // not written, and a pass with no changes lets the engine skip reloading
    // the whole catalog (every dense vector) into a new retrieval snapshot.
    let embedded = 0;
    let changed = 0;
    for (const p of prepared) {
      embedded += p.pending.length;
      if (p.unchanged) continue;
      changed++;
      this.store.upsertChunks(p.stored);
      this.store.pruneSource(p.sourcePath, p.stored.map((c) => c.id));
    }
    return { embedded, changed };
  }

  /**
   * Index raw markdown for one source path (file or virtual). Chunk → dirty-check
   * → embed only changed chunks → upsert → prune the stale tail. Returns the
   * number of chunks (re)embedded.
   */
  async indexContent(
    sourcePath: string,
    sourceClass: string,
    raw: string,
    ref?: { refType?: string; refId?: string }
  ): Promise<number> {
    if (this.cancelled && (!ref?.refType || ref.refType === 'doc-file')) return 0;
    const p = this.prepareContent(sourcePath, sourceClass, raw, ref);
    if (p.unchanged) return 0;
    if (p.pending.length) {
      const vectors = await this.embedder.embed(p.pending.map((t) => t.input));
      p.pending.forEach((t, i) => {
        p.stored[t.idx].denseEmbedding = vectors[i] ?? null;
      });
    }
    if (this.cancelled && (!ref?.refType || ref.refType === 'doc-file')) return 0;
    this.store.upsertChunks(p.stored);
    this.store.pruneSource(sourcePath, p.stored.map((c) => c.id));
    return p.pending.length;
  }

  /**
   * Chunk + dirty-check one source without embedding. Reusable chunks keep their
   * stored vector; changed/new ones are collected in `pending` for a batched
   * embed by the caller.
   */
  private prepareContent(
    sourcePath: string,
    sourceClass: string,
    raw: string,
    ref?: { refType?: string; refId?: string }
  ): PreparedSource {
    const chunks = chunkMarkdown(sourcePath, sourceClass, raw, { ...this.config.chunk, plainText: (ref?.refType ?? 'doc-file') === 'doc-file' && !/\.md$/i.test(sourcePath) }, ref);
    // A2: the page-level vector rides the same dirty-check and prune path as
    // the chunks, so it stays consistent with them for free.
    const page = pageRowFor(sourcePath, sourceClass, raw, chunks.length, ref);
    const rows = page ? [...chunks, page] : chunks;
    const existing = new Map(this.store.chunksForSource(sourcePath).map((c) => [c.id, c]));
    const info = this.embedder.info;

    const pending: { idx: number; input: string }[] = [];
    const stored: StoredChunk[] = rows.map((c, idx) => {
      const prev = existing.get(c.id);
      const reusable =
        prev &&
        prev.contentHash === c.contentHash &&
        embedInput(prev.headingPath,prev.text) === embedInput(c.headingPath,c.text) &&
        prev.embedderId === info.id &&
        prev.model === info.model &&
        prev.dims === info.dims &&
        (info.dims === 0 || prev.denseEmbedding);
      if (!reusable) pending.push({ idx, input: embedInput(c.headingPath, c.text) });
      return {
        ...c,
        denseEmbedding: reusable ? prev!.denseEmbedding : null,
        // Page rows stay out of BM25 entirely: giving one terms would both
        // double-count the document's vocabulary in the IDF statistics and let
        // the same source surface twice in the keyword arm.
        sparseTerms: c.granularity === 'page' ? {} : termFrequencies(c.headingPath.length ? c.headingPath.join(' > ') + '\n' + c.text : c.text),
        embedderId: info.id,
        model: info.model,
        dims: info.dims,
        updatedAt: Date.now(),
      };
    });
    const unchanged =
      pending.length === 0 &&
      existing.size === rows.length &&
      rows.every((c) => sameChunk(c, existing.get(c.id)!));
    return { sourcePath, stored, pending, unchanged };
  }

  /** Drop a source file from the index. */
  removeFile(sourcePath: string): void {
    this.clearFailure(this.failureKey(sourcePath));
    this.knownFiles.delete(sourcePath);this.unsupportedFiles.delete(sourcePath);
    const key = this.entityFileKey(sourcePath);
    const record = key ? this.fileRecords.get(key) : undefined;
    if (record) { this.store.deleteSource(record.id); this.validatedFiles.delete(record.id); }
    this.store.deleteSource(sourcePath);
  }

  /**
   * Map an absolute path, a `sourcePath`, or a bare primary-relative path to the
   * source class that claims it plus its canonical `sourcePath`. Null when no
   * source set covers it, when it is excluded, or when an absolute path lies
   * outside every configured root.
   *
   * Returns the `sourcePath` as well as the class because with more than one
   * root the caller can no longer derive it from `config.root` alone — the
   * watcher used to do exactly that.
   */
  classify(relOrAbs: string): { sourceClass: string; sourcePath: string } | null {
    const key = this.entityFileKey(relOrAbs);
    const record = key ? this.fileRecords.get(key) : undefined;
    if (record) {
      const rel = path.relative(this.config.root, path.resolve(this.config.root, record.file.path.replace(/[\\/]/g, path.sep))).split(path.sep).join('/');
      // Excluded paths remain watchable so an older body can be evicted.
      return { sourceClass: record.sourceClass, sourcePath: rel };
    }
    return this.classifyDocument(relOrAbs);
  }

  private excludedByRules(root:ResolvedRoot,relative:string):boolean {
    if(this.isExcluded(relative))return true;
    const override=pathOverrideFor(this.rootOverrides.get(root.dir)??[],relative);
    if(override)return override.mode==='exclude';
    return !!this.rootExcluded.get(root.dir)?.(relative) || root.id===null && this.isWorkspaceExcluded(relative);
  }
  /** Rule membership for the file explorer, independent of successful embeddings. */
  ruleFilePaths():string[]{
    const paths=new Set<string>();
    for(const sp of this.knownFiles){if(this.unsupportedFiles.has(sp))continue;let located;try{located=parseSourcePath(this.roots,sp);}catch{continue;}if(this.excludedByRules(located.root,located.rel))continue;const hit=this.classify(sp);if(hit){try{paths.add(resolveInRoots(this.roots,hit.sourcePath).abs);}catch{/* Detached source. */}}}
    for(const record of this.fileRecords.values())if(!record.file.disabled && !this.excludedByRules(this.roots[0],record.file.path))paths.add(path.resolve(this.config.root,record.file.path));
    return [...paths];
  }
  private classifyDocument(relOrAbs: string): { sourceClass: string; sourcePath: string } | null {
    const located = path.isAbsolute(relOrAbs)
      ? locateAbsolute(this.roots, relOrAbs)
      : parseSourcePath(this.roots, relOrAbs);
    if (!located) return null;
    const { root, rel } = located;
    const posix = rel.split(path.sep).join('/');
    if (locateAbsolute(this.roots, path.resolve(root.dir, posix))?.root.dir !== root.dir || this.excludedByRules(root,posix)) return null;
    for (const m of this.matchers) {
      if (m.root.dir === root.dir && m.isMatch(posix)) {
        return { sourceClass: m.sourceClass, sourcePath: toSourcePath(root, posix) };
      }
    }
    return null;
  }
}
