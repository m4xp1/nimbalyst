// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';
const f = vi.hoisted(() => ({
  spawn: vi.fn(), clients: [] as any[], scope: 'work' as string | null, percent: 90, fail: false,
  subject: 'same-user' as unknown, selection: null as string | null, credentials: vi.fn(),
  notifications: [] as Array<(method: string, params: unknown) => void>,
  start: vi.fn(), browserSwitch: false, partialList: false, list: vi.fn(),
  desktopAvailable: false, desktopGet: vi.fn(), desktopShutdown: vi.fn(), desktopIdentity: null as any,
  authSlot: null as string | null, remove: vi.fn(), scopes: new Map<string, string | null>(),
}));
vi.mock('node:child_process', () => ({ spawn: f.spawn }));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), readFile: f.credentials, rm: f.remove }));
vi.mock('../../utils/store', () => ({
  getAppSetting: (key: string) => key === 'codexWorkspaceAuthSlot' ? f.authSlot : key === 'codexDesktopWorkspaceIdentity' ? f.desktopIdentity : f.selection,
  setAppSetting: (key: string, value: any) => {
    if (key === 'codexWorkspaceAuthSlot') f.authSlot = value;
    else if (key === 'codexDesktopWorkspaceIdentity') f.desktopIdentity = value;
    else f.selection = value;
  },
}));
vi.mock('../CodexDesktopWorkspace', () => ({ CodexDesktopWorkspace: class {
  canUse = async () => f.desktopAvailable;
  get = f.desktopGet;
  shutdown = f.desktopShutdown;
} }));
vi.mock('@nimbalyst/runtime/ai/server/protocols/codexAppServer/codexAppServerBinary', () => ({ resolveCodexBinaryPath: () => '/synthetic/codex', getCodexVendorPathEntries: () => [] }));
vi.mock('../shellEnvironment', () => ({ getEnhancedPath: () => '' }));
vi.mock('electron', () => ({ app: { getPath: () => '/synthetic/nimbalyst' }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } } }));
vi.mock('@nimbalyst/runtime/ai/server/protocols/codexAppServer/jsonRpcClient', () => ({ JsonRpcClient: class {
  home: string;
  request = vi.fn(async (method: string, params?: { accountId?: string; refreshWorkspaceMetadata?: boolean }) => {
    if (method === 'initialize') return {};
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'same@example.test', planType: 'pro' }, requiresOpenaiAuth: true };
    if (method === 'account/login/start') return f.start(this.home);
    if (method === 'account/login/cancel') return {};
    if (method === 'accountSession/switch' && f.browserSwitch) return { login_id: 'sso-login', auth_url: 'https://auth.example.test/sso' };
    if (method === 'accountSession/switch') {
      if (f.scopes.has(this.home)) f.scopes.set(this.home, params?.accountId ?? null);
      else f.scope = params?.accountId ?? null;
    }
    const scope = f.scopes.has(this.home) ? f.scopes.get(this.home) : f.scope;
    if (method === 'accountSession/list' || method === 'accountSession/switch') {
      const override = await f.list(params, this.home);
      if (override) return override;
      return {
        activeSessionId: 'login',
        sessions: scope ? [{
          sessionId: 'login', email: 'same@example.test', userId: f.subject, isActive: true, selectedWorkspaceAccountId: scope,
          workspaces: f.partialList && !params?.refreshWorkspaceMetadata
            ? [{ accountId: scope, name: null }]
            : [{ accountId: 'personal', name: 'Personal' }, { accountId: 'work', name: 'GPT' }],
        }] : [],
      };
    }
    if (method === 'account/rateLimits/read') { if (f.fail) throw new Error('synthetic quota failure'); return { accountId: scope, rateLimits: { primary: { usedPercent: f.percent } } }; }
    throw new Error('Unexpected RPC: ' + method);
  });
  notify = vi.fn(); close = vi.fn(); onNotification = vi.fn((callback) => { f.notifications.push(callback); return () => {}; });
  constructor(child: any) { this.home = child.codexHome; f.clients.push(this); }
} }));
import { codexAuthService as service } from '../CodexAuthService';
beforeEach(() => {
  vi.stubEnv('NIMBALYST_ALLOW_CODEX_ACCESS', '1'); f.scope = 'work'; f.fail = false; f.subject = 'same-user'; f.clients.length = 0;
  f.selection = null;
  f.authSlot = null; f.scopes.clear(); f.remove.mockReset().mockResolvedValue(undefined);
  f.desktopAvailable = false; f.desktopIdentity = null; f.desktopGet.mockReset(); f.desktopShutdown.mockClear();
  f.notifications.length = 0; f.browserSwitch = false;
  f.partialList = false; f.list.mockReset();
  f.start.mockReset().mockResolvedValue({ type: 'chatgpt', loginId: 'browser-login', authUrl: 'https://auth.example.test/login' });
  f.spawn.mockClear();
  f.credentials.mockReset();
  f.spawn.mockImplementation((_binary, _args, options) => {
    const child = Object.assign(new EventEmitter(), { codexHome: options.env.CODEX_HOME, killed: false, exitCode: null as number | null,
      kill: vi.fn(), stdin: { end: vi.fn() }, stderr: { setEncoding: vi.fn(), on: vi.fn() } });
    child.kill.mockImplementation(() => { child.killed = true; child.exitCode = 0; child.emit('exit', 0); });
    return child;
  });
});
afterEach(async () => { service.shutdown(); vi.useRealTimers(); await new Promise(resolve => setImmediate(resolve)); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('keeps current credentials and limits usable during an isolated browser attempt and its quiet expiry', async () => {
  vi.useFakeTimers();
  f.selection = 'work';
  await service.getWorkspaceStatus(true);
  const active = f.clients[0];
  f.scopes.set(active.home, 'work');
  const auth = service.workspaceAuth();
  f.credentials.mockResolvedValue(JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'current-access', account_id: 'work' } }));
  // A native login may clear or change its own store before it completes.
  f.start.mockImplementation(async home => {
    f.scopes.set(home, null);
    return { type: 'chatgpt', loginId: 'browser-login', authUrl: 'https://auth.example.test/login' };
  });
  await service.signInIndependently();
  expect(f.clients).toHaveLength(2);
  const attempt = f.clients[1];
  expect(attempt.home).not.toBe(active.home);
  expect(await service.getWorkspaceStatus()).toMatchObject({ signingIn: true, signInHintVisible: true, selectedId: 'work', authenticated: true });
  await expect(auth.getTokens!(false)).resolves.toMatchObject({ chatgptAccountId: 'work' });
  await expect(service.getRateLimits()).resolves.toMatchObject({ accountScope: expect.stringContaining('work') });
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await service.getWorkspaceStatus()).toMatchObject({ signingIn: true, signInHintVisible: false });
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(await service.getWorkspaceStatus()).toMatchObject({ signingIn: false, signInHintVisible: false, selectedId: 'work', error: undefined });
  expect(f.authSlot).toBeNull();
  expect(active.close).not.toHaveBeenCalled();
  expect(attempt.close).toHaveBeenCalled();
  expect(f.remove).toHaveBeenCalledWith(attempt.home, expect.objectContaining({ recursive: true }));
  await expect(auth.getTokens!(false)).resolves.toMatchObject({ chatgptAccountId: 'work' });
});

it('allows choosing the current account workspace while awaiting a browser and ignores its late success', async () => {
  f.selection = 'work';
  await service.getWorkspaceStatus(true);
  await service.signInIndependently();
  const lateNotifications = [...f.notifications];
  await expect(service.selectWorkspace('personal')).resolves.toBeUndefined();
  for (const notify of lateNotifications) notify('account/login/completed', { loginId: 'browser-login', success: true });
  await new Promise(resolve => setImmediate(resolve));
  expect(await service.getWorkspaceStatus()).toMatchObject({ selectedId: 'personal', signingIn: false, signInHintVisible: false });
  expect(f.authSlot).toBeNull();
  await expect(service.getRateLimits()).resolves.toMatchObject({ accountScope: expect.stringContaining('personal') });
});

it('adopts only a completed browser store and restores that account after restarting the service', async () => {
  f.selection = 'work';
  await service.getWorkspaceStatus(true);
  const active = f.clients[0];
  f.scopes.set(active.home, 'work');
  await service.signInIndependently();
  const attempt = f.clients[1];
  f.scopes.set(attempt.home, 'personal');
  expect(f.authSlot).toBeNull(); expect(f.selection).toBe('work');
  for (const notify of f.notifications) notify('account/login/completed', { loginId: 'browser-login', success: true });
  await vi.waitFor(() => expect(f.selection).toBe('personal'));
  expect(f.authSlot).toBeTruthy();
  expect(active.close).toHaveBeenCalled();
  expect(attempt.close).not.toHaveBeenCalled();
  expect(await service.getWorkspaceStatus()).toMatchObject({ signingIn: false, signInHintVisible: false, selectedId: 'personal' });
  service.shutdown();
  await expect(service.getRateLimits()).resolves.toMatchObject({ accountScope: expect.stringContaining('personal') });
  expect(f.clients.at(-1).home).toBe(attempt.home);
  f.credentials.mockResolvedValue(JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'new-access', account_id: 'personal' } }));
  await expect(service.workspaceAuth().getTokens!(false)).resolves.toMatchObject({ chatgptAccountId: 'personal' });
  expect(f.credentials).toHaveBeenCalledWith(path.join(attempt.home, 'auth.json'), 'utf8');
  expect(f.remove.mock.calls.some(([home]) => home === attempt.home)).toBe(false);
});

it('keeps the existing login when starting a replacement fails and allows retry', async () => {
  f.selection = 'work';
  await service.getWorkspaceStatus(true);
  const active = f.clients[0];
  f.start.mockRejectedValueOnce(new Error('synthetic browser-start failure'));
  await expect(service.signInIndependently()).rejects.toThrow('synthetic browser-start failure');
  expect(await service.getWorkspaceStatus()).toMatchObject({ selectedId: 'work', authenticated: true, signingIn: false, signInHintVisible: false });
  expect(active.close).not.toHaveBeenCalled(); expect(f.authSlot).toBeNull();
  await expect(service.getRateLimits()).resolves.toMatchObject({ accountScope: expect.stringContaining('work') });
  await expect(service.signInIndependently()).resolves.toMatchObject({ loginId: 'browser-login' });
});

it('does not promote a completed login if its confirmation read finishes after another workspace was chosen', async () => {
  f.selection = 'work';
  await service.getWorkspaceStatus(true);
  await service.signInIndependently();
  const attempt = f.clients[1];
  let confirm!: (value: unknown) => void;
  f.list.mockImplementation((_params, home) => home === attempt.home ? new Promise(resolve => { confirm = resolve; }) : undefined);
  for (const notify of f.notifications) notify('account/login/completed', { loginId: 'browser-login', success: true });
  await vi.waitFor(() => expect(confirm).toBeTypeOf('function'));
  await service.selectWorkspace('personal');
  confirm({ activeSessionId: 'other-login', sessions: [{ sessionId: 'other-login', isActive: true, selectedWorkspaceAccountId: 'work' }] });
  await new Promise(resolve => setImmediate(resolve));
  expect(f.authSlot).toBeNull();
  expect(await service.getWorkspaceStatus()).toMatchObject({ selectedId: 'personal', signingIn: false });
});
it('enables workspace selection for a reusable Desktop login without a browser login', async () => {
  f.desktopAvailable = true;
  expect(await service.getWorkspaceStatus(true)).toMatchObject({ independent: false, canSwitch: true });
  expect(f.start).not.toHaveBeenCalled();
});

it('selects only the isolated Desktop scope and supplies its tokens to existing sessions', async () => {
  f.desktopAvailable = true;
  const account = { sessionId: 'desktop-login', userId: 'same-user', email: 'same@example.test', isActive: true,
    selectedWorkspaceAccountId: 'personal', workspaces: [{ accountId: 'personal', name: 'Personal', kind: 'personal' }] };
  const request = vi.fn(async (method: string) => method === 'accountSession/list'
    ? { activeSessionId: 'desktop-login', sessions: [account] }
    : { accountId: 'personal', rateLimits: { primary: { usedPercent: 10 } } });
  f.desktopGet.mockResolvedValue({ account, identity: { userId: 'same-user', email: 'same@example.test' },
    client: { request }, tokens: { accessToken: 'isolated-access', chatgptAccountId: 'personal' } });
  const previous = service.workspaceAuth();
  await service.selectWorkspace('personal');
  expect(f.selection).toBe('personal');
  expect(f.desktopIdentity?.userId).toBe('same-user');
  expect(() => previous.assertCurrent()).toThrow('workspace changed');
  await expect(service.workspaceAuth().getTokens!(false)).resolves.toEqual({ accessToken: 'isolated-access', chatgptAccountId: 'personal' });
  await expect(service.getRateLimits()).resolves.toMatchObject({ accountScope: expect.stringContaining('personal') });
  expect(f.clients.flatMap(client => client.request.mock.calls).some(([method]) => /switch|login\/start/.test(method))).toBe(false);
});

it('keeps the previous scope when isolated Desktop selection fails', async () => {
  f.desktopGet.mockRejectedValue(new Error('Workspace requires sign-in'));
  await expect(service.selectWorkspace('personal')).rejects.toThrow('Workspace requires sign-in');
  expect(f.selection).toBeNull(); expect(f.desktopIdentity).toBeNull();
});

it('replaces Desktop reuse only after a separate browser login succeeds', async () => {
  f.selection = 'work'; f.desktopIdentity = { userId: 'same-user', email: 'same@example.test' };
  await service.signInIndependently();
  expect(f.desktopIdentity?.userId).toBe('same-user');
  for (const notify of f.notifications) notify('account/login/completed', { loginId: 'browser-login', success: true });
  await vi.waitFor(() => expect(f.desktopIdentity).toBeNull());
  expect(f.desktopShutdown).toHaveBeenCalled();
  expect(f.selection).toBe('work');
});
it('preserves complete workspace metadata when native quota reads return only the current workspace', async () => {
  f.selection = 'work'; f.partialList = true;
  expect((await service.getWorkspaceStatus(true)).choices).toHaveLength(2);
  await service.getRateLimits();
  expect((await service.getWorkspaceStatus()).choices).toEqual([
    { id: 'personal', name: 'Personal' }, { id: 'work', name: 'GPT' },
  ]);
});

it('does not discard the known list when account/updated is followed by a partial quota read', async () => {
  f.selection = 'work'; f.partialList = true;
  await service.getWorkspaceStatus(true);
  for (const notify of f.notifications) notify('account/updated', {});
  await service.getRateLimits();
  expect((await service.getWorkspaceStatus()).choices).toEqual([
    { id: 'personal', name: 'Personal' }, { id: 'work', name: 'GPT' },
  ]);
});

it('discovers workspaces in the background even when the initial list contains only one entry', async () => {
  f.selection = 'work'; f.partialList = true;
  expect((await service.getWorkspaceStatus()).choices).toHaveLength(1);
  await vi.waitFor(async () => expect((await service.getWorkspaceStatus()).choices).toHaveLength(2));
});

it('invalidates membership for another identity instead of carrying the old workspaces into its UI', async () => {
  f.selection = 'work'; f.partialList = true;
  await service.getWorkspaceStatus(true);
  f.subject = 'another-user';
  f.scope = 'personal'; f.selection = 'personal';
  await service.getRateLimits();
  expect((await service.getWorkspaceStatus()).choices).toEqual([{ id: 'personal', name: 'Workspace' }]);
});

it('keeps discovered memberships on a metadata outage and does not retry on every panel open', async () => {
  f.selection = 'work'; f.partialList = true;
  await service.getWorkspaceStatus(true);
  const currentTime = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(currentTime + 61_000);
  f.list.mockImplementation(params => { if (params?.refreshWorkspaceMetadata) throw new Error('synthetic metadata outage'); });
  await expect(service.getWorkspaceStatus(true)).rejects.toThrow('synthetic metadata outage');
  const attempts = f.list.mock.calls.length;
  for (let i = 0; i < 3; i++) {
    expect(await service.getWorkspaceStatus(true)).toMatchObject({ choices: [{ id: 'personal' }, { id: 'work' }], error: expect.stringContaining('Could not update') });
  }
  expect(f.list.mock.calls).toHaveLength(attempts);
  await service.getRateLimits();
  expect((await service.getWorkspaceStatus()).choices).toHaveLength(2);
});

it('finishes sign-in before waiting for optional workspace discovery', async () => {
  f.selection = 'work'; f.partialList = true;
  let finishMetadata!: (value: unknown) => void;
  f.list.mockImplementation((params) => params?.refreshWorkspaceMetadata
    ? new Promise(resolve => { finishMetadata = resolve; }) : undefined);
  await service.signInIndependently();
  for (const notify of f.notifications) notify('account/login/completed', { loginId: 'browser-login', success: true });
  await vi.waitFor(async () => expect(await service.getWorkspaceStatus()).toMatchObject({ signingIn: false, authenticated: true }));
  finishMetadata({ activeSessionId: 'login', sessions: [{ sessionId: 'login', userId: f.subject, isActive: true,
    selectedWorkspaceAccountId: 'work', email: 'same@example.test',
    workspaces: [{ accountId: 'personal', name: 'Personal' }, { accountId: 'work', name: 'GPT' }],
  }] });
  await vi.waitFor(async () => expect((await service.getWorkspaceStatus()).choices).toHaveLength(2));
});

it('refreshes membership after signing in again as the same identity', async () => {
  f.selection = 'work'; f.partialList = true;
  f.list.mockResolvedValueOnce({ activeSessionId: 'login', sessions: [{ sessionId: 'login', userId: f.subject, isActive: true,
    selectedWorkspaceAccountId: 'work', email: 'same@example.test', workspaces: [{ accountId: 'work', name: 'GPT' }],
  }] });
  expect((await service.getWorkspaceStatus(true)).choices).toHaveLength(1);
  await service.signInIndependently();
  for (const notify of f.notifications) notify('account/login/completed', { loginId: 'browser-login', success: true });
  await vi.waitFor(async () => expect((await service.getWorkspaceStatus()).choices).toHaveLength(2));
});

it('shows the current Desktop account and known workspace metadata without changing its authorization', async () => {
  const status = await service.getWorkspaceStatus(true);
  expect(status).toMatchObject({
    independent: false, authenticated: true, email: 'same@example.test',
    selectedId: 'work', canSwitch: false,
    choices: [{ id: 'personal', name: 'Personal' }, { id: 'work', name: 'GPT' }],
  });
  expect(f.clients.flatMap(client => client.request.mock.calls).some(([method]) => /login|logout|switch/.test(method))).toBe(false);
});

it('supports the native SSO switch response instead of treating it as an empty session list', async () => {
  f.selection = 'work';
  f.browserSwitch = true;
  await expect(service.selectWorkspace('personal')).resolves.toMatchObject({
    type: 'chatgpt', loginId: 'sso-login', authUrl: 'https://auth.example.test/sso',
  });
  expect(await service.getWorkspaceStatus()).toMatchObject({ signingIn: true });
});

it('accepts a completion notification that arrives before login/start resolves', async () => {
  f.start.mockImplementation(async () => {
    for (const notify of f.notifications) notify('account/login/completed', { loginId: 'browser-login', success: true });
    return { type: 'chatgpt', loginId: 'browser-login', authUrl: 'https://auth.example.test/login' };
  });
  await service.signInIndependently();
  await vi.waitFor(async () => expect(await service.getWorkspaceStatus()).toMatchObject({ signingIn: false, selectedId: 'work' }));
  await expect(service.signInIndependently()).resolves.toMatchObject({ loginId: 'browser-login' });
});

it('restarts pending sign-in and ignores the superseded completion', async () => {
  await service.signInIndependently();
  f.start.mockResolvedValue({ type: 'chatgpt', loginId: 'second-login', authUrl: 'https://auth.example.test/second' });
  await service.signInIndependently();
  expect(f.clients[0].request).toHaveBeenCalledWith('account/login/cancel', { loginId: 'browser-login' }, 10_000);
  for (const notify of f.notifications) notify('account/login/completed', { loginId: 'browser-login', success: true });
  await Promise.resolve();
  expect(await service.getWorkspaceStatus()).toMatchObject({ signingIn: true });
  for (const notify of f.notifications) notify('account/login/completed', { loginId: 'second-login', success: true });
  await vi.waitFor(async () => expect(await service.getWorkspaceStatus()).toMatchObject({ signingIn: false, email: 'same@example.test' }));
});

it('releases sign-in state after rejection and permits another browser attempt', async () => {
  await service.signInIndependently();
  for (const notify of f.notifications) notify('account/login/completed', { loginId: 'browser-login', success: false, error: 'synthetic rejection' });
  await vi.waitFor(async () => expect(await service.getWorkspaceStatus()).toMatchObject({ signingIn: false, error: expect.stringContaining('did not complete') }));
  await service.signInIndependently();
  expect(await service.getWorkspaceStatus()).toMatchObject({ signingIn: true, error: undefined });
});

it('clears a pending browser attempt when its owned process exits', async () => {
  await service.signInIndependently();
  const child = f.spawn.mock.results[0].value;
  child.exitCode = 1; child.emit('exit', 1);
  expect(await service.getWorkspaceStatus()).toMatchObject({ signingIn: false, error: expect.stringContaining('interrupted') });
  await service.signInIndependently();
  expect(f.spawn).toHaveBeenCalledTimes(2);
});

it('shares cached workspace reads and rate-limits metadata refreshes', async () => {
  await Promise.all([service.getWorkspaceStatus(true), service.getWorkspaceStatus(true)]);
  expect(f.spawn).toHaveBeenCalledTimes(1);
  await service.getWorkspaceStatus();
  await service.getWorkspaceStatus(true);
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.clients[0].request.mock.calls.filter(([method]: [string]) => method === 'accountSession/list')).toHaveLength(1);
});
it('loads current native scope in a separate reader and leaves the existing auth process running', async () => {
  await service.getStatus(); const authChild = f.spawn.mock.results[0].value;
  const identified = vi.fn();
  const first = await service.getRateLimits(identified);
  expect(identified).toHaveBeenCalledWith(expect.stringContaining('work'));
  expect(first.accountScope).toContain('work');
  expect(f.clients[1].request).toHaveBeenCalledWith('accountSession/list', { refreshWorkspaceMetadata: false });
  expect(f.clients[1].close).toHaveBeenCalled();
  f.scope = 'personal'; const second = await service.getRateLimits(identified);
  expect(second.accountScope).toContain('personal');
  expect(authChild.kill).not.toHaveBeenCalled();
  expect(f.clients.flatMap(c => c.request.mock.calls).some(([m]: any[]) => /login|logout/.test(m))).toBe(false);
});
it('does not reuse session logs or call quota when the current native account cannot be identified', async () => {
  f.scope = null; const identified = vi.fn();
  await expect(service.getRateLimits(identified)).rejects.toThrow(/account|ChatGPT/i);
  expect(identified).toHaveBeenCalledWith(null);
  expect(f.clients[0].request.mock.calls.some(([m]: any[]) => m === 'account/rateLimits/read')).toBe(false);
  expect(f.clients[0].close).toHaveBeenCalled();
});
it('closes the temporary reader when quota fails', async () => {
  f.fail = true;
  await expect(service.getRateLimits()).rejects.toThrow('synthetic quota failure');
  expect(f.clients[0].close).toHaveBeenCalled();
  expect(f.spawn.mock.results[0].value.kill).toHaveBeenCalled();
});

it('withholds ambient API keys from account readers without changing the native login', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-direct-api'); vi.stubEnv('CODEX_API_KEY', 'synthetic-codex-api');
  await service.getRateLimits();
  const options = f.spawn.mock.calls[0][2];
  expect(options.env.OPENAI_API_KEY).toBeUndefined(); expect(options.env.CODEX_API_KEY).toBeUndefined();
});
it('rejects quota returned for a different workspace', async () => {
  // Switch the fake backend after local identity was read, before quota responds.
  const identified = vi.fn(() => { f.scope = 'other-workspace'; });
  await expect(service.getRateLimits(identified)).rejects.toThrow(/changed while reading limits/);
  expect(identified).toHaveBeenLastCalledWith(null);
  expect(f.clients[0].close).toHaveBeenCalled();
});

it('rejects an invalid external subject instead of treating it as an application identity', async () => {
  f.subject = 123;
  await expect(service.getRateLimits()).rejects.toThrow('invalid account identity');
  expect(f.clients[0].request.mock.calls.some(([method]: any[]) => method === 'account/rateLimits/read')).toBe(false);
  expect(f.clients[0].close).toHaveBeenCalled();
});

it('switches and reads quota in the app-owned home, invalidating the old turn auth', async () => {
  f.selection = 'work';
  const previous = service.workspaceAuth();
  await service.selectWorkspace('personal');
  expect(f.selection).toBe('personal');
  expect(() => previous.assertCurrent()).toThrow('workspace changed');
  expect(f.clients[0].request).toHaveBeenCalledWith('accountSession/switch', {
    sessionId: 'login', accountId: 'personal', allowBrowserLogin: true,
  });
  await expect(service.getRateLimits()).resolves.toMatchObject({ accountScope: expect.stringContaining('personal') });
  expect(f.spawn.mock.calls.map(([, , options]) => options.env.CODEX_HOME)).toEqual([
    expect.stringContaining('codex-workspace-auth'),
  ]);
  expect(f.clients[0].close).not.toHaveBeenCalled();
});

it('reads only app-owned credentials and rejects any mismatch with the selected workspace', async () => {
  f.selection = 'work';
  const getTokens = service.workspaceAuth().getTokens!;
  f.credentials.mockResolvedValue(JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'synthetic-access', account_id: 'personal' },
  }));
  await expect(getTokens(false)).rejects.toThrow(/match the selected workspace/);
  expect(f.credentials).toHaveBeenCalledWith(expect.stringMatching(/codex-workspace-auth[/\\]auth\.json$/), 'utf8');
  f.credentials.mockResolvedValue(JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'synthetic-access', account_id: 'work' },
  }));
  await expect(getTokens(true)).resolves.toEqual({ accessToken: 'synthetic-access', chatgptAccountId: 'work' });
  expect(f.clients[0].request).toHaveBeenCalledWith('account/read', { refreshToken: true });
  f.scope = 'personal';
  await expect(service.getRateLimits()).rejects.toThrow('selected Codex workspace');
});
