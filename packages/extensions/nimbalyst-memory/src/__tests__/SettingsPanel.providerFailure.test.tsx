// @vitest-environment jsdom
import {render, screen, cleanup} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {NimbalystMemorySettings} from '../components/SettingsPanel';
afterEach(cleanup);
it('shows provider access failure before a long list of retained files', async () => {
  const error={category:'authentication',action:'Review provider access.'};
  const call=vi.fn(async(name:string)=>name==='memory.status'?{
    ready:true,indexing:false,available:{indexedFiles:425,sessions:0,trackers:0},
    fileIndex:{state:'partial',error,failures:[{sourcePath:'docs/changed.md',stage:'embeddings',httpStatus:401,updatedAt:1,error}]},
    unavailableFiles:[{sourcePath:'docs/retained.md',rootId:null,relativePath:'docs/retained.md',reason:'missing',firstSeenAt:1,updatedAt:1}],
  }:name==='memory.get_sources'?{version:1,include:[],exclude:[]}:name==='memory.list_facts'?{facts:[]}:name==='memory.local_embeddings_status'?{models:[]}:[]);
  render(<NimbalystMemorySettings workspacePath='/test' theme='light' storage={{get:()=>undefined,set:vi.fn(),delete:vi.fn(),keys:()=>[]} as any} callBackendTool={call}/>);
  const retained=await screen.findByRole('region',{name:'Retained unavailable files'});
  const alert=screen.getByRole('alert');
  expect(alert.textContent).toContain('API key');
  expect(alert.compareDocumentPosition(retained)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByLabelText('Source indexing errors').textContent).toContain('HTTP 401');
  expect(call.mock.calls.some(([name])=>name.includes('rebuild')||name.includes('clear_unavailable'))).toBe(false);
});
