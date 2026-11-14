/**
 * IPC Handlers for Codex Usage tracking
 */

import { logger } from '../utils/logger';
import { safeHandle } from '../utils/ipcRegistry';
import { codexUsageService, CodexUsageData } from '../services/CodexUsageService';
import { codexAuthService } from '../services/CodexAuthService';
import type { CodexLoginStartedChatGpt } from '../services/CodexAuthService';
import { systemShell } from '../utils/systemShell';

export function registerCodexUsageHandlers(): void {
  const openSignIn = async (login: CodexLoginStartedChatGpt) => {
    try {
      await systemShell.openExternal(login.authUrl);
    } catch {
      await codexAuthService.cancelIndependentLogin();
      throw new Error('Could not open ChatGPT sign-in.');
    }
  };
  safeHandle('codex-workspace:get', async (_event, refresh: unknown) => codexAuthService.getWorkspaceStatus(refresh === true));
  safeHandle('codex-workspace:select', async (_event, accountId: unknown) => {
    if (typeof accountId !== 'string' || !accountId) throw new Error('Select a Codex workspace.');
    const login = await codexAuthService.selectWorkspace(accountId);
    if (login) await openSignIn(login);
  });
  safeHandle('codex-workspace:sign-in', async () => {
    await openSignIn(await codexAuthService.signInIndependently());
  });
  safeHandle('codex-workspace:cancel-sign-in', async () => codexAuthService.cancelIndependentLogin());
  safeHandle('codex-workspace:follow-desktop', async () => codexAuthService.followDesktopWorkspace());

  safeHandle('codex-usage:get', async (): Promise<CodexUsageData | null> => {
    try {
      const cached = codexUsageService.getCachedUsage();
      if (cached) {
        return cached;
      }
      return await codexUsageService.refresh();
    } catch (error) {
      logger.main.error('[CodexUsageHandlers] Error getting usage:', error);
      return null;
    }
  });

  safeHandle('codex-usage:refresh', async (): Promise<CodexUsageData> => {
    try {
      return await codexUsageService.refresh();
    } catch (error) {
      logger.main.error('[CodexUsageHandlers] Error refreshing usage:', error);
      throw error;
    }
  });

  safeHandle('codex-usage:activity', async (): Promise<void> => {
    try {
      await codexUsageService.recordActivity();
    } catch (error) {
      logger.main.error('[CodexUsageHandlers] Error recording activity:', error);
    }
  });

  logger.main.info('[CodexUsageHandlers] Codex usage IPC handlers registered');
}
