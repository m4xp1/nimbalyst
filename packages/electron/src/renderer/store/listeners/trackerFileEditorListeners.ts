import { flushTrackerFileEditors, getOpenTrackerFileModel } from '../../services/trackerFileEditor';

let initialized = false;

/** Install once with the app listeners, independently of editor/session mounts. */
export function initTrackerFileEditorListeners(): () => void {
  if (initialized) return () => {};
  initialized = true;
  const unsubscribe = window.electronAPI.on('tracker-file:prepare-write', async ({ filePath, resultChannel }) => {
    try {
      await flushTrackerFileEditors(filePath);
      const model = getOpenTrackerFileModel(filePath);
      if (model?.getState().diffState) throw new Error('Finish reviewing the open file changes before editing this tracker.');
      window.electronAPI.send(resultChannel, { success: true });
    } catch (error) {
      window.electronAPI.send(resultChannel, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  return () => {
    initialized = false;
    unsubscribe();
  };
}
