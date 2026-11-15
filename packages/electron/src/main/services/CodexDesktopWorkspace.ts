import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { JsonRpcClient } from '@nimbalyst/runtime/ai/server/protocols/codexAppServer/jsonRpcClient';
import type { CodexWorkspaceTokens } from '@nimbalyst/runtime/ai/server/protocols/codexAppServer/workspaceAuth';
import { writePrivateFile } from '../utils/privateFile';

export interface DesktopLoginIdentity { userId: string; email: string | null }
interface NativeAccount {
  sessionId: string; isActive: boolean; selectedWorkspaceAccountId: string | null;
  userId?: unknown; email?: string | null;
  workspaces?: Array<{ accountId: string; name: string | null; kind: string | null }>;
}
interface Accounts { activeSessionId: string | null; sessions: NativeAccount[] }
interface Connection { client: JsonRpcClient; child: ChildProcessWithoutNullStreams }
interface Source {
  identity: DesktopLoginIdentity; access: string; id: string; accountId: string; expires: number;
}
interface Selected extends Connection {
  account: NativeAccount; identity: DesktopLoginIdentity; tokens: CodexWorkspaceTokens;
}
interface Dependencies {
  sourceHome(): string;
  ownedHome(): string;
  connect(name: string, home?: string): Promise<Connection>;
}
const unavailable = 'The Desktop sign-in is unavailable. Use your email link to sign in to Nimbalyst.';
const active = (accounts: Accounts) => accounts.sessions?.find(account => account.isActive &&
  (!accounts.activeSessionId || account.sessionId === accounts.activeSessionId));
function claims(token: string): Record<string, any> {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
  catch { throw new Error(unavailable); }
}
function sameUser(a: DesktopLoginIdentity, b: DesktopLoginIdentity): boolean {
  return a.userId === b.userId;
}
async function close(connection: Connection): Promise<void> {
  const exited = connection.child.exitCode != null || connection.child.signalCode != null ? Promise.resolve() : new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Codex did not close its workspace connection.')), 3000);
    connection.child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  connection.client.close('Desktop workspace connection retired');
  connection.child.stdin.end();
  if (!connection.child.killed) connection.child.kill();
  await exited;
}

/** Reuses access tokens only. The Desktop's native store remains the sole refresh-token owner. */
export class CodexDesktopWorkspace {
  private current: (Selected & { sourceAccess: string; expires: number }) | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  constructor(private readonly dependencies: Dependencies) {}

  private async source(): Promise<Source> {
    try {
      const auth = JSON.parse(await readFile(path.join(this.dependencies.sourceHome(), 'auth.json'), 'utf8'));
      const tokens = auth.tokens;
      if (auth.auth_mode !== 'chatgpt' || typeof tokens?.access_token !== 'string' ||
          typeof tokens.id_token !== 'string' || typeof tokens.account_id !== 'string') throw new Error(unavailable);
      const token = claims(tokens.access_token);
      const subject = token['https://api.openai.com/auth']?.chatgpt_user_id;
      const email = token['https://api.openai.com/profile']?.email ?? token.email ?? claims(tokens.id_token).email;
      if (typeof subject !== 'string' || !subject || typeof token.exp !== 'number') throw new Error(unavailable);
      return { identity: { userId: subject, email: typeof email === 'string' ? email : null },
        access: tokens.access_token, id: tokens.id_token, accountId: tokens.account_id, expires: token.exp * 1000 };
    } catch { throw new Error(unavailable); }
  }

  async canUse(account: NativeAccount | undefined): Promise<boolean> {
    if (!account?.selectedWorkspaceAccountId) return false;
    try {
      const source = await this.source();
      return source.accountId === account.selectedWorkspaceAccountId &&
        source.identity.userId === account.userId;
    } catch { return false; }
  }

  get(accountId: string, identity?: DesktopLoginIdentity, force = false): Promise<Selected> {
    const generation = this.generation;
    const pending = this.queue.then(() => this.select(accountId, identity, force, generation));
    this.queue = pending.catch(() => {});
    return pending;
  }

  private async select(accountId: string, expected: DesktopLoginIdentity | undefined, force: boolean, generation: number): Promise<Selected> {
    const assertCurrent = () => { if (generation !== this.generation) throw new Error('Desktop workspace connection retired.'); };
    assertCurrent();
    let source = await this.source();
    assertCurrent();
    const identity = expected ?? source.identity;
    const assertIdentity = () => {
      if (!sameUser(source.identity, identity)) throw new Error('The Desktop account changed. Use your email link to sign in to the selected account.');
    };
    assertIdentity();
    // Refresh through the native owner of the existing login, never through a copied refresh token.
    if (source.expires <= Date.now() + 60_000) {
      const owner = await this.dependencies.connect('nimbalyst-desktop-token-refresh');
      try { assertCurrent(); await owner.client.request('account/read', { refreshToken: true }); }
      catch { throw new Error(unavailable); }
      finally { await close(owner); }
      source = await this.source();
      assertIdentity();
      if (source.expires <= Date.now() + 60_000) throw new Error(unavailable);
    }
    assertCurrent();
    if (!force && this.current?.account.selectedWorkspaceAccountId === accountId &&
        this.current.sourceAccess === source.access && this.current.expires > Date.now() + 60_000) return this.current;
    if (this.current) { const previous = this.current; this.current = undefined; await close(previous); }
    assertCurrent();
    const home = this.dependencies.ownedHome();
    writePrivateFile(path.join(home, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt', OPENAI_API_KEY: null,
      tokens: { id_token: source.id, access_token: source.access, account_id: source.accountId, refresh_token: '' },
      last_refresh: new Date().toISOString(),
    }));
    const connection = await this.dependencies.connect('nimbalyst-desktop-workspace', home);
    try {
      assertCurrent();
      let account = active(await connection.client.request<Accounts>('accountSession/list', { refreshWorkspaceMetadata: false }));
      if (!account || account.selectedWorkspaceAccountId !== source.accountId) throw new Error(unavailable);
      if (accountId !== source.accountId) {
        account = active(await connection.client.request<Accounts>('accountSession/list', { refreshWorkspaceMetadata: true }));
        if (!account?.workspaces?.some(workspace => workspace.accountId === accountId)) {
          throw new Error('This workspace is no longer available to the Desktop account.');
        }
        let result: Accounts | { login_id: string };
        try {
          result = await connection.client.request('accountSession/switch', {
            sessionId: account.sessionId, accountId, allowBrowserLogin: false,
          });
        } catch { throw new Error('Could not switch using the Desktop sign-in. Use your email link if this workspace requires sign-in.'); }
        if ('login_id' in result) throw new Error('This workspace requires sign-in. Use your email link to continue.');
        account = active(result);
      }
      if (account?.selectedWorkspaceAccountId !== accountId) throw new Error('Codex did not select the requested workspace.');
      const saved = JSON.parse(await readFile(path.join(home, 'auth.json'), 'utf8'));
      const token = saved.tokens?.access_token;
      if (typeof token !== 'string' || saved.tokens?.account_id !== accountId ||
          claims(token)['https://api.openai.com/auth']?.chatgpt_user_id !== identity.userId ||
          !(claims(token).exp * 1000 > Date.now())) throw new Error(unavailable);
      assertCurrent();
      const selected = { ...connection, account, identity, tokens: { accessToken: token, chatgptAccountId: accountId } };
      this.current = { ...selected, sourceAccess: source.access, expires: claims(token).exp * 1000 };
      connection.child.on('exit', () => { if (this.current?.client === connection.client) this.current = undefined; });
      return selected;
    } catch (error) { await close(connection); throw error; }
  }

  shutdown(): void {
    this.generation++;
    const closing = this.current ? close(this.current) : Promise.resolve();
    this.current = undefined;
    this.queue = Promise.allSettled([this.queue, closing]);
  }
}
