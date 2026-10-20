// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {memorySourceChanges} from '@nimbalyst/runtime';
import { SourceSettings } from '../components/SourceSettings';
afterEach(cleanup);
const initial = { version: 1, include: ['ропо'], exclude: [] };
async function field() { const f=screen.getByLabelText('Additional source includes'); await waitFor(()=>expect((f as HTMLTextAreaElement).disabled).toBe(false));return f; }
describe('automatic source settings',()=>{
 it('saves empty includes on blur without preview or Apply',async()=>{
  const call=vi.fn(async(name:string)=>name==='memory.get_sources'?initial:{});
  render(<SourceSettings callBackendTool={call} onApplied={()=>{}}/>);
  const f=await field();fireEvent.change(f,{target:{value:''}});fireEvent.blur(f);
  await waitFor(()=>expect(call).toHaveBeenCalledWith('memory.set_sources',{version:1,include:[],exclude:[]}));
  expect(screen.queryByRole('button')).toBeNull();expect(screen.queryByRole('note')).toBeNull();
 });
 it('does not replace edits when callbacks change and saves on close',async()=>{
  const first=vi.fn(async()=>initial),second=vi.fn(async()=>({}));
  const r=render(<SourceSettings callBackendTool={first} onApplied={()=>{}}/>);
  const f=await field();fireEvent.change(f,{target:{value:'config/**/*.json'}});
  r.rerender(<SourceSettings callBackendTool={second} onApplied={()=>{}}/>);
  expect((f as HTMLTextAreaElement).value).toBe('config/**/*.json');expect(second).not.toHaveBeenCalled();
  r.unmount();await waitFor(()=>expect(second).toHaveBeenCalledWith('memory.set_sources',{version:1,include:['config/**/*.json'],exclude:[]}));
 });
 it('serializes rapid blur and close updates and keeps the latest draft',async()=>{
  let release!:()=>void;const hold=new Promise<void>(r=>release=r);
  const call=vi.fn(async(name:string,params?:any)=>name==='memory.get_sources'?initial:params.include[0]==='ропо2'?hold:{});
  const r=render(<SourceSettings callBackendTool={call} onApplied={()=>{}}/>);
  const f=await field();fireEvent.change(f,{target:{value:'ропо2'}});fireEvent.blur(f);
  await waitFor(()=>expect(call.mock.calls.filter(([name])=>name==='memory.set_sources')).toHaveLength(1));
  fireEvent.change(f,{target:{value:'ропо'}});r.unmount();expect(call.mock.calls.filter(([name])=>name==='memory.set_sources')).toHaveLength(1);
  await act(async()=>release());await waitFor(()=>expect(call).toHaveBeenLastCalledWith('memory.set_sources',initial));
 });
 it('saves Include and Exclude together when either loses focus',async()=>{
  const call=vi.fn(async(name:string)=>name==='memory.get_sources'?initial:{});
  render(<SourceSettings callBackendTool={call} onApplied={()=>{}}/>);await field();
  const e=screen.getByLabelText('Source excludes');fireEvent.change(e,{target:{value:'cache/**'}});fireEvent.blur(e);
  await waitFor(()=>expect(call).toHaveBeenCalledWith('memory.set_sources',{...initial,exclude:['cache/**']}));
 });
 it('reports failed saves safely and retries on the next blur',async()=>{
  let fail=true;const call=vi.fn(async(name:string)=>{if(name==='memory.get_sources')return initial;if(fail)throw new Error('SECRET RESPONSE');return {};});
  render(<SourceSettings callBackendTool={call} onApplied={()=>{}}/>);const f=await field();
  fireEvent.change(f,{target:{value:''}});fireEvent.blur(f);
  expect((await screen.findByRole('alert')).textContent).not.toContain('SECRET');
  fail=false;fireEvent.blur(f);await waitFor(()=>expect(screen.queryByRole('alert')).toBeNull());
  expect(call.mock.calls.filter(([name])=>name==='memory.set_sources')).toHaveLength(2);
 });

 it('selects an attached source root and saves its rules without changing the primary',async()=>{
  const call=vi.fn(async(name:string,params?:any)=>{
   if(name==='memory.get_source_roots')return [{id:null,path:'/main',label:'main',available:true},{id:'attached-link',path:'/link',label:'link',available:true}];
   if(name==='memory.get_sources')return params?.rootId?{version:1,include:[],exclude:[]}:initial;
   return {};
  });
  render(<SourceSettings callBackendTool={call} onApplied={()=>{}}/>);await field();
  const select=await screen.findByRole('combobox',{name:'Source folder'});
  fireEvent.change(select,{target:{value:'attached-link'}});
  await waitFor(()=>expect((screen.getByLabelText('Additional source includes') as HTMLTextAreaElement).value).toBe(''));
  const f=await field();fireEvent.change(f,{target:{value:'archive/**'}});fireEvent.blur(f);
  await waitFor(()=>expect(call).toHaveBeenCalledWith('memory.set_sources',{version:1,rootId:'attached-link',include:['archive/**'],exclude:[]}));
 });
});


describe('selectable source folders',()=>{
 it('hides the selector for one physical workspace even with duplicate or harness roots',async()=>{
  const call=vi.fn(async(name:string)=>name==='memory.get_sources'?initial:name==='memory.get_source_roots'?[{id:null,path:'C:/Main',label:'Main',available:true},{id:'duplicate',path:'c:/main/',label:'alias',available:true},{id:'harness-memory',path:'C:/private/memory',label:'harness',available:true}]:{});
  render(<SourceSettings callBackendTool={call} onApplied={()=>{}}/>);await field();
  await waitFor(()=>expect(call).toHaveBeenCalledWith('memory.get_source_roots',{includeRules:true}));
  expect(screen.queryByRole('combobox',{name:'Source folder'})).toBeNull();
 });
});


describe('editable tree source rules',()=>{
 it('edits a tree include in the ordinary lists without a separate overrides section',async()=>{
  const rules={...initial,include:['docs/a.md'],exclude:['docs']};
  const call=vi.fn(async(name:string)=>name==='memory.get_sources'?rules:{});
  render(<SourceSettings callBackendTool={call} onApplied={()=>{}}/>);const f=await field();
  expect(screen.queryByText('File and folder overrides')).toBeNull();
  expect((f as HTMLTextAreaElement).value).toBe('docs/a.md');
  fireEvent.change(f,{target:{value:''}});fireEvent.blur(f);
  await waitFor(()=>expect(call).toHaveBeenCalledWith('memory.set_sources',{...rules,include:[]}));
 });
});


describe('shared durable source rules',()=>{
 it('updates a clean field after a tree action, retains a dirty draft and sends its original revision',async()=>{
  const call=vi.fn(async(name:string)=>name==='memory.get_sources'?{...initial,revision:'one'}:name==='memory.set_sources'?Promise.reject(Error('Conflict')):[]);
  render(<SourceSettings workspacePath='/test' callBackendTool={call} onApplied={()=>{}}/>);const f=await field();
  act(()=>memorySourceChanges.publish({workspacePath:'/other',rootId:null,revision:'foreign',rules:{version:1,include:['foreign'],exclude:[]}}));
  expect((f as HTMLTextAreaElement).value).toBe('ропо');
  act(()=>memorySourceChanges.publish({workspacePath:'/test',rootId:null,revision:'two',rules:{version:1,include:['tree.md'],exclude:[]}}));
  expect((f as HTMLTextAreaElement).value).toBe('tree.md');
  fireEvent.change(f,{target:{value:'my-draft.md'}});
  act(()=>memorySourceChanges.publish({workspacePath:'/test',rootId:null,revision:'three',rules:{version:1,include:['new-tree.md'],exclude:[]}}));
  expect((f as HTMLTextAreaElement).value).toBe('my-draft.md');expect(screen.getByRole('alert').textContent).toContain('draft');
  fireEvent.blur(f);
  await waitFor(()=>expect(call).toHaveBeenCalledWith('memory.set_sources',{version:1,include:['my-draft.md'],exclude:[],expectedRevision:'two'}));
 });
});


describe('source draft across folder switches',()=>{
 it('does not call a successfully saved draft unsaved after switching away before acknowledgement',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);let saved=initial;
  const call=vi.fn(async(name:string,params?:any)=>{
   if(name==='memory.get_source_roots')return[{id:null,path:'/main',label:'main',available:true},{id:'link',path:'/link',label:'link',available:true}];
   if(name==='memory.get_sources')return params?.rootId?{version:1,include:[],exclude:[]}:saved;
   if(name==='memory.set_sources'){await gate;saved={version:1,include:params.include,exclude:params.exclude};return{rules:saved,revision:'two'};}
   return{};
  });
  render(<SourceSettings workspacePath='/draft-root-test' callBackendTool={call} onApplied={()=>{}}/>);const f=await field(),select=await screen.findByRole('combobox',{name:'Source folder'});
  fireEvent.change(f,{target:{value:'saved.md'}});fireEvent.blur(f);await waitFor(()=>expect(call.mock.calls.filter(([name])=>name==='memory.set_sources')).toHaveLength(1));
  fireEvent.change(select,{target:{value:'link'}});await act(async()=>release());await field();
  fireEvent.change(select,{target:{value:''}});await waitFor(()=>expect((screen.getByLabelText('Additional source includes') as HTMLTextAreaElement).value).toBe('saved.md'));
  expect(screen.queryByRole('alert')).toBeNull();expect(screen.queryByRole('button',{name:'Reload saved rules'})).toBeNull();
 });
});


describe('textarea fast durable receipts',()=>{
 it('publishes acknowledged rules and icon policy before the background status request finishes',async()=>{
  const policy={caseInsensitive:false,roots:[]};const publish=vi.spyOn(memorySourceChanges,'publish');let applied=0;
  const call=vi.fn(async(name:string)=>name==='memory.get_sources'?initial:name==='memory.set_sources'?{rules:{version:1,include:['normalized.md'],exclude:[]},revision:'saved',treePolicy:policy}:[]);
  try{render(<SourceSettings workspacePath='/form-fast-test' callBackendTool={call} onApplied={()=>{applied++;void new Promise(()=>{});}}/>);
   const f=await field();fireEvent.change(f,{target:{value:'normalized.md'}});fireEvent.blur(f);
   await waitFor(()=>expect(publish).toHaveBeenCalledWith({workspacePath:'/form-fast-test',rootId:null,rules:{version:1,include:['normalized.md'],exclude:[]},revision:'saved',treePolicy:policy}));expect(applied).toBe(1);
  }finally{publish.mockRestore();}
 });
});
