import type { GitStatus } from '../store/atoms/gitOperations';
import { normalizeGitStatus, sameGitRepository } from '../utils/gitStatus';

type Api = Pick<Window['electronAPI'], 'invoke' | 'git'>;
type Listener = (status: GitStatus | null) => void;
interface Entry { path: string; listeners: Set<Listener>; status: GitStatus | null; generation: number; revision: number; reading?: Promise<void>; }
interface Hub { entries: Set<Entry>; stop?: () => void; focus: () => void; }
const hubs = new WeakMap<Api, Hub>();

/** One IPC subscription and one snapshot per repository for all renderer surfaces. */
export function watchGitStatus(api: Api, repoPath: string, listener: Listener) {
  const read = (entry: Entry): Promise<void> => {
    if (entry.reading) return entry.reading;
    const generation = ++entry.generation;
    const task = (async () => {
      try {
        const value = await api.invoke('git:status', entry.path);
        if (generation !== entry.generation || !entry.listeners.size) return;
        entry.status = normalizeGitStatus(value); entry.listeners.forEach(fn => fn(entry.status));
      } catch (error) { console.error('[GitStatus] Refresh failed:', error); }
    })().finally(() => { if (entry.reading === task) entry.reading = undefined; });
    entry.reading = task; return task;
  };
  const checkRemote = (entry: Entry) => {
    void api.invoke('git:sync-refresh', entry.path).catch(error => console.error('[GitStatus] Remote check failed:', error));
  };
  let hub = hubs.get(api);
  if (!hub) {
    const created: Hub = { entries: new Set(), focus: () => { created.entries.forEach(checkRemote); } };
    created.stop = api.git?.onStatusChanged?.(event => {
      for (const entry of created.entries) {
        if (!sameGitRepository(event.repoPath ?? event.workspacePath, entry.path)) continue;
        if (event.status) {
          if (event.revision !== undefined) { if (event.revision <= entry.revision) continue; entry.revision = event.revision; }
          const previousBranch = entry.status?.branch;
          entry.generation++; entry.status = normalizeGitStatus(event.status); entry.listeners.forEach(fn => fn(entry.status));
          if (previousBranch !== entry.status?.branch || entry.status?.sync?.freshness === 'local') checkRemote(entry);
        } else {
          // Invalidate the old read; do not let a coalesced in-flight read swallow this change.
          entry.generation++; entry.reading = undefined; void read(entry);
        }
      }
    });
    window.addEventListener('focus', created.focus); hubs.set(api, created); hub = created;
  }
  const owner = hub;
  let entry = [...owner.entries].find(value => sameGitRepository(value.path, repoPath));
  if (!entry) {
    entry = { path: repoPath, listeners: new Set(), status: null, generation: 0, revision: -1 };
    owner.entries.add(entry);
  }
  const selected = entry;
  selected.listeners.add(listener);
  if (selected.status) listener(selected.status);
  else void read(selected);
  checkRemote(selected);
  let disposed = false;
  return {
    refresh: () => disposed ? Promise.resolve() : read(selected),
    dispose: () => {
      if (disposed) return; disposed = true; selected.listeners.delete(listener);
      if (!selected.listeners.size) { selected.generation++; owner.entries.delete(selected); }
      if (!owner.entries.size) { owner.stop?.(); window.removeEventListener('focus', owner.focus); hubs.delete(api); }
    },
  };
}
