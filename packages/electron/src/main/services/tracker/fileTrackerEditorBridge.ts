import * as path from 'node:path';
import { windows, windowStates } from '../../window/windowState';
import { requestFromRenderer } from '../../mcp/rendererRequest';

/** Save through each window's existing DocumentModel before a tracker file write. */
export async function prepareFileTrackerEditor(workspace: string, filePath: string): Promise<void> {
  const key = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  for (const [id, window] of windows) {
    const state = windowStates.get(id);
    const roots = [state?.workspacePath, state?.activeWorkspacePath, ...(state?.additionalWorkspacePaths ?? [])];
    if (window.isDestroyed() || !roots.some(root => root && key(root) === key(workspace))) continue;
    const result = await requestFromRenderer<{ success: boolean; error?: string }>(
      window, 'tracker-file:prepare-write', { filePath }, { timeoutMs: 10_000 },
    );
    if (result.status !== 'responded' || !result.response.success) {
      throw new Error(result.status === 'responded' ? result.response.error || 'Could not save pending file edits.' : 'The file editor did not confirm its pending edits were saved.');
    }
  }
}
