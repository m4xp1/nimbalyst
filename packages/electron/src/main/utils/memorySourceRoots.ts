import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { searchPathKey, type WorkspaceSearchRoot } from './workspaceSearchRoots';

interface Snapshot {
  paths: string;
  requested: string;
  roots: WorkspaceSearchRoot[];
  checkedAt: number;
  pending?: Promise<void>;
}
const snapshots = new Map<string, Snapshot>();
interface DirectoryDescription {canonical:string;error?:string;}
const probes = new Map<string, Promise<DirectoryDescription>>();
function probeDirectory(absolute: string): Promise<DirectoryDescription> {
  const key = searchPathKey(absolute), existing = probes.get(key);
  if (existing) return existing;
  const pending = (async () => {
    let current=absolute;const tail:string[]=[];
    let canonical=absolute;
    for(;;){
      try{canonical=path.join(await realpath(current),...tail);break;}
      catch{const parent=path.dirname(current);if(parent===current)break;tail.unshift(path.basename(current));current=parent;}
    }
    try {
      if (!(await stat(canonical)).isDirectory()) return {canonical,error:'Not a directory'};
      return {canonical};
    } catch(failure){return{canonical,error:failure instanceof Error?failure.message:String(failure)};}
  })().finally(() => { probes.delete(key); });
  probes.set(key, pending);
  return pending;
}

/** Metadata reads never synchronously probe disks or walk every alias per root. */
export async function memorySourceRoots(workspace: string, paths: string[]): Promise<WorkspaceSearchRoot[]> {
  const key = searchPathKey(path.resolve(workspace));
  let snapshot = snapshots.get(key);
  const first = !snapshot;
  if (!snapshot) {
    snapshot = { paths: '', requested: '', roots: [], checkedAt: 0 };
    snapshots.set(key, snapshot);
    if (snapshots.size > 128) {
      for (const [oldKey, old] of snapshots) {
        if (oldKey !== key && !old.pending) { snapshots.delete(oldKey); break; }
      }
    }
  }
  const signature = JSON.stringify(paths);
  snapshot.requested = signature;
  const configured = new Set(paths.map(value => searchPathKey(path.resolve(value))));
  // Detach takes effect before any asynchronous filesystem probe finishes.
  snapshot.roots = snapshot.roots.filter(root => (root.treePaths ?? [root.path]).some(value => configured.has(searchPathKey(path.resolve(value)))));
  const previousByAlias = new Map(snapshot.roots.flatMap(root =>
    (root.treePaths ?? [root.path]).map(alias => [searchPathKey(path.resolve(alias)), root] as const)));
  const needsRoots = [...configured].some(value => !previousByAlias.has(value));
  if (!snapshot.pending && (snapshot.paths !== signature || Date.now() - snapshot.checkedAt >= 1000)) {
    const current = snapshot;
    current.pending = (async () => {
      const described = await Promise.all(paths.map(async (value, index) => {
        const absolute = path.resolve(value);
        const prior = previousByAlias.get(searchPathKey(absolute));
        let timer: ReturnType<typeof setTimeout> | undefined;
        let canonical = prior?.path ?? absolute;
        let error: string | undefined;
        try {
          const result = await Promise.race([probeDirectory(absolute), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Source folder check timed out')), 1000);
          })]);
          canonical=result.canonical;error=result.error;
        } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
        finally { if (timer) clearTimeout(timer); }
        const id = index === 0 ? null : 'attached-' + createHash('sha256').update(searchPathKey(canonical)).digest('hex');
        return { id, path: canonical, label: path.basename(canonical) || canonical, available: !error,
          ...(error ? { error } : {}), treePaths: [value] } satisfies WorkspaceSearchRoot;
      }));
      const unique = new Map<string, WorkspaceSearchRoot>();
      for (const root of described) {
        const rootKey = searchPathKey(root.path), existing = unique.get(rootKey);
        if (existing) existing.treePaths!.push(...root.treePaths);
        else unique.set(rootKey, root);
      }
      if (current.requested === signature) {
        current.roots = [...unique.values()];
        current.paths = signature;
        current.checkedAt = Date.now();
      }
    })().finally(() => { current.pending = undefined; });
  }
  if (first||needsRoots) {
    await snapshot.pending;
    // An older background probe may have been invalidated by this attachment.
    // Only the latest requested membership can start its replacement probe.
    if(snapshot.requested===signature&&snapshot.paths!==signature)return memorySourceRoots(workspace,paths);
  }
  return snapshot.roots.map(root => ({ ...root, treePaths: [...root.treePaths ?? []] }));
}
