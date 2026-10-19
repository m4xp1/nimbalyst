import {treePolicyIncludes} from '../../../../../../extensions/nimbalyst-memory/engine/src/ruleProgram';
// @vitest-environment node
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {store,memorySourceChangeAtom} from '@nimbalyst/runtime/store';
import {rawFileTreeAtom} from '../../atoms/fileTree';
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


describe('durable Memory rule acknowledgement',()=>{
 it('publishes the acknowledged tree without waiting for a refresh and retains it through a transient backend error',async()=>{
  let fail=false;
  const invoke=vi.fn(async(channel:string,payload:any)=>{
   if(channel==='extensions:get-enabled')return true;
   if(payload.toolName==='memory.set_path_override'){fail=true;return{revision:'rules-2',rootId:null,rules:{version:1,include:['extra.md'],exclude:[]},treeState:{revision:'tree-2',files:['/main/extra.md'],directories:['/main']}};}
   if(fail)throw Error('temporary refresh failure');
   return{revision:'tree-1',files:[],directories:[]};
  });
  vi.stubGlobal('window',{electronAPI:{invoke}});stop=initMemoryTreeListeners('/main');await vi.advanceTimersByTimeAsync(0);
  await changeMemoryTreeRule('/main/extra.md','include');
  expect(store.get(memoryTreeIncludedAtom('/main/extra.md'))).toBe(true);
  await vi.advanceTimersByTimeAsync(2000);
  expect(store.get(memoryTreeAvailableAtom)).toBe(true);expect(store.get(memoryTreeIncludedAtom('/main/extra.md'))).toBe(true);
 });
});


describe('config-only icon receipts',()=>{
 it('applies menu and field receipts without a tree refresh, including a stale delayed response',async()=>{
  store.set(rawFileTreeAtom,[{name:'main',path:'/main',type:'directory',children:[{name:'extra.md',path:'/main/extra.md',type:'file'}]}]);
  const policy=(include:boolean)=>({caseInsensitive:false,roots:[{id:null,path:'/main',available:true,includes:[],hardExcludes:[],directoryTargets:[],entityFiles:[],rules:include?[{mode:'include',match:{source:'^extra\\.md$',flags:''},prefixes:[]}]:[]}]});
  let hold=false,release!:(v:unknown)=>void;const delayed=new Promise(r=>release=r);
  const invoke=vi.fn(async(channel:string,payload:any)=>{
   if(channel==='extensions:get-enabled')return true;
   if(payload.toolName==='memory.set_path_override')return{revision:'saved',rootId:null,rules:{version:1,include:['extra.md'],exclude:[]},treePolicy:policy(true)};
   return hold?delayed:{revision:'initial',files:[],directories:[],treePolicy:policy(false)};
  });
  vi.stubGlobal('window',{electronAPI:{invoke}});stop=initMemoryTreeListeners('/main');await vi.advanceTimersByTimeAsync(0);
  hold=true;await vi.advanceTimersByTimeAsync(2000);const calls=invoke.mock.calls.length;
  await changeMemoryTreeRule('/main/extra.md','include');
  expect(invoke.mock.calls.length).toBe(calls+1);expect(store.get(memoryTreeIncludedAtom('/main/extra.md'))).toBe(true);
  release({revision:'stale',files:[],directories:[],treePolicy:policy(false)});await vi.advanceTimersByTimeAsync(0);
  expect(store.get(memoryTreeIncludedAtom('/main/extra.md'))).toBe(true);
  store.set(memorySourceChangeAtom,{workspacePath:'/main',rootId:null,revision:'field',rules:{version:1,include:[],exclude:['extra.md']},treePolicy:policy(false)});
  expect(store.get(memoryTreeIncludedAtom('/main/extra.md'))).toBe(false);
  store.set(rawFileTreeAtom,[]);
 });
});


describe('collapsed default source directories',()=>{
 it('uses the subtree rule without requiring indexed or loaded children and honors exclusions',()=>{
  const root={id:null,path:'/main',available:true,includes:[],hardExcludes:[],entityFiles:[],directoryTargets:['docs'],rules:[] as any[]};const policy={caseInsensitive:false,roots:[root]};
  expect(treePolicyIncludes(policy,'/main/docs/deep',true)).toBe(true);
  root.rules=[{mode:'exclude',match:{source:'^docs/private(?:/.*)?$',flags:''},prefixes:[]}];
  expect(treePolicyIncludes(policy,'/main/docs/private/deep',true)).toBe(false);
 });
});
