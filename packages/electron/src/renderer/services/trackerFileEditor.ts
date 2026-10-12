import { DocumentModelRegistry } from './document-model/DocumentModelRegistry';

/** File routes must use a real path, never a tracker/collab virtual URI. */
export function trackerFilePath(documentPath: string | undefined, workspacePath: string): string | null {
  if (!documentPath || /^[a-z][a-z\d+.-]*:\/\//i.test(documentPath)) return null;
  const file = documentPath.replace(/\\/g, '/');
  if (file.startsWith('/') || /^[a-z]:\//i.test(file)) return file;
  return `${workspacePath.replace(/\\/g, '/').replace(/\/+$/, '')}/${file}`;
}

const editorFlushers = new Map<string, Set<() => Promise<void>>>();
function fileKey(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}
/** Main-process file paths may use Windows separators/casing unlike a tab. */
export function getOpenTrackerFileModel(path: string) {
  const registered = DocumentModelRegistry.getRegisteredPaths().find(candidate => fileKey(candidate) === fileKey(path));
  return registered ? DocumentModelRegistry.get(registered) : null;
}
export function registerTrackerFileFlusher(path: string, flush: () => Promise<void>): () => void {
  const key = fileKey(path);
  const set = editorFlushers.get(key) ?? new Set(); set.add(flush); editorFlushers.set(key, set);
  return () => { set.delete(flush); if (!set.size) editorFlushers.delete(key); };
}

const writes = new Map<string, Promise<void>>();
/** Also used by main's preparation request while a renderer write awaits IPC. */
export async function flushTrackerFileEditors(path: string): Promise<void> {
  for (const flush of editorFlushers.get(fileKey(path)) ?? []) await flush();
  const model = getOpenTrackerFileModel(path);
  if (model?.isDirty()) {
    await model.flushDirtyEditors();
    if (model.isDirty()) throw new Error('Save pending content edits before changing this page’s attributes.');
  }
}
/** Serialize frontmatter writes after the open document's own save, preserving body edits. */
export async function withFlushedTrackerFile(path: string, write: () => Promise<void>): Promise<void> {
  const key = fileKey(path);
  const previous = writes.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    await flushTrackerFileEditors(path);
    await write();
  });
  writes.set(key, operation);
  try { await operation; } finally { if (writes.get(key) === operation) writes.delete(key); }
}
