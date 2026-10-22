// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { createGit } from '../gitClient';
import { gitSandboxEnv, assertGitSandbox } from '../testSupport/gitTestSandbox';
import { fetchGitSyncRefs, GitRemoteRefresher, readGitSyncCounts, resolveGitPush, resolveGitSyncTargets } from '../GitSyncService';
let root: string, repo: string, bare: string, external: string;
let sequence = 0;
const cli = (cwd: string, args: string[]) => {
  if (args[0] !== 'init' && args[0] !== 'clone' && cwd !== root && cwd !== bare) assertGitSandbox(cwd, root);
  return execFileSync('git', args, {cwd, env:gitSandboxEnv(root), encoding:'utf8'}).trim();
};
const commit = (cwd: string) => { writeFileSync(path.join(cwd,'fixture.txt'),String(++sequence)); cli(cwd,['add','fixture.txt']); cli(cwd,['-c','user.name=Test User','-c','user.email=test@example.com','-c','commit.gpgsign=false','commit','-qm','artificial '+sequence]); };
const git = () => createGit(repo, {}, gitSandboxEnv(root));
const targets = () => resolveGitSyncTargets(git(), 'main');
const counts = async () => readGitSyncCounts(git(), await targets());
beforeAll(() => {
 root=mkdtempSync(path.join(os.tmpdir(),'nim-sync-test-')); repo=path.join(root,'local'); bare=path.join(root,'remote.git'); external=path.join(root,'external');
 mkdirSync(repo); cli(root,['init','--bare',bare]);cli(repo,['init','-b','main']);commit(repo);
 cli(repo,['remote','add','origin',bare]);cli(repo,['remote','add','helper',bare]);cli(repo,['push','-u','helper','main']);cli(repo,['fetch','origin']);
 cli(root,['clone','-b','main',bare,external]);
 vi.stubEnv('GIT_CONFIG_GLOBAL',path.join(root,'absent-global'));vi.stubEnv('GIT_CONFIG_SYSTEM',path.join(root,'absent-system'));
},60000);
afterAll(() => { vi.unstubAllEnvs(); rmSync(root,{recursive:true,force:true}); });

describe.sequential('real current-branch sync refs in artificial repositories',()=>{
 it('two aliases: one Push clears ahead without Pull; external changes populate behind without merging',async()=>{
  commit(repo);expect(await counts()).toMatchObject({ahead:1,behind:0});
  const push=await resolveGitPush(git(),'main');expect(push).toEqual({remote:'helper',refspec:'main'});
  cli(repo,['push','--',push.remote,push.refspec]);expect(await counts()).toMatchObject({ahead:0,behind:0});
  cli(external,['pull','--ff-only']);commit(external);cli(external,['push']);const head=cli(repo,['rev-parse','HEAD']);
  await fetchGitSyncRefs(repo,await targets());expect(cli(repo,['rev-parse','HEAD'])).toBe(head);expect(await counts()).toMatchObject({ahead:0,behind:1});
  commit(repo);expect(await counts()).toMatchObject({ahead:1,behind:1});
 },60000);
 it('pushRemote and pushDefault select the outgoing alias independently of Pull',async()=>{
  cli(repo,['config','remote.pushDefault','origin']);expect(await resolveGitPush(git(),'main')).toMatchObject({remote:'origin'});
  cli(repo,['config','branch.main.pushRemote','helper']);expect(await resolveGitPush(git(),'main')).toMatchObject({remote:'helper'});
  cli(repo,['config','branch.main.pushRemote','origin']);expect((await targets()).pull.remote).toBe('helper');
  cli(repo,['config','--unset','branch.main.pushRemote']);cli(repo,['config','--unset','remote.pushDefault']);
 });
 it('counts outgoing against a different push repository and incoming against Pull upstream',async()=>{
  const fork=path.join(root,'fork.git');cli(root,['init','--bare',fork]);cli(repo,['remote','add','fork',fork]);cli(repo,['push','fork','main']);
  cli(repo,['config','branch.main.pushRemote','fork']);expect(await counts()).toMatchObject({ahead:0,behind:1});commit(repo);expect(await counts()).toMatchObject({ahead:1,behind:1});
  cli(repo,['config','--unset','branch.main.pushRemote']);
 },60000);
 it('respects differently named upstream, push.default, and explicit current-branch mapping',async()=>{
  cli(repo,['config','branch.main.merge','refs/heads/different']);
  await expect(resolveGitPush(git(),'main')).rejects.toThrow(/differs/);
  cli(repo,['config','push.default','upstream']);expect(await resolveGitPush(git(),'main')).toMatchObject({remote:'helper',refspec:'refs/heads/main:refs/heads/different'});
  cli(repo,['config','push.default','current']);expect(await resolveGitPush(git(),'main')).toMatchObject({refspec:'main'});
  cli(repo,['config','push.default','nothing']);await expect(resolveGitPush(git(),'main')).rejects.toThrow(/nothing/);
  cli(repo,['config','remote.helper.push','refs/heads/main:refs/heads/destination']);expect(await resolveGitPush(git(),'main')).toMatchObject({refspec:'refs/heads/main:refs/heads/destination'});
  cli(repo,['config','--unset','remote.helper.push']);cli(repo,['config','--unset','push.default']);cli(repo,['config','branch.main.merge','refs/heads/main']);
 });
 it('marks differing push URLs and ambiguous/matching config unavailable instead of false in-sync',async()=>{
  cli(repo,['config','remote.helper.pushurl',path.join(root,'different.git')]);
  const result=await readGitSyncCounts(git(),await targets());expect(result.push.available).toBe(false);expect(result.push.reason).toMatch(/Push URL/);expect(result.pull.available).toBe(true);
  cli(repo,['config','--unset','remote.helper.pushurl']);cli(repo,['config','push.default','matching']);await expect(resolveGitPush(git(),'main')).rejects.toThrow(/Matching/);cli(repo,['config','--unset','push.default']);
  cli(repo,['config','remote.helper.push','HEAD:refs/heads/main']);expect(await resolveGitPush(git(),'main')).toMatchObject({refspec:'main'});cli(repo,['config','--unset','remote.helper.push']);
 });
 it('does not invent zero counts for a missing ref, missing upstream or detached HEAD',async()=>{
  const resolved=await resolveGitSyncTargets(git(),'unpublished');expect(resolved.pull.available).toBe(false);
  const result=await readGitSyncCounts(git(),resolved);expect(result.push.available).toBe(false);
  expect(await resolveGitSyncTargets(git(),'HEAD')).toMatchObject({push:{available:false},pull:{available:false}});
 });
 it('keeps worktree refs and nested/attached repository config independent',async()=>{
  const worktree=path.join(root,'worktree');cli(repo,['worktree','add','-b','topic',worktree]);
  cli(worktree,['config','branch.topic.remote','origin']);cli(worktree,['config','branch.topic.merge','refs/heads/main']);cli(worktree,['config','push.default','upstream']);
  expect(await resolveGitPush(createGit(worktree,{},gitSandboxEnv(root)),'topic')).toEqual({remote:'origin',refspec:'refs/heads/topic:refs/heads/main'});
  cli(repo,['config','--unset','push.default']);
  const nested=path.join(repo,'nested');mkdirSync(nested);cli(nested,['init','-b','inner']);commit(nested);
  const inner=await resolveGitSyncTargets(createGit(nested,{},gitSandboxEnv(root)),'inner');expect(inner.push.remote).toBeUndefined();expect(inner.pull.remote).toBeUndefined();expect((await targets()).pull.remote).toBe('helper');
 },60000);
 it('coalesces checking, enforces TTL and retains verified time on a safe fetch error',async()=>{
  let now=100000, release!:()=>void;const changed=vi.fn(async()=>{});
  const fetch=vi.fn(async()=>{await new Promise<void>(resolve=>release=resolve);});
  const service=new GitRemoteRefresher(changed,fetch,()=>now);
  const first=service.request(repo),second=service.request(repo);expect(first).toBe(second);
  await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(1));expect(service.status(repo,await targets()).freshness).toBe('checking');
  release();await first;expect(service.status(repo,await targets())).toMatchObject({freshness:'fresh',checkedAt:now});
  await service.request(repo);expect(fetch).toHaveBeenCalledTimes(1);
  now+=60001;fetch.mockRejectedValueOnce(new Error('secret credential URL must not reach UI'));await service.request(repo);
  expect(service.status(repo,await targets())).toMatchObject({freshness:'error',checkedAt:100000});expect(service.status(repo,await targets()).error).not.toContain('secret');
 },60000);
});
