import { assertCodexAccessAllowed, codexAccessAllowed } from '@nimbalyst/runtime/ai/codexAccessPolicy';
import { CodexSandboxSetup } from './CodexSandboxSetup';
import { codexSandboxSetupCompleted, type WindowsSandboxMode } from '@nimbalyst/runtime/ai/server/protocols/codexAppServer/windowsSandbox';
/**
 * CodexAuthService -- drives the codex app-server's `account/*` RPCs from a
 * single lazy long-lived child, so the renderer can show login status and run
 * the ChatGPT browser flow / API-key login in-app instead of via the codex CLI.
 *
 * Lazy spawn: the child is only started on the first auth interaction. Once
 * alive it stays up for the rest of the app's lifetime so we can receive
 * async `account/login/completed` and `account/updated` notifications. The
 * codex binary persists auth to ~/.codex/auth.json, which session children
 * read on their own startup -- no need to coordinate state in memory.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { stripAmbientCodexCredentials, type CodexWorkspaceAuth } from '@nimbalyst/runtime/ai/server/protocols/codexAppServer/workspaceAuth';
import { ModelRegistry } from '@nimbalyst/runtime/ai/server/ModelRegistry';
import type { CodexWorkspaceStatus } from '../../shared/codexWorkspace';
import { JsonRpcClient } from '@nimbalyst/runtime/ai/server/protocols/codexAppServer/jsonRpcClient';
import {
  getCodexVendorPathEntries,
  resolveCodexBinaryPath,
} from '@nimbalyst/runtime/ai/server/protocols/codexAppServer/codexAppServerBinary';
import { resolvePackagedCodexBinaryPath } from '@nimbalyst/runtime/ai/server/providers/codex/codexBinaryPath';
import type {
  AccountAuthMode,
  AccountKind,
  AccountLoginCompletedNotification,
  AccountLoginStartResponse,
  AccountRateLimitsReadResponse,
  AccountRateLimitsUpdatedNotification,
  AccountReadResponse,
  AccountUpdatedNotification,
  InitializeResponse,
} from '@nimbalyst/runtime/ai/server/protocols/codexAppServer/types';
import { logger } from '../utils/logger';
import { getEnhancedPath } from './shellEnvironment';
import { getAppSetting, setAppSetting } from '../utils/store';

export interface CodexAuthStatus {
  account: AccountKind;
  requiresOpenaiAuth: boolean;
  authMode: AccountAuthMode;
  planType: string | null;
}

export interface CodexLoginStartedChatGpt {
  type: 'chatgpt';
  loginId: string;
  authUrl: string;
}

interface CodexLoginSession {
  sessionId: string;
  userId?: unknown;
  isActive: boolean;
  selectedWorkspaceAccountId: string | null;
  workspaces?: Array<{ accountId: string; name: string | null; kind: string | null }>;
}

interface CodexLoginSessions {
  activeSessionId: string | null;
  sessions: CodexLoginSession[];
}

const independentWorkspaceSetting = 'codexIndependentWorkspace';

function activeLogin(accounts: CodexLoginSessions): CodexLoginSession | undefined {
  return accounts.sessions?.find(session => session.isActive && session.sessionId === accounts.activeSessionId);
}

class CodexAuthServiceImpl {
  private child: ChildProcessWithoutNullStreams | null = null;
  private client: JsonRpcClient | null = null;
  private initializing: Promise<JsonRpcClient> | null = null;
  private currentLoginId: string | null = null;
  private connectionGeneration = 0;
  private cachedStatus: CodexAuthStatus | null = null;
  private rateLimitsUpdatedListeners = new Set<() => void>();
  private accountUpdatedListeners = new Set<() => void>();
  private workspaceRevision = 0;
  private workspaceSwitching = false;
  private independentLoginStarting = false;
  private independentConnection: Promise<{ client: JsonRpcClient; child: ChildProcessWithoutNullStreams }> | undefined;
  private independentLoginId: string | null = null;
  private independentLoginError: string | undefined;

  private independentEnabled(): boolean {
    return this.independentWorkspaceId() !== undefined;
  }

  private independentWorkspaceId(): string | undefined {
    const value = getAppSetting<string>(independentWorkspaceSetting);
    return typeof value === 'string' && value ? value : undefined;
  }

  private independentHome(): string {
    return path.join(app.getPath('userData'), 'codex-workspace-auth');
  }

  private independentClient(): Promise<{ client: JsonRpcClient; child: ChildProcessWithoutNullStreams }> {
    assertCodexAccessAllowed();
    if (this.independentConnection) return this.independentConnection;
    const pending = this.openConnection('nimbalyst-workspace-auth', this.independentHome());
    this.independentConnection = pending;
    const clear = () => {
      if (this.independentConnection === pending) this.independentConnection = undefined;
    };
    void pending.then(({ client, child }) => {
      child.on('exit', clear);
      client.onNotification((method, params) => {
        if (this.independentConnection !== pending || method !== 'account/login/completed') return;
        const notification = params as AccountLoginCompletedNotification;
        if (!this.independentLoginId || notification.loginId !== this.independentLoginId) return;
        void this.completeIndependentLogin(client, notification);
      });
    }, clear);
    return pending;
  }

  private async completeIndependentLogin(client: JsonRpcClient, notification: AccountLoginCompletedNotification): Promise<void> {
    let accountId: string | null | undefined;
    try {
      if (notification.success) {
        accountId = activeLogin(await client.request<CodexLoginSessions>(
          'accountSession/list', { refreshWorkspaceMetadata: false },
        ))?.selectedWorkspaceAccountId;
      }
    } catch {
      accountId = null;
    }
    if (notification.loginId !== this.independentLoginId) return;
    this.independentLoginId = null;
    if (accountId) {
      setAppSetting(independentWorkspaceSetting, accountId);
      this.workspaceChanged();
      this.broadcast('openai-codex:auth-login-completed', notification);
    } else {
      this.independentLoginError = 'ChatGPT sign-in did not complete. Try again.';
      this.broadcast('codex-workspace:changed', {});
      this.broadcast('openai-codex:auth-login-completed', {
        loginId: notification.loginId, success: false, error: this.independentLoginError,
      });
    }
  }

  private workspaceChanged(): void {
    this.workspaceRevision++;
    this.cachedStatus = null;
    ModelRegistry.clearCache('openai-codex');
    for (const listener of this.accountUpdatedListeners) listener();
    this.broadcast('codex-workspace:changed', {});
  }

  async getWorkspaceStatus(refreshWorkspaceMetadata = false): Promise<CodexWorkspaceStatus> {
    const expected = this.independentWorkspaceId();
    const independent = Boolean(expected);
    const status = {
      independent,
      signingIn: Boolean(this.independentLoginId),
      error: this.independentLoginError,
    };
    if (!independent) return { ...status, selectedId: null, choices: [] };
    const { client } = await this.independentClient();
    const account = activeLogin(await client.request<CodexLoginSessions>('accountSession/list', { refreshWorkspaceMetadata }));
    return {
      ...status,
      selectedId: account?.selectedWorkspaceAccountId === expected ? expected ?? null : null,
      choices: (account?.workspaces ?? []).map(workspace => ({
        id: workspace.accountId,
        name: workspace.name || (workspace.kind === 'personal' ? 'Personal' : 'ChatGPT workspace'),
      })),
    };
  }

  async signInIndependently(): Promise<CodexLoginStartedChatGpt> {
    if (this.workspaceSwitching || this.independentLoginStarting || this.independentLoginId) {
      throw new Error('Finish or cancel the current Codex account change first.');
    }
    this.independentLoginStarting = true;
    try {
      const { client } = await this.independentClient();
      this.independentLoginError = undefined;
      const response = await client.request<AccountLoginStartResponse>('account/login/start', { type: 'chatgpt' });
      if (response.type !== 'chatgpt') throw new Error('Codex could not start ChatGPT sign-in.');
      this.independentLoginId = response.loginId;
      this.broadcast('codex-workspace:changed', {});
      return response;
    } finally {
      this.independentLoginStarting = false;
    }
  }

  async cancelIndependentLogin(): Promise<void> {
    const loginId = this.independentLoginId;
    if (!loginId || !this.independentConnection) return;
    this.independentLoginId = null;
    const { client } = await this.independentConnection;
    try {
      await client.request('account/login/cancel', { loginId });
    } finally {
      this.broadcast('codex-workspace:changed', {});
    }
  }

  async selectWorkspace(accountId: string): Promise<void> {
    if (!this.independentEnabled()) throw new Error('Sign in to Nimbalyst’s independent Codex account first.');
    if (this.workspaceSwitching || this.independentLoginStarting || this.independentLoginId) {
      throw new Error('Finish or cancel the current Codex account change first.');
    }
    this.workspaceSwitching = true;
    this.workspaceChanged();
    try {
      const { client } = await this.independentClient();
      const login = activeLogin(await client.request<CodexLoginSessions>('accountSession/list', { refreshWorkspaceMetadata: false }));
      if (!login?.workspaces?.some(workspace => workspace.accountId === accountId)) {
        throw new Error('The selected workspace is not available for this ChatGPT sign-in.');
      }
      const result = await client.request<CodexLoginSessions>('accountSession/switch', {
        sessionId: login.sessionId,
        accountId,
        allowBrowserLogin: false,
      });
      if (activeLogin(result)?.selectedWorkspaceAccountId !== accountId) {
        throw new Error('Codex could not select the requested workspace. Sign in to that workspace again.');
      }
      setAppSetting(independentWorkspaceSetting, accountId);
    } finally {
      this.workspaceSwitching = false;
      this.workspaceChanged();
    }
  }

  followDesktopWorkspace(): void {
    if (this.workspaceSwitching || this.independentLoginStarting || this.independentLoginId) {
      throw new Error('Finish or cancel the current Codex account change first.');
    }
    setAppSetting(independentWorkspaceSetting, null);
    this.workspaceChanged();
  }

  workspaceAuth(): CodexWorkspaceAuth {
    const revision = this.workspaceRevision;
    const assertCurrent = () => {
      if (this.workspaceSwitching || revision !== this.workspaceRevision) {
        throw new Error('The Codex workspace changed. Retry in the selected workspace.');
      }
    };
    const expected = this.independentWorkspaceId();
    if (!expected) return { revision, assertCurrent };
    return {
      revision,
      assertCurrent,
      getTokens: async (refresh) => {
        assertCurrent();
        const { client } = await this.independentClient();
        const login = activeLogin(await client.request<CodexLoginSessions>('accountSession/list', { refreshWorkspaceMetadata: false }));
        const accountId = login?.selectedWorkspaceAccountId;
        if (accountId !== expected) throw new Error('Sign in to the selected Codex workspace.');
        if (refresh) await client.request<AccountReadResponse>('account/read', { refreshToken: true });
        // Only the app-owned native sign-in writes this file. Desktop auth never enters this broker.
        let auth: { auth_mode?: string; tokens?: { account_id?: string; access_token?: string } };
        try {
          auth = JSON.parse(await readFile(path.join(this.independentHome(), 'auth.json'), 'utf8'));
        } catch {
          throw new Error('The independent Codex sign-in is unavailable. Sign in again.');
        }
        assertCurrent();
        if (auth?.auth_mode !== 'chatgpt' || auth.tokens?.account_id !== accountId ||
            typeof auth.tokens?.access_token !== 'string' || !auth.tokens.access_token) {
          throw new Error('Codex credentials do not match the selected workspace. Sign in again.');
        }
        return { accessToken: auth.tokens.access_token, chatgptAccountId: accountId };
      },
    };
  }

  private readonly sandboxSetup = new CodexSandboxSetup({
    connect: async () => {
      if (process.platform !== 'win32') throw new Error('Windows sandbox setup is only available on Windows.');
      const client = await this.ensureChild();
      if (!this.child) throw new Error('Codex management process is unavailable.');
      return { client, child: this.child };
    },
    reset: () => this.shutdown(),
    ready: codexSandboxSetupCompleted,
    changed: state => this.broadcast('openai-codex:sandbox-updated', state),
  });

  getWindowsSandboxStatus() { return this.sandboxSetup.status(); }

  setupWindowsSandbox(mode: WindowsSandboxMode, cwd: string) {
    if (this.currentLoginId) throw new Error('Finish or cancel Codex sign-in before setting up the sandbox.');
    return this.sandboxSetup.start(mode, cwd);
  }

  async getStatus(refreshToken = false): Promise<CodexAuthStatus> {
    if (!codexAccessAllowed()) return { account: null, requiresOpenaiAuth: true, authMode: null, planType: null };
    const client = this.independentEnabled() ? (await this.independentClient()).client : await this.ensureChild();
    const res = await client.request<AccountReadResponse>('account/read', { refreshToken });
    // logger.main.info('[CodexAuth] account/read result', {
    //   refreshToken,
    //   account: res.account ? { type: res.account.type, hasEmail: 'email' in res.account, planType: 'planType' in res.account ? res.account.planType : null } : null,
    //   requiresOpenaiAuth: res.requiresOpenaiAuth,
    // });
    const status: CodexAuthStatus = {
      account: res.account,
      requiresOpenaiAuth: res.requiresOpenaiAuth,
      authMode: this.deriveAuthMode(res.account),
      planType: res.account && res.account.type === 'chatgpt' ? res.account.planType : null,
    };
    this.cachedStatus = status;
    return status;
  }

  /** In shared mode a fresh reader sees external workspace switches without
   * restarting the Desktop or a running turn. In independent mode the app owns
   * the selection and uses one native client for login, refresh, and quota.
   */
  async getRateLimits(onAccountIdentified?: (scope: string | null) => void): Promise<AccountRateLimitsReadResponse & { accountScope: string }> {
    assertCodexAccessAllowed();
    const auth = this.workspaceAuth();
    auth.assertCurrent();
    const expected = this.independentWorkspaceId();
    const { client, child } = await (expected ? this.independentClient() : this.openConnection('nimbalyst-usage'));
    try {
      const accounts = await client.request<{
        activeSessionId: string | null;
        sessions: Array<{ sessionId: string; userId?: unknown; isActive: boolean; selectedWorkspaceAccountId: string | null }>;
      }>('accountSession/list', { refreshWorkspaceMetadata: false });
      const active = accounts.sessions.filter(session => session.isActive && session.sessionId === accounts.activeSessionId);
      if (active.length !== 1 || !active[0].selectedWorkspaceAccountId) {
        onAccountIdentified?.(null);
        throw new Error('Current ChatGPT account could not be identified. Sign in with ChatGPT to view subscription limits.');
      }
      const account = active[0];
      if (expected && account.selectedWorkspaceAccountId !== expected) {
        onAccountIdentified?.(null);
        throw new Error('Sign in to the selected Codex workspace.');
      }
      // This is a native Codex subject, not a Nimbalyst personal/team member identity.
      // Decode the external wire value before using it in the opaque quota scope.
      const nativeSubject = account.userId;
      if (nativeSubject !== undefined && nativeSubject !== null && typeof nativeSubject !== 'string') {
        throw new Error('Codex returned an invalid account identity.');
      }
      const accountScope = JSON.stringify([account.sessionId, nativeSubject ?? null, account.selectedWorkspaceAccountId]);
      onAccountIdentified?.(accountScope);
      const response = await client.request<AccountRateLimitsReadResponse & { accountId?: string | null }>('account/rateLimits/read', {});
      auth.assertCurrent();
      if (response.accountId && response.accountId !== account.selectedWorkspaceAccountId) {
        onAccountIdentified?.(null);
        throw new Error('ChatGPT account changed while reading limits. Refresh to try again.');
      }
      return { ...response, accountScope };
    } finally {
      if (!expected) {
        try { client.close('usage read completed'); } catch { /* already closed */ }
        try { child.stdin.end(); } catch { /* already closed */ }
        if (!child.killed) child.kill();
      }
    }
  }

  onAccountUpdated(listener: () => void): () => void {
    this.accountUpdatedListeners.add(listener);
    return () => this.accountUpdatedListeners.delete(listener);
  }

  onRateLimitsUpdated(listener: () => void): () => void {
    this.rateLimitsUpdatedListeners.add(listener);
    return () => this.rateLimitsUpdatedListeners.delete(listener);
  }

  /** Browser flow: returns the auth URL. Codex emits `account/login/completed` when done. */
  async startChatGptLogin(): Promise<CodexLoginStartedChatGpt> {
    assertCodexAccessAllowed();
    if (this.independentEnabled()) return this.signInIndependently();
    const client = await this.ensureChild();
    const res = await client.request<AccountLoginStartResponse>('account/login/start', { type: 'chatgpt' });
    if (res.type !== 'chatgpt') {
      throw new Error('[CodexAuth] account/login/start returned unexpected type: ' + res.type);
    }
    this.currentLoginId = res.loginId;
    return { type: 'chatgpt', loginId: res.loginId, authUrl: res.authUrl };
  }

  /** API-key flow: codex stores the key in ~/.codex/auth.json so session children see it. */
  async loginWithApiKey(apiKey: string): Promise<void> {
    assertCodexAccessAllowed();
    if (!apiKey || !apiKey.trim()) {
      throw new Error('API key is required');
    }
    if (this.independentEnabled()) {
      throw new Error('Independent Codex uses ChatGPT sign-in. Configure the OpenAI API provider separately.');
    }
    const client = await this.ensureChild();
    await client.request<AccountLoginStartResponse>('account/login/start', { type: 'apiKey', apiKey });
  }

  async cancelChatGptLogin(): Promise<void> {
    if (this.independentLoginId) return this.cancelIndependentLogin();
    if (!this.currentLoginId || !this.client) return;
    try {
      await this.client.request('account/login/cancel', { loginId: this.currentLoginId });
    } finally {
      this.currentLoginId = null;
    }
  }

  async logout(): Promise<void> {
    assertCodexAccessAllowed();
    const independent = this.independentEnabled();
    const client = independent ? (await this.independentClient()).client : await this.ensureChild();
    await client.request('account/logout', {});
    this.cachedStatus = null;
    if (independent) this.workspaceChanged();
  }

  getCachedStatus(): CodexAuthStatus | null {
    if (!codexAccessAllowed()) return null;
    return this.cachedStatus;
  }

  shutdown(): void {
    this.connectionGeneration++;
    this.currentLoginId = null;
    try { this.client?.close('shutdown'); } catch { /* noop */ }
    this.client = null;
    if (this.child && !this.child.killed) {
      try { this.child.stdin?.end(); } catch { /* noop */ }
      try { this.child.kill(); } catch { /* noop */ }
    }
    this.child = null;
    this.initializing = null;
    const independent = this.independentConnection;
    this.independentConnection = undefined;
    this.independentLoginId = null;
    void independent?.then(({ client, child }) => {
      client.close('shutdown');
      child.stdin.end();
      if (!child.killed) child.kill();
    }).catch(() => {});
  }

  private deriveAuthMode(account: AccountKind): AccountAuthMode {
    if (!account) return null;
    if (account.type === 'apiKey') return 'apikey';
    if (account.type === 'chatgpt') return 'chatgpt';
    return null;
  }

  private ensureChild(): Promise<JsonRpcClient> {
    assertCodexAccessAllowed();
    if (this.client) return Promise.resolve(this.client);
    if (this.initializing) return this.initializing;

    const generation = this.connectionGeneration;
    this.initializing = this.openConnection('nimbalyst-auth').then(({ client, child }) => {
      if (generation !== this.connectionGeneration) {
        client.close('management connection retired');
        child.kill();
        throw new Error('Codex management connection retired.');
      }
      this.child = child;
      this.client = client;
      return client;
    });
    return this.initializing.catch((err) => {
      if (generation === this.connectionGeneration) this.initializing = null;
      throw err;
    });
  }

  private async openConnection(name: string, independentHome?: string): Promise<{ client: JsonRpcClient; child: ChildProcessWithoutNullStreams }> {
    assertCodexAccessAllowed();
    const binaryPath = resolveCodexBinaryPath(() => resolvePackagedCodexBinaryPath());
    const env = this.buildEnv(binaryPath);
    const args: string[] = [];
    if (independentHome) {
      await mkdir(independentHome, { recursive: true, mode: 0o700 });
      for (const key of Object.keys(env)) {
        if (key.toUpperCase() === 'CODEX_HOME' || key.toUpperCase() === 'CODEX_SQLITE_HOME') delete env[key];
      }
      env.CODEX_HOME = independentHome;
      args.push('-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"');
    }
    args.push('app-server', '--listen', 'stdio://');
    const child = spawn(binaryPath, args, {
      env, cwd: independentHome, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.setEncoding('utf8');
    // Never forward account-reader diagnostics: native errors may contain credential metadata.
    child.stderr.on('data', () => {});
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      logger.main.warn('[CodexAuth] management process exited', { code, signal });
      this.client = null;
      this.child = null;
      this.initializing = null;
    });
    const client = new JsonRpcClient(child, {
      defaultTimeoutMs: name === 'nimbalyst-usage' ? 15_000 : undefined,
      logger: { log: () => {}, warn: () => logger.main.warn('[CodexAuth] protocol warning') },
    });
    client.onNotification((method, params) => {
      if (this.child === child) this.handleNotification(method, params);
    });
    try {
      await client.request<InitializeResponse>('initialize', {
        clientInfo: { name, version: process.env.NIMBALYST_VERSION ?? '0.0.0' },
        capabilities: { experimentalApi: true },
      });
      client.notify('initialized', {});
      return { client, child };
    } catch (err) {
      try { client.close('init failed'); } catch { /* noop */ }
      try { child.kill(); } catch { /* noop */ }
      throw err;
    }
  }

  private buildEnv(binaryPath: string): NodeJS.ProcessEnv {
    const baseEnv: NodeJS.ProcessEnv = { ...process.env };
    // Native account reads must use the configured Codex store, never ambient API keys.
    stripAmbientCodexCredentials(baseEnv);
    const helperPathEntries = getCodexVendorPathEntries(binaryPath);
    const enhancedPath = getEnhancedPath();
    const existingPath = baseEnv.PATH ?? baseEnv.Path ?? '';
    const merged = Array.from(new Set([
      ...helperPathEntries,
      ...enhancedPath.split(path.delimiter).filter(Boolean),
      ...existingPath.split(path.delimiter).filter(Boolean),
    ])).join(path.delimiter);
    baseEnv.PATH = merged;
    delete baseEnv.Path;
    return baseEnv;
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === 'account/updated') {
      const n = params as AccountUpdatedNotification;
      const planType = n.planType ?? this.cachedStatus?.planType ?? null;
      const account: AccountKind =
        n.authMode === 'apikey' ? { type: 'apiKey' } :
        n.authMode === 'chatgpt' ? { type: 'chatgpt', email: this.cachedStatusEmail() ?? '', planType: planType ?? '' } :
        null;
      this.cachedStatus = {
        account,
        requiresOpenaiAuth: !account,
        authMode: n.authMode,
        planType,
      };
      this.broadcast('openai-codex:auth-updated', this.cachedStatus);
      for (const listener of this.accountUpdatedListeners) listener();
      return;
    }
    if (method === 'account/login/completed') {
      const n = params as AccountLoginCompletedNotification;
      this.currentLoginId = null;
      this.broadcast('openai-codex:auth-login-completed', n);
      // Always refresh after a completion so account email / planType are accurate.
      this.getStatus().catch((err) => logger.main.warn('[CodexAuth] refresh after login/completed failed:', err));
      return;
    }
    if (method === 'account/rateLimits/updated') {
      const notification = params as AccountRateLimitsUpdatedNotification;
      if (!notification.rateLimits) return;
      for (const listener of this.rateLimitsUpdatedListeners) {
        listener();
      }
    }
  }

  private cachedStatusEmail(): string | null {
    const account = this.cachedStatus?.account;
    return account && account.type === 'chatgpt' ? account.email : null;
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    }
  }
}

export const codexAuthService = new CodexAuthServiceImpl();
