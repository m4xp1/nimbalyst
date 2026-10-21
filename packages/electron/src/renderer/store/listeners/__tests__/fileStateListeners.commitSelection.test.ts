// @vitest-environment node
import {afterEach,expect,it,vi} from 'vitest';
import {store} from '@nimbalyst/runtime/store';
import {initFileStateListeners,loadInitialSessionFileState} from '../fileStateListeners';
import {workspaceUncommittedFilesAtom} from '../../atoms/sessionFiles';
vi.mock('../../../services/sessionFilesLoader',()=>({loadSessionFilesResult:vi.fn(async()=>({success:true,files:[{filePath:'selected.md',sessionId:'selection',metadata:{}},{filePath:'old.md',sessionId:'selection',metadata:{}}]}))}));
afterEach(()=>vi.unstubAllGlobals());
it('publishes fresh session dirty paths before an older initial workspace snapshot can clear them',async()=>{
 const workspace='C:/fixture/session-selection';let resolve!:(value:unknown)=>void;
 const initial=new Promise(r=>resolve=r);
 vi.stubGlobal('window',{electronAPI:{on:()=>()=>{},invoke:vi.fn(async(channel:string)=>{
  if(channel==='git:get-uncommitted-files')return initial;
  if(channel==='session-files:get-tool-call-matches')return{success:true,matches:[]};
  if(channel==='git:get-file-status')return{success:true,status:{'selected.md':{status:'modified'},'old.md':{status:'unchanged'}}};
  if(channel==='history:get-pending-files-for-session')return[];
  throw Error('Unexpected '+channel);
 })}});
 store.set(workspaceUncommittedFilesAtom(workspace),[workspace+'/old.md','C:/attached/foreign.md']);
 const stop=initFileStateListeners(workspace);
 try{
  await loadInitialSessionFileState('session-selection-fixture',workspace);
  expect(store.get(workspaceUncommittedFilesAtom(workspace))).toEqual(['C:/attached/foreign.md',workspace+'/selected.md']);
  resolve({success:true,files:[]});await Promise.resolve();await Promise.resolve();
  expect(store.get(workspaceUncommittedFilesAtom(workspace))).toContain(workspace+'/selected.md');
 }finally{resolve({success:true,files:[]});stop();}
});

it('coalesces external writes into one fresh scoped status read without waiting for a Git index change',async()=>{
 vi.useFakeTimers();const workspace='C:/fixture/external-writes',events=new Map<string,(payload:any)=>void>();
 const invoke=vi.fn(async(channel:string,_workspace?:string,paths?:string[])=>{
  if(channel==='git:get-uncommitted-files')return{success:true,files:[]};
  if(channel==='git:clear-status-cache')return{success:true};
  if(channel==='git:get-file-status')return{success:true,status:Object.fromEntries(paths!.map(file=>[file,{status:'modified'}]))};
  throw Error('Unexpected '+channel);
 });
 vi.stubGlobal('window',{electronAPI:{invoke,on:(name:string,handler:(payload:any)=>void)=>{events.set(name,handler);return()=>events.delete(name);}}});
 const stop=initFileStateListeners(workspace);
 try{
  await Promise.resolve();const changed=events.get('file-changed-on-disk');expect(changed).toBeDefined();
  changed!({path:workspace+'/a.md'});changed!({path:workspace+'/b.md'});
  await vi.advanceTimersByTimeAsync(300);
  expect(invoke.mock.calls.filter(([name])=>name==='git:get-file-status')).toHaveLength(1);
  expect(store.get(workspaceUncommittedFilesAtom(workspace))).toEqual([workspace+'/a.md',workspace+'/b.md']);
 }finally{stop();vi.useRealTimers();}
});
