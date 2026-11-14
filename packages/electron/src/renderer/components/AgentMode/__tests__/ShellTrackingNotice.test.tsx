import React from 'react';
import { it, expect, vi } from 'vitest';
import { Provider } from 'jotai';
import { store } from '@nimbalyst/runtime/store/store';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import { ShellTrackingNotice } from '../ShellTrackingNotice';
import { initFileStateListeners } from '../../../store/listeners/fileStateListeners';

it('shows the time, turn and capture failure for a missed shell batch', async () => {
  const original = window.electronAPI;
  const invoke = vi.fn(async () => [{
    sessionId: 'bulk-session', state: 'degraded', observation: 'watching',
    reasons: { checkoutBaseline: 1 }, turns: [],
    events: [{
      at: 1794510000000, reason: 'checkoutBaseline', turnId: 'bulk-turn',
      tool: 'Bash', error: 'capture timeout: preparation budget exceeded',
    }],
  }]);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke } });
  try {
    render(<Provider store={store}><ShellTrackingNotice sessionIds={['bulk-session']} /></Provider>);
    const failures = await screen.findByRole('list', { name: 'Recent tracking failures' });
    expect(failures.textContent).toContain('bulk-turn');
    expect(failures.textContent).toContain('Bash');
    expect(failures.textContent).toContain('capture timeout: preparation budget exceeded');
    expect(failures.querySelector('time')?.getAttribute('datetime')).toBe(new Date(1794510000000).toISOString());
  } finally {
    cleanup();
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: original });
  }
});

it('refreshes coverage through the central listener, isolates scopes, and rejects stale responses', async () => {
  const original = window.electronAPI;
  let finishOld!: (value: any) => void;
  const handlers = new Map<string, (...args: any[]) => void>();
  const coverage = vi.fn()
    .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
    .mockResolvedValue([{ sessionId: 'b', state: 'no-detected-fault', reasons: {}, turns: [] }]);
  const invoke = vi.fn((channel: string, ...args: any[]) => {
    if (channel === 'session-files:coverage') return coverage(...args);
    return Promise.resolve({ success: true, files: [] });
  });
  const on = vi.fn((channel: string, handler: (...args: any[]) => void) => {
    handlers.set(channel, handler);
    return () => { handlers.delete(channel); };
  });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke, on } });
  const stop = initFileStateListeners('/workspace');
  const view = (ids: string[]) => <Provider store={store}><ShellTrackingNotice sessionIds={ids} /></Provider>;
  try {
    const { rerender, unmount } = render(view(['a']));
    rerender(view(['b']));
    await waitFor(() => expect(coverage).toHaveBeenCalledTimes(2));
    await act(async () => { finishOld([{ sessionId: 'a', state: 'degraded', reasons: { quota: 1 }, turns: [] }]); });
    expect(screen.queryByTestId('shell-tracking-notice')).toBeNull();

    // The existing listener coalesces bursts and updates coverage even with no file links.
    coverage.mockResolvedValue([{ sessionId: 'b', state: 'degraded', reasons: { persistence: 1 }, turns: [] }]);
    act(() => {
      for (let i = 0; i < 3; i++) handlers.get('session-files:updated')!('b');
      handlers.get('session-files:updated')!('unrelated');
    });
    await screen.findByText('File tracking incomplete');
    expect(coverage).toHaveBeenCalledTimes(3);
    expect(coverage).toHaveBeenLastCalledWith(['b']);
    expect(screen.getByText('File links could not be saved.')).toBeDefined();
    expect(screen.queryByText('The session reached its file tracking limit.')).toBeNull();

    coverage.mockResolvedValue([{ sessionId: 'b', state: 'degraded', observation: 'watching', reasons: { watcherLoss: 1, suspiciousWindow: 3 }, turns: [] }]);
    act(() => handlers.get('session-files:updated')!('b'));
    await screen.findByText('Earlier file tracking gaps');
    expect(screen.queryByText('A tool tracking window could not be reconciled.')).toBeNull();
    coverage.mockRejectedValueOnce(new Error('unavailable'));
    act(() => handlers.get('session-files:updated')!('b'));
    await screen.findByText('File tracking status unavailable');
    coverage.mockResolvedValue([]);
    act(() => handlers.get('session-files:updated')!('b'));
    await waitFor(() => expect(screen.queryByTestId('shell-tracking-notice')).toBeNull());

    unmount();
    render(view(['b']));
    await waitFor(() => expect(coverage).toHaveBeenCalledTimes(7));
    expect(on.mock.calls.filter(([channel]) => channel === 'session-files:updated')).toHaveLength(1);
  } finally {
    cleanup();
    stop();
    expect(handlers.size).toBe(0);
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: original });
  }
});
