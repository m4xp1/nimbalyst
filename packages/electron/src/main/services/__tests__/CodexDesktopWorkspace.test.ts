// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ files: new Map<string, string>(), write: vi.fn(), read: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: f.read }));
vi.mock('../../utils/privateFile', () => ({ writePrivateFile: f.write }));
import { CodexDesktopWorkspace, type DesktopLoginIdentity } from '../CodexDesktopWorkspace';
const sourcePath = '/desktop/auth.json';
const ownedPath = '/nimbalyst/auth.json';
const user = { userId: 'owner' as DesktopLoginIdentity['userId'], email: 'owner@example.test' };
const token = (account: string, subject = 'owner', seconds = 3600) => `x.${Buffer.from(JSON.stringify({
  exp: Math.floor(Date.now() / 1000) + seconds, email: 'owner@example.test',
  'https://api.openai.com/auth': { chatgpt_user_id: subject, chatgpt_account_id: account },
})).toString('base64url')}.synthetic`;
function source(account = 'A', subject = 'owner', seconds = 3600) {
  return JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: 'must-not-copy',
    tokens: { access_token: token(account, subject, seconds), id_token: token(account, subject),
      account_id: account, refresh_token: 'desktop-refresh-secret', login_owner_id: 'desktop-only-owner' } });
}
let bridge: CodexDesktopWorkspace;
let connect: ReturnType<typeof vi.fn<(name: string, home?: string) => Promise<any>>>;
let connections: Array<{ home?: string; client: any; child: any }>;
let rejectSwitch: boolean;
beforeEach(() => {
  f.files.clear(); f.files.set(sourcePath, source());
  f.read.mockReset().mockImplementation(async (file: string) => {
    const value = f.files.get(file.replaceAll('\\', '/'));
    if (value === undefined) throw new Error('Missing fixture file'); return value;
  });
  f.write.mockReset().mockImplementation((file: string, value: string) => f.files.set(file.replaceAll('\\', '/'), value));
  connections = []; rejectSwitch = false;
  connect = vi.fn(async (_name: string, home?: string) => {
    const authPath = home ? ownedPath : sourcePath;
    const account = () => JSON.parse(f.files.get(authPath)!).tokens.account_id;
    const accounts = () => ({ activeSessionId: 'login', sessions: [{ sessionId: 'login', isActive: true,
      selectedWorkspaceAccountId: account(), userId: user.userId, email: user.email,
      workspaces: ['A', 'B'].map(accountId => ({ accountId, name: accountId, kind: 'workspace' })),
    }] });
    const client = { close: vi.fn(), request: vi.fn(async (method: string, params: any) => {
      if (method === 'account/read' && !home) { f.files.set(sourcePath, source()); return {}; }
      if (method === 'accountSession/list') return accounts();
      if (method === 'accountSession/switch') {
        if (rejectSwitch) throw new Error('Synthetic server rejection');
        const auth = JSON.parse(f.files.get(authPath)!);
        auth.tokens.access_token = token(params.accountId); auth.tokens.account_id = params.accountId;
        f.files.set(authPath, JSON.stringify(auth)); return accounts();
      }
      throw new Error(`Unexpected request ${method}`);
    }) };
    const child = { on: vi.fn(), exitCode: 0, killed: false, kill: vi.fn(), stdin: { end: vi.fn() } };
    const connection = { home, client, child }; connections.push(connection); return connection as any;
  });
  bridge = new CodexDesktopWorkspace({ sourceHome: () => '/desktop', ownedHome: () => '/nimbalyst', connect });
});
afterEach(() => { bridge.shutdown(); vi.restoreAllMocks(); });

it('offers switching only when the file login matches the account reported by native Codex', async () => {
  const account = { sessionId: 'login', isActive: true, selectedWorkspaceAccountId: 'A', userId: user.userId };
  expect(await bridge.canUse(account)).toBe(true);
  expect(await bridge.canUse({ ...account, selectedWorkspaceAccountId: 'B' })).toBe(false);
  expect(await bridge.canUse({ ...account, userId: 'another-user' })).toBe(false);
  f.files.delete(sourcePath);
  expect(await bridge.canUse(account)).toBe(false);
  expect(connect).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled();
});

it('switches inside the app home without copying Desktop refresh credentials or changing Desktop selection', async () => {
  const before = f.files.get(sourcePath);
  const selected = await bridge.get('B');
  expect(selected.account.selectedWorkspaceAccountId).toBe('B');
  expect(selected.tokens.chatgptAccountId).toBe('B');
  expect(f.files.get(sourcePath)).toBe(before);
  const seeded = JSON.parse(f.write.mock.calls[0][1]);
  expect(seeded.OPENAI_API_KEY).toBeNull();
  expect(seeded.tokens.refresh_token).toBe('');
  expect(seeded.tokens.login_owner_id).toBeUndefined();
  expect(connections[0].client.request).toHaveBeenCalledWith('accountSession/switch', {
    sessionId: 'login', accountId: 'B', allowBrowserLogin: false,
  });
  expect(connections.every(connection => connection.home === '/nimbalyst')).toBe(true);
});

it('coalesces concurrent reads and retains the selection after recreating the broker', async () => {
  const [first, second] = await Promise.all([bridge.get('B', user), bridge.get('B', user)]);
  expect(first.tokens).toEqual(second.tokens);
  expect(connect).toHaveBeenCalledTimes(1);
  bridge.shutdown();
  bridge = new CodexDesktopWorkspace({ sourceHome: () => '/desktop', ownedHome: () => '/nimbalyst', connect });
  expect((await bridge.get('B', user)).tokens.chatgptAccountId).toBe('B');
  expect(JSON.parse(f.files.get(sourcePath)!).tokens.account_id).toBe('A');
});

it('refreshes an expired source through its native owner and reapplies only the Nimbalyst selection', async () => {
  f.files.set(sourcePath, source('A', 'owner', -60));
  expect((await bridge.get('B', user)).tokens.chatgptAccountId).toBe('B');
  expect(connections[0].home).toBeUndefined();
  expect(connections[0].client.request).toHaveBeenCalledExactlyOnceWith('account/read', { refreshToken: true });
  expect(connections[0].child.kill).toHaveBeenCalled();
  expect(JSON.parse(f.files.get(sourcePath)!).tokens.account_id).toBe('A');
  expect(JSON.parse(f.files.get(ownedPath)!).tokens.refresh_token).toBe('');
});

it('reissues rejected workspace tokens without forcing a still-valid Desktop token to refresh', async () => {
  const before = f.files.get(sourcePath);
  await bridge.get('B', user);
  await bridge.get('B', user, true);
  expect(connections).toHaveLength(2);
  expect(connections.every(connection => connection.home === '/nimbalyst')).toBe(true);
  expect(f.files.get(sourcePath)).toBe(before);
});

it('rejects another Desktop user instead of silently spending a different account quota', async () => {
  await bridge.get('B', user);
  f.files.set(sourcePath, source('A', 'different-user'));
  await expect(bridge.get('B', user)).rejects.toThrow('Desktop account changed');
  expect(connect).toHaveBeenCalledTimes(1);
});

it('does not start browser login or touch the source when membership or switching fails', async () => {
  const before = f.files.get(sourcePath);
  await expect(bridge.get('missing', user)).rejects.toThrow('no longer available');
  rejectSwitch = true;
  await expect(bridge.get('B', user)).rejects.toThrow('Could not switch');
  expect(f.files.get(sourcePath)).toBe(before);
  expect(connections.flatMap(connection => connection.client.request.mock.calls).some(([method]) => method === 'account/login/start')).toBe(false);
  expect(connections.every(connection => connection.child.kill.mock.calls.length > 0)).toBe(true);
});

it('abandons queued work after shutdown before it can write a new auth snapshot', async () => {
  const pending = bridge.get('B', user);
  bridge.shutdown();
  await expect(pending).rejects.toThrow('retired');
  expect(f.write).not.toHaveBeenCalled();
});
