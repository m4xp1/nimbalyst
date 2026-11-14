import { BrowserWindow } from 'electron';
import type { SessionData } from '@nimbalyst/runtime/ai/server/types';
import { logger } from '../../utils/logger';

/** One existing listener/atom route, including other open views of the session. */
export function broadcastSessionTokenUsage(sessionId: string, tokenUsage: SessionData['tokenUsage']): void {
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (!window.isDestroyed()) window.webContents.send('ai:tokenUsageUpdated', { sessionId, tokenUsage });
    } catch (error) {
      logger.main.warn('[AIService] Could not deliver context usage to a closing window:', error);
    }
  }
}
