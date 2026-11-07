import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as workspaceEventBus from '../../file/WorkspaceEventBus';
import type { WorkspaceEventListener } from '../../file/WorkspaceEventBus';
import { isPortableTrackerSourceId } from './portableTrackerIdentity';

interface WatchBus {
  subscribe(workspace: string, subscriberId: string, listener: WorkspaceEventListener): Promise<void>;
  unsubscribe(workspace: string, subscriberId: string): void;
  addGitignoreBypass(workspace: string, absolutePath: string, owner: string): void;
  removeGitignoreBypass(workspace: string, absolutePath: string, owner: string): void;
}
export interface PortableTrackerWatch {
  /** Registered cards get exact sidecar events even if a parent directory is ignored. */
  track(portableId: string): void;
  dispose(): void;
}

/** Reuse the workspace watcher; no additional OS watcher or background polling. */
export async function createPortableTrackerWatch(
  workspace: string,
  onCommentsChanged: (portableId: string, isCurrent: () => boolean) => Promise<void>,
  onError: (error: unknown, portableId: string) => void,
  bus: WatchBus = workspaceEventBus,
): Promise<PortableTrackerWatch> {
  const owner = `portable-tracker-comments-${randomUUID()}`;
  const tracked = new Set<string>(), pending = new Set<string>();
  let disposed = false, running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (disposed || running || timer || !pending.size) return;
    timer = setTimeout(() => { timer = undefined; void flush(); }, 50);
    timer.unref?.();
  };
  const flush = async () => {
    if (disposed || running) return;
    running = true;
    const ids = [...pending]; pending.clear();
    try {
      for (const id of ids) {
        if (disposed) break;
        try { await onCommentsChanged(id, () => !disposed); }
        catch (error) { if (!disposed) onError(error, id); }
      }
    } finally { running = false; schedule(); }
  };
  const observe = (file: string) => {
    if (disposed) return;
    const relative = path.relative(workspace, file).split(path.sep).join('/');
    const match = /^\.nimbalyst\/tracker-comments\/([A-Za-z0-9][A-Za-z0-9_-]{3,100})\.jsonl$/.exec(relative);
    if (!match) return;
    pending.add(match[1]); schedule();
  };
  try { await bus.subscribe(workspace, owner, { onAdd: observe, onChange: observe, onUnlink: observe }); }
  catch (error) { disposed = true; if (timer) clearTimeout(timer); bus.unsubscribe(workspace, owner); throw error; }
  return {
    track(portableId) {
      if (disposed) return;
      if (!isPortableTrackerSourceId(portableId)) throw new Error('Invalid portable tracker ID');
      const absolute = path.join(workspace, '.nimbalyst', 'tracker-comments', `${portableId}.jsonl`);
      if (tracked.has(absolute)) return;
      tracked.add(absolute); bus.addGitignoreBypass(workspace, absolute, owner);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer) clearTimeout(timer);
      pending.clear();
      for (const absolute of tracked) bus.removeGitignoreBypass(workspace, absolute, owner);
      tracked.clear(); bus.unsubscribe(workspace, owner);
    },
  };
}
