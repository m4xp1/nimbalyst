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
import { mkdir, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { homedir } from 'node:os';
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
import { CodexDesktopWorkspace, type DesktopLoginIdentity } from './CodexDesktopWorkspace';

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
  email?: string | null;
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
const desktopIdentitySetting = 'codexDesktopWorkspaceIdentity';
const authSlotSetting = 'codexWorkspaceAuthSlot';
const authSlotPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type AuthConnection = { client: JsonRpcClient; child: ChildProcessWithoutNullStreams };

function activeLogin(accounts: CodexLoginSessions): CodexLoginSession | undefined {
  const active = accounts.sessions?.filter(session => session.isActive) ?? [];
  return accounts.activeSessionId
    ? active.find(session => session.sessionId === accounts.activeSessionId)
    : active.length === 1 ? active[0] : undefined;
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
  private independentLoginConnection: Promise<AuthConnection> | undefined;
  private independentLoginSlot: string | undefined;
  private independentLoginId: string | null = null;
  private independentLoginError: string | undefined;
  private loginTimer: ReturnType<typeof setTimeout> | undefined;
  private loginHintTimer: ReturnType<typeof setTimeout> | undefined;
  private earlyLoginNotifications: AccountLoginCompletedNotification[] = [];
  private workspaceSnapshot: CodexWorkspaceStatus | null = null;
  private workspaceRead: Promise<CodexWorkspaceStatus> | null = null;
  private workspaceMetadataAt = 0;
  private workspaceMetadataAttemptAt = 0;
  private workspaceIdentity: string | null = null;
  private workspaceMetadataError: string | undefined;
  private workspaceDiscoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private publishedWorkspace = '';
  private desktopAvailable = false;
  private readonly desktopWorkspace = new CodexDesktopWorkspace({
    sourceHome: () => process.env.CODEX_HOME || path.join(homedir(), '.codex'),
    ownedHome: () => path.join(app.getPath('userData'), 'codex-desktop-workspace-auth'),
    connect: (name, home) => this.openConnection(name, home),
  });

  private desktopIdentity(): DesktopLoginIdentity | undefined {
    const identity = getAppSetting<DesktopLoginIdentity>(desktopIdentitySetting);
    return identity && typeof identity.userId === 'string' ? identity : undefined;
  }

  private selectedClient(force = false): Promise<{ client: JsonRpcClient; child: ChildProcessWithoutNullStreams }> {
    const identity = this.desktopIdentity();
    const selected = this.independentWorkspaceId();
    return identity && selected ? this.desktopWorkspace.get(selected, identity, force) : this.independentClient();
  }

  private independentEnabled(): boolean {
    return this.independentWorkspaceId() !== undefined;
  }

  private independentWorkspaceId(): string | undefined {
    const value = getAppSetting<string>(independentWorkspaceSetting);
    return typeof value === 'string' && value ? value : undefined;
  }

  private independentHome(): string {
    const slot = this.authSlot();
    return slot ? this.authSlotHome(slot) : path.join(app.getPath('userData'), 'codex-workspace-auth');
  }

  private authSlot(): string | undefined {
    const slot = getAppSetting<string>(authSlotSetting);
    return typeof slot === 'string' && authSlotPattern.test(slot) ? slot : undefined;
  }

  private authSlotHome(slot: string): string {
    if (!authSlotPattern.test(slot)) throw new Error('Invalid Codex sign-in store.');
    const root = path.resolve(app.getPath('userData'), 'codex-workspace-logins');
    const home = path.resolve(root, slot);
    if (path.dirname(home) !== root) throw new Error('Invalid Codex sign-in store.');
    return home;
  }

  private independentClient(): Promise<{ client: JsonRpcClient; child: ChildProcessWithoutNullStreams }> {
    assertCodexAccessAllowed();
    if (this.independentConnection) return this.independentConnection;
    const pending = this.openConnection('nimbalyst-workspace-auth', this.independentHome());
    this.independentConnection = pending;
    this.observeIndependentConnection(pending);
    return pending;
  }

  private observeIndependentConnection(pending: Promise<AuthConnection>): void {
    const clear = () => {
      if (this.independentConnection === pending) this.independentConnection = undefined;
      if (this.independentLoginConnection === pending) {
        const slot = this.independentLoginSlot;
        this.clearLogin();
        this.independentLoginError = 'ChatGPT sign-in was interrupted. Select your account to try again.';
        this.publishWorkspaceState();
        void this.retireIndependentConnection(pending, slot);
      }
    };
    void pending.then(({ client, child }) => {
      child.on('exit', clear);
      client.onNotification((method, params) => {
        if (method === 'account/updated') {
          if (this.independentConnection !== pending || this.workspaceSwitching) return;
          this.scheduleWorkspaceDiscovery(true);
          return;
        }
        if (method !== 'account/login/completed') return;
        const notification = params as AccountLoginCompletedNotification;
        if (this.independentLoginConnection !== pending && !(this.independentConnection === pending && this.workspaceSwitching)) return;
        if (!this.independentLoginId && (this.independentLoginStarting || this.workspaceSwitching)) {
          this.earlyLoginNotifications.push(notification);
          return;
        }
        if (!this.independentLoginId || (notification.loginId && notification.loginId !== this.independentLoginId)) return;
        void this.completeIndependentLogin(pending, notification);
      });
    }, clear);
  }

  private async retireIndependentConnection(pending: Promise<AuthConnection>, slot?: string): Promise<void> {
    try {
      const connection = await pending.catch(() => undefined);
      if (connection) {
        const { child, client } = connection;
        const exited = child.exitCode != null || child.signalCode != null ? Promise.resolve() : new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Codex sign-in process did not exit.')), 3000);
          timer.unref?.();
          child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
        try {
          client.close('workspace connection retired');
          child.stdin.end();
          if (!child.killed) child.kill();
        } finally {
          await exited;
        }
      }
      // Only an inactive, generated directory may be removed; never Desktop or the legacy store.
      if (slot && slot !== this.authSlot()) await rm(this.authSlotHome(slot), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      logger.main.warn('[CodexAuth] Could not retire an inactive sign-in store.');
    }
  }

  private async completeIndependentLogin(connection: Promise<AuthConnection>, notification: AccountLoginCompletedNotification): Promise<void> {
    const loginId = this.independentLoginId;
    if (!loginId || connection !== this.independentLoginConnection) return;
    let account: CodexLoginSession | undefined;
    try {
      if (notification.success) {
        // This local read confirms the selected account. Network membership
        // discovery is optional and must not keep a completed login pending.
        const { client } = await connection;
        const response = await client.request<CodexLoginSessions>('accountSession/list', { refreshWorkspaceMetadata: false }, 15_000);
        account = activeLogin(response);
      }
    } catch {
      account = undefined;
    }
    if (loginId !== this.independentLoginId || connection !== this.independentLoginConnection) return;
    const slot = this.independentLoginSlot;
    this.clearLogin();
    if (account?.selectedWorkspaceAccountId) {
      if (slot) {
        const previous = this.independentConnection;
        const previousSlot = this.authSlot();
        setAppSetting(authSlotSetting, slot);
        this.independentConnection = connection;
        if (previous && previous !== connection) void this.retireIndependentConnection(previous, previousSlot);
      }
      setAppSetting(desktopIdentitySetting, null);
      this.desktopWorkspace.shutdown();
      setAppSetting(independentWorkspaceSetting, account.selectedWorkspaceAccountId);
      this.independentLoginError = undefined;
      this.rememberWorkspace(account);
      this.workspaceMetadataAttemptAt = 0;
      this.workspaceChanged();
      this.broadcast('openai-codex:auth-login-completed', notification);
      this.scheduleWorkspaceDiscovery(true);
    } else {
      if (slot) void this.retireIndependentConnection(connection, slot);
      this.independentLoginError = 'ChatGPT sign-in did not complete. Try again.';
      this.publishWorkspaceState();
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
    this.publishWorkspaceState(true);
  }

  private rememberWorkspace(account: CodexLoginSession | undefined, complete = false): CodexWorkspaceStatus {
    const identity = account ? JSON.stringify([this.independentEnabled(), account.sessionId, account.userId ?? null, account.email ?? null]) : null;
    const sameIdentity = identity !== null && identity === this.workspaceIdentity;
    if (!sameIdentity) {
      this.workspaceMetadataAt = 0;
      this.workspaceMetadataAttemptAt = 0;
      this.workspaceMetadataError = undefined;
    }
    this.workspaceIdentity = identity;
    const names = new Map<string, number>();
    let choices = [...new Map((account?.workspaces ?? []).map(workspace => [workspace.accountId, workspace])).values()].map(workspace => ({
        id: workspace.accountId,
        name: workspace.name?.trim() || (workspace.kind === 'personal' ? 'Personal' : 'Workspace'),
    }));
    for (const choice of choices) names.set(choice.name, (names.get(choice.name) ?? 0) + 1);
    for (const choice of choices) {
      if ((names.get(choice.name) ?? 0) > 1) choice.name += ' (' + choice.id.slice(-6) + ')';
    }
    // Native refresh=false is a current-account observation, even after a
    // complete discovery. It is not an authoritative membership replacement.
    if (!complete && sameIdentity && this.workspaceMetadataAt && this.workspaceSnapshot) {
      const known = this.workspaceSnapshot.choices;
      choices = [...known, ...choices.filter(choice => !known.some(previous => previous.id === choice.id))];
    }
    if (complete) {
      this.workspaceMetadataAt = Date.now();
      this.workspaceMetadataAttemptAt = this.workspaceMetadataAt;
      this.workspaceMetadataError = undefined;
    }
    this.workspaceSnapshot = {
      independent: this.independentEnabled(), authenticated: Boolean(account?.selectedWorkspaceAccountId),
      email: account?.email || null, selectedId: account?.selectedWorkspaceAccountId ?? null,
      selectedName: choices.find(choice => choice.id === account?.selectedWorkspaceAccountId)?.name ?? null,
      choices, signingIn: Boolean(this.independentLoginId), signInHintVisible: Boolean(this.loginHintTimer),
      canSwitch: this.independentEnabled() || this.desktopAvailable, error: this.independentLoginError ?? this.workspaceMetadataError,
    };
    this.publishWorkspaceState();
    return this.workspaceSnapshot;
  }

  private publishWorkspaceState(force = false): void {
    const snapshot: CodexWorkspaceStatus = {
      ...this.workspaceSnapshot,
      independent: this.independentEnabled(),
      selectedId: this.workspaceSnapshot?.selectedId ?? null,
      choices: this.workspaceSnapshot?.choices ?? [],
      signingIn: Boolean(this.independentLoginId),
      signInHintVisible: Boolean(this.loginHintTimer),
      error: this.independentLoginError ?? this.workspaceMetadataError,
    };
    this.workspaceSnapshot = snapshot;
    const serialized = JSON.stringify(snapshot);
    if (force || serialized !== this.publishedWorkspace) {
      this.publishedWorkspace = serialized;
      this.broadcast('codex-workspace:changed', snapshot);
    }
  }

  private scheduleWorkspaceDiscovery(afterLogin = false): void {
    if (this.workspaceDiscoveryTimer || (this.workspaceMetadataAt && !afterLogin) || !this.workspaceSnapshot?.authenticated ||
        this.independentLoginId || this.independentLoginStarting || this.workspaceSwitching ||
        Date.now() - this.workspaceMetadataAttemptAt < 60_000) return;
    this.workspaceDiscoveryTimer = setTimeout(() => {
      this.workspaceDiscoveryTimer = undefined;
      void this.getWorkspaceStatus(true).catch(() => {});
    }, 0);
  }

  async getWorkspaceStatus(refreshWorkspaceMetadata = false): Promise<CodexWorkspaceStatus> {
    if (!codexAccessAllowed()) return { independent: false, authenticated: false, selectedId: null, choices: [], signingIn: false };
    const refresh = refreshWorkspaceMetadata && Date.now() - this.workspaceMetadataAttemptAt >= 60_000;
    if (this.workspaceSnapshot && !refresh) return this.workspaceSnapshot;
    if (this.workspaceRead) return this.workspaceRead;
    const revision = this.workspaceRevision;
    if (refresh) this.workspaceMetadataAttemptAt = Date.now();
    const pending = (async () => {
      const independent = this.independentEnabled();
      const { client, child } = await (independent ? this.selectedClient() : this.openConnection('nimbalyst-workspace-read'));
      try {
        const accounts = await client.request<CodexLoginSessions>('accountSession/list', { refreshWorkspaceMetadata: refresh }, 15_000);
        if (revision !== this.workspaceRevision && this.workspaceSnapshot) return this.workspaceSnapshot;
        if (!independent) this.desktopAvailable = await this.desktopWorkspace.canUse(activeLogin(accounts));
        if (revision !== this.workspaceRevision && this.workspaceSnapshot) return this.workspaceSnapshot;
        return this.rememberWorkspace(activeLogin(accounts), refresh);
      } catch (error) {
        if (refresh && revision === this.workspaceRevision) {
          this.workspaceMetadataError = 'Could not update workspaces. Use Refresh to try again.';
          this.publishWorkspaceState();
        }
        throw error;
      } finally {
        if (!independent) {
          client.close('workspace read completed');
          child.stdin.end();
          if (!child.killed) child.kill();
        }
      }
    })();
    this.workspaceRead = pending;
    const clear = () => {
      if (this.workspaceRead === pending) {
        this.workspaceRead = null;
        if (!refresh) this.scheduleWorkspaceDiscovery();
      }
    };
    void pending.then(clear, clear);
    return pending;
  }

  private clearLogin(): void {
    if (this.loginTimer) clearTimeout(this.loginTimer);
    if (this.loginHintTimer) clearTimeout(this.loginHintTimer);
    this.loginTimer = undefined;
    this.loginHintTimer = undefined;
    this.independentLoginId = null;
    this.independentLoginConnection = undefined;
    this.independentLoginSlot = undefined;
    this.earlyLoginNotifications = [];
  }

  private async beginLogin(connection: Promise<AuthConnection>, login: CodexLoginStartedChatGpt): Promise<void> {
    this.independentLoginConnection = connection;
    this.independentLoginId = login.loginId;
    this.independentLoginError = undefined;
    this.loginHintTimer = setTimeout(() => {
      this.loginHintTimer = undefined;
      this.publishWorkspaceState();
    }, 15_000);
    this.loginHintTimer.unref?.();
    this.loginTimer = setTimeout(() => {
      // Abandoning an optional account change is not an authentication failure.
      void this.cancelIndependentLogin().catch(() => {});
    }, 5 * 60_000);
    this.loginTimer.unref?.();
    this.publishWorkspaceState();
    const early = this.earlyLoginNotifications.find(notification => !notification.loginId || notification.loginId === login.loginId);
    this.earlyLoginNotifications = [];
    if (early) await this.completeIndependentLogin(connection, early);
  }

  async signInIndependently(): Promise<CodexLoginStartedChatGpt> {
    if (this.workspaceSwitching || this.independentLoginStarting) {
      throw new Error('Finish or cancel the current Codex account change first.');
    }
    if (this.independentLoginId) await this.cancelIndependentLogin();
    this.independentLoginStarting = true;
    const slot = randomUUID();
    const connection = this.openConnection('nimbalyst-workspace-sign-in', this.authSlotHome(slot));
    this.independentLoginSlot = slot;
    this.independentLoginConnection = connection;
    this.observeIndependentConnection(connection);
    try {
      const { client } = await connection;
      this.independentLoginError = undefined;
      const response = await client.request<AccountLoginStartResponse>('account/login/start', { type: 'chatgpt' });
      if (response.type !== 'chatgpt') throw new Error('Codex could not start ChatGPT sign-in.');
      if (this.independentLoginConnection !== connection) throw new Error('Codex sign-in was cancelled.');
      await this.beginLogin(connection, response);
      return response;
    } catch (error) {
      if (this.independentLoginConnection === connection) {
        this.clearLogin();
        this.publishWorkspaceState();
        await this.retireIndependentConnection(connection, slot);
      }
      throw error;
    } finally {
      this.independentLoginStarting = false;
      this.scheduleWorkspaceDiscovery(true);
    }
  }

  async cancelIndependentLogin(): Promise<void> {
    const loginId = this.independentLoginId;
    const connection = this.independentLoginConnection;
    const slot = this.independentLoginSlot;
    if (!connection) return;
    this.clearLogin();
    this.publishWorkspaceState();
    try {
      const { client } = await connection;
      if (loginId) await client.request('account/login/cancel', { loginId }, 10_000);
    } catch {
      if (this.independentConnection === connection) {
        this.independentConnection = undefined;
        await this.retireIndependentConnection(connection);
      }
    } finally {
      if (slot) await this.retireIndependentConnection(connection, slot);
      this.publishWorkspaceState();
      this.scheduleWorkspaceDiscovery();
    }
  }

  async selectWorkspace(accountId: string): Promise<CodexLoginStartedChatGpt | void> {
    if (this.workspaceSwitching || this.independentLoginStarting) {
      throw new Error('Finish or cancel the current Codex account change first.');
    }
    this.workspaceSwitching = true;
    try {
      // An explicit workspace choice supersedes an unfinished browser account change.
      await this.cancelIndependentLogin();
      if (!this.independentEnabled() || this.desktopIdentity()) {
        const selected = await this.desktopWorkspace.get(accountId, this.desktopIdentity());
        setAppSetting(desktopIdentitySetting, selected.identity);
        setAppSetting(independentWorkspaceSetting, accountId);
        this.independentLoginError = undefined;
        this.rememberWorkspace(selected.account);
        return;
      }
      const { client } = await this.independentClient();
      let login = activeLogin(await client.request<CodexLoginSessions>('accountSession/list', { refreshWorkspaceMetadata: false }));
      if (!login?.workspaces?.some(workspace => workspace.accountId === accountId)) {
        login = activeLogin(await client.request<CodexLoginSessions>('accountSession/list', { refreshWorkspaceMetadata: true }));
      }
      if (!login?.workspaces?.some(workspace => workspace.accountId === accountId)) {
        throw new Error('The selected workspace is not available for this ChatGPT sign-in.');
      }
      const result = await client.request<CodexLoginSessions | { login_id: string; auth_url: string }>('accountSession/switch', {
        sessionId: login.sessionId,
        accountId,
        allowBrowserLogin: true,
      });
      if ('login_id' in result) {
        const browserLogin: CodexLoginStartedChatGpt = { type: 'chatgpt', loginId: result.login_id, authUrl: result.auth_url };
        await this.beginLogin(this.independentConnection!, browserLogin);
        return browserLogin;
      }
      if (activeLogin(result)?.selectedWorkspaceAccountId !== accountId) {
        throw new Error('Codex could not select the requested workspace. Sign in to that workspace again.');
      }
      setAppSetting(independentWorkspaceSetting, accountId);
      this.independentLoginError = undefined;
      this.rememberWorkspace(activeLogin(result));
    } finally {
      this.workspaceSwitching = false;
      this.workspaceChanged();
      this.scheduleWorkspaceDiscovery();
    }
  }

  followDesktopWorkspace(): void {
    if (this.workspaceSwitching || this.independentLoginStarting || this.independentLoginId) {
      throw new Error('Finish or cancel the current Codex account change first.');
    }
    setAppSetting(independentWorkspaceSetting, null);
    setAppSetting(desktopIdentitySetting, null);
    this.desktopWorkspace.shutdown();
    this.workspaceSnapshot = null;
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
    const desktopIdentity = this.desktopIdentity();
    return {
      revision,
      assertCurrent,
      getTokens: async (refresh) => {
        assertCurrent();
        if (desktopIdentity) {
          const selected = await this.desktopWorkspace.get(expected, desktopIdentity, refresh);
          assertCurrent();
          return selected.tokens;
        }
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
    const client = this.independentEnabled() ? (await this.selectedClient(refreshToken)).client : await this.ensureChild();
    const res = await client.request<AccountReadResponse>('account/read', { refreshToken: this.desktopIdentity() ? false : refreshToken });
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
    const { client, child } = await (expected ? this.selectedClient() : this.openConnection('nimbalyst-usage'));
    try {
      const accounts = await client.request<CodexLoginSessions>('accountSession/list', { refreshWorkspaceMetadata: false });
      const account = activeLogin(accounts);
      if (!expected) this.desktopAvailable = await this.desktopWorkspace.canUse(account);
      auth.assertCurrent();
      if (!account?.selectedWorkspaceAccountId) {
        this.rememberWorkspace(undefined);
        onAccountIdentified?.(null);
        throw new Error('Current ChatGPT account could not be identified. Sign in with ChatGPT to view subscription limits.');
      }
      this.rememberWorkspace(account);
      this.scheduleWorkspaceDiscovery();
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
    await this.cancelIndependentLogin();
    const independent = this.independentEnabled();
    if (this.desktopIdentity()) {
      setAppSetting(desktopIdentitySetting, null);
      this.desktopWorkspace.shutdown();
    }
    const client = independent ? (await this.independentClient()).client : await this.ensureChild();
    await client.request('account/logout', {});
    this.cachedStatus = null;
    if (independent) { this.rememberWorkspace(undefined); this.workspaceChanged(); }
  }

  getCachedStatus(): CodexAuthStatus | null {
    if (!codexAccessAllowed()) return null;
    return this.cachedStatus;
  }

  shutdown(): void {
    this.desktopWorkspace.shutdown();
    this.desktopAvailable = false;
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
    const login = this.independentLoginConnection;
    const loginSlot = this.independentLoginSlot;
    this.independentConnection = undefined;
    this.clearLogin();
    this.independentLoginStarting = false;
    this.workspaceSwitching = false;
    this.workspaceSnapshot = null;
    this.workspaceRead = null;
    this.workspaceMetadataAt = 0;
    this.workspaceMetadataAttemptAt = 0;
    this.workspaceIdentity = null;
    this.workspaceMetadataError = undefined;
    if (this.workspaceDiscoveryTimer) clearTimeout(this.workspaceDiscoveryTimer);
    this.workspaceDiscoveryTimer = undefined;
    this.publishedWorkspace = '';
    this.independentLoginError = undefined;
    if (independent) void this.retireIndependentConnection(independent);
    if (login && login !== independent) void this.retireIndependentConnection(login, loginSlot);
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
