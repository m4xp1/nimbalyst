import { DocumentModelRegistry } from './document-model/DocumentModelRegistry';

/** File routes must use a real path, never a tracker/collab virtual URI. */
export function trackerFilePath(documentPath: string | undefined, workspacePath: string): string | null {
  if (!documentPath || /^[a-z][a-z\d+.-]*:\/\//i.test(documentPath)) return null;
  const file = documentPath.replace(/\\/g, '/');
  if (file.startsWith('/') || /^[a-z]:\//i.test(file)) return file;
  return `${workspacePath.replace(/\\/g, '/').replace(/\/+$/, '')}/${file}`;
}

const editorFlushers = new Map<string, Set<() => Promise<void>>>();
export function registerTrackerFileFlusher(path: string, flush: () => Promise<void>): () => void {
  const set = editorFlushers.get(path) ?? new Set(); set.add(flush); editorFlushers.set(path, set);
  return () => { set.delete(flush); if (!set.size) editorFlushers.delete(path); };
}

const writes = new Map<string, Promise<void>>();
/** Serialize frontmatter writes after the open document's own save, preserving body edits. */
export async function withFlushedTrackerFile(path: string, write: () => Promise<void>): Promise<void> {
  const previous = writes.get(path) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    for (const flush of editorFlushers.get(path) ?? []) await flush();
    const model = DocumentModelRegistry.get(path);
    if (model?.isDirty()) {
      await model.flushDirtyEditors();
      if (model.isDirty()) throw new Error('Save pending content edits before changing this page’s attributes.');
    }
    await write();
  });
  writes.set(path, operation);
  try { await operation; } finally { if (writes.get(path) === operation) writes.delete(path); }
}
