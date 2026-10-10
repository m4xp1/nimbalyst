import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MarkdownEditor } from '@nimbalyst/runtime';
import { TabEditor } from '../TabEditor/TabEditor';
import { createReadOnlyEditorHost } from '../editors/createReadOnlyEditorHost';
import { DocumentModelRegistry } from '../../services/document-model/DocumentModelRegistry';
import { registerTrackerFileFlusher } from '../../services/trackerFileEditor';
import { errorNotificationService } from '../../services/ErrorNotificationService';

/** Uses the same file model, saves and watcher as an ordinary open file tab. */
export function TrackerFilePageEditor({ filePath, workspacePath, editable, onSaved }: {
  filePath: string; workspacePath: string; editable: boolean; onSaved: () => void;
}) {
  const [loaded, setLoaded] = useState<{ path: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recoveryKey = 'wikiRecovery.' + encodeURIComponent(filePath).replace(/\./g, '%2E');
  const [recovery, setRecovery] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const saveContent = useRef<(() => Promise<void>) | null>(null);
  const getContent = useRef<(() => string) | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoaded(null); setError(null); setRecovery(null);
    void window.electronAPI.invoke('app-settings:get', recoveryKey).then(value => {
      if (!cancelled) setRecovery(typeof value === 'string' ? value : null);
    }).catch(e => errorNotificationService.showError('Recovery unavailable', e instanceof Error ? e.message : String(e)));
    const load = async () => {
      try {
        const existing = DocumentModelRegistry.get(filePath);
        if (existing?.isDirty()) {
          await existing.flushDirtyEditors();
          if (existing.isDirty()) throw new Error('Save the open document’s pending edits before opening this page.');
        }
        const result = await window.electronAPI.readFileContent(filePath);
        if (!result?.success) throw new Error(result?.error || 'Could not read this page’s file.');
        if (result.isBinary || typeof result.content !== 'string') throw new Error('This page’s file is not text.');
        if (!cancelled) setLoaded({ path: filePath, content: result.content });
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); }
    };
    void load();
    const off = !editable ? window.electronAPI.onFileChangedOnDisk(({ path }) => {
      if (path.replace(/\\/g, '/') === filePath.replace(/\\/g, '/')) void load();
    }) : undefined;
    return () => { cancelled = true; off?.(); };
  }, [filePath, editable, attempt]);

  useLayoutEffect(() => {
    if (!editable || loaded?.path !== filePath) return;
    // Pin the shared model until the save started before editor teardown completes.
    const pin = DocumentModelRegistry.getOrCreate(filePath);
    const flush = async () => {
      const text = getContent.current?.();
      if (text === undefined || text === pin.model.getLastPersistedContent()) return;
      if (pin.model.getState().diffState) throw new Error('Finish reviewing pending file changes before changing this page’s attributes.');
      await saveContent.current?.();
      if (getContent.current?.() !== pin.model.getLastPersistedContent()) throw new Error('Could not save this page’s pending content.');
    };
    const unregister = registerTrackerFileFlusher(filePath, flush);
    return () => {
      unregister();
      const text = getContent.current?.();
      const dirty = text !== undefined && text !== pin.model.getLastPersistedContent();
      const saving = flush();
      void saving.then(async () => {
        if (dirty && text !== undefined && pin.model.getLastPersistedContent() !== text) {
          await window.electronAPI.invoke('history:create-snapshot', filePath, text, 'manual', 'Unsaved Wiki edits kept on navigation');
          errorNotificationService.showError('Content not saved', 'The page’s unsaved edits were kept in file history. Reopen the file to recover them.');
        }
      }).catch(async e => {
        if (text !== undefined) {
          // Recovery remains available even if both disk and history writes fail.
          try {
            await window.electronAPI.invoke('history:create-snapshot', filePath, text, 'manual', 'Unsaved Wiki edits kept on navigation');
            errorNotificationService.showError('Content not saved', 'The unsaved copy is available in file history.');
            return;
          } catch {
            try {
              await window.electronAPI.invoke('app-settings:set', recoveryKey, text);
              errorNotificationService.showError('Content not saved', 'A recovery copy was kept in application storage. Reopen this page to copy it.');
              return;
            } catch (recoveryError) {
              errorNotificationService.showError('Recovery failed', recoveryError instanceof Error ? recoveryError.message : String(recoveryError));
            }
          }
        }
        errorNotificationService.showError('Content not saved', (e instanceof Error ? e.message : String(e)));
      }).finally(() => DocumentModelRegistry.release(filePath, pin.handle));
    };
  }, [filePath, editable, loaded?.path]);
  const readOnlyHost = useMemo(() => createReadOnlyEditorHost({
    filePath, fileName: filePath.split('/').pop() || 'Page', theme: 'light', content: loaded?.content ?? '',
  }), [filePath, loaded?.content]);
  if (error) return <div role="alert" className="tracker-page-view-gutter py-4"><p>{error}</p><button type="button" onClick={() => setAttempt(n => n + 1)}>Retry</button></div>;
  if (loaded?.path !== filePath) return <div className="tracker-page-view-gutter py-4 text-nim-muted">Loading document...</div>;
  return <>{recovery !== null && <div role="alert" className="tracker-page-view-gutter py-2">
    Unsaved edits from the previous visit are available.
    <button type="button" onClick={() => void navigator.clipboard.writeText(recovery)}>Copy recovered text</button>
    <button type="button" onClick={() => void window.electronAPI.invoke('app-settings:set', recoveryKey, null).then(() => setRecovery(null)).catch(e => errorNotificationService.showError('Recovery not discarded', e instanceof Error ? e.message : String(e)))}>Discard recovery copy</button>
  </div>}<div className="tracker-file-page-editor min-h-[480px] h-[70vh]" data-testid="tracker-wiki-file-editor">
    {editable ? <TabEditor key={filePath} embedded filePath={filePath} fileName={filePath.split('/').pop() || 'Page'} initialContent={loaded.content}
      isActive workspaceId={workspacePath} onGetContentReady={fn => { getContent.current = fn; }} onSaveComplete={onSaved} onManualSaveReady={fn => { saveContent.current = fn; }} />
      : <MarkdownEditor key={`${filePath}-${loaded.content}`} host={readOnlyHost} config={{ editable: false, documentHeader: null }} />}
  </div></>;
}
