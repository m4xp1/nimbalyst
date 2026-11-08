// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ spawn: vi.fn(), clients: [] as any[], scope: 'work' as string | null, percent: 90, fail: false }));
vi.mock('node:child_process', () => ({ spawn: f.spawn }));
vi.mock('@nimbalyst/runtime/ai/server/protocols/codexAppServer/codexAppServerBinary', () => ({ resolveCodexBinaryPath: () => '/synthetic/codex', getCodexVendorPathEntries: () => [] }));
vi.mock('../shellEnvironment', () => ({ getEnhancedPath: () => '' }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } } }));
vi.mock('@nimbalyst/runtime/ai/server/protocols/codexAppServer/jsonRpcClient', () => ({ JsonRpcClient: class {
  request = vi.fn(async (method: string) => {
    if (method === 'initialize') return {};
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'same@example.test', planType: 'pro' }, requiresOpenaiAuth: true };
    if (method === 'accountSession/list') return { activeSessionId: 'login', sessions: f.scope ? [{ sessionId: 'login', userId: 'same-user', email: 'same@example.test', isActive: true, selectedWorkspaceAccountId: f.scope }] : [] };
    if (method === 'account/rateLimits/read') { if (f.fail) throw new Error('synthetic quota failure'); return { accountId: f.scope, rateLimits: { primary: { usedPercent: f.percent } } }; }
    throw new Error('Unexpected RPC: ' + method);
  });
  notify = vi.fn(); close = vi.fn(); onNotification = vi.fn(() => () => {});
  constructor() { f.clients.push(this); }
} }));
import { codexAuthService as service } from '../CodexAuthService';
beforeEach(() => {
  vi.stubEnv('NIMBALYST_ALLOW_CODEX_ACCESS', '1'); f.scope = 'work'; f.fail = false; f.clients.length = 0;
  f.spawn.mockImplementation(() => ({ killed: false, kill: vi.fn(), stdin: { end: vi.fn() }, stderr: { setEncoding: vi.fn(), on: vi.fn() }, on: vi.fn() }));
});
afterEach(() => { service.shutdown(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
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
