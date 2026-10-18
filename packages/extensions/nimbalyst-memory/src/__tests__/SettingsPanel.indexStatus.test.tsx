// @vitest-environment jsdom
import { render,screen,fireEvent,waitFor,cleanup } from '@testing-library/react';import { describe,it,expect,vi,afterEach } from 'vitest';
import { NimbalystMemorySettings } from '../components/SettingsPanel';
afterEach(cleanup);
describe('Memory status UI',()=>{
 it('shows a partial index despite complete saved vectors and Refresh calls no rebuild',async()=>{
  const call=vi.fn(async(name:string)=>{
   if(name==='memory.status')return{ready:true,chunks:2,denseChunks:2,sourceFiles:1,indexedFiles:1,watching:false,chunksWithoutVectors:0,fileIndex:{state:'partial',phase:'index',discoveredFiles:4,completedFiles:1,failedFiles:1,error:{category:'quota',action:'Check provider quota, then use Rebuild.'}},retrieval:{mode:'hybrid',semantic:{available:true}}};
   if(name==='memory.get_sources')return{version:1,include:[],exclude:[]};if(name==='memory.list_facts')return{facts:[]};if(name==='memory.local_embeddings_status')return{enabled:false,supported:false,activeMode:'openai',selectedModelId:'bge-small',models:[]};return {};
  });
  render(<NimbalystMemorySettings theme="light" storage={{get:()=>undefined,set:vi.fn(),delete:vi.fn(),keys:()=>[]} as any} callBackendTool={call}/>);
  await screen.findByText('Partial index');screen.getByText('Inactive');screen.getByText(/Embedding coverage describes saved chunks/);
  call.mockClear();fireEvent.click(screen.getByRole('button',{name:'Refresh'}));await waitFor(()=>expect(call).toHaveBeenCalledWith('memory.status'));
  expect(call.mock.calls.every(([name])=>name==='memory.status')).toBe(true);
  expect(screen.queryByText('Ready')).toBeNull();
 });
});


describe('scoped Coverage',()=>{
 it('defaults to All and ignores a late response from a previously selected folder',async()=>{
  const roots=[{id:null,path:'/main',label:'main',available:true},{id:'attached-link',path:'/link',label:'link',available:true}];
  let late!:(v:unknown)=>void;
  const linked=new Promise(resolve=>late=resolve);
  const status=(chunks:number)=>({ready:true,chunks,denseChunks:chunks,sourceFiles:1,sourceRoots:roots,fileIndex:{state:'ready',phase:'done',discoveredFiles:1,completedFiles:1,failedFiles:0},indexSizeBytes:32000});
  const call=vi.fn(async(name:string,params?:any)=>{
   if(name==='memory.status')return params?.rootId==='attached-link'?linked:status(params?.rootId===null?11:33);
   if(name==='memory.get_source_roots')return roots;
   if(name==='memory.get_sources')return{version:1,include:[],exclude:[]};
   if(name==='memory.list_facts')return{facts:[]};
   if(name==='memory.local_embeddings_status')return{enabled:false,supported:false,models:[]};
   return{};
  });
  render(<NimbalystMemorySettings theme='light' storage={{get:()=>undefined,set:vi.fn(),delete:vi.fn(),keys:()=>[]} as any} callBackendTool={call}/>);
  await screen.findByText('33');
  const select=await screen.findByRole('combobox',{name:'Coverage source folder'});
  expect((select as HTMLSelectElement).selectedOptions[0].textContent).toBe('All');
  fireEvent.change(select,{target:{value:'attached-link'}});
  await waitFor(()=>expect(call).toHaveBeenCalledWith('memory.status',{rootId:'attached-link'}));
  fireEvent.change(select,{target:{value:''}});
  await screen.findByText('11');
  late(status(22));await new Promise(resolve=>setTimeout(resolve,20));
  expect(screen.queryByText('22')).toBeNull();expect(screen.getByText('11')).toBeDefined();
  expect(screen.queryByText('Index size')).toBeNull();
  expect(screen.getByRole('button',{name:'Rebuild all'})).toBeDefined();
 });
});
