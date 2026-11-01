// @vitest-environment node
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import path from 'node:path';
const fake=vi.hoisted(()=>({state:{} as any,blocked:false,release:[] as Array<()=>void>}));
vi.mock('../store',()=>({getWorkspaceState:()=>fake.state,updateWorkspaceState:(_workspace:string,apply:(state:any)=>void)=>{apply(fake.state);return fake.state;}}));
vi.mock('node:fs/promises',()=>({realpath:vi.fn(async(value:string)=>value),stat:vi.fn(async()=>{if(fake.blocked)await new Promise<void>(resolve=>fake.release.push(resolve));return{isDirectory:()=>true};})}));
beforeEach(()=>{fake.state={};fake.blocked=false;fake.release=[];vi.useFakeTimers();vi.setSystemTime(10000);});
afterEach(()=>{for(const release of fake.release)release();vi.useRealTimers();vi.restoreAllMocks();});
describe('Memory configured roots and availability diagnostics',()=>{
 it('preserves all identities on timeout, logs the incomplete stage and later recovery without raw paths',async()=>{
  const log=vi.spyOn(console,'info').mockImplementation(()=>{});const {memorySourceRoots}=await import('../memorySourceRoots');
  const main=path.resolve('C:/synthetic-roots/main'),attached=path.resolve('C:/synthetic-roots/attached');
  const first=await memorySourceRoots(main,[main,attached]);expect(first.map(row=>row.available)).toEqual([true,true]);
  fake.blocked=true;await vi.advanceTimersByTimeAsync(1100);await memorySourceRoots(main,[main,attached]);await vi.advanceTimersByTimeAsync(1100);
  const failed=await memorySourceRoots(main,[main,attached]);expect(failed.map(row=>row.id)).toEqual(first.map(row=>row.id));expect(failed.every(row=>!row.available)).toBe(true);
  const events=log.mock.calls.map(([,value])=>JSON.parse(String(value)));expect(events).toContainEqual(expect.objectContaining({event:'result',stage:'stat',code:'TIMEOUT',deadlineMs:1000,available:false}));
  expect(JSON.stringify(events)).not.toContain('synthetic-roots');
  fake.blocked=false;for(const release of fake.release)release();await vi.advanceTimersByTimeAsync(0);await vi.advanceTimersByTimeAsync(1100);await memorySourceRoots(main,[main,attached]);await vi.advanceTimersByTimeAsync(0);
  const restored=await memorySourceRoots(main,[main,attached]);expect(restored.map(row=>row.id)).toEqual(first.map(row=>row.id));expect(restored.every(row=>row.available)).toBe(true);
  expect(log.mock.calls.some(([,value])=>JSON.parse(String(value)).event==='late-result')).toBe(true);
 });
 it('restores saved identities and exposes an explicit reattachment revision',async()=>{
  vi.spyOn(console,'info').mockImplementation(()=>{});const {memorySourceRoots}=await import('../memorySourceRoots');const main=path.resolve('C:/synthetic-roots/restart'),attached=path.resolve('C:/synthetic-roots/restart-attached');
  const prior={id:'attached-stable',path:attached,treePaths:[attached]};fake.state={memoryRootIdentities:[prior],memoryAttachmentEpochs:{[attached]:7}};
  const result=await memorySourceRoots(main,[main,attached]);expect(result[1]).toMatchObject({id:prior.id,attachmentRevision:7});
 });
});
