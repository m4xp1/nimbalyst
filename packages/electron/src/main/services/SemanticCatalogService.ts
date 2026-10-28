/**
 * SemanticCatalogService — bridges DB-resident content (tracker items today; AI
 * sessions later) into the nimbalyst-memory extension's hybrid index, and serves
 * the Quick Open global semantic search.
 *
 * It is entirely reactive to the memory engine's lifecycle: the engine only runs
 * when the user has enabled the (off-by-default) memory extension, so this
 * service does nothing until a `com.nimbalyst.memory/memory-engine` module
 * reaches `running` for a workspace. At that point it backfills the workspace's
 * trackers and subscribes to live changes; when the module stops it tears those
 * subscriptions down. Embeddings are the engine's local, rebuildable shadow
 * index — nothing here is synced.
 */
import type {
  TrackerItem,
  TrackerItemChangeEvent,
  SessionMeta,
} from '@nimbalyst/runtime';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { readMemorySessionContent, invalidateMemorySessionContent } from './sessionMemoryContent';
import { watchSessionMemoryChanges, registerSessionMemoryRebuilder, invalidateSessionMemoryReads, type SessionMemoryChange } from './sessionMemoryEvents';
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { runWhenFirstUsable } from './startupMaintenanceGate';
import { getPrivilegedExtensionHost, type ModuleHandle } from '../extensions/PrivilegedExtensionHost';
import { documentServices } from '../window/WindowManager';
import { getAppSetting, setAppSetting } from '../utils/store';
import * as path from 'node:path';
import { isFileTracker, readFileTrackerBody } from './tracker/fileTrackerBody';
import { EXTENSION_OWNED_KEYS, LEGACY_KEY_TO_TYPE } from '@nimbalyst/runtime/plugins/TrackerPlugin/documentHeader/frontmatterUtils';

const EXT_ID = 'com.nimbalyst.memory';
const MODULE_ID = 'memory-engine';

/** App-setting key gating session indexing (opt-in, off by default). */
const SESSIONS_SETTING_KEY = 'memoryIndexSessions';

/** Coalesce live tracker changes before flushing them to the engine. */
const FLUSH_DEBOUNCE_MS = 800;

/** Cap records per ingest RPC so a large backfill is many bounded messages. */
const INGEST_BATCH = 200;


/** Recheck a running engine while its initial index is still becoming ready. */
const READINESS_RETRY_MS = 1000;

/** Mirror of the engine-side VirtualRecord shape (host-agnostic by design). */
interface VirtualRecord {
  id: string;
  sourceClass: string;
  refType: string;
  refId: string;
  title?: string;
  text: string;
  parentSessionId?: string | null;
}

interface FileRecord extends VirtualRecord {
  file: { path: string; disabled?: boolean; markerKey: string; typeField?: string; expectedType?: string; defaultType?: string; fields: Record<string,string> };
}

/** Mirror of the backend `globalSearch` result shape. */
export interface SemanticSearchResult {
  matchedFields?:Array<{field:string;value:string;match:'exact'|'stem';sourceRange?:{start:number;end:number}}>;
  fieldPriority?:number;

  rootId?:string|null;
  refType: string;
  refId: string;
  sourceClass: string;
  sourcePath: string;
  rootLabel?: string;
  rootPath?: string;
  relativePath?: string;
  title: string;
  snippet: string;
  score: number;
  signals: { dense: boolean; sparse: boolean };
  /**
   * Raw pre-fusion scores. `score` is an RRF rank reciprocal — comparable
   * within one query's result list, meaningless across queries — so a caller
   * that needs an absolute threshold (duplicate detection) reads
   * `similarity.cosine`. Absent when the engine predates the passthrough.
   */
  similarity?: { cosine?: number; bm25?: number; contextCosine?:number };
  keywordMatch?: 'exact' | 'stem';
  parentSessionId?: string | null;
}

/**
 * Keeps "index unavailable" distinct from "available with no matches" for
 * main-process callers without changing the renderer's result-array contract.
 */
export type SemanticQueryOutcome =
  | { available: false; results: [] }
  | { available: true; results: SemanticSearchResult[] };

/**
 * The fields we read off the memory backend's read-only `status` RPC.
 *
 * `ready` is the backend module's own flag (`nimbalyst-memory/src/backend.ts`):
 * `false` when the engine failed to construct, and in that branch none of the
 * engine fields are present at all. The rest is
 * `buildPublicEngineStatus(engine.status())` — the engine's `EngineStatus`
 * minus `lastEmbedError`. Mirrored rather than imported so the main process
 * does not depend on the extension's build output; the readiness test type-
 * checks its fixtures against the real `EngineStatus`, so a field invented here
 * fails to compile there.
 */
interface MemoryEngineStatus {
  ready?: boolean;
  chunks?: number;
  indexing?: boolean;
}

interface PendingChanges {
  upserts: Map<string, VirtualRecord>;
  removes: Set<string>;
  timer: NodeJS.Timeout | null;
  fileChanged: boolean;
}

interface WiredWorkspace {
  unwatch: () => void;
  pending: PendingChanges;
}

interface ReadinessCheck {
  generation: number;
  promise: Promise<void>;
}

/** Recursively pull visible text out of a Lexical editor-state JSON blob. */
function lexicalToText(content: unknown): string {
  if (!content) return '';
  let root: unknown = content;
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (!trimmed.startsWith('{')) return trimmed; // already plain text/markdown
    try {
      root = JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  const out: string[] = [];
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.text === 'string') out.push(node.text);
    if (node.root) walk(node.root);
    if (Array.isArray(node.children)) for (const child of node.children) walk(child);
  };
  walk(root);
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/** Build the indexable record for a tracker item (title + metadata + body). */
function buildTrackerRecord(item: TrackerItem): VirtualRecord {
  const typeLabel = (item.typeTags?.length ? item.typeTags : [item.type]).join(', ');
  const meta = [
    item.issueKey,
    `Type: ${typeLabel}`,
    item.status ? `Status: ${item.status}` : '',
    item.priority ? `Priority: ${item.priority}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const tags = item.tags?.length ? `Tags: ${item.tags.join(', ')}` : '';
  const body = lexicalToText(item.content);
  const text = [meta, tags, item.description ?? '', body].filter(Boolean).join('\n\n');
  return {
    id: `tracker:${item.id}`,
    sourceClass: 'trackers',
    refType: 'tracker',
    refId: item.id,
    title: item.title || item.issueKey || 'Untitled',
    text,
  };
}

async function buildFileRecord(workspace: string, item: TrackerItem): Promise<{ record: FileRecord; verified: boolean }> {
  const prefix: VirtualRecord = {
    id: `tracker:${item.id}`, sourceClass: 'trackers', refType: 'tracker', refId: item.id,
    title: item.title || item.issueKey || 'Untitled',
    text: [item.issueKey, `Type: ${(item.typeTags?.length ? item.typeTags : [item.type]).join(', ')}`].filter(Boolean).join(' · '),
  };
  let relativePath = item.sourceRef || item.module || '';
  let markerKey = 'trackerStatus';
  let typeField: string | undefined = 'type';
  let verified = false;
  try {
    const file = await readFileTrackerBody(workspace, item);
    relativePath = file.relativePath;
    const owned = Object.entries(EXTENSION_OWNED_KEYS).find(([key,type]) => type === item.type && file.frontmatter[key]);
    const legacy = Object.entries(LEGACY_KEY_TO_TYPE).find(([key,type]) => type === item.type && file.frontmatter[key]);
    if (owned) { markerKey = owned[0]; typeField = undefined; }
    else if (!file.frontmatter.trackerStatus && legacy) { markerKey = legacy[0]; typeField = undefined; }
    verified = true;
  } catch { /* Keep the binding so the engine evicts unreadable/obsolete bodies. */ }
  return { verified, record: { ...prefix, file: {
    path: relativePath.replace(/\\/g, '/'), disabled: !!item.archived, markerKey, typeField,
    expectedType: typeField ? item.type : undefined, defaultType: 'plan',
    fields: {status:'Status',priority:'Priority',tags:'Tags',description:'Description'},
  } } };
}


export class SemanticCatalogService {
  constructor(private readonly readSession:typeof readMemorySessionContent=readMemorySessionContent) {}
  private static instance: SemanticCatalogService | null = null;
  private wired = new Map<string, WiredWorkspace>();
  private readiness = new Map<string, boolean>();
  private readinessGenerations = new Map<string, number>();
  private readinessChecks = new Map<string, ReadinessCheck>();
  private readinessRetryTimers = new Map<string, NodeJS.Timeout>();
  private started = false;
  private sessionGenerations = new Map<string, number>();
  private sessionErrors = new Map<string, string>();
  private sessionOperations = new Map<string, Promise<void>>();
  private catalogOperations = new Map<string, Promise<void>>();
  private sessionPending = new Map<string, {ids:Set<string>; deferred:Set<string>; timer:NodeJS.Timeout|null}>();
  private subscriptions: Array<() => void> = [];

  static getInstance(): SemanticCatalogService {
    if (!this.instance) this.instance = new SemanticCatalogService();
    return this.instance;
  }

  /** Begin reacting to memory-engine lifecycle. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const host = getPrivilegedExtensionHost();
    this.subscriptions.push(registerSessionMemoryRebuilder(workspace=>this.rebuildSessions(workspace)));
    this.subscriptions.push(watchSessionMemoryChanges(change => this.enqueueSessionChange(change)));
    this.subscriptions.push(getSessionStateManager().subscribe(event => {
      if (['session:completed','session:interrupted','session:error','session:waiting'].includes(event.type)) {
        this.enqueueSessionChange({sessionId:event.sessionId,kind:'metadata'});
      }
    }));

    // Wire any memory modules that are already running (service may init after
    // the user enabled memory in a prior window).
    for (const handle of host.list()) this.onModuleState(handle);

    this.subscriptions.push(host.onStateChanged((handle) => this.onModuleState(handle)));
  }

  stop(): void {
    invalidateSessionMemoryReads();
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe?.();
    for (const workspace of this.sessionPending.keys()) this.cancelSessionTimer(workspace);
    for (const workspace of this.wired.keys()) this.unwireWorkspace(workspace);
    for (const [workspace,generation] of this.sessionGenerations) this.sessionGenerations.set(workspace,generation+1);
    for (const timer of this.readinessRetryTimers.values()) clearTimeout(timer);
    this.readinessRetryTimers.clear(); this.started=false;
  }

  private cancelSessionTimer(workspace: string): void {
    const pending=this.sessionPending.get(workspace);
    if(pending?.timer) clearTimeout(pending.timer);
    this.sessionPending.delete(workspace);
  }

  private enqueueSessionChange(change: SessionMemoryChange): void {
    if(change.kind==='metadata'||change.kind==='access'||change.kind==='deleted')invalidateMemorySessionContent(change.sessionId);
    if(!this.sessionsEnabled()) return;
    for(const handle of getPrivilegedExtensionHost().list()) {
      if(handle.extensionId!==EXT_ID || handle.moduleId!==MODULE_ID || handle.state.status!=='running') continue;
      const workspace=handle.workspacePath;
      let pending=this.sessionPending.get(workspace);
      if(!pending) {pending={ids:new Set(),deferred:new Set(),timer:null};this.sessionPending.set(workspace,pending);}
      pending.ids.add(change.sessionId);
      if(change.kind==='output' && getSessionStateManager().getSessionState(change.sessionId)?.status==='running') {
        pending.deferred.add(change.sessionId);continue;
      }
      pending.deferred.delete(change.sessionId);
      if(pending.timer) clearTimeout(pending.timer);
      pending.timer=setTimeout(()=>{
        const ids=[...pending!.ids].filter(id=>!pending!.deferred.has(id));
        pending!.timer=null;
        for(const id of ids)pending!.ids.delete(id);
        if(!pending!.ids.size)this.sessionPending.delete(workspace);
        if(!ids.length)return;
        const generation=this.sessionGenerations.get(workspace)??0;
        runWhenFirstUsable('live-session-projection',()=>{
          if(!this.sessionPassCurrent(workspace,generation))return;
          const previous=this.sessionOperations.get(workspace)??Promise.resolve();
          const operation=previous.catch(()=>{}).then(()=>this.updateSessions(workspace,generation,ids));
          this.sessionOperations.set(workspace,operation);
          return operation.catch(()=>{this.sessionErrors.set(workspace,'Session content could not be indexed. Retry Rebuild.');});
        });
      },FLUSH_DEBOUNCE_MS);
      pending.timer.unref?.();
    }
  }

  private async updateSessions(workspace: string,generation: number,ids:string[]): Promise<void> {
    if(!this.sessionPassCurrent(workspace,generation)) return;
    if(getPrivilegedExtensionHost().getState(EXT_ID,MODULE_ID,workspace)?.status!=='running') return;
    const metas=new Map((await AISessionsRepository.list(workspace)).map(meta=>[meta.id,meta]));
    const failures:string[]=[];
    for(const id of ids) {
      if(!this.sessionPassCurrent(workspace,generation)) return;
      const meta=metas.get(id);
      try {
        const record=meta&&!meta.isArchived?await this.buildSessionRecord(meta):null;
        if(!this.sessionPassCurrent(workspace,generation)) return;
        if(record) await this.ingest(workspace,[record]);
        else await this.removeSessionSource(workspace,id);
      } catch {
        await this.removeSessionSource(workspace,id);failures.push(id);
      }
    }
    if(!this.sessionPassCurrent(workspace,generation)) return;
    const parents=Object.fromEntries([...metas.values()].filter(meta=>!meta.isArchived).map(meta=>[`session:${meta.id}`,meta.parentSessionId??null]));
    await getPrivilegedExtensionHost().request({extensionId:EXT_ID,moduleId:MODULE_ID,workspacePath:workspace,
      method:'completeSessionProjection',params:{parents},requiredPermission:null});
    if(failures.length) throw new Error('Session content unavailable ('+failures.length+' session(s))');
    this.sessionErrors.delete(workspace);
  }

  private async removeSessionSource(workspace: string,id:string): Promise<void> {
    await getPrivilegedExtensionHost().request({extensionId:EXT_ID,moduleId:MODULE_ID,workspacePath:workspace,
      method:'removeRecords',params:{ids:[`session:${id}`]},requiredPermission:null});
  }

  async rebuildSessions(workspacePath:string): Promise<void> { await this.reconcileSessions(workspacePath); }

  private onModuleState(handle: ModuleHandle): void {
    if (handle.extensionId !== EXT_ID || handle.moduleId !== MODULE_ID) return;
    const generation = this.invalidateReadiness(handle.workspacePath);
    if (handle.state.status === 'running') {
      this.wireWorkspace(handle.workspacePath);
      void this.refreshReadiness(handle.workspacePath, generation);
      const reconcile=()=>{
        if(this.currentGeneration(handle.workspacePath)!==generation)return;
        return this.reconcileSessions(handle.workspacePath).catch(()=>console.error('[SemanticCatalog] session reconciliation failed'));
      };
      if(this.sessionsEnabled())runWhenFirstUsable('memory-session-backfill',reconcile);
      else void reconcile();
    } else {
      invalidateSessionMemoryReads(handle.workspacePath);
      this.cancelSessionTimer(handle.workspacePath);
      this.sessionGenerations.set(handle.workspacePath,
        (this.sessionGenerations.get(handle.workspacePath) ?? 0) + 1);
      this.unwireWorkspace(handle.workspacePath);
    }
  }

  // --- Quick Open query (Phase 3) ------------------------------------------

  /**
   * Synchronous hot-path read of the last engine-readiness signal. Unknown and
   * stale states fail closed; lifecycle events refresh the cache in background.
   */
  isAvailable(workspacePath: string): boolean {
    return this.readiness.get(workspacePath) === true;
  }

  /** Opening Quick Open must recover after an idle empty index gains live records. */
  async checkAvailability(workspacePath: string): Promise<boolean> {
    if (this.isAvailable(workspacePath)) return true;
    const generation = this.currentGeneration(workspacePath);
    if (generation < 0) return false;
    await this.refreshReadiness(workspacePath, generation);
    return this.isAvailable(workspacePath);
  }

  async query(
    workspacePath: string,
    query: string,
    k = 20,
    sourceClasses?: string[],
    rootIds?:Array<string|null>,
    origin:"interface"|"agent"|"unknown"="unknown",
  ): Promise<SemanticQueryOutcome> {
    if (!this.isAvailable(workspacePath)) {
      // The index may have gained its first chunks since our last check (from
      // the engine's own watcher, or a rebuild). Re-check so an actively
      // searching user recovers within a second; the pending-timer guard in
      // scheduleReadinessRefresh collapses a burst of keystrokes into one RPC.
      this.scheduleReadinessRefresh(workspacePath, this.currentGeneration(workspacePath));
      return { available: false, results: [] };
    }
    if (!query.trim()) return { available: true, results: [] };
    try {
      const res = await getPrivilegedExtensionHost().request<{ results: SemanticSearchResult[] }>({
        extensionId: EXT_ID,
        moduleId: MODULE_ID,
        workspacePath,
        method: 'globalSearch',
        params: { query, k, origin, ...(sourceClasses?.length ? { sourceClasses } : {}),...(rootIds!==undefined?{rootIds}:{}) },
        requiredPermission: null,
      });
      return { available: true, results: res?.results ?? [] };
    } catch (err) {
      if(String((err as Error).message).includes('MEMORY_SOURCE_SCOPE_INVALID'))throw err;
      console.error('[SemanticCatalog] query failed:', (err as Error).message);
      const generation = this.invalidateReadiness(workspacePath);
      this.scheduleReadinessRefresh(workspacePath, generation);
      return { available: false, results: [] };
    }
  }

  async filterTrackerIds(workspacePath:string,ids:string[],rootIds?:Array<string|null>):Promise<Array<{id:string;rootId:string|null}>>{
    return getPrivilegedExtensionHost().request({extensionId:EXT_ID,moduleId:MODULE_ID,workspacePath,method:'filterTrackerIds',params:{ids,...(rootIds!==undefined?{rootIds}:{})},requiredPermission:null});
  }

  private currentGeneration(workspacePath: string): number {
    // Absent means we have never seen the module run here, so every refresh
    // path below no-ops — which is what we want when memory is disabled.
    return this.readinessGenerations.get(workspacePath) ?? -1;
  }

  private invalidateReadiness(workspacePath: string): number {
    const generation = (this.readinessGenerations.get(workspacePath) ?? 0) + 1;
    this.readinessGenerations.set(workspacePath, generation);
    this.readiness.set(workspacePath, false);
    const timer = this.readinessRetryTimers.get(workspacePath);
    if (timer) clearTimeout(timer);
    this.readinessRetryTimers.delete(workspacePath);
    return generation;
  }

  private refreshReadiness(workspacePath: string, generation: number): Promise<void> {
    if (this.readinessGenerations.get(workspacePath) !== generation) return Promise.resolve();
    const existing = this.readinessChecks.get(workspacePath);
    if (existing?.generation === generation) return existing.promise;

    const promise = (async () => {
      const host = getPrivilegedExtensionHost();
      if (host.getState(EXT_ID, MODULE_ID, workspacePath)?.status !== 'running') return;

      let ready = false;
      let fillingEmptyIndex = false;
      try {
        const status = await host.request<MemoryEngineStatus>({
          extensionId: EXT_ID,
          moduleId: MODULE_ID,
          workspacePath,
          method: 'status',
          requiredPermission: null,
        });
        // Available means "the index holds something searchable", NOT "the
        // initial pass has finished". The engine republishes its retrieval
        // snapshot every 25 files during a full pass precisely so partial
        // results are searchable in seconds instead of after a multi-minute
        // corpus walk, so gating on `indexing` would blank Quick Open out on
        // every cold start and discard that. What is genuinely unavailable is a
        // cold, empty index: advertising search over zero chunks is what made
        // Quick Open silently return nothing.
        //
        // Deliberately not consulted: `retrieval.mode === 'keyword-only'` and
        // `denseChunks === 0` are *working* states (the sparse fallback), not
        // unavailable ones.
        ready = status?.ready === true && (status.chunks ?? 0) > 0;
        fillingEmptyIndex = status?.ready === true && !ready && status.indexing === true;
      } catch {
        // Unknown readiness fails closed until a module transition or failed query retries it.
      }

      if (this.readinessGenerations.get(workspacePath) !== generation) return;
      if (host.getState(EXT_ID, MODULE_ID, workspacePath)?.status !== 'running') return;
      this.readiness.set(workspacePath, ready);
      // Only poll while chunks are actively landing; this stops on the first
      // non-empty status, or when the pass ends still empty.
      if (fillingEmptyIndex) this.scheduleReadinessRefresh(workspacePath, generation);
    })();

    this.readinessChecks.set(workspacePath, { generation, promise });
    void promise.finally(() => {
      if (this.readinessChecks.get(workspacePath)?.promise === promise) {
        this.readinessChecks.delete(workspacePath);
      }
    });
    return promise;
  }

  private scheduleReadinessRefresh(workspacePath: string, generation: number): void {
    if (this.readinessGenerations.get(workspacePath) !== generation) return;
    if (
      getPrivilegedExtensionHost().getState(EXT_ID, MODULE_ID, workspacePath)?.status !== 'running'
    ) {
      return;
    }
    if (this.readinessRetryTimers.has(workspacePath)) return;
    const timer = setTimeout(() => {
      this.readinessRetryTimers.delete(workspacePath);
      void this.refreshReadiness(workspacePath, generation);
    }, READINESS_RETRY_MS);
    timer.unref?.();
    this.readinessRetryTimers.set(workspacePath, timer);
  }

  // --- Tracker backfill + live sync (Phase 2) ------------------------------

  private wireWorkspace(workspacePath: string): void {
    if (this.wired.has(workspacePath)) return;
    const docService = documentServices.get(workspacePath);
    if (!docService) {
      // The engine runs only in an open workspace, so this is unexpected; live
      // changes will still arrive once the service exists, but backfill is
      // skipped. Don't mark wired so a later state event can retry.
      console.warn(`[SemanticCatalog] no document service for ${workspacePath}; skipping backfill`);
      return;
    }

    const pending: PendingChanges = { upserts: new Map(), removes: new Set(), timer: null, fileChanged: false };
    const unwatch = docService.watchTrackerItems((change: TrackerItemChangeEvent) => {
      this.enqueueChange(workspacePath, change);
    });
    const unwatchFiles = docService.watchDocumentMetadata(() => {
      pending.fileChanged = true;
      this.scheduleFlush(workspacePath);
    });
    this.wired.set(workspacePath, { unwatch: () => { unwatch(); unwatchFiles(); }, pending });

    void this.backfillTrackers(workspacePath);
  }

  private unwireWorkspace(workspacePath: string): void {
    const entry = this.wired.get(workspacePath);
    if (!entry) return;
    entry.unwatch();
    if (entry.pending.timer) clearTimeout(entry.pending.timer);
    this.wired.delete(workspacePath);
  }

  private async backfillTrackers(workspacePath: string): Promise<void> {
    const prior = this.catalogOperations.get(workspacePath) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => this.backfillTrackersNow(workspacePath));
    this.catalogOperations.set(workspacePath, next);
    try { await next; } finally { if (this.catalogOperations.get(workspacePath) === next) this.catalogOperations.delete(workspacePath); }
  }

  private async backfillTrackersNow(workspacePath: string): Promise<void> {
    const docService = documentServices.get(workspacePath);
    if (!docService) return;
    try {
      const items = await docService.listTrackerItems();
      const records = items.filter((i) => !i.archived && !isFileTracker(i)).map(buildTrackerRecord);
      const files = new Map<string, {record:FileRecord;verified:boolean}>();
      const fileIds = new Set<string>();
      for (const item of items.filter(isFileTracker)) {
        fileIds.add(`tracker:${item.id}`);
        const candidate = await buildFileRecord(workspacePath, item);
        const abs = path.resolve(workspacePath, candidate.record.file.path);
        const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
        if (!files.get(key)?.verified || candidate.verified) files.set(key, candidate);
      }
      const fileRecords = [...files.values()].map(entry => entry.record);
      const selected = new Set(fileRecords.map(record => record.id));
      await getPrivilegedExtensionHost().request({
        extensionId: EXT_ID, moduleId: MODULE_ID, workspacePath, method: 'syncFileRecords',
        params: { records: fileRecords, obsoleteIds: [...fileIds].filter(id => !selected.has(id)) }, requiredPermission: null,
      });
      if (!this.isAvailable(workspacePath)) {
        this.scheduleReadinessRefresh(workspacePath, this.currentGeneration(workspacePath));
      }
      for (let i = 0; i < records.length; i += INGEST_BATCH) {
        const batch = records.slice(i, i + INGEST_BATCH);
        await this.ingest(workspacePath, batch, 'startup-tracker');
      }
      console.log(
        `[SemanticCatalog] backfilled ${records.length} tracker(s) for ${workspacePath}`,
      );
    } catch (err) {
      console.error('[SemanticCatalog] tracker backfill failed:', (err as Error).message);
    }
  }

  private enqueueChange(workspacePath: string, change: TrackerItemChangeEvent): void {
    const entry = this.wired.get(workspacePath);
    if (!entry) return;
    const { upserts, removes } = entry.pending;
    for (const item of [...change.added, ...change.updated]) {
      const recordId = `tracker:${item.id}`;
      if (isFileTracker(item)) {
        upserts.delete(recordId); removes.delete(recordId); entry.pending.fileChanged = true;
        continue;
      }
      if (item.archived) {
        upserts.delete(recordId);
        removes.add(recordId);
      } else {
        removes.delete(recordId);
        upserts.set(recordId, buildTrackerRecord(item));
      }
    }
    for (const id of change.removed) {
      entry.pending.fileChanged = true;
      const recordId = `tracker:${id}`;
      upserts.delete(recordId);
      removes.add(recordId);
    }
    this.scheduleFlush(workspacePath);
  }

  private scheduleFlush(workspacePath: string): void {
    const entry = this.wired.get(workspacePath);
    if (!entry) return;
    if (entry.pending.timer) clearTimeout(entry.pending.timer);
    entry.pending.timer = setTimeout(() => void this.flush(workspacePath), FLUSH_DEBOUNCE_MS);
  }

  private async flush(workspacePath: string): Promise<void> {
    const entry = this.wired.get(workspacePath);
    if (!entry) return;
    const { upserts, removes } = entry.pending;
    const records = Array.from(upserts.values());
    const ids = Array.from(removes);
    const fileChanged = entry.pending.fileChanged;
    entry.pending.fileChanged = false;
    upserts.clear();
    removes.clear();
    entry.pending.timer = null;

    try {
      if (fileChanged) await this.backfillTrackers(workspacePath);
      if (records.length) await this.ingest(workspacePath, records);
      if (ids.length) {
        // A queued removal can be followed by recreation during the backfill.
        // Do not erase the freshly indexed entity from that newer snapshot.
        const current = await documentServices.get(workspacePath)?.listTrackerItems();
        const active = new Set(current?.filter(item => !item.archived).map(item => `tracker:${item.id}`));
        await getPrivilegedExtensionHost().request({
          extensionId: EXT_ID,
          moduleId: MODULE_ID,
          workspacePath,
          method: 'removeRecords',
          params: { ids: ids.filter(id => !active.has(id)) },
          requiredPermission: null,
        });
      }
    } catch (err) {
      console.error('[SemanticCatalog] flush failed:', (err as Error).message);
    }
  }

  private async ingest(workspacePath: string, records: VirtualRecord[],reason?:string): Promise<void> {
    if (!records.length) return;
    await getPrivilegedExtensionHost().request({
      extensionId: EXT_ID,
      moduleId: MODULE_ID,
      workspacePath,
      method: 'ingestRecords',
      params: { records, ...(reason?{reason}:{}) },
      requiredPermission: null,
    });
    // Our tracker/session records can be the first content in an otherwise
    // empty index (a workspace with no indexable files), and nothing else would
    // tell readiness that chunks now exist.
    if (!this.isAvailable(workspacePath)) {
      this.scheduleReadinessRefresh(workspacePath, this.currentGeneration(workspacePath));
    }
  }

  // --- AI session indexing (Phase 4, opt-in / off by default) --------------

  sessionsEnabled(): boolean {
    return getAppSetting<boolean>(SESSIONS_SETTING_KEY) === true;
  }

  sessionIndexingError(): string | null {
    return this.sessionErrors.size ? [...this.sessionErrors.values()][0] : null;
  }

  /** Toggle session indexing and (un)backfill every wired workspace to match. */
  async setSessionsEnabled(enabled: boolean): Promise<void> {
    setAppSetting(SESSIONS_SETTING_KEY, enabled);
    if(!enabled)invalidateSessionMemoryReads();
    if(!enabled)invalidateMemorySessionContent();
    if(!enabled) for(const workspace of this.sessionPending.keys()) this.cancelSessionTimer(workspace);
    const running = getPrivilegedExtensionHost().list()
      .filter((h) => h.extensionId === EXT_ID && h.moduleId === MODULE_ID && h.state.status === 'running')
      .map((h) => h.workspacePath);
    const workspaces = new Set([...this.wired.keys(), ...running]);
    const results = await Promise.allSettled([...workspaces].map((ws) => this.reconcileSessions(ws)));
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (errors.length) throw new Error('Could not update session indexing (' + errors.length + ' workspace(s) failed)');
  }

  /** Cancel stale passes immediately, then reconcile after any in-flight ingest. */
  private reconcileSessions(workspacePath: string): Promise<void> {
    const generation = (this.sessionGenerations.get(workspacePath) ?? 0) + 1;
    this.sessionGenerations.set(workspacePath, generation);
    const enabled = this.sessionsEnabled();
    const previous = this.sessionOperations.get(workspacePath) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      if (this.sessionGenerations.get(workspacePath) !== generation) return;
      if (getPrivilegedExtensionHost().getState(EXT_ID, MODULE_ID, workspacePath)?.status !== 'running') return;
      try {
        if (enabled) await this.backfillSessions(workspacePath, generation);
        else await this.clearSessions(workspacePath);
        if (this.sessionGenerations.get(workspacePath) === generation) this.sessionErrors.delete(workspacePath);
      } catch (err) {
        if (this.sessionGenerations.get(workspacePath) === generation) {
          this.sessionErrors.set(workspacePath, 'Session indexing could not be reconciled. Retry the session option; saved session chunks may still be present.');
        }
        throw err;
      }
    });
    this.sessionOperations.set(workspacePath, operation);
    void operation.then(() => {
      if (this.sessionOperations.get(workspacePath) === operation) this.sessionOperations.delete(workspacePath);
    }, () => {
      if (this.sessionOperations.get(workspacePath) === operation) this.sessionOperations.delete(workspacePath);
    });
    return operation;
  }

  private sessionPassCurrent(workspacePath: string, generation: number): boolean {
    return this.sessionsEnabled() && this.sessionGenerations.get(workspacePath) === generation;
  }

  /** Normalized chronological dialogue, using the same projection as the UI. */
  private async buildSessionRecord(meta: SessionMeta): Promise<VirtualRecord | null> {
    const content = await this.readSession(meta);
    const tags = meta.tags?.length ? `Tags: ${meta.tags.join(', ')}` : '';
    const text = [
      meta.phase ? `Phase: ${meta.phase}` : '',
      tags,
      content.text,
    ]
      .filter(Boolean)
      .join('\n\n');
    if (!text.trim() && !meta.title) return null;
    return {
      id: `session:${meta.id}`,
      sourceClass: 'sessions',
      refType: 'session',
      refId: meta.id,
      title: meta.title || 'Untitled session',
      text,
      parentSessionId: content.parentSessionId,
    };
  }

  private async backfillSessions(workspacePath: string, generation: number): Promise<void> {
    const metas = await AISessionsRepository.list(workspacePath);
    const active = metas.filter((m) => !m.isArchived);
    let batch: VirtualRecord[] = [];
    let count = 0;
    const parents:Record<string,string|null>={};
    const failures:string[]=[];
    for (const meta of active) {
      if (!this.sessionPassCurrent(workspacePath, generation)) return;
      let rec:VirtualRecord|null;
      try { rec=await this.buildSessionRecord(meta); }
      catch { await this.removeSessionSource(workspacePath,meta.id);failures.push(meta.id);continue; }
      if (!this.sessionPassCurrent(workspacePath, generation)) return;
      if (!rec) continue;
      batch.push(rec);
      parents[rec.id]=rec.parentSessionId??null;
      count++;
      if (batch.length >= 10) {
        await this.ingest(workspacePath, batch, 'startup-session');
        batch = [];
      }
    }
    if (!this.sessionPassCurrent(workspacePath, generation)) return;
    if (batch.length) await this.ingest(workspacePath, batch, 'startup-session');
    if(!this.sessionPassCurrent(workspacePath,generation)) return;
    await getPrivilegedExtensionHost().request({extensionId:EXT_ID,moduleId:MODULE_ID,workspacePath,
      method:'completeSessionProjection',params:{version:failures.length?0:2,parents},requiredPermission:null});
    if(failures.length) throw new Error('Session content unavailable ('+failures.length+' session(s))');
    console.log('[SemanticCatalog] backfilled ' + count + ' session(s) for ' + workspacePath);
  }

  private async clearSessions(workspacePath: string): Promise<void> {
    const result = await getPrivilegedExtensionHost().request({
      extensionId: EXT_ID,
      moduleId: MODULE_ID,
      workspacePath,
      method: 'clearSessionRecords',
      requiredPermission: null,
    });
    // Purging can make an otherwise searchable index empty.
    if ((result as { removed: number }).removed > 0) {
      await this.refreshReadiness(workspacePath, this.invalidateReadiness(workspacePath));
    }
  }
}
