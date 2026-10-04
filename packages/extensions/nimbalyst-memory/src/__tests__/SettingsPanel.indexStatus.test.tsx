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
