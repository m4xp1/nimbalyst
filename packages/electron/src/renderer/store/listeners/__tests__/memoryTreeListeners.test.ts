// @vitest-environment node
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {store} from '@nimbalyst/runtime/store';
import {initMemoryTreeListeners,changeMemoryTreeRule} from '../memoryTreeListeners';
import {memoryTreeAvailableAtom,memoryTreeIncludedAtom} from '../../atoms/memoryTree';
let stop:()=>void=()=>{};
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{stop();vi.useRealTimers();vi.unstubAllGlobals();});
describe('workspace-scoped Memory tree cache',()=>{
 it('uses one backend snapshot for many icons and hides participation when Memory is disabled',async()=>{
  let enabled=true;
  const invoke=vi.fn(async(channel:string,...args:any[])=>channel==='extensions:get-enabled'?enabled:args[0]?.toolName==='memory.get_tree_index_state'?{revision:'one',files:['C:/Main/CLAUDE.md'],directories:['C:/Main']}:{});
  vi.stubGlobal('window',{electronAPI:{invoke}});stop=initMemoryTreeListeners('C:/Main');
  await vi.advanceTimersByTimeAsync(0);
  expect(store.get(memoryTreeAvailableAtom)).toBe(true);
  for(let i=0;i<100;i++)expect(store.get(memoryTreeIncludedAtom('c:\\main\\CLAUDE.md'))).toBe(true);
  expect(invoke.mock.calls.filter(([c])=>c==='extensions:ai-call-backend-tool')).toHaveLength(1);
  await changeMemoryTreeRule('C:/Main/docs','exclude');
  expect(invoke).toHaveBeenCalledWith('extensions:ai-call-backend-tool',{toolName:'memory.set_path_override',args:{path:'C:/Main/docs',mode:'exclude'},workspacePath:'C:/Main',callerExtensionId:'com.nimbalyst.memory'});
  enabled=false;await vi.advanceTimersByTimeAsync(2000);
  expect(store.get(memoryTreeAvailableAtom)).toBe(false);expect(store.get(memoryTreeIncludedAtom('C:/Main/CLAUDE.md'))).toBe(false);
 });
 it('does not restore the previous workspace when its delayed response arrives',async()=>{
  let release!:(value:any)=>void;const old=new Promise(resolve=>release=resolve);
  const invoke=vi.fn(async(channel:string,payload:any)=>channel==='extensions:get-enabled'?true:payload.workspacePath==='/old'?old:{revision:'new',files:['/new/docs/a.md'],directories:['/new/docs']});
  vi.stubGlobal('window',{electronAPI:{invoke}});stop=initMemoryTreeListeners('/old');await vi.advanceTimersByTimeAsync(0);stop();
  stop=initMemoryTreeListeners('/new');await vi.advanceTimersByTimeAsync(0);
  release({revision:'old',files:['/old/private.md'],directories:['/old']});await vi.advanceTimersByTimeAsync(0);
  expect(store.get(memoryTreeIncludedAtom('/new/docs/a.md'))).toBe(true);expect(store.get(memoryTreeIncludedAtom('/old/private.md'))).toBe(false);
 });
});
