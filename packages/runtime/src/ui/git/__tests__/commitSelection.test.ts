// @vitest-environment node
import{describe,it,expect}from'vitest';import{eligibleCommitPaths,selectedCommitPaths}from'../commitSelection';
describe('shared commit eligibility',()=>{
 it('commits only the one changed visible file out of eleven history paths',()=>{const files=Array.from({length:11},(_,i)=>'/repo/file-'+i);expect(eligibleCommitPaths(files,[files[3]],['/repo'],'/repo')).toEqual([files[3]]);expect(selectedCommitPaths(files,files,[files[3]],['/repo'],'/repo')).toEqual([files[3]]);});
 it('keeps attached/nested repositories separate from outside and invisible changes',()=>{const all=['/repo/nested/a','/attached/b','/outside/c','/repo/hidden'];expect(selectedCommitPaths(all,all.slice(0,3),all,['/repo','/attached'],'/repo')).toEqual(['/repo/nested/a','/attached/b']);});
 it('deduplicates Windows separators/case and resolves worktree-relative paths without escaping its roots',()=>{expect(selectedCommitPaths(['c:\\Repo\\A.md','C:/Repo/a.md','../outside.md'],['C:/Repo/A.md','C:/Repo/../outside.md'],['A.md','C:/outside.md'],['C:/Repo'],'C:/Repo')).toEqual(['C:/Repo/A.md']);expect(eligibleCommitPaths(['src/a.md','../outside.md'],['src/a.md','../outside.md'],['/tmp/tree'],'/tmp/tree')).toEqual(['src/a.md']);});
});

it('reconciles a fresh session status without losing dirty files outside that response',async()=>{
 const {reconcileCommitStatus}=await import('../commitSelection');
 const result=reconcileCommitStatus(['C:/repo/old.txt','C:/attached/staged.txt'],{'old.txt':{status:'unchanged'},'new.txt':{status:'modified'}},'C:/repo');
 expect(result).toEqual(['C:/attached/staged.txt','C:/repo/new.txt']);
});
