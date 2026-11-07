import { memorySourceChanges, sameMemoryWorkspace } from '@nimbalyst/runtime';

type Area = 'status' | 'sources' | 'usage';
// The extension can also be loaded by an older host which supplies rule receipts only.
const changes=memorySourceChanges as typeof memorySourceChanges & {
  subscribeStatus?:(listener:(change:{workspacePath:string;areas:Area[]})=>void)=>()=>void;
};
/** A visible consumer owns one snapshot request, never a timer-driven poll. */
export function subscribeMemoryUpdates(workspacePath: string | undefined, areas: Area[], refresh: (isCurrent: () => boolean) => Promise<void>): () => void {
  let disposed = false, running = false, pending = true, generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
  const schedule = () => {
    if (disposed || !visible() || running || timer) return;
    timer = setTimeout(() => { timer = undefined; void run(); }, 100);
  };
  const run = async () => {
    if (disposed || running || !visible() || !pending) return;
    pending = false; running = true;
    const current = generation;
    try { await refresh(() => !disposed && visible() && current === generation); }
    finally { running = false; if (pending) schedule(); }
  };
  const stop = changes.subscribeStatus?.(change => {
    if (!sameMemoryWorkspace(workspacePath, change.workspacePath) || !change.areas.some(area => areas.includes(area))) return;
    pending = true; schedule();
  });
  const visibilityChanged = () => {
    generation++; pending = true;
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (visible()) void run();
  };
  document.addEventListener('visibilitychange', visibilityChanged);
  void run();
  return () => {
    disposed = true; generation++;
    if (timer) clearTimeout(timer);
    stop?.(); document.removeEventListener('visibilitychange', visibilityChanged);
  };
}
