import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrackerStoragePanel } from '../TrackerStoragePanel';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const types = [{ type: 'task', displayNamePlural: 'Tasks' }, { type: 'release', displayNamePlural: 'Releases' }];
const config = { version: 1, mode: 'database', directories: { legacy: 'docs/legacy' } };
const snapshot = { config, version: 'original-hash' };

describe('tracker storage settings', () => {
  it('saves the chosen mode and per-type paths through the versioned project API', async () => {
    const invoke = vi.fn(async (channel: string, payload: any) => channel.endsWith(':get') ? snapshot : { config: payload.config, version: 'saved-hash' });
    vi.stubGlobal('electronAPI', { invoke });
    render(<TrackerStoragePanel workspacePath="/project" types={types} />);
    fireEvent.change(await screen.findByLabelText('New card storage'), { target: { value: 'files' } });
    fireEvent.change(screen.getByLabelText('Tasks folder'), { target: { value: 'docs/work/tasks' } });
    fireEvent.change(screen.getByLabelText('Releases folder'), { target: { value: 'docs/work/releases' } });
    expect((screen.getByLabelText('legacy folder') as HTMLInputElement).value).toBe('docs/legacy');
    fireEvent.click(screen.getByRole('button', { name: 'Save storage settings' }));
    await screen.findByText('Saved. This setting applies to new cards.');
    expect(invoke).toHaveBeenNthCalledWith(1, 'document-service:tracker-storage:get', { workspacePath: '/project' });
    expect(invoke).toHaveBeenCalledWith('document-service:tracker-storage:set', {
      workspacePath: '/project', expectedVersion: 'original-hash',
      config: { version: 1, mode: 'files', directories: { legacy: 'docs/legacy', task: 'docs/work/tasks', release: 'docs/work/releases' } },
    });
    expect((screen.getByRole('button', { name: 'Save storage settings' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps an invalid/conflicting draft visible and permits one pending save at a time', async () => {
    let fail!: (error: Error) => void;
    const invoke = vi.fn((channel: string) => channel.endsWith(':get') ? Promise.resolve(snapshot) : new Promise((_, reject) => { fail = reject; }));
    vi.stubGlobal('electronAPI', { invoke });
    render(<TrackerStoragePanel workspacePath="/project" types={types} />);
    fireEvent.change(await screen.findByLabelText('New card storage'), { target: { value: 'files' } });
    fireEvent.change(screen.getByLabelText('Tasks folder'), { target: { value: '../outside' } });
    const save = screen.getByRole('button', { name: 'Save storage settings' });
    fireEvent.click(save); fireEvent.click(save);
    expect(invoke.mock.calls.filter(([channel]) => channel.endsWith(':set'))).toHaveLength(1);
    await act(async () => fail(new Error('Tracker directory must be a portable relative path')));
    expect(screen.getByRole('alert').textContent).toContain('portable relative path');
    expect((screen.getByLabelText('Tasks folder') as HTMLInputElement).value).toBe('../outside');
    expect(screen.queryByText('Saved. This setting applies to new cards.')).toBeNull();
  });

  it('discards a previous workspace load instead of saving its configuration into the new project', async () => {
    let finish!: (value: unknown) => void;
    const invoke = vi.fn((channel: string, payload: any) => {
      if (payload.workspacePath === '/a') return new Promise(resolve => { finish = resolve; });
      return Promise.resolve(channel.endsWith(':get') ? { config: { ...config, directories: { task: 'current/tasks' } }, version: 'b-hash' } : { config: payload.config, version: 'b-saved' });
    });
    vi.stubGlobal('electronAPI', { invoke });
    const view = render(<TrackerStoragePanel workspacePath="/a" types={types} />);
    view.rerender(<TrackerStoragePanel workspacePath="/b" types={types} />);
    await screen.findByLabelText('New card storage');
    await act(async () => finish(snapshot));
    fireEvent.change(screen.getByLabelText('New card storage'), { target: { value: 'files' } });
    expect((screen.getByLabelText('Tasks folder') as HTMLInputElement).value).toBe('current/tasks');
    fireEvent.click(screen.getByRole('button', { name: 'Save storage settings' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('document-service:tracker-storage:set', { workspacePath: '/b', expectedVersion: 'b-hash', config: { ...config, mode: 'files', directories: { task: 'current/tasks' } } }));
  });
});
