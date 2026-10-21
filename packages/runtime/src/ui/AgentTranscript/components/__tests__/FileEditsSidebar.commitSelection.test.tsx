// @vitest-environment jsdom
import {afterEach,describe,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {FileEditsSidebar} from '../FileEditsSidebar';
vi.mock('../../../git/useDiffPeek',()=>({useDiffPeek:()=>({peekSupported:false,registerRowEl:vi.fn(),togglePeek:vi.fn(),isActive:()=>false,popoverElement:null})}));
afterEach(cleanup);
describe('Select all commit payload',()=>{
 it('passes only the one selectable file when the session history contains eleven files',async()=>{
  const paths=Array.from({length:11},(_,i)=>'/repo/docs/file-'+i+'.md'),changed=paths[3],select=vi.fn();
  (window as any).electronAPI={invoke:vi.fn(async()=>({success:true,status:Object.fromEntries(paths.map(file=>[file,{status:file===changed?'modified':'unchanged'}]))}))};
  render(<FileEditsSidebar fileEdits={paths.map(filePath=>({filePath,linkType:'edited' as const,timestamp:'2026-10-21',sessionId:'artificial'}))} workspacePath='/repo' showCheckboxes selectedFiles={new Set()} onSelectAll={select} groupByDirectory={false}/>);
  const label=await screen.findByText('Select all (1 uncommitted)');fireEvent.click(label.previousElementSibling!);
  expect(select).toHaveBeenCalledExactlyOnceWith(true,[changed]);
 });
});

it('selects and deselects only the changed descendant of a history folder',async()=>{
 const paths=Array.from({length:11},(_,i)=>'/repo/docs/file-'+i+'.md'),changed=paths[3],bulk=vi.fn();
 (window as any).electronAPI={invoke:vi.fn(async()=>({success:true,status:{}}))};
 const props={fileEdits:paths.map(filePath=>({filePath,linkType:'edited' as const,timestamp:'2026-10-22',sessionId:'artificial-folder'})),workspacePath:'/repo',showCheckboxes:true,commitEligibleFiles:new Set([changed]),onBulkSelectionChange:bulk,groupByDirectory:true};
 const view=render(<FileEditsSidebar {...props} selectedFiles={new Set()}/>);
 const folder=await screen.findByText('docs');const checkbox=folder.closest('.file-edits-sidebar__directory-header')!.querySelector('.file-edits-sidebar__checkbox')!;
 fireEvent.click(checkbox);expect(bulk).toHaveBeenCalledExactlyOnceWith([changed],true);
 view.rerender(<FileEditsSidebar {...props} selectedFiles={new Set([changed])}/>);
 fireEvent.click(checkbox);expect(bulk).toHaveBeenLastCalledWith([changed],false);
});
