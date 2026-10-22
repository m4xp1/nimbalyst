import type { SimpleGit } from 'simple-git';
import { realpathSync } from 'fs';
import { simpleGitReadOnly } from './gitReadOnly';
import { createGit } from './gitClient';
import { getGitSubprocessEnv } from './gitEnv';
import { validateGitOperand } from './gitOperandValidation';
import type { GitSyncStatus, GitSyncTarget } from '../../shared/gitSync';

export interface GitSyncTargets { push: GitSyncTarget; pull: GitSyncTarget; }
const unavailable = (reason: string): GitSyncTarget => ({ available: false, reason });

/** Map one branch through Git's configured fetch/push refspec, including wildcards. */
function mapRef(source: string, spec: string): string | undefined {
  const [from, to, extra] = spec.replace(/^\+/, '').split(':');
  if (!from || !to || extra !== undefined || from.startsWith('^')) return;
  if (!from.includes('*')) return source === from ? to : undefined;
  const [prefix, suffix] = from.split('*');
  if (!source.startsWith(prefix) || !source.endsWith(suffix)) return;
  return to.replace('*', source.slice(prefix.length, source.length - suffix.length || undefined));
}

/** Resolve only the current branch; never turn a toolbar click into a multi-branch push. */
export async function resolveGitSyncTargets(git: SimpleGit, branch: string): Promise<GitSyncTargets> {
  if (!branch || branch === 'HEAD') return { push: unavailable('Detached HEAD'), pull: unavailable('Detached HEAD') };
  validateGitOperand(branch, 'branch');
  const raw = await git.raw(['config', '--null', '--list']);
  const config = new Map<string, string[]>();
  for (const entry of raw.split('\0')) {
    const separator = entry.indexOf('\n');
    if (separator < 0) continue;
    const key = entry.slice(0, separator), value = entry.slice(separator + 1);
    config.set(key, [...(config.get(key) ?? []), value]);
  }
  const last = (key: string) => { const values = config.get(key); return values?.[values.length - 1]; };
  const remotes = [...config.keys()].filter(key => key.startsWith('remote.') && key.endsWith('.url')).map(key => key.slice(7, -4));
  const pullRemote = last('branch.' + branch + '.remote');
  const merges = config.get('branch.' + branch + '.merge') ?? [];
  const pullRef = merges.length === 1 ? merges[0] : undefined;
  const tracking = (remote: string, ref: string) => remote === '.' ? ref
    : (() => {
      const specs = config.get('remote.' + remote + '.fetch') ?? [];
      if (specs.some(spec => spec.startsWith('^') && mapRef(ref, spec.slice(1) + ':' + spec.slice(1)))) return;
      const refs = [...new Set(specs.map(spec => mapRef(ref, spec)).filter((value): value is string => !!value && value.startsWith('refs/')))];
      return refs.length === 1 ? refs[0] : undefined;
    })();
  const target = (remote: string, ref: string): GitSyncTarget => ({ remote, branch: ref.replace(/^refs\/heads\//, ''), trackingRef: tracking(remote, ref), available: false });
  const pull = pullRemote && pullRef ? target(pullRemote, pullRef) : unavailable('No single Pull upstream configured');
  const pushRemote = last('branch.' + branch + '.pushremote') ?? last('remote.pushdefault') ?? pullRemote
    ?? (remotes.length === 1 ? remotes[0] : remotes.includes('origin') ? 'origin' : undefined);
  if (!pushRemote) return { pull, push: unavailable('No Push remote configured') };
  validateGitOperand(pushRemote, 'remote');
  let pushRef: string | undefined;
  let reason: string | undefined;
  const configuredPush = config.get('remote.' + pushRemote + '.push');
  if (configuredPush?.length) {
    const refs = configuredPush.map(spec => mapRef('refs/heads/' + branch, spec) ?? mapRef(branch, spec) ?? mapRef('HEAD', spec)
      ?? (spec.replace(/^\+/, '') === branch || spec.replace(/^\+/, '') === 'refs/heads/' + branch ? 'refs/heads/' + branch : undefined)).filter((ref): ref is string => !!ref);
    if (refs.length === 1) pushRef = refs[0];
    else reason = 'No unambiguous current-branch Push refspec';
  } else {
    const mode = last('push.default') ?? 'simple';
    if (mode === 'nothing') reason = 'push.default=nothing';
    else if (mode === 'upstream') {
      if (pullRemote === pushRemote && pullRef) pushRef = pullRef;
      else reason = 'Push upstream is unavailable for this remote';
    } else if (mode === 'simple' && pushRemote === pullRemote && pullRef && pullRef !== 'refs/heads/' + branch) {
      reason = 'Push branch name differs from upstream (push.default=simple)';
    } else if (mode === 'matching') reason = 'Matching Push spans branches; use an explicit current-branch refspec';
    else if (['simple', 'current'].includes(mode)) pushRef = 'refs/heads/' + branch;
    else reason = 'Unsupported push.default';
  }
  if (!pushRef?.startsWith('refs/heads/')) return { pull, push: { ...unavailable(reason ?? 'Push target is not a branch'), remote: pushRemote } };
  validateGitOperand(pushRef, 'branch');
  const push = target(pushRemote, pushRef);
  const pushUrls = config.get('remote.' + pushRemote + '.pushurl');
  const fetchUrls = config.get('remote.' + pushRemote + '.url') ?? [];
  if (pushUrls?.some(url => url !== fetchUrls[0])) {
    push.trackingRef = undefined; push.reason = 'Push URL differs from fetch URL; local tracking ref cannot verify destination';
  }
  if (last('remote.' + pushRemote + '.mirror') === 'true') {
    return { pull, push: { ...unavailable('Mirror remote cannot be used for a current-branch toolbar Push'), remote: pushRemote } };
  }
  return { pull, push };
}

export async function readGitSyncCounts(git: SimpleGit, targets: GitSyncTargets): Promise<{ ahead: number; behind: number; push: GitSyncTarget; pull: GitSyncTarget }> {
  const count = async (target: GitSyncTarget, direction: 'ahead' | 'behind') => {
    if (!target.trackingRef) return { value: 0, target: { ...target, available: false, reason: target.reason ?? 'No local tracking ref' } };
    try {
      const range = direction === 'ahead' ? target.trackingRef + '..HEAD' : 'HEAD..' + target.trackingRef;
      const value = Number((await git.raw(['rev-list', '--count', range, '--'])).trim());
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid count');
      return { value, target: { ...target, available: true } };
    } catch { return { value: 0, target: { ...target, available: false, reason: 'Tracking branch unavailable locally' } }; }
  };
  const [push, pull] = await Promise.all([count(targets.push, 'ahead'), count(targets.pull, 'behind')]);
  return { ahead: push.value, behind: pull.value, push: push.target, pull: pull.target };
}

/** Native Git selection, pinned to one explicit branch so config cannot push others. */
export async function resolveGitPush(git: SimpleGit, branch: string, remote?: string, setUpstream?: boolean): Promise<{ remote: string; refspec: string }> {
  if (remote !== undefined) return { remote, refspec: branch };
  const { push } = await resolveGitSyncTargets(git, branch);
  if (!push.remote) throw new Error(push.reason ?? 'Push target unavailable');
  if (setUpstream) return { remote: push.remote, refspec: branch };
  if (!push.branch) throw new Error(push.reason ?? 'Push target unavailable');
  const destination = 'refs/heads/' + push.branch;
  return { remote: push.remote, refspec: push.branch === branch ? branch : 'refs/heads/' + branch + ':' + destination };
}

interface Freshness { signature: string; attemptedAt: number; checkedAt?: number; error?: string; checking: boolean; }
export class GitRemoteRefresher {
  private readonly states = new Map<string, Freshness>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly requeued = new Set<string>();
  constructor(private readonly changed: (repo: string) => Promise<void>,
    private readonly fetchRefs: (repo: string, targets: GitSyncTargets) => Promise<void> = fetchGitSyncRefs,
    private readonly now: () => number = Date.now) {}
  private key(repo: string) { try { return realpathSync.native(repo); } catch { return repo; } }
  status(repo: string, targets: GitSyncTargets): Pick<GitSyncStatus, 'freshness' | 'checkedAt' | 'error'> {
    const state = this.states.get(this.key(repo));
    if (!state || state.signature !== JSON.stringify(targets)) return { freshness: 'local' };
    return { freshness: state.checking ? 'checking' : state.error ? 'error' : 'fresh', checkedAt: state.checkedAt, error: state.error };
  }
  request(repo: string): Promise<void> {
    const key = this.key(repo), running = this.running.get(key);
    if (running) { this.requeued.add(key); return running; }
    const task = this.refresh(repo, key).finally(() => {
      this.running.delete(key);
      if (this.requeued.delete(key)) void this.request(repo).catch(() => undefined);
    });
    this.running.set(key, task); return task;
  }
  private async refresh(repo: string, key: string): Promise<void> {
    const git = simpleGitReadOnly(repo);
    const branch = (await git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();
    if (!branch) return;
    const targets = await resolveGitSyncTargets(git, branch), signature = JSON.stringify(targets);
    if (![targets.push, targets.pull].some(target => target.remote && target.remote !== '.' && target.branch && target.trackingRef)) return;
    const previous = this.states.get(key);
    if (previous?.signature === signature && this.now() - previous.attemptedAt < 60000) return;
    const state: Freshness = { signature, attemptedAt: this.now(), checkedAt: previous?.signature === signature ? previous.checkedAt : undefined, checking: true };
    this.states.set(key, state); await this.changed(repo);
    try { await this.fetchRefs(repo, targets); state.checkedAt = this.now(); }
    catch { state.error = 'Could not check configured remote branches. Check network, credentials and remote access.'; }
    finally { state.checking = false; await this.changed(repo); }
  }
}

/** Fetch just the two directional refs. No HEAD/index/config writes or merge, no credential prompts. */
export async function fetchGitSyncRefs(repo: string, targets: GitSyncTargets): Promise<void> {
  const env = { ...getGitSubprocessEnv(), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never' };
  const git = createGit(repo, { timeout: { block: 30000, stdErr: false, stdOut: false } }, env);
  const remotes = new Map<string, Set<string>>();
  for (const target of [targets.push, targets.pull]) {
    if (!target.remote || target.remote === '.' || !target.branch || !target.trackingRef) continue;
    validateGitOperand(target.remote, 'remote'); validateGitOperand(target.trackingRef, 'ref');
    if (!target.trackingRef.startsWith('refs/remotes/')) throw new Error('Background fetch requires a remote-tracking namespace');
    const refs = remotes.get(target.remote) ?? new Set<string>();
    refs.add('+refs/heads/' + target.branch + ':' + target.trackingRef); remotes.set(target.remote, refs);
  }
  let failed = false;
  for (const [remote, refs] of remotes) {
    try { await git.raw(['fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--', remote, ...refs]); }
    catch { failed = true; }
  }
  if (failed) throw new Error('Remote branch check failed');
}
