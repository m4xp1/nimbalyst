// @vitest-environment node
import {expect,it,vi} from 'vitest';
import {memorySourceChanges} from '@nimbalyst/runtime/store/atoms/memorySources';
import {initMemoryStatusListeners} from '../memoryStatusListeners';

it('routes one host IPC listener to shared consumers and unsubscribes once',()=>{
  const off=vi.fn(),on=vi.fn(()=>off),receive=vi.fn();
  vi.stubGlobal('window',{electronAPI:{on}});
  const unsubscribe=memorySourceChanges.subscribeStatus(receive),stop=initMemoryStatusListeners();
  try{
    const duplicate=initMemoryStatusListeners();expect(on).toHaveBeenCalledTimes(1);
    const callback=(on.mock.calls as any)[0][1];
    callback({workspacePath:'/main',areas:['status','unknown']});expect(receive).toHaveBeenCalledWith({workspacePath:'/main',areas:['status']});
    callback({areas:['status']});expect(receive).toHaveBeenCalledTimes(1);
    duplicate();expect(off).not.toHaveBeenCalled();
  }finally{stop();unsubscribe();vi.unstubAllGlobals();}
  expect(off).toHaveBeenCalledTimes(1);
});
