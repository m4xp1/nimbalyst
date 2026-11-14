// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  spawn: vi.fn(), clients: [] as any[], scope: 'work' as string | null, percent: 90, fail: false,
  subject: 'same-user' as unknown, selection: null as string | null, credentials: vi.fn(),
  notifications: [] as Array<(method: string, params: unknown) => void>,
  start: vi.fn(), browserSwitch: false,
}));
vi.mock('node:child_process', () => ({ spawn: f.spawn }));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), readFile: f.credentials }));
vi.mock('../../utils/store', () => ({
  getAppSetting: () => f.selection,
  setAppSetting: (_key: string, value: string | null) => { f.selection = value; },
}));
vi.mock('@nimbalyst/runtime/ai/server/protocols/codexAppServer/codexAppServerBinary', () => ({ resolveCodexBinaryPath: () => '/synthetic/codex', getCodexVendorPathEntries: () => [] }));
vi.mock('../shellEnvironment', () => ({ getEnhancedPath: () => '' }));
vi.mock('electron', () => ({ app: { getPath: () => '/synthetic/nimbalyst' }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } } }));
vi.mock('@nimbalyst/runtime/ai/server/protocols/codexAppServer/jsonRpcClient', () => ({ JsonRpcClient: class {
  request = vi.fn(async (method: string, params?: { accountId?: string }) => {
    if (method === 'initialize') return {};
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'same@example.test', planType: 'pro' }, requiresOpenaiAuth: true };
    if (method === 'account/login/start') return f.start();
    if (method === 'account/login/cancel') return {};
    if (method === 'accountSession/switch' && f.browserSwitch) return { login_id: 'sso-login', auth_url: 'https://auth.example.test/sso' };
    if (method === 'accountSession/switch') f.scope = params?.accountId ?? null;
    if (method === 'accountSession/list' || method === 'accountSession/switch') {
      return {
        activeSessionId: 'login',
        sessions: f.scope ? [{
          sessionId: 'login', email: 'same@example.test', userId: f.subject, isActive: true, selectedWorkspaceAccountId: f.scope,
          workspaces: [{ accountId: 'personal', name: 'Personal' }, { accountId: 'work', name: 'GPT' }],
        }] : [],
      };
    }
    if (method === 'account/rateLimits/read') { if (f.fail) throw new Error('synthetic quota failure'); return { accountId: f.scope, rateLimits: { primary: { usedPercent: f.percent } } }; }
    throw new Error('Unexpected RPC: ' + method);
  });
  notify = vi.fn(); close = vi.fn(); onNotification = vi.fn((callback) => { f.notifications.push(callback); return () => {}; });
  constructor() { f.clients.push(this); }
} }));
import { codexAuthService as service } from '../CodexAuthService';
beforeEach(() => {
  vi.stubEnv('NIMBALYST_ALLOW_CODEX_ACCESS', '1'); f.scope = 'work'; f.fail = false; f.subject = 'same-user'; f.clients.length = 0;
  f.selection = null;
  f.notifications.length = 0; f.browserSwitch = false;
  f.start.mockReset().mockResolvedValue({ type: 'chatgpt', loginId: 'browser-login', authUrl: 'https://auth.example.test/login' });
  f.spawn.mockClear();
  f.credentials.mockReset();
  f.spawn.mockImplementation(() => ({ killed: false, kill: vi.fn(), stdin: { end: vi.fn() }, stderr: { setEncoding: vi.fn(), on: vi.fn() }, on: vi.fn() }));
});
afterEach(() => { service.shutdown(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
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
  for (const [event, callback] of child.on.mock.calls) if (event === 'exit') callback(1);
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
