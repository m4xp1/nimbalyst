import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { projectStateAtom } from '../../../store/atoms/projectState';
import { FileGutter } from '../FileGutter';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('edited file gutter', () => {
  it.each([false, true])('does not render a bare zero in grouping=%s and still opens files', async (grouped) => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'session-files:get-by-sessions') return {
        success: true, files: [
          { sessionId: 'gutter-session', filePath: 'C:/fixture/docs/PLAN.md', metadata: { operation: 'edit', linesAdded: 0, linesRemoved: 0 } },
          { sessionId: 'gutter-session', filePath: 'C:/fixture/docs/CHANGED.md', metadata: { operation: 'edit', linesAdded: 2, linesRemoved: 1 } },
        ],
      };
      return { success: true, status: {} };
    });
    vi.stubGlobal('electronAPI', { invoke });
    const store = createStore();
    store.set(projectStateAtom, { ...store.get(projectStateAtom), diffTree: { groupByDirectory: grouped } });
    const onFileClick = vi.fn();
    const { container } = render(<Provider store={store}><FileGutter sessionId="gutter-session" workspacePath="C:/fixture" type="edited" onFileClick={onFileClick} /></Provider>);
    const plan = (await screen.findByText('PLAN.md')).closest('button')!;
    expect(plan.textContent).toBe('editPLAN.md');
    expect(plan.querySelector('.file-gutter__file-stats')).toBeNull();
    expect(screen.getByText('+2')).toBeTruthy();
    expect(screen.getByText('-1')).toBeTruthy();
    fireEvent.click(plan);
    expect(onFileClick).toHaveBeenCalledExactlyOnceWith('C:/fixture/docs/PLAN.md');
    expect(container.querySelectorAll('.file-gutter__file')).toHaveLength(2);
    expect(container.querySelector('.file-gutter__directory-header') !== null).toBe(grouped);
  });
});
