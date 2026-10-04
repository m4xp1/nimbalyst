// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const calls=vi.hoisted(() => ({ open: vi.fn(), mode: vi.fn(), reveal: vi.fn() }));
vi.mock('../../../store', () => ({ openFileRequestAtom: 'open', setWindowModeAtom: 'mode' }));
vi.mock('jotai', () => ({ useSetAtom: (atom: string) => atom === 'open' ? calls.open : calls.mode }));
vi.mock('../../../utils/revealFileInTree', () => ({ revealFileInTree: calls.reveal }));
import { FilePathBreadcrumb } from '../FilePathBreadcrumb';
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); calls.reveal.mockResolvedValue(undefined); (window as any).electronAPI={ refreshFolderContents: vi.fn(async (p:string) => p.endsWith('/clips') ? [{name:'nested',path:'C:/ws/docs/clips/nested',type:'directory'},{name:'sibling.md',path:'C:/ws/docs/clips/sibling.md',type:'file'}] : []) }; });
describe('breadcrumb folder menu', () => {
  it('browses folder children, goes up and opens a file', async () => {
    render(<FilePathBreadcrumb filePath="C:\ws\docs\clips\current.md" workspacePath="C:\ws" />);
    fireEvent.click(screen.getByRole('button',{name:'clips'}));
    fireEvent.click(await screen.findByRole('menuitem',{name:/nested/}));
    await screen.findByText('Empty folder');
    fireEvent.click(screen.getByRole('menuitem',{name:/Parent folder/}));
    fireEvent.click(await screen.findByRole('menuitem',{name:/sibling.md/}));
    expect(calls.open).toHaveBeenCalledWith(expect.objectContaining({path:'C:/ws/docs/clips/sibling.md'}));
    expect(calls.reveal).toHaveBeenCalledWith('C:/ws/docs/clips/sibling.md');
    expect(screen.queryByRole('menu')).toBeNull();
  });
  it('keeps filename reveal and closes with Escape/outside click', async () => {
    render(<FilePathBreadcrumb filePath="C:/ws/docs/current.md" workspacePath="C:/ws" />);
    fireEvent.click(screen.getByRole('button',{name:'current.md'}));
    expect(calls.reveal).toHaveBeenCalledWith('C:/ws/docs/current.md');
    fireEvent.click(screen.getByRole('button',{name:'docs'})); await screen.findByRole('menu');
    fireEvent.keyDown(document,{key:'Escape'}); expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'docs'})); await screen.findByRole('menu');
    fireEvent.mouseDown(document.body); expect(screen.queryByRole('menu')).toBeNull();
  });
  it('reports an unreadable folder and supports keyboard movement', async () => {
    render(<FilePathBreadcrumb filePath="C:/ws/docs/clips/current.md" workspacePath="C:/ws" />);
    fireEvent.click(screen.getByRole('button',{name:'clips'}));
    const folder = await screen.findByRole('menuitem',{name:/nested/}); folder.focus();
    fireEvent.keyDown(folder,{key:'ArrowDown'}); expect(document.activeElement?.textContent).toContain('sibling.md');
    (window.electronAPI.refreshFolderContents as any).mockRejectedValueOnce(new Error('denied'));
    fireEvent.click(folder); await screen.findByRole('alert');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not read'));
  });
});
