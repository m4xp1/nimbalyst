// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
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
