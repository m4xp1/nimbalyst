// @vitest-environment jsdom
import { render,screen,fireEvent,waitFor,cleanup,act } from '@testing-library/react';import { describe,it,expect,vi,afterEach } from 'vitest';
import { NimbalystMemorySettings } from '../components/SettingsPanel';
afterEach(cleanup);
describe('Memory status UI',()=>{
 it('shows a partial index despite complete saved vectors and Refresh calls no rebuild',async()=>{
  const call=vi.fn(async(name:string)=>{
   if(name==='memory.status')return{ready:true,chunks:2,denseChunks:2,sourceFiles:1,indexedFiles:1,watching:false,chunksWithoutVectors:0,fileIndex:{state:'partial',phase:'index',discoveredFiles:4,completedFiles:1,failedFiles:1,error:{category:'quota',action:'Check provider quota, then use Rebuild.'}},retrieval:{mode:'hybrid',semantic:{available:true}}};
   if(name==='memory.get_sources')return{version:1,include:[],exclude:[]};if(name==='memory.list_facts')return{facts:[]};if(name==='memory.local_embeddings_status')return{enabled:false,supported:false,activeMode:'openai',selectedModelId:'bge-small',models:[]};return {};
  });
  render(<NimbalystMemorySettings theme="light" storage={{get:()=>undefined,set:vi.fn(),delete:vi.fn(),keys:()=>[]} as any} callBackendTool={call}/>);
  await screen.findByText('Needs attention');screen.getByText('Inactive');screen.getByText(/Available to search now/);
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
  await screen.findAllByText('33');
  const select=await screen.findByRole('combobox',{name:'Coverage source folder'});
  expect((select as HTMLSelectElement).selectedOptions[0].textContent).toBe('All');
  fireEvent.change(select,{target:{value:'attached-link'}});
  await waitFor(()=>expect(call).toHaveBeenCalledWith('memory.status',{rootId:'attached-link'}));
  fireEvent.change(select,{target:{value:''}});
  await screen.findAllByText('11');
  late(status(22));await new Promise(resolve=>setTimeout(resolve,20));
  expect(screen.queryByText('22')).toBeNull();expect(screen.getAllByText('11')[0]).toBeDefined();
  expect(screen.queryByText('Index size')).toBeNull();
  expect(screen.getByRole('button',{name:'Rebuild all'})).toBeDefined();
 });
});


describe('truthful live Coverage',()=>{
 it('uses searchable counts, shows file operation progress and keeps the card during a delayed refresh',async()=>{
  let hold=false,release!:(v:unknown)=>void;
  const current={ready:true,indexing:true,chunks:9,denseChunks:9,sourceFiles:3,available:{chunks:4,sourceFiles:2,indexedFiles:2,bySourceClass:{docs:4}},operation:{kind:'rules',state:'running',totalFiles:7,completedFiles:2,remainingFiles:4,failedFiles:1},fileIndex:{state:'ready',discoveredFiles:20,completedFiles:20,failedFiles:0}};
  const call=vi.fn(async(name:string)=>name==='memory.status'?(hold?new Promise(r=>release=r):current):name==='memory.get_sources'?{version:1,include:[],exclude:[]}:name==='memory.list_facts'?{facts:[]}:name==='memory.local_embeddings_status'?{models:[]}:[]);
  render(<NimbalystMemorySettings theme='light' storage={{get:()=>undefined,set:vi.fn(),delete:vi.fn(),keys:()=>[]} as any} callBackendTool={call}/>);
  await screen.findByText('Files available');
  expect(screen.queryByText('saved chunks with vectors')).toBeNull();
  expect(screen.getByText('2 processed · 4 remaining · 1 failed')).toBeDefined();
  hold=true;fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
  expect(screen.getByText('Files available')).toBeDefined();await act(async()=>release(current));
 });
});


describe('scoped Coverage recovery UI',()=>{
 it('shows the failing source and stage, then stops treating a recovered watch operation as a current error',async()=>{
  const issue={id:'watch-primary',stage:'watch',rootId:null,relativePath:'docs/a.md',code:'EACCES',error:{category:'access',action:'Check access'},updatedAt:1,state:'active'};
  let recovered=false;
  const call=vi.fn(async(name:string)=>{
   if(name==='memory.status')return{ready:true,available:{indexedFiles:1,sessions:0,trackers:0,chunks:1,sourceFiles:1,bySourceClass:{docs:1}},operation:{kind:'watch',state:'failed',error:issue.error},rebuildOperation:{id:1,state:'failed',error:issue.error},fileIndex:{state:recovered?'ready':'partial',phase:'done',discoveredFiles:1,completedFiles:1,failedFiles:0,error:recovered?null:issue.error,issues:[{...issue,state:recovered?'recovered':'active',resolvedAt:recovered?2:undefined}]}};
   if(name==='memory.get_sources')return{version:1,include:[],exclude:[]};if(name==='memory.list_facts')return{facts:[]};if(name==='memory.local_embeddings_status')return{enabled:false,supported:false,activeMode:'openai',selectedModelId:'bge-small',models:[]};return{};
  });
  render(<NimbalystMemorySettings theme="light" storage={{get:()=>undefined,set:vi.fn(),delete:vi.fn(),keys:()=>[]} as any} callBackendTool={call}/>);
  await screen.findByText('Needs attention');expect(screen.getByRole('alert').textContent).toContain('docs/a.md');expect(screen.getByRole('alert').textContent).toContain('EACCES');
  recovered=true;fireEvent.click(screen.getByRole('button',{name:'Refresh'}));await screen.findByText('Ready');expect(screen.queryByRole('alert')).toBeNull();expect(screen.getByText('Recovered source errors')).toBeDefined();
 });
});
