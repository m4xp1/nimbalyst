/** One resolved snapshot and one lookup per workspace, shared by card and Wiki mounts. */
export interface TrackerTeamSnapshot {
  teamOrgId: string | null | undefined;
  error: string | null;
}
interface Entry {
  snapshot: TrackerTeamSnapshot;
  listeners: Set<() => void>;
  generation: number;
  controller?: AbortController;
  inFlight?: Promise<void>;
}
const entries = new Map<string, Entry>();
const RETRY_MS = [500, 1000, 2000, 4000, 8000];
let wiredApi: Window['electronAPI'] | undefined;
let disconnect: Array<() => void> = [];

function entryFor(workspacePath: string): Entry {
  let entry = entries.get(workspacePath);
  if (!entry) {
    entry = { snapshot: { teamOrgId: undefined, error: null }, listeners: new Set(), generation: 0 };
    entries.set(workspacePath, entry);
  }
  return entry;
}
function publish(entry: Entry, snapshot: TrackerTeamSnapshot): void {
  entry.snapshot = snapshot;
  for (const listener of entry.listeners) listener();
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); reject(new Error('Lookup invalidated')); };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
interface LookupResult { success: boolean; complete?: boolean; team?: { orgId: string } | null; authState?: 'restoring' | 'signed-out'; error?: string; }
async function lookup(workspacePath: string): Promise<LookupResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      window.electronAPI.invoke('team:find-for-workspace', workspacePath),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Team lookup timed out. Try again.')), 12_000);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
function start(workspacePath: string, entry: Entry): void {
  if (entry.inFlight || entry.snapshot.teamOrgId !== undefined || entry.snapshot.error) return;
  const generation = entry.generation;
  const controller = new AbortController();
  entry.controller = controller;
  entry.inFlight = (async () => {
    try {
      let result = await lookup(workspacePath);
      for (const ms of RETRY_MS) {
        if (controller.signal.aborted) return;
        if (!result?.success) throw new Error(result?.error || 'Could not determine this project’s team.');
        if (result.complete !== false) break;
        if (result.authState === 'signed-out') throw new Error('Sign in to open content for this team project.');
        await delay(ms, controller.signal);
        result = await lookup(workspacePath);
      }
      if (entry.generation !== generation) return;
      if (!result?.success || result.complete === false) {
        throw new Error(result?.error || 'Could not determine this project’s team. Try again.');
      }
      publish(entry, { teamOrgId: result.team?.orgId ?? null, error: null });
    } catch (error) {
      if (entry.generation === generation) {
        // Unknown membership never becomes writable local content.
        publish(entry, { teamOrgId: undefined, error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (entry.generation === generation) {
        entry.inFlight = undefined;
        entry.controller = undefined;
      }
    }
  })();
}
export function invalidateTrackerTeam(workspacePath?: string): void {
  for (const [path, entry] of entries) {
    if (workspacePath && path !== workspacePath) continue;
    entry.generation++;
    entry.controller?.abort();
    entry.inFlight = undefined;
    entry.controller = undefined;
    publish(entry, { teamOrgId: undefined, error: null });
    if (entry.listeners.size) start(path, entry);
  }
}
function wireInvalidation(): void {
  const api = window.electronAPI;
  if (wiredApi === api) return;
  const replacingApi = wiredApi !== undefined;
  for (const unsubscribe of disconnect) unsubscribe();
  disconnect = [];
  wiredApi = api;
  if (replacingApi) {
    for (const entry of entries.values()) { entry.generation++; entry.controller?.abort(); }
    entries.clear();
  }
  if (api.onWorkspaceTeamResolutionInvalidated) {
    disconnect.push(api.onWorkspaceTeamResolutionInvalidated(invalidateTrackerTeam));
  }
  if (api.stytch?.onAuthStateChange) {
    disconnect.push(api.stytch.onAuthStateChange(() => invalidateTrackerTeam()));
  }
}
export function subscribeTrackerTeam(workspacePath: string, listener: () => void): () => void {
  wireInvalidation();
  const entry = entryFor(workspacePath);
  entry.listeners.add(listener);
  start(workspacePath, entry);
  return () => { entry.listeners.delete(listener); };
}
export function trackerTeamSnapshot(workspacePath: string): TrackerTeamSnapshot {
  return entryFor(workspacePath).snapshot;
}
