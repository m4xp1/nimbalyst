/**
 * Incremental file watcher. Watches ONLY the configured source directories —
 * NOT the engine root. Watching a large monorepo root recursively opens an fd
 * per directory/file when chokidar falls back to `fs.watch` (the fsevents
 * native binding is not available in the Electron utility-process), which on a
 * repo with node_modules + multiple packages blows past the process fd limit
 * (EMFILE). That fd exhaustion also starves outbound sockets, so the OpenAI
 * query-embedding `fetch` fails and search silently degrades to sparse-only.
 * Scoping to the source bases keeps the watch set to a few small trees. That
 * scoping is now computed per root (see `computeWatchScopes`), so a source set
 * with its own root is watched under that root rather than being silently
 * resolved against the primary one.
 *
 * Debounces per-file and re-indexes (or drops) markdown files that belong to a
 * configured source set. After a batch settles it invokes `onSettled` so the
 * engine can rebuild its in-memory retrieval snapshot.
 */
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { expandSourcePatterns } from '../sourceRules.js';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import fg from 'fast-glob';
import type { EngineConfig, SourceSet } from '../types.js';
import { rootForSet, type ResolvedRoot } from '../roots.js';
import type { Indexer } from './indexer.js';

const DEBOUNCE_MS = 400;

/** Static directory prefix of a glob (the part before the first magic char). */
export function globBaseDir(glob: string): string {
  const magic = glob.search(/[*?{}[\]!()]/);
  const prefix = magic === -1 ? glob : glob.slice(0, magic);
  const slash = prefix.lastIndexOf('/');
  return slash === -1 ? '' : prefix.slice(0, slash);
}

/**
 * Resolve the minimal watch scope for a set of source globs.
 * - `dirs`: distinct, non-overlapping base directories (relative, POSIX) to
 *   watch recursively (descendants of another listed dir are dropped).
 * - `rootAnchoredGlobs`: globs whose base is the root (e.g. `CLAUDE.md`,
 *   `**​/CLAUDE.md`). These are watched by enumerating their current matches as
 *   individual file watches rather than watching the entire root tree.
 */
export function computeWatchScope(sources: SourceSet[]): {
  dirs: string[];
  rootAnchoredGlobs: string[];
} {
  const dirSet = new Set<string>();
  const rootAnchoredGlobs: string[] = [];
  for (const set of sources) {
    for (const g of set.include) {
      const base = globBaseDir(g);
      if (base === '') rootAnchoredGlobs.push(g);
      else dirSet.add(base);
    }
  }
  const sorted = Array.from(dirSet).sort();
  const dirs: string[] = [];
  for (const d of sorted) {
    if (!dirs.some((m) => d === m || d.startsWith(m + '/'))) dirs.push(d);
  }
  return { dirs, rootAnchoredGlobs };
}

/**
 * Per-root watch scopes. Source sets are grouped by the root they index against
 * before scoping, because the base-dir de-overlap above is only meaningful
 * within a single root — `docs` under two different roots are two watch targets,
 * not one, and the shorter-prefix check would otherwise collapse them.
 *
 * Root-anchored globs are handled differently per root, deliberately. On the
 * PRIMARY root they stay file-enumerated: that root is a monorepo, and watching
 * it recursively is the EMFILE bug in this file's header. A non-primary root is
 * a purpose-scoped tree the caller declared precisely because it is small (the
 * harness memory directory is ~90 files), so it is watched recursively — which
 * is what lets a newly-added page index without a restart. A caller must not
 * declare a huge tree as a source root.
 */
export function computeWatchScopes(
  sources: SourceSet[],
  roots: ResolvedRoot[]
): Array<{ root: ResolvedRoot; dirs: string[]; rootAnchoredGlobs: string[] }> {
  const byRoot = new Map<string, { root: ResolvedRoot; sets: SourceSet[] }>();
  for (const set of sources) {
    const root = rootForSet(roots, set);
    const group = byRoot.get(root.dir) ?? { root, sets: [] };
    group.sets.push(set);
    byRoot.set(root.dir, group);
  }
  return Array.from(byRoot.values()).map(({ root, sets }) => {
    const scope = computeWatchScope(sets);
    if (root.id !== null && scope.rootAnchoredGlobs.length) {
      // '' is the root itself; it subsumes every other base dir under it.
      return { root, dirs: [''], rootAnchoredGlobs: [] };
    }
    return { root, ...scope };
  });
}

export class IndexWatcher {
  private watcher: FSWatcher | null = null;
  private pending = new Map<string, "upsert" | "remove">();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private discovered = new Map<string, string>();
  private discovering: Promise<void> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private config: EngineConfig,
    private indexer: Indexer,
    private onSettled: () => void,
    private onError: (error:unknown) => void = () => {}
  ) {}

  isWatching():boolean { return this.watcher !== null && !this.stopped; }

  start(): void {
    if (this.watcher) return;
    const targets = this.resolveWatchTargets();
    this.stopped = false;
    if (
      targets.length === 0 &&
      !this.config.sources.some((s) => s.sourceClass === "custom")
    )
      return;
    this.watcher = chokidar.watch(targets, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    if (this.config.sources.some((s) => s.sourceClass === "custom")) {
      void this.discover();
      this.discoveryTimer = setInterval(() => void this.discover(), 3000);
    }
    this.watcher
      .on("add", (p) => this.queue(p, "upsert"))
      .on("change", (p) => this.queue(p, "upsert"))
      .on("unlink", (p) => this.queue(p, "remove"))
      .on("error", error => this.onError(error));
  }

  /**
   * Absolute paths to hand chokidar: the existing source base dirs plus the
   * current matches of any root-anchored globs (as individual files). This is
   * what keeps the watch set tiny instead of the whole monorepo.
   */
  private resolveWatchTargets(): string[] {
    const targets: string[] = [];
    for (const scope of computeWatchScopes(
      this.config.sources.map(set => ({ ...set, include: expandSourcePatterns(set.include, rootForSet(this.indexer.sourceRoots(), set).dir) })),
      this.indexer.sourceRoots()
    )) {
      for (const d of scope.dirs) {
        const abs = path.join(scope.root.dir, d);
        if (existsSync(abs)) targets.push(abs);
      }
      if (scope.rootAnchoredGlobs.length) {
        const files = fg.sync(scope.rootAnchoredGlobs, {
          cwd: scope.root.dir,
          absolute: true,
          dot: true,
          onlyFiles: true,
          followSymbolicLinks: false,
          suppressErrors: true,
          ignore: [...(this.config.exclude ?? []), ...(scope.root.id === null ? expandSourcePatterns(this.config.workspaceExclude ?? [], this.config.root) : [])],
        });
        targets.push(...files);
      }
    }
    return targets;
  }

  /** Discover new matches without recursively watching every workspace directory. */
  private async discover(): Promise<void> {
    if (this.stopped || this.discovering) return;
    this.discovering = (async () => {
      const next = new Map<string, string>();
      for (const hit of await this.indexer.enumerate()) {
        if (this.stopped || hit.sourcePath.startsWith("@")) continue;
        const abs = path.resolve(this.config.root, hit.sourcePath);
        let info;
        try {
          info = await stat(abs);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw e;
        }
        const stamp = info.mtimeMs + ":" + info.size;
        next.set(abs, stamp);
        if (this.discovered.get(abs) !== stamp) {
          this.watcher?.add(abs);
          this.queue(abs, "upsert");
        }
      }
      if (!this.stopped) {
        for (const abs of this.discovered.keys())
          if (!next.has(abs)) this.queue(abs, "remove");
        this.discovered = next;
      }
    })()
      .catch(error => { this.onError(error); this.config.onLog?.('warn','[watcher] source discovery failed; retained existing files'); })
      .finally(() => {
        this.discovering = null;
      });
    await this.discovering;
  }

  private queue(absPath: string, op: "upsert" | "remove"): void {
    if (this.stopped) return;
    // classify() also yields the canonical sourcePath — with more than one root
    // the watcher can no longer derive it from config.root.
    const hit = this.indexer.classify(absPath);
    if (!hit) return;
    this.pending.set(hit.sourcePath, op);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), DEBOUNCE_MS);
  }

  private flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.flushBatch());
    return this.flushing;
  }
  private async flushBatch(): Promise<void> {
    const batch = Array.from(this.pending.entries());
    this.pending.clear();
    this.timer = null;
    for (const [sourcePath, op] of batch) {
      try {
        if (op === "remove") {
          this.indexer.removeFile(sourcePath);
        } else {
          const sourceClass =
            this.indexer.classify(sourcePath)?.sourceClass ?? "unknown";
          await this.indexer.indexFile(sourcePath, sourceClass);
        }
      } catch (error) {
        this.onError(error);
        // Best-effort; a failed file is retried on its next change event.
      }
    }
    if (batch.length) this.onSettled();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    this.discoveryTimer = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    await this.watcher?.close();
    this.watcher = null;
    await this.discovering;
    await this.flushing;
  }
}
