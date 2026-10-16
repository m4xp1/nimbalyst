// @vitest-environment jsdom
import React, {useState} from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
vi.mock('../../useTrackerData', () => ({useTrackerDataSelector: (select: (state: unknown) => unknown) => select({records:[],loaded:true})}));
import {PagesSearchView, type PagesSearchLane} from '../PagesSearchView';
import {parsePagesSearch} from '../pagesSearch';
const pages = [
 {documentId:'draft',title:'Русский интерфейс',fields:{status:'draft',owner:'ann@test'},updatedAt:1},
 {documentId:'done',title:'Русский интерфейс завершён',fields:{status:'done',owner:'bob@test'},updatedAt:2},
];
afterEach(cleanup);
function Host({lane}: {lane:PagesSearchLane}) {
 const [search,setSearch] = useState('');
 return <><output data-testid="stored-search">{search}</output><PagesSearchView lane={lane} pages={pages} typePlacements={[]} authorLabel={id=>id} search={search} onSearchChange={next=>setSearch(next)} onOpenPage={()=>{}} onOpenItem={()=>{}} /></>;
}
describe('Wiki search field filters', () => {
 it.each(['personal','team'] as const)('commits %s field/value selection without losing the clause to a text update', async lane => {
  const {container} = render(<Host lane={lane}/>);
  const input = screen.getByTestId('tracker-filter-omnibox-input');
  fireEvent.focus(input);
  fireEvent.mouseDown(await screen.findByTestId('tracker-filter-omnibox-option-field:status'));
  expect((input as HTMLInputElement).value).toBe('status:');
  fireEvent.mouseDown(await screen.findByTestId('tracker-filter-omnibox-option-value:draft'));
  await waitFor(()=>expect(container.querySelectorAll('tbody tr')).toHaveLength(1));
  expect(container.querySelector('tbody tr')?.getAttribute('data-row-id')).toBe('draft');
  expect(parsePagesSearch(new URLSearchParams(screen.getByTestId('stored-search').textContent!)).filters?.clauses).toEqual([{field:'status',op:'=',value:'draft'}]);
  expect(screen.getByTestId('tracker-filter-omnibox-pill-0').textContent).toContain('Draft');
  fireEvent.change(input,{target:{value:'русский'}});
  expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
  fireEvent.click(within(screen.getByTestId('tracker-filter-omnibox-pill-0')).getByRole('button',{name:'Remove Status filter'}));
  expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
  expect((input as HTMLInputElement).value).toBe('русский');
  fireEvent.change(input,{target:{value:'русский status:done'}});
  fireEvent.keyDown(input,{key:'Enter'});
  expect(container.querySelector('tbody tr')?.getAttribute('data-row-id')).toBe('done');
  expect(parsePagesSearch(new URLSearchParams(screen.getByTestId('stored-search').textContent!)).query.trim()).toBe('русский');
  fireEvent.focus(input);
  fireEvent.mouseDown(await screen.findByTestId('tracker-filter-omnibox-option-field:owner'));
  fireEvent.mouseDown(await screen.findByTestId('tracker-filter-omnibox-option-value:ann@test'));
  expect(container.querySelectorAll('tbody tr')).toHaveLength(0); // both conditions remain an AND
  expect(parsePagesSearch(new URLSearchParams(screen.getByTestId('stored-search').textContent!)).filters?.clauses).toHaveLength(2);
  fireEvent.click(screen.getByTestId('tracker-filter-omnibox-clear'));
  expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
  expect((input as HTMLInputElement).value).toBe('');
  expect(parsePagesSearch(new URLSearchParams(screen.getByTestId('stored-search').textContent!)).filters).toBeNull();
 });
});
