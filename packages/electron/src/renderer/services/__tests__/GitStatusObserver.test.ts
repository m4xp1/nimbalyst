import { describe, expect, it, vi } from 'vitest';
import { watchGitStatus } from '../GitStatusObserver';
const deferred = <T,>() => {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
const status={branch:'main',ahead:1,behind:0,hasUncommitted:false};
function fixture() {
 let event!:(value:any)=>void;const stop=vi.fn();
 const initial=deferred<unknown>();
 const invoke=vi.fn(async(channel:string)=>channel==='git:status'?initial.promise:undefined);
 const onStatusChanged=vi.fn((listener:any)=>{event=listener;return stop;});
 const api={invoke,git:{onStatusChanged}} as unknown as Window['electronAPI'];
 return {api,invoke,initial,stop,onStatusChanged,event:(value:any)=>event(value)};
}
describe('shared revisioned Git snapshot',()=>{
 it('shares one read/subscription and rejects an older response after a post-Push snapshot',async()=>{
  const f=fixture(),title=vi.fn(),panel=vi.fn();
  const a=watchGitStatus(f.api,'C:/workspace/repo',title),b=watchGitStatus(f.api,'c:\\workspace\\repo',panel);
  expect(f.onStatusChanged).toHaveBeenCalledTimes(1);expect(f.invoke.mock.calls.filter(([c])=>c==='git:status')).toHaveLength(1);
  f.event({workspacePath:'C:/workspace/repo',revision:2,status:{...status,ahead:0}});
  f.initial.resolve(status);await a.refresh();
  expect(title).toHaveBeenLastCalledWith({...status,ahead:0});expect(panel).toHaveBeenLastCalledWith({...status,ahead:0});
  f.event({workspacePath:'C:/workspace/repo',revision:1,status});expect(title).toHaveBeenCalledTimes(1);
  a.dispose();expect(f.stop).not.toHaveBeenCalled();b.dispose();expect(f.stop).toHaveBeenCalledOnce();
 });
 it('ignores other repositories and disposed reads, refreshes refs on focus',async()=>{
  const f=fixture(),listen=vi.fn();const a=watchGitStatus(f.api,'/primary',listen);
  f.event({workspacePath:'/primary/nested',revision:100,status});expect(listen).not.toHaveBeenCalled();
  const before=f.invoke.mock.calls.length;window.dispatchEvent(new Event('focus'));expect(f.invoke.mock.calls.slice(before)).toEqual([['git:sync-refresh','/primary']]);
  a.dispose();f.initial.resolve(status);await a.refresh();expect(listen).not.toHaveBeenCalled();
 });
 it('a legacy invalidation supersedes the pending initial read',async()=>{
  const f=fixture(),listen=vi.fn();const next=deferred<unknown>();const a=watchGitStatus(f.api,'/repo',listen);
  f.invoke.mockImplementationOnce(async()=>next.promise);f.event({workspacePath:'/repo'});
  next.resolve({...status,behind:2});await vi.waitFor(()=>expect(listen).toHaveBeenLastCalledWith({...status,behind:2}));
  f.initial.resolve(status);await new Promise(resolve=>setTimeout(resolve,0));expect(listen).toHaveBeenCalledTimes(1);a.dispose();
 });
});
