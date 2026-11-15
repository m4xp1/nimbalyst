import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { interactiveWidgetHostAtom } from '../../../../store/atoms/interactiveWidgetHost';
import { CodexWriterConflictWidget } from '../CodexWriterConflictWidget';
import { isCodexWriterConflict } from '../../../../ai/codexWriterConflict';

afterEach(cleanup);
describe('Codex writer recovery', () => {
  const detail = 'Error: [CodexAppServer] thread/resume failed: thread fixture already has an active writer';
  it('only recognizes the concrete resume failure', () => {
    expect(isCodexWriterConflict(detail)).toBe(true);
    expect(isCodexWriterConflict('This project already has an active writer')).toBe(false);
    expect(isCodexWriterConflict('[CodexAppServer] thread/resume failed: unauthorized')).toBe(false);
  });
  it('shares pending state between views and allows retry after an unsuccessful check', async () => {
    const store = createStore();
    let finish!: (result: { success: boolean; error?: string }) => void;
    const resolveCodexWriter = vi.fn(() => new Promise<{ success: boolean; error?: string }>(resolve => { finish = resolve; }));
    store.set(interactiveWidgetHostAtom('writer-test'), { resolveCodexWriter } as never);
    render(<Provider store={store}>{[1, 2].map(key => <CodexWriterConflictWidget key={key}
      detail={detail} sessionId="writer-test" messageId={4} isLastMessage />)}</Provider>);
    fireEvent.click(screen.getAllByRole('button', { name: 'Try resolve' })[0]);
    expect(screen.getAllByRole('button', { name: 'Resolving…' }).every(button => (button as HTMLButtonElement).disabled)).toBe(true);
    finish({ success: false, error: 'Close the other connection.' });
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Try resolve' })).toHaveLength(2));
    expect(screen.getAllByText('Close the other connection.')).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Try resolve' })[1]);
    finish({ success: true });
    await waitFor(() => expect(screen.getAllByText('Connection restored. Send your message again.')).toHaveLength(2));
    expect(resolveCodexWriter).toHaveBeenCalledTimes(2);
  });
  it('does not offer recovery on a historical error', () => {
    const store = createStore();
    store.set(interactiveWidgetHostAtom('old-writer'), { resolveCodexWriter: vi.fn() } as never);
    render(<Provider store={store}><CodexWriterConflictWidget detail={detail} sessionId="old-writer" messageId={9} isLastMessage={false} /></Provider>);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(detail)).toBeTruthy();
  });
});
