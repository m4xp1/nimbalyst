/**
 * Centralized IPC listeners for Codex usage tracking
 *
 * Follows the pattern from centralized-ipc-listener-architecture.md:
 * - Components NEVER subscribe to IPC events directly
 * - Central listeners update atoms
 * - Components read from atoms
 */

import { store } from '../index';
import { codexUsageAtom, codexWorkspaceAtom, codexWorkspaceRevisionAtom, CodexUsageData } from '../atoms/codexUsageAtoms';
import type { CodexWorkspaceStatus } from '../../../shared/codexWorkspace';

let usageRevision = 0;
let workspaceRead: Promise<CodexWorkspaceStatus | null> | null = null;

export function refreshCodexWorkspace(refreshMetadata = false): Promise<CodexWorkspaceStatus | null> {
  if (workspaceRead) return workspaceRead;
  const revision = store.get(codexWorkspaceRevisionAtom);
  const pending = window.electronAPI.invoke('codex-workspace:get', refreshMetadata).then((data: CodexWorkspaceStatus) => {
    if (data && typeof data.independent === 'boolean' && store.get(codexWorkspaceRevisionAtom) === revision) store.set(codexWorkspaceAtom, data);
    return data ?? null;
  });
  workspaceRead = pending;
  const clear = () => { if (workspaceRead === pending) workspaceRead = null; };
  void pending.then(clear, clear);
  return pending;
}
function applyUsage(data: CodexUsageData): void {
  usageRevision++;
  store.set(codexUsageAtom, data);
}

export function initCodexUsageListeners(): () => void {
  const cleanups: Array<() => void> = [];
  let active = true;
  const initialRevision = usageRevision;

  const handleUsageUpdate = (data: CodexUsageData) => {
    if (!active) return;
    applyUsage(data);
  };

  cleanups.push(
    window.electronAPI.on('codex-usage:update', handleUsageUpdate),
    window.electronAPI.on('codex-workspace:changed', (data?: CodexWorkspaceStatus) => {
      if (!active) return;
      store.set(codexWorkspaceRevisionAtom, value => value + 1);
      if (data && typeof data.independent === 'boolean') store.set(codexWorkspaceAtom, data);
      else void refreshCodexWorkspace().catch(() => {});
    }),
  );

  // Fetch initial usage data on startup
  window.electronAPI.invoke('codex-usage:get').then((data: CodexUsageData | null) => {
    if (active && usageRevision === initialRevision && data) {
      applyUsage(data);
    }
    if (active) void refreshCodexWorkspace().catch(() => {});
  }).catch((error: Error) => {
    console.error('[CodexUsageListeners] Failed to get initial usage:', error);
  });

  return () => {
    active = false;
    cleanups.forEach(fn => fn?.());
  };
}

export async function recordCodexActivity(): Promise<void> {
  try {
    await window.electronAPI.invoke('codex-usage:activity');
  } catch (error) {
    console.error('[CodexUsageListeners] Failed to record activity:', error);
  }
}

export async function refreshCodexUsage(): Promise<CodexUsageData | null> {
  try {
    const revision = usageRevision;
    const data = await window.electronAPI.invoke('codex-usage:refresh');
    if (data && usageRevision === revision) applyUsage(data);
    return data;
  } catch (error) {
    console.error('[CodexUsageListeners] Failed to refresh usage:', error);
    return null;
  }
}
