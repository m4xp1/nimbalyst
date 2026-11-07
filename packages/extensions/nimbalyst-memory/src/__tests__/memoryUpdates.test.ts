// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {memorySourceChanges} from '../../../../runtime/src/store/atoms/memorySources';
import {subscribeMemoryUpdates} from '../components/memoryUpdates';

const cleanups:Array<()=>void>=[];
afterEach(()=>{for(const stop of cleanups.splice(0).reverse())stop();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('coalesces same-workspace invalidations, repeats once after an in-flight snapshot and disposes queued work',async()=>{
  vi.useFakeTimers();let release!:()=>void;
  const refresh=vi.fn(async()=>{if(refresh.mock.calls.length===2)await new Promise<void>(resolve=>release=resolve);});
  const stop=subscribeMemoryUpdates('C:/main',['status'],refresh);cleanups.push(stop);
  await vi.advanceTimersByTimeAsync(0);expect(refresh).toHaveBeenCalledTimes(1);
  const changed=(workspacePath='c:\\MAIN',areas:Array<'status'|'sources'|'usage'>=['status'])=>memorySourceChanges.publishStatus({workspacePath,areas});
  changed('/foreign');changed('C:/main',['usage']);await vi.advanceTimersByTimeAsync(10000);expect(refresh).toHaveBeenCalledTimes(1);
  for(let i=0;i<30;i++)changed();await vi.advanceTimersByTimeAsync(100);expect(refresh).toHaveBeenCalledTimes(2);
  for(let i=0;i<30;i++)changed();await vi.advanceTimersByTimeAsync(1000);expect(refresh).toHaveBeenCalledTimes(2);
  release();await vi.advanceTimersByTimeAsync(100);expect(refresh).toHaveBeenCalledTimes(3);
  changed();stop();await vi.advanceTimersByTimeAsync(10000);changed();expect(refresh).toHaveBeenCalledTimes(3);
});
it('does no reads while hidden and rejects old replies across visibility changes or disposal',async()=>{
  vi.useFakeTimers();let visibility:DocumentVisibilityState='hidden';
  vi.spyOn(document,'visibilityState','get').mockImplementation(()=>visibility);
  let release!:()=>void;const writes:number[]=[];
  const refresh=vi.fn(async(isCurrent:()=>boolean)=>{const count=refresh.mock.calls.length;await new Promise<void>(resolve=>release=resolve);if(isCurrent())writes.push(count);});
  const stop=subscribeMemoryUpdates('/main',['status'],refresh);cleanups.push(stop);
  memorySourceChanges.publishStatus({workspacePath:'/main',areas:['status']});await vi.advanceTimersByTimeAsync(10000);expect(refresh).not.toHaveBeenCalled();
  visibility='visible';document.dispatchEvent(new Event('visibilitychange'));expect(refresh).toHaveBeenCalledTimes(1);
  visibility='hidden';document.dispatchEvent(new Event('visibilitychange'));release();await vi.advanceTimersByTimeAsync(1000);expect(writes).toEqual([]);
  visibility='visible';document.dispatchEvent(new Event('visibilitychange'));expect(refresh).toHaveBeenCalledTimes(2);
  stop();release();await vi.advanceTimersByTimeAsync(1000);expect(writes).toEqual([]);
});
