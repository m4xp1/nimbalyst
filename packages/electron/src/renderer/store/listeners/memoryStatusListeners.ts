import { memorySourceChanges } from '@nimbalyst/runtime/store/atoms/memorySources';

let initialized = false;
/** One IPC subscription for all Memory consumers, independent of panel mounts. */
export function initMemoryStatusListeners(): () => void {
  if (initialized) return () => {};
  initialized = true;
  const stop = window.electronAPI?.on?.('memory:changed', (value: unknown) => {
    const change = value as { workspacePath?: unknown; areas?: unknown } | null;
    if (!change || typeof change.workspacePath !== 'string' || !Array.isArray(change.areas)) return;
    const areas = change.areas.filter((area): area is 'status' | 'sources' | 'usage' => area === 'status' || area === 'sources' || area === 'usage');
    if (areas.length) memorySourceChanges.publishStatus({ workspacePath: change.workspacePath, areas });
  });
  return () => { initialized = false; stop?.(); };
}
