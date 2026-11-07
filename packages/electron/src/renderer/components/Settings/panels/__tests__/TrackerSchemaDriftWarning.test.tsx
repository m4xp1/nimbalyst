import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrackerSchemaDriftWarning } from '../TrackerSchemaDriftWarning';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const drift = { hasDrift: true, entries: [{ type: 'task', status: 'drifted', source: '.nimbalyst/trackers/task.yaml' }] };

describe('tracker schema resync', () => {
  it('shows a failed resync and retries the actual operation without losing the warning', async () => {
    const invoke = vi.fn().mockResolvedValueOnce(drift).mockRejectedValueOnce(new Error('EACCES: schema unavailable')).mockResolvedValueOnce({ hasDrift: false, entries: [] });
    vi.stubGlobal('electronAPI', { invoke });
    render(<TrackerSchemaDriftWarning workspacePath="/project" />);
    fireEvent.click(await screen.findByRole('button', { name: 'sync Resync from files' }));
    expect((await screen.findByRole('alert')).textContent).toContain('EACCES');
    fireEvent.click(screen.getByTestId('tracker-schema-resync-button'));
    await waitFor(() => expect(screen.queryByTestId('tracker-schema-drift-warning')).toBeNull());
    expect(invoke).toHaveBeenNthCalledWith(3, 'tracker-schema:resync-mirror', '/project');
  });

  it('discards a delayed resync result after changing workspace', async () => {
    let finish!: (value: unknown) => void;
    const invoke = vi.fn((channel: string, workspace: string) => {
      if (channel === 'tracker-schema:resync-mirror') return new Promise(resolve => { finish = resolve; });
      return Promise.resolve(workspace === '/a' ? drift : { hasDrift: false, entries: [] });
    });
    vi.stubGlobal('electronAPI', { invoke });
    const view = render(<TrackerSchemaDriftWarning workspacePath="/a" />);
    fireEvent.click(await screen.findByTestId('tracker-schema-resync-button'));
    view.rerender(<TrackerSchemaDriftWarning workspacePath="/b" />);
    await waitFor(() => expect(screen.queryByTestId('tracker-schema-drift-warning')).toBeNull());
    await act(async () => finish(drift));
    expect(screen.queryByTestId('tracker-schema-drift-warning')).toBeNull();
  });
});
