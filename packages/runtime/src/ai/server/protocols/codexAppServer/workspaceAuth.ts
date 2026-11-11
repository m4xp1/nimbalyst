import type { JsonRpcClient } from './jsonRpcClient';
import type { AccountLoginCompletedNotification, AccountLoginStartResponse } from './types';

export interface CodexWorkspaceTokens {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType?: string;
}

export async function authenticateCodexWorkspace(client: JsonRpcClient, tokens: CodexWorkspaceTokens): Promise<void> {
  let unsubscribe: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const completed = new Promise<void>((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('Workspace authentication timed out.')), 20_000);
    unsubscribe = client.onNotification((method, params) => {
      if (method !== 'account/login/completed') return;
      const notification = params as AccountLoginCompletedNotification;
      if (notification.loginId !== null) return;
      if (notification.success) resolve();
      else reject(new Error('Workspace authentication failed.'));
    });
  });
  try {
    const [login] = await Promise.all([
      client.request<AccountLoginStartResponse>('account/login/start', { type: 'chatgptAuthTokens', ...tokens }),
      completed,
    ]);
    if (login.type !== 'chatgptAuthTokens') throw new Error('External authentication rejected.');
  } finally {
    clearTimeout(timeout);
    unsubscribe?.();
  }
}

/** Main-process credentials for one verified workspace, scoped to a Codex child. */
export interface CodexWorkspaceAuth {
  revision: number;
  assertCurrent(): void;
  getTokens?: (refresh: boolean) => Promise<CodexWorkspaceTokens>;
}

export function stripAmbientCodexCredentials(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'].includes(key.toUpperCase())) {
      delete env[key];
    }
  }
}
