// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NimbalystMemorySettings } from '../components/SettingsPanel';

afterEach(() => { cleanup(); delete (window as any).electronAPI; });
it('shows session cleanup errors and refreshes Coverage after a failed toggle', async () => {
  let error: string | null = null;
  const invoke = vi.fn(async (name: string) => {
    if (name === 'semantic-search:get-index-sessions') return false;
    if (name === 'semantic-search:get-session-indexing-error') return error;
    if (name === 'semantic-search:set-index-sessions') {
      error = 'Session indexing could not be reconciled. Retry the session option.';
      throw new Error('Could not update session indexing');
    }
  });
  (window as any).electronAPI = { invoke };
  const call = vi.fn(async (name: string) => {
    if (name === 'memory.status') return { ready: true, chunks: 1, denseChunks: 1, bySourceClass: { sessions: 1 } };
    if (name === 'memory.get_sources') return { version: 1, include: [], exclude: [] };
    if (name === 'memory.list_facts') return { facts: [] };
    if (name === 'memory.local_embeddings_status') return { enabled: false, supported: false, activeMode: 'openai', selectedModelId: 'bge-small', models: [] };
    return {};
  });
  render(<NimbalystMemorySettings theme="light" storage={{ get: () => undefined, set: vi.fn(), delete: vi.fn(), keys: () => [] } as any} callBackendTool={call}/>);
  const checkbox = await screen.findByRole('checkbox', { name: /Also index AI sessions/ });
  await waitFor(() => expect(call.mock.calls.some(([n]) => n === 'memory.status')).toBe(true));
  const count = call.mock.calls.filter(([n]) => n === 'memory.status').length;
  fireEvent.click(checkbox);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('could not be reconciled'));
  expect(call.mock.calls.filter(([n]) => n === 'memory.status').length).toBeGreaterThan(count);
  expect((checkbox as HTMLInputElement).checked).toBe(false); // actual persisted setting
});
